import { getSetting } from './db';

export interface JiraCredentials {
  baseUrl: string;
  token: string;
}

export interface JiraUser {
  name: string;
  displayName?: string;
}

export interface WorklogInput {
  issueKey: string;
  timeSpentMinutes: number;
  startedDate: string; // YYYY-MM-DD
  comment?: string;
}

export interface WorklogResult {
  success: boolean;
  worklogId?: string;
  error?: string;
}

/**
 * Get Jira credentials from settings
 */
export function getJiraCredentials(): JiraCredentials | null {
  const baseUrl = getSetting('jira_url');
  const token = getSetting('jira_pat');

  if (!baseUrl || !token) {
    return null;
  }

  return { baseUrl, token };
}

/**
 * Translate a raw fetch/network error into a user-friendly message.
 */
function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return 'Unknown error.';
  const cause = (error as Error & { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code || '';
  const msg = error.message || '';

  if (code === 'ENOTFOUND' || msg.includes('getaddrinfo')) {
    return 'Could not reach that address. Check the URL for typos Ã¢â‚¬â€ it should look like https://its-pro.ucsd.edu (no trailing slash).';
  }
  if (code === 'ECONNREFUSED') {
    return 'The server refused the connection. Verify the URL is correct and that you are on the UCSD network or VPN.';
  }
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || msg.includes('timeout')) {
    return 'The connection timed out. The server may be slow or unreachable. Try again, or check your network/VPN connection.';
  }
  if (code === 'CERT_HAS_EXPIRED' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || msg.includes('certificate') || msg.includes('CERT')) {
    return 'The server certificate could not be verified. Contact your Jira administrator if this persists.';
  }
  if (msg === 'fetch failed') {
    return 'Could not connect to that address. Check the URL, make sure you are on the UCSD network or VPN, and try again.';
  }
  return msg;
}

/**
 * Test Jira connection using the session endpoint
 */
export async function testJiraConnection(baseUrl: string, token: string): Promise<{
  success: boolean;
  message: string;
}> {
  try {
    // Ensure baseUrl doesn't end with a slash
    const cleanBaseUrl = baseUrl.replace(/\/$/, '');
    const apiUrl = `${cleanBaseUrl}/rest/auth/1/session`;

    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });

    const contentType = response.headers.get('content-type') || '';

    if (response.status === 404) {
      return {
        success: false,
        message: 'That address does not have a Jira API. Check that you entered the Jira base URL (e.g. https://its-pro.ucsd.edu), not a Tempo or dashboard link.',
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        success: false,
        message: 'Your Personal Access Token was rejected. Double-check the token Ã¢â‚¬â€ it must be a Jira Personal Access Token, not your Jira password.',
      };
    }

    if (response.ok) {
      if (!contentType.includes('application/json')) {
        return {
          success: false,
          message: 'The server returned an HTML page instead of a Jira API response. Check that your address is the Jira base URL (e.g. https://its-pro.ucsd.edu), not a Tempo or dashboard link.',
        };
      }
      return {
        success: true,
        message: 'Successfully connected to Jira',
      };
    }

    return {
      success: false,
      message: `Failed to connect: ${response.statusText}`,
    };
  } catch (error) {
    return {
      success: false,
      message: describeFetchError(error),
    };
  }
}

/**
 * Validate a Jira issue key and return its summary
 */
