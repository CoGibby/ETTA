'use client';

import { ReactNode, useState, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useConnection } from '@/lib/connection-context';

/**
 * Default Jira server for UCSD ITS.
 * Pre-seeded in the database (db.ts) so every user shares the same server.
 * The PAT is what makes each user unique, not the URL.
 */
const DEFAULT_JIRA_URL = 'https://its-pro.ucsd.edu';

function ConnChip() {
  const { connected, email, jiraUrl, checking } = useConnection();
  if (checking) {
    return <span className="conn-chip off"><span className="dot"></span> Checking...</span>;
  }
  if (!connected) {
    return <span className="conn-chip off"><span className="dot"></span> Not connected</span>;
  }
  const host = jiraUrl ? jiraUrl.replace(/^https?:\/\//, '').replace(/\/$/, '') : 'Jira';
  return <span className="conn-chip green"><span className="dot"></span> Connected to {host} as {email}</span>;
}

/**
 * Extract just the protocol + host from any URL the user might paste.
 * Used in Settings for the rare case someone needs to change the server.
 */
export function cleanJiraUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const u = new URL(trimmed);
    return u.origin;
  } catch {
    return trimmed;
  }
}

export { DEFAULT_JIRA_URL };

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { connected, checking, refresh, setConnecting } = useConnection();
  const [showConnect, setShowConnect] = useState(false);

  const onboarding = !connected && !checking;

  const tabs = [
    { href: '/', label: connected ? 'Review' : 'Get started' },
    { href: '/metrics', label: 'Metrics' },
  ] as const;

  const settingsActive = pathname === '/settings';

  const handleLockedNav = (e: React.MouseEvent) => {
    if (!connected) {
      e.preventDefault();
      setShowConnect(true);
    }
  };

  return (
    <div style={{ background: '#E9EEF3', minHeight: '100vh' }}>
      <div className="apptop">
        <div className="apptop-in">
          <span className="logo">ETTA <small>{'\u00b7'} Time Tracker</small></span>
          <nav>
            {tabs.map((tab) => {
              const isActive = tab.href === '/' ? (onboarding || pathname === '/') : pathname === tab.href;
              const locked = !connected && tab.href !== '/';
              if (locked) {
                return (
                  <a key={tab.href} className="locked" title="Connect Jira first" onClick={handleLockedNav}>{tab.label}</a>
                );
              }
              return (
                <Link key={tab.href} href={tab.href} className={isActive ? 'active' : ''}>{tab.label}</Link>
              );
            })}
          </nav>
          <div className="right">
            <ConnChip />
            {(() => {
              const locked = !connected;
              if (locked) {
                return <a className="navlink locked" title="Connect Jira first" onClick={handleLockedNav}>Settings</a>;
              }
              return <Link href="/settings" className={settingsActive ? 'navlink active' : 'navlink'}>Settings</Link>;
            })()}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1240, margin: '20px auto 60px', padding: '0 28px' }}>
        <div className="etta-frame">
          <div className="etta-frame-body">
            {onboarding ? (
              <GetStarted onSuccess={refresh} setConnecting={setConnecting} />
            ) : (
              children
            )}
          </div>
        </div>
      </div>

      {showConnect && (
        <div className="modal-overlay" role="dialog" aria-modal="true" onClick={(e) => { if (e.target === e.currentTarget) setShowConnect(false); }}>
          <div className="modal" style={{ maxWidth: 380 }}>
            <h3>Connect Jira first</h3>
            <p>Set up your Jira connection to unlock Review, Metrics, and Settings.</p>
            <div className="actions">
              <button className="btn btn-secondary" onClick={() => setShowConnect(false)}>Cancel</button>
              <button className="btn btn-navy" onClick={() => { setShowConnect(false); router.push('/'); }}>Set up</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============== Get Started / Connect screen ==============

function GetStarted({ onSuccess, setConnecting }: { onSuccess: () => Promise<void>; setConnecting: (v: boolean) => void }) {
  const router = useRouter();
  const [pat, setPat] = useState('');
  const [showPat, setShowPat] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [outlookConnected, setOutlookConnected] = useState(false);
  const [serverUrl, setServerUrl] = useState(DEFAULT_JIRA_URL);

  // Load the server URL from settings (seeded in the database)
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/settings');
        const data = await res.json();
        const saved = data.settings?.jira_url;
        if (saved) setServerUrl(cleanJiraUrl(saved));
      } catch {
        // Fall back to default
      }
    })();
  }, []);

  const finishConnect = useCallback(async () => {
    setTesting(true);
    setMsg(null);
    try {
      const testRes = await fetch('/api/jira/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: serverUrl, pat }),
      });
      const testData = await testRes.json();
      if (!testData.success) {
        const errText = testData.error || testData.message || 'Could not connect. Check your token.';
        setMsg({ ok: false, text: errText });
        setTesting(false);
        return;
      }
      // Save credentials
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jira_url: serverUrl, jira_pat: pat }),
      });
      setMsg({ ok: true, text: 'Connected. Taking you to Review...' });
      setConnecting(true);
      await onSuccess();
      setTimeout(() => router.push('/'), 600);
    } catch {
      setMsg({ ok: false, text: 'Network error. Please try again.' });
    } finally {
      setTesting(false);
    }
  }, [serverUrl, pat, router, onSuccess, setConnecting]);

  const serverHost = serverUrl.replace(/^https?:\/\//, '');

  return (
    <div style={{ maxWidth: 980, margin: '0 auto' }}>
      <div style={{ textAlign: 'center', padding: '14px 0 22px' }}>
        <h2 style={{ fontSize: 24, fontWeight: 700, color: 'var(--navy)' }}>Set up ETTA once</h2>
        <p style={{ color: 'var(--slate-500)', fontSize: 15, maxWidth: 560, margin: '10px auto 0' }}>
          ETTA turns your calendar and email into Jira time entries. About 2 minutes to set up.
        </p>
      </div>
      <div className="card" style={{ padding: 24 }}>
        <div style={{ maxWidth: 480, margin: '0 auto' }}>
          <div>
            {/* Server info - read-only, not an input */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              background: 'var(--slate-100)', border: '1px solid var(--slate-200)',
              borderRadius: 10, padding: '12px 14px', marginBottom: 18,
            }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 32, height: 32, borderRadius: 8, background: 'var(--blue-50)',
                color: 'var(--blue-600)', fontSize: 15, fontWeight: 700, flexShrink: 0,
              }}>J</span>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--navy)' }}>Connecting to {serverHost}</div>
                <div style={{ fontSize: 12.5, color: 'var(--slate-500)' }}>
                  UCSD Jira server - need a different one? Change it in Settings after connecting.
                </div>
              </div>
            </div>

            <label className="field-label" htmlFor="cPat">Your Jira token</label>
            <p style={{ color: 'var(--slate-500)', fontSize: 13.5, marginBottom: 8 }}>
              Get one in Jira: <b>Profile {'\u2192'} Personal Access Tokens</b> {'\u2192'} Create, then copy it.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ position: 'relative', flex: 1, minWidth: 240 }}>
                <input
                  type={showPat ? 'text' : 'password'}
                  id="cPat"
                  className="input"
                  style={{ paddingRight: 48 }}
                  value={pat}
                  onChange={(e) => setPat(e.target.value)}
                  placeholder="Paste your Personal Access Token"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  onClick={() => setShowPat(!showPat)}
                  style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--slate-400)', fontSize: 13, fontWeight: 600 }}
                >
                  {showPat ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>

            <div style={{ marginTop: 20, paddingTop: 18, borderTop: '1px solid var(--slate-200)' }}>
              <label className="field-label" htmlFor="cOutlook">Connect Outlook</label>
              <p style={{ color: 'var(--slate-500)', fontSize: 13.5, marginBottom: 8 }}>
                Fills your weekly calendar from your UCSD Outlook (non-private events only).
              </p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  className="btn btn-secondary"
                  onClick={() => { setOutlookConnected(true); alert('Outlook connection will be available in the next step.'); }}
                >
                  {outlookConnected ? 'Reconnect Outlook' : 'Connect Outlook'}
                </button>
                <span className="status-pill sp-gray">{outlookConnected ? 'Connected' : 'Not connected'}</span>
              </div>
            </div>

            <div style={{ marginTop: 22, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <button className="btn btn-navy btn-lg" onClick={finishConnect} disabled={testing || !pat}>
                {testing ? 'Testing...' : 'Test & Connect'}
              </button>
              <span style={{ color: 'var(--slate-500)', fontSize: 13 }}>Tests, saves, and opens Review.</span>
            </div>
            {msg && (
              <div
                aria-live="polite"
                style={{
                  marginTop: 16,
                  borderRadius: 12,
                  padding: '12px 14px',
                  fontSize: 13.5,
                  background: msg.ok ? 'var(--success-50)' : 'var(--danger-50)',
                  border: `1px solid ${msg.ok ? '#bfe5cd' : '#f2c2bf'}`,
                  color: msg.ok ? 'var(--success-600)' : 'var(--danger-600)',
                }}
              >
                {msg.ok ? <b>Connected. </b> : <b>Could not connect. </b>}{msg.text}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}