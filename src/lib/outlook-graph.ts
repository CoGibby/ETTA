import fs from 'fs';
import { getDataFilePath } from './app-paths';
import crypto from 'crypto';
import { getSetting } from '@/lib/db';

// ---------- Config ----------

// Mirrors electron/main.ts ENTRA_DEFAULTS (the v15 sealed-config fix) so the
// Entra app registration is available in every runtime, including the web
// server started outside the packaged desktop shell.
const ENTRA_DEFAULTS = {
  clientId: 'b13c664e-d672-412b-bb7a-4eb9e53e059c',
  tenantId: '8a198873-4fec-4e76-8182-ca479edbbd60',
  scopes: 'Mail.Read Calendars.Read User.Read offline_access',
};

function getClientId(): string {
  return (
    getSetting('azure_client_id') ||
    process.env.AZURE_CLIENT_ID ||
    process.env.MS_CLIENT_ID ||
    ENTRA_DEFAULTS.clientId ||
    ''
  ).trim();
}

function getTenantId(): string {
  return (
    getSetting('azure_tenant_id') ||
    process.env.AZURE_TENANT_ID ||
    process.env.MS_TENANT_ID ||
    ENTRA_DEFAULTS.tenantId ||
    'common'
  ).trim() || 'common';
}

function getScopes(): string[] {
  const raw =
    getSetting('azure_scopes') ||
    process.env.AZURE_SCOPES ||
    ENTRA_DEFAULTS.scopes ||
    'Mail.Read Calendars.Read User.Read offline_access';
  return raw.split(/\s+/).filter(Boolean);
}

function getCachePath(): string {
  return getDataFilePath('msal_cache.json');
}

function getDeviceFlowPath(): string {
  return getDataFilePath('outlook_device_flow.json');
}

// ---------- Token cache ----------

interface TokenCache {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch seconds
  account?: string;
}

function loadCache(): TokenCache | null {
  const cachePath = getCachePath();
  if (!fs.existsSync(cachePath)) return null;
  try {
    const raw = fs.readFileSync(cachePath, 'utf-8');
    return JSON.parse(raw) as TokenCache;
  } catch {
    return null;
  }
}

function saveCache(cache: TokenCache): void {
  fs.writeFileSync(getCachePath(), JSON.stringify(cache, null, 2), 'utf-8');
}

function clearCache(): void {
  for (const p of [getCachePath(), getDeviceFlowPath(), getPkcePath()]) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch { /* ignore */ }
  }
}

﻿// ---------- Auth: Authorization Code flow with PKCE ----------

function getPkcePath(): string {
  return getDataFilePath('outlook_pkce.json');
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function generatePkceVerifier(): string {
  return base64UrlEncode(crypto.randomBytes(32));
}

function computePkceChallenge(verifier: string): string {
  const hash = crypto.createHash('sha256').update(verifier).digest();
  return base64UrlEncode(hash);
}

export function buildAuthUrl(
  redirectUri: string,
  options: { prompt?: 'select_account' } = {}
): string {
  const clientId = getClientId();
  if (!clientId) {
    throw new Error('Azure Client ID is not configured.');
  }
  const tenantId = getTenantId();
  const scopes = getScopes();
  const verifier = generatePkceVerifier();
  const challenge = computePkceChallenge(verifier);

  fs.writeFileSync(getPkcePath(), JSON.stringify({ verifier, redirectUri }), 'utf-8');

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: scopes.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    response_mode: 'query',
  });
  if (options.prompt) {
    params.set('prompt', options.prompt);
  }

  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
}