export async function validateJiraIssue(creds: JiraCredentials, issueKey: string): Promise<{
  valid: boolean;
  jiraName?: string;
  error?: string;
}> {
  try {
    const cleanBaseUrl = creds.baseUrl.replace(/\/$/, '');
    const apiUrl = `${cleanBaseUrl}/rest/api/2/issue/${issueKey}?fields=summary`;

    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${creds.token}`,
        'Accept': 'application/json',
      },
    });

    const contentType = response.headers.get('content-type') || '';

    if (response.ok) {
      if (!contentType.includes('application/json')) {
        return {
          valid: false,
          error: 'The server returned an HTML page instead of Jira data. Check that your Jira address is the base server URL (e.g. https://its-pro.ucsd.edu), not a Tempo or dashboard link.',
        };
      }
      try {
        const data = await response.json();
        const issueTypeName = (data.fields?.issuetype?.name || '').toLowerCase();
        if (issueTypeName === 'epic' || issueTypeName === 'milestone' || issueTypeName === 'requirement') {
          return {
            valid: false,
            error: `Time cannot be logged to ${issueTypeName}s. Choose a task, bug, or story instead.`,
          };
        }
        return {
          valid: true,
          jiraName: data.fields?.summary || 'Unknown Issue',
        };
      } catch {
        return {
          valid: false,
          error: 'Could not parse the response from Jira. Check that your Jira address is correct.',
        };
      }
    }

    // Try to get detailed error message from response
    let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
    if (contentType.includes('application/json')) {
      try {
        const errorData = await response.json();
        if (errorData.errorMessages?.length > 0) {
          errorMessage = errorData.errorMessages.join(', ');
        } else if (errorData.message) {
          errorMessage = errorData.message;
        }
      } catch {
        // Keep default error message
      }
    }

    if (response.status === 404) {
      return {
        valid: false,
        error: `Issue ${issueKey} was not found. Check the key and try again.`,
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        valid: false,
        error: 'Your Jira token does not have permission to view issues. Check your Personal Access Token in Settings.',
      };
    }

    return {
      valid: false,
      error: errorMessage,
    };
  } catch (error) {
    return {
      valid: false,
      error: describeFetchError(error),
    };
  }
}

/**
 * Add a worklog entry to a Jira issue
 */
export async function addWorklog(
  creds: JiraCredentials,
  input: WorklogInput
): Promise<WorklogResult> {
  try {
    // Ensure baseUrl doesn't end with a slash
    const cleanBaseUrl = creds.baseUrl.replace(/\/$/, '');
    const apiUrl = `${cleanBaseUrl}/rest/api/2/issue/${input.issueKey}/worklog`;

    // Format started time as ISO datetime
    const startedDateTime = `${input.startedDate}T09:00:00.000+0000`;

    // Convert minutes to Jira format (e.g., "1h 30m")
    const hours = Math.floor(input.timeSpentMinutes / 60);
    const minutes = input.timeSpentMinutes % 60;
    let timeSpent = '';
    if (hours > 0) timeSpent += `${hours}h `;
    if (minutes > 0) timeSpent += `${minutes}m`;
    if (!timeSpent) timeSpent = '0m';

    const body: Record<string, unknown> = {
      timeSpent: timeSpent.trim(),
      started: startedDateTime,
    };

    if (input.comment) {
      body.comment = input.comment;
    }

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${creds.token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (response.ok) {
      let responseData;
      const responseText = await response.text();
      try {
        responseData = responseText ? JSON.parse(responseText) : null;
      } catch {
        // Response wasn't JSON but request succeeded
      }
      return {
        success: true,
        worklogId: responseData?.id?.toString(),
      };
    }

    // Handle specific error cases
    if (response.status === 404) {
      return {
        success: false,
        error: 'Issue not found. Please check the issue key.',
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        success: false,
        error: 'Authentication failed. Please check your Personal Access Token.',
      };
    }

    // Try to parse error response
    let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
    try {
      const errorData = await response.json();
      if (errorData.errorMessages?.length > 0) {
        errorMessage = errorData.errorMessages.join(', ');
      } else if (errorData.message) {
        errorMessage = errorData.message;
      }
    } catch {
      // Keep default error message
    }

    return {
      success: false,
      error: errorMessage,
    };
  } catch (error) {
    return {
      success: false,
      error: describeFetchError(error),
    };
  }
}

/**
 * Fetch Jira favorites from Tempo Core API
 */
export async function fetchJiraFavorites(creds: JiraCredentials): Promise<{
  success: boolean;
  favorites?: { jiraKey: string; jiraName: string }[];
  error?: string;
}> {
  try {
    const cleanBaseUrl = creds.baseUrl.replace(/\/$/, '');

    // First request: Get favorite issue keys from Tempo Core
    const favoritesUrl = `${cleanBaseUrl}/rest/tempo-core/1/favorites/issue/`;
    const favoritesResponse = await fetch(favoritesUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${creds.token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });

    if (!favoritesResponse.ok) {
      if (favoritesResponse.status === 401 || favoritesResponse.status === 403) {
        return { success: false, error: 'Authentication failed. Please check your credentials.' };
      }
      return { success: false, error: `Failed to fetch favorites: ${favoritesResponse.statusText}` };
    }

    const favoriteKeys = await favoritesResponse.json();

    if (!favoriteKeys || !Array.isArray(favoriteKeys) || favoriteKeys.length === 0) {
      return { success: true, favorites: [] };
    }

    // Second request: Get issue details for favorites
    const searchUrl = `${cleanBaseUrl}/rest/api/2/search`;
    const searchResponse = await fetch(searchUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${creds.token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        jql: `issue in (${favoriteKeys.map((key: string) => `"${key}"`).join(', ')})`,
        fields: ['summary'],
        maxResults: 200,
      }),
    });

    if (!searchResponse.ok) {
      return { success: false, error: `Failed to fetch issue details: ${searchResponse.statusText}` };
    }

    const searchData = await searchResponse.json();
    const issues = searchData.issues || [];

    const favorites = issues.map((issue: { key: string; fields: { summary: string } }) => ({
      jiraKey: issue.key,
      jiraName: issue.fields.summary,
    }));

    return { success: true, favorites };
  } catch (error) {
    return {
      success: false,
      error: describeFetchError(error),
    };
  }
}

/**
 * Push multiple worklogs with rate limiting
 */
export async function pushWorklogs(
  creds: JiraCredentials,
  worklogs: WorklogInput[]
): Promise<{
  success: boolean;
  results: { input: WorklogInput; result: WorklogResult }[];
  pushed: number;
  failed: number;
}> {
  const results: { input: WorklogInput; result: WorklogResult }[] = [];
  let pushed = 0;
  let failed = 0;

  for (const worklog of worklogs) {
    const result = await addWorklog(creds, worklog);
    results.push({ input: worklog, result });

    if (result.success) {
      pushed++;
    } else {
      failed++;
    }

    // Rate limit: 50ms between requests
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return {
    success: failed === 0,
    results,
    pushed,
    failed,
  };
}
/**
 * Search Jira issues by key or summary using JQL.
 * Returns all matching issues for autocomplete.
 */
export async function searchJiraIssues(creds: JiraCredentials, query: string): Promise<{
  success: boolean;
  issues?: { key: string; summary: string; updated?: string; timeestimate?: number }[];
  error?: string;
}> {
  try {
    const cleanBaseUrl = creds.baseUrl.replace(/\/$/, '');
    const safeQuery = query.replace(/"/g, '\"');

    const headers = {
      'Authorization': `Bearer ${creds.token}`,
      'Accept': 'application/json',
    };

    // Step 1: Collect candidate keys from two sources in parallel:
    //   a) Issue picker API Ã¢â‚¬â€ partial key matching (e.g. "ett" finds ETTA-34)
    //   b) JQL summary search Ã¢â‚¬â€ text matching (e.g. "TIM" finds issues mentioning TIM)
    const pickerUrl = `${cleanBaseUrl}/rest/api/2/issue/picker?query=${encodeURIComponent(query)}&showSubTasks=true&showSubTaskParent=true`;
    const jql = `summary ~ "${safeQuery}*" ORDER BY updated DESC`;
    const searchUrl = `${cleanBaseUrl}/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=100&fields=summary,updated,issuetype,status`;
    const textJql = `text ~ "${safeQuery}" ORDER BY updated DESC`;
    const textUrl = `${cleanBaseUrl}/rest/api/2/search?jql=${encodeURIComponent(textJql)}&maxResults=100&fields=summary,updated,issuetype,status`;

    const [pickerRes, searchRes, textRes] = await Promise.allSettled([
      fetch(pickerUrl, { method: 'GET', headers }),
      fetch(searchUrl, { method: 'GET', headers }),
      fetch(textUrl, { method: 'GET', headers }),
    ]);

    const candidateKeys = new Set<string>();

    // Collect keys from picker
    if (pickerRes.status === 'fulfilled' && pickerRes.value.ok) {
      const ct = pickerRes.value.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        const data = await pickerRes.value.json();
        const sections = data.sections || [];
        for (const section of sections) {
          for (const issue of (section.issues || [])) {
            if (issue.key) candidateKeys.add(issue.key);
          }
        }
      }
    }

    // Collect keys from JQL summary search
    if (searchRes.status === 'fulfilled' && searchRes.value.ok) {
      const ct = searchRes.value.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        const data = await searchRes.value.json();
        for (const issue of (data.issues || [])) {
          if (issue.key) candidateKeys.add(issue.key);
        }
      }
    }

    // Collect keys from full-text search (matches summary, description, and comments)
    if (textRes.status === 'fulfilled' && textRes.value.ok) {
      const ct = textRes.value.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        const data = await textRes.value.json();
        for (const issue of (data.issues || [])) {
          if (issue.key) candidateKeys.add(issue.key);
        }
      }
    }

    if (candidateKeys.size === 0) {
      return { success: true, issues: [] };
    }

    // Step 2: Batch-fetch full issue details (including issuetype) for ALL candidate keys.
    // This is the critical step Ã¢â‚¬â€ every result goes through a JQL query that returns
    // issuetype, so epics and milestones can NEVER appear in the final results.
    // Keys are batched in groups of 40 to avoid URL length limits on Jira Server.
    const allKeys = Array.from(candidateKeys);
    const batches: string[][] = [];
    for (let i = 0; i < allKeys.length; i += 40) {
      batches.push(allKeys.slice(i, i + 40));
    }

    const verified: { key: string; summary: string; updated: string; timeestimate?: number }[] = [];
    for (const batch of batches) {
      try {
        const keyList = batch.join(',');
        const batchJql = `key in (${keyList}) ORDER BY updated DESC`;
        const batchUrl = `${cleanBaseUrl}/rest/api/2/search?jql=${encodeURIComponent(batchJql)}&maxResults=100&fields=summary,updated,issuetype,aggregatetimeestimate,timeestimate`;
        const batchRes = await fetch(batchUrl, { method: 'GET', headers });
        if (batchRes.ok) {
          const batchData = await batchRes.json();
          for (const issue of (batchData.issues || [])) {
            const issueType = (issue.fields?.issuetype?.name || '').toLowerCase();
            // Filter out epics and milestones Ã¢â‚¬â€ time cannot be logged to these
            if (issueType === 'epic' || issueType === 'milestone' || issueType === 'requirement') continue;
            verified.push({
              key: issue.key,
              summary: (issue.fields && issue.fields.summary) || issue.key,
              updated: (issue.fields && issue.fields.updated) || '',
              timeestimate: (issue.fields && (issue.fields.timeestimate ?? issue.fields.aggregatetimeestimate)) ?? 0,
            });
          }
        }
      } catch {
        // If a batch fails, skip those keys rather than showing unverified results
      }
    }

    // Step 3: Sort Ã¢â‚¬â€ key prefix matches first, then by updated date (newest first)
    const upperQuery = query.toUpperCase();
    const sorted = verified.sort((a, b) => {
      const aKeyMatch = a.key.toUpperCase().startsWith(upperQuery) ? 0 : 1;
      const bKeyMatch = b.key.toUpperCase().startsWith(upperQuery) ? 0 : 1;
      if (aKeyMatch !== bKeyMatch) return aKeyMatch - bKeyMatch;
      const aDate = a.updated || '';
      const bDate = b.updated || '';
      return bDate.localeCompare(aDate);
    });

    return { success: true, issues: sorted };
  } catch (error) {
    return {
      success: false,
      error: describeFetchError(error),
    };
  }
}
export async function updateJiraWorklog(
  creds: JiraCredentials,
  issueKey: string,
  worklogId: string,
  timeSpentMinutes: number,
  startedDate: string,
  comment?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const cleanBaseUrl = creds.baseUrl.replace(/\/$/, '');
    const apiUrl = `${cleanBaseUrl}/rest/api/2/issue/${issueKey}/worklog/${worklogId}`;
    const hours = Math.floor(timeSpentMinutes / 60);
    const minutes = timeSpentMinutes % 60;
    let timeSpent = '';
    if (hours > 0) timeSpent += `${hours}h `;
    if (minutes > 0) timeSpent += `${minutes}m`;
    if (!timeSpent) timeSpent = '0m';
    const body: Record<string, unknown> = {
      timeSpent: timeSpent.trim(),
      started: `${startedDate}T09:00:00.000+0000`,
    };
    if (comment) body.comment = comment;
    const response = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${creds.token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (response.ok) return { success: true };
    return { success: false, error: `Jira returned HTTP ${response.status}` };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Network error' };
  }
}
/**
 * Fetch total minutes already logged in Tempo Timesheets for a date range.
 * Used to prevent double-logging time that is already in Jira.
 */
export async function fetchTempoWorklogs(creds: JiraCredentials, dateFrom: string, dateTo: string): Promise<{
  success: boolean;
  username?: string;
  totalMinutes?: number;
  entries?: { issueKey: string; minutes: number; date: string; comment: string; worklogId?: string }[];
  error?: string;
}> {
  try {
    const cleanBaseUrl = creds.baseUrl.replace(/\/$/, '');

    // Get the current user's username (Jira Server uses username, not accountId)
    const userRes = await fetch(`${cleanBaseUrl}/rest/api/2/myself`, {
      headers: { 'Authorization': `Bearer ${creds.token}`, 'Accept': 'application/json' },
    });
    if (!userRes.ok) {
      return { success: false, error: 'Could not fetch Jira user info.' };
    }
    const userData = await userRes.json();
    const username = userData.name || userData.key || userData.accountId;
    if (!username) {
      return { success: false, error: 'Could not determine Jira user.' };
    }

    // Tempo Timesheets v3 API for Jira Server/DC
    const tempoUrl = `${cleanBaseUrl}/rest/tempo-timesheets/3/worklogs?username=${encodeURIComponent(username)}&dateFrom=${dateFrom}&dateTo=${dateTo}`;
    const tempoRes = await fetch(tempoUrl, {
      headers: { 'Authorization': `Bearer ${creds.token}`, 'Accept': 'application/json' },
    });

    const contentType = tempoRes.headers.get('content-type') || '';
    if (!tempoRes.ok) {
      return { success: false, error: `Tempo request failed: ${tempoRes.statusText}` };
    }
    if (!contentType.includes('application/json')) {
      return { success: false, error: 'Tempo returned an unexpected response.' };
    }

    interface TempoWorklogResponse {
      id?: number | string;
      worklogId?: number | string;
      tempoWorklogId?: number | string;
      timeSpentSeconds?: number;
      dateStarted?: string;
      startDate?: string;
      comment?: string;
      issue?: { key?: string };
      issueKey?: string;
    }

    const worklogs = (await tempoRes.json()) as TempoWorklogResponse[];
    const entries = (worklogs || []).map((worklog) => ({
      issueKey: worklog.issue?.key || worklog.issueKey || '',
      minutes: worklog.timeSpentSeconds ? Math.round(worklog.timeSpentSeconds / 60) : 0,
      date: worklog.dateStarted || worklog.startDate || '',
      comment: worklog.comment || '',
      worklogId: worklog.tempoWorklogId?.toString()
        || worklog.worklogId?.toString()
        || worklog.id?.toString(),
    }));

    const totalMinutes = entries.reduce((sum, entry) => sum + entry.minutes, 0);
    return { success: true, username, totalMinutes, entries };
  } catch (error) {
    return { success: false, error: describeFetchError(error) };
  }
}
/**
 * Validate all favorite issue keys against Jira in a single batch.
 * Returns keys that are ineligible (epic/milestone) or no longer exist in Jira.
 * Used to keep the favorites list clean as issues change type or get deleted.
 */
export async function validateFavorites(
  creds: JiraCredentials,
  keys: string[]
): Promise<{
  success: boolean;
  ineligible?: { key: string; reason: string }[];
  error?: string;
}> {
  if (keys.length === 0) return { success: true, ineligible: [] };
  try {
    const cleanBaseUrl = creds.baseUrl.replace(/\/$/, '');
    const keyList = keys.map((k) => k.toUpperCase()).join(',');
    const jql = `key in (${keyList})`;
    const url = `${cleanBaseUrl}/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=100&fields=summary,issuetype`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${creds.token}`, 'Accept': 'application/json' },
    });
    if (!res.ok) {
      return { success: false, error: `Jira request failed: ${res.statusText}` };
    }
    const data = await res.json();
    const foundKeys = new Set<string>();
    const ineligible: { key: string; reason: string }[] = [];
    for (const issue of (data.issues || [])) {
      foundKeys.add((issue.key || '').toUpperCase());
      const issueType = (issue.fields?.issuetype?.name || '').toLowerCase();
      if (issueType === 'epic' || issueType === 'milestone') {
        ineligible.push({ key: issue.key, reason: `This issue is a ${issueType} Ã¢â‚¬â€ time cannot be logged to it.` });
      }
    }
    // Any keys not found in the results were deleted or don't exist
    for (const k of keys) {
      const upper = k.toUpperCase();
      if (!foundKeys.has(upper)) {
        ineligible.push({ key: k, reason: 'This issue no longer exists in Jira.' });
      }
    }
    return { success: true, ineligible };
  } catch (error) {
    return { success: false, error: describeFetchError(error) };
  }
}