export async function exchangeAuthCode(code: string, redirectUri: string): Promise<{ success: boolean; account?: string; error?: string }> {
  const clientId = getClientId();
  const tenantId = getTenantId();
  const scopes = getScopes();
  const pkcePath = getPkcePath();

  if (!fs.existsSync(pkcePath)) {
    return { success: false, error: 'No sign-in in progress. Please try again.' };
  }

  const { verifier } = JSON.parse(fs.readFileSync(pkcePath, 'utf-8'));

  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    scope: scopes.join(' '),
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const data = await res.json();

  if (data.error) {
    return { success: false, error: data.error_description || data.error || 'Sign-in failed.' };
  }

  const cache: TokenCache = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
  };
  saveCache(cache);

  try { fs.unlinkSync(pkcePath); } catch { /* ignore */ }

  try {
    const userRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    if (userRes.ok) {
      const userData = await userRes.json();
      cache.account = userData.userPrincipalName || userData.displayName || '';
      saveCache(cache);
      return { success: true, account: cache.account };
    }
  } catch { /* ignore */ }

  return { success: true };
}


async function refreshToken(): Promise<{ cache: TokenCache; expired: boolean } | null> {
  const cache = loadCache();
  if (!cache || !cache.refresh_token) return null;

  const clientId = getClientId();
  const tenantId = getTenantId();
  const scopes = getScopes();

  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: cache.refresh_token,
    scope: scopes.join(' '),
  });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    const data = await res.json();

    // Permanent failure: refresh token is invalid or revoked
    if (data.error === 'invalid_grant' || data.error === 'invalid_token') {
      clearCache();
      return null;
    }

    if (!data.access_token) {
      // Transient failure (network, 5xx, etc.) — keep existing cache
      return { cache, expired: false };
    }

    const updated: TokenCache = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || cache.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
      account: cache.account,
    };
    saveCache(updated);
    return { cache: updated, expired: false };
  } catch {
    // Network error — transient, keep existing cache so user stays connected
    return { cache, expired: false };
  }
}

export async function getAccessToken(): Promise<string> {
  const cache = loadCache();
  if (!cache) {
    throw new Error('Outlook is not connected. Open Settings and sign in with Microsoft 365.');
  }

  // If token expires in next 60s, refresh
  const now = Math.floor(Date.now() / 1000);
  if (cache.expires_at - now < 60) {
    const result = await refreshToken();
    if (result) return result.cache.access_token;
    throw new Error('Token expired and could not be refreshed. Please sign in again.');
  }

  return cache.access_token;
}

export interface AuthStatus {
  configured: boolean;
  connected: boolean;
  account: string | null;
  message: string;
}

export async function getAuthStatus(): Promise<AuthStatus> {
  const clientId = getClientId();
  if (!clientId) {
    return {
      configured: false,
      connected: false,
      account: null,
      message: 'Azure Client ID is not configured.',
    };
  }

  const cache = loadCache();
  if (!cache) {
    return {
      configured: true,
      connected: false,
      account: null,
      message: 'Not signed in.',
    };
  }

  // Check if token is still valid (or can be refreshed)
  const now = Math.floor(Date.now() / 1000);
  if (cache.expires_at - now < 300) {
    // Proactively refresh if expiring within 5 minutes
    const result = await refreshToken();
    if (!result) {
      return {
        configured: true,
        connected: false,
        account: cache.account || null,
        message: 'Token expired. Please sign in again.',
      };
    }
  }

  return {
    configured: true,
    connected: true,
    account: cache.account || null,
    message: 'Connected.',
  };
}

export function logout(): void {
  clearCache();
}

// ---------- Text utilities ----------

export function htmlToPlainText(html: string): string {
  if (!html) return '';
  // Decode common HTML entities that can break code matching
  let text = html
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, String.fromCharCode(34))
    .replace(/&#39;/g, String.fromCharCode(39))
    .replace(/&#45;/g, '-')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
  // Strip style and script blocks entirely
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ');
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, ' ');
  // Normalize whitespace
  text = text.replace(/\r\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

export function extractReplyOnly(body: string): string {
  if (!body) return '';
  const separators = [
    /\n\s*From:.*\n/i,
    /\n\s*-----Original Message-----/i,
    /\n\s*----- Original Message -----/i,
    /\n\s*On .+ wrote:/i,
    /\n\s*_{5,}/i,
    /\n\s*>/,
    /\n\s*Sent from my /i,
  ];
  let earliest = body.length;
  for (const pattern of separators) {
    const match = body.match(pattern);
    if (match && match.index !== undefined && match.index < earliest) {
      earliest = match.index;
    }
  }
  return body.slice(0, earliest).trim();
}

export function graphDatetimeToLocal(iso: string): string {
  if (!iso) return '';
  // Graph returns e.g. 2024-01-15T10:30:00.0000000-08:00 or with Z
  const normalized = iso.replace('Z', '+00:00');
  const dt = new Date(normalized);
  if (isNaN(dt.getTime())) return iso;
  // Format as YYYY-MM-DDTHH:MM:SS in local time
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  const h = String(dt.getHours()).padStart(2, '0');
  const min = String(dt.getMinutes()).padStart(2, '0');
  const s = String(dt.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d}T${h}:${min}:${s}`;
}

// ---------- Graph API client ----------

interface GraphItem {
  type: 'email' | 'meeting';
  subject: string;
  body: string;
  date: string;
  duration_minutes?: number;
  external_id?: string;
  conversation_id?: string;
}

async function graphHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

// Graph API items are dynamic payloads; callers narrow the fields they use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function paginate(url: string): Promise<any[]> {
  const headers = await graphHeaders();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: any[] = [];
  let currentUrl = url;

  while (currentUrl) {
    const res = await fetch(currentUrl, { headers });
    if (!res.ok) {
      throw new Error(`Graph API error: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    if (data.value) {
      all.push(...data.value);
    }
    currentUrl = data['@odata.nextLink'] || '';
  }

  return all;
}

function shouldSkipEmailSubject(subject: string): boolean {
  const lower = subject.toLowerCase();
  // Skip automated messages
  return (
    lower.startsWith('automatic reply') ||
    lower.startsWith('auto:') ||
    lower.startsWith('accepted:') ||
    lower.startsWith('declined:') ||
    lower.startsWith('tentative:') ||
    lower.startsWith('canceled:') ||
    lower.startsWith('cancelled:') ||
    lower.startsWith('out of office') ||
    lower.startsWith('undeliverable') ||
    lower.startsWith('delivery status notification')
  );
}

export async function fetchSentEmails(
  startDate: string,
  endDate: string,
  onProgress?: (current: number, total: number, message: string) => void
): Promise<GraphItem[]> {
  const startIso = `${startDate}T00:00:00Z`;
  const endIso = `${endDate}T23:59:59Z`;
  const filterQuery = `sentDateTime ge ${startIso} and sentDateTime lt ${endIso}`;
  const select = encodeURIComponent('subject,body,sentDateTime,conversationId');
  const url = `https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages?$filter=${encodeURIComponent(filterQuery)}&$select=${select}&$top=50&$orderby=sentDateTime%20desc`;

  const messages = await paginate(url);
  const items: GraphItem[] = [];
  let scanned = 0;

  for (const msg of messages) {
    scanned++;
    if (onProgress && scanned % 20 === 0) {
      onProgress(scanned, scanned, `Processing emails... ${scanned}`);
    }

    const subject = msg.subject || '';
    if (shouldSkipEmailSubject(subject)) continue;

    const sentRaw = msg.sentDateTime || '';
    const sentLocal = graphDatetimeToLocal(sentRaw);
    const dateOnly = sentLocal.slice(0, 10);
    if (dateOnly < startDate || dateOnly > endDate) continue;

    const bodyObj = msg.body || {};
    let bodyContent = bodyObj.content || '';
    if ((bodyObj.contentType || '').toLowerCase() === 'html') {
      bodyContent = htmlToPlainText(bodyContent);
    }
    const replyOnly = extractReplyOnly(bodyContent);

    items.push({
      type: 'email',
      subject,
      body: replyOnly.slice(0, 5000),
      date: sentLocal,
      conversation_id: msg.conversationId || '',
    });
  }

  if (onProgress) {
    onProgress(scanned, scanned, `Found ${items.length} emails in date range`);
  }

  return items;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function includeCalendarEvent(event: any, includeTentative: boolean): boolean {
  if (event.isCancelled) return false;
  if (event.isAllDay) return false;
  if (String(event.showAs || '').toLowerCase() === 'free') return false;

  const categories = (event.categories || []).map((category: string) => String(category).toLowerCase());

  // Skip generic placeholders and explicitly personal events.
  const subject = (event.subject || '').trim().toLowerCase();
  if (
    subject === 'busy' ||
    subject === 'free' ||
    subject === 'tentative' ||
    subject === 'out of office' ||
    subject === 'oof' ||
    subject === 'unavailable' ||
    subject === 'blocked' ||
    subject === 'do not schedule'
  ) {
    return false;
  }

  if (categories.some((category: string) => category.includes('personal') || category.includes('non-work'))) {
    return false;
  }

  // ETTA imports meetings and emails, not individual focus blocks. Keep
  // attendee-less appointments only when they explicitly reference a Jira issue.
  const hasAttendees = Array.isArray(event.attendees) && event.attendees.length > 0;
  const hasOnlineMeeting = !!event.onlineMeeting;
  const text = `${event.subject || ''} ${event.body?.content || ''}`;
  const hasJiraReference = /\b[A-Z]+-\d+\b/i.test(text);
  if (!hasAttendees && !hasOnlineMeeting && !hasJiraReference) {
    return false;
  }

  const response = event.responseStatus?.response || '';
  if (event.isOrganizer) return true;
  if (response === 'accepted' || response === 'organizer') return true;
  return includeTentative && response === 'tentative';
}

export async function fetchCalendarEvents(
  startDate: string,
  endDate: string,
  includeTentative: boolean,
  onProgress?: (current: number, total: number, message: string) => void
): Promise<GraphItem[]> {
  const startIso = `${startDate}T00:00:00Z`;
  // End date is exclusive in Graph calendarView
  const endDateObj = new Date(endDate + 'T00:00:00Z');
  endDateObj.setUTCDate(endDateObj.getUTCDate() + 1);
  const endExclusive = endDateObj.toISOString();

  const select = encodeURIComponent('subject,body,start,end,responseStatus,isOrganizer,isCancelled,isAllDay,iCalUId,seriesMasterId,attendees,categories,onlineMeeting,showAs');
  const url = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${encodeURIComponent(startIso)}&endDateTime=${encodeURIComponent(endExclusive)}&$select=${select}&$top=50`;

  const events = await paginate(url);
  const items: GraphItem[] = [];
  let scanned = 0;

  for (const event of events) {
    scanned++;
    if (onProgress && scanned % 20 === 0) {
      onProgress(scanned, scanned, `Processing meetings... ${scanned}`);
    }

    if (!includeCalendarEvent(event, includeTentative)) continue;

    const startRaw = event.start?.dateTime || '';
    const meetingLocal = graphDatetimeToLocal(startRaw);
    const dateOnly = meetingLocal.slice(0, 10);
    if (dateOnly < startDate || dateOnly > endDate) continue;

    const endRaw = event.end?.dateTime || '';
    let durationMinutes = 60;
    if (startRaw && endRaw) {
      try {
        const startDt = new Date(startRaw.replace('Z', '+00:00'));
        const endDt = new Date(endRaw.replace('Z', '+00:00'));
        durationMinutes = Math.max(1, Math.round((endDt.getTime() - startDt.getTime()) / 60000));
      } catch { /* default 60 */ }
    }

    const bodyObj = event.body || {};
    let bodyContent = bodyObj.content || '';
    if ((bodyObj.contentType || '').toLowerCase() === 'html') {
      bodyContent = htmlToPlainText(bodyContent);
    }

    const externalId = event.iCalUId || event.seriesMasterId || '';

    items.push({
      type: 'meeting',
      subject: event.subject || '',
      body: bodyContent.slice(0, 5000),
      date: meetingLocal,
      duration_minutes: durationMinutes,
      external_id: externalId,
    });
  }

  if (onProgress) {
    onProgress(scanned, scanned, `Found ${items.length} meetings in date range`);
  }

  return items;
}

export function isOutlookConfigured(): boolean {
  return !!getClientId();
}
