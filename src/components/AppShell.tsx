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
  const { connected, outlookConnected, checking } = useConnection();
  if (checking) {
    return <span className="conn-chip off"><span className="dot"></span> Checking...</span>;
  }
  if (!connected && !outlookConnected) {
    return <span className="conn-chip off"><span className="dot"></span> Not connected</span>;
  }
  const parts: string[] = [];
  if (connected) parts.push('Jira');
  if (outlookConnected) parts.push('Outlook');
  return <span className="conn-chip green"><span className="dot"></span> Connected to {parts.join(' & ')}</span>;
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
      <BottomStatus />
    </div>
  );
}

// ============== Bottom status bar ==============

function BottomStatus() {
  const { connected, outlookConnected, checking } = useConnection();
  const parts: string[] = [];
  if (connected) parts.push('Jira');
  if (outlookConnected) parts.push('Outlook');
  return (
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0,
      background: 'var(--navy)', color: '#fff',
      padding: '6px 28px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8,
      zIndex: 100,
    }}>
      {checking ? (
        <><span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--slate-400)', display: 'inline-block' }}></span> Checking...</>
      ) : parts.length === 0 ? (
        <><span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--slate-400)', display: 'inline-block' }}></span> Not connected</>
      ) : (
        <><span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--success-400)', display: 'inline-block' }}></span> Connected to {parts.join(' & ')}</>
      )}
    </div>
  );
}

// ============== Get Started / Connect screen ==============

function GetStarted({ onSuccess, setConnecting }: { onSuccess: () => Promise<void>; setConnecting: (v: boolean) => void }) {
  const router = useRouter();
  const { outlookConnected, refreshOutlook } = useConnection();
  const [pat, setPat] = useState('');
  const [showPat, setShowPat] = useState(false);
  const [outlookSkipped, setOutlookSkipped] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
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
      setMsg({ ok: true, text: 'Connected to Jira.' });
      setConnecting(true);
      await onSuccess();
      // Redirect to review page
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
            {/* Server URL - editable, pre-filled with UCSD default */}
            <label className="field-label" htmlFor="cUrl">Jira server address</label>
            <p style={{ color: 'var(--slate-500)', fontSize: 13.5, marginBottom: 8 }}>
              Pre-filled with the UCSD Jira server. Change it only if you use a different Jira instance.
            </p>
            <div style={{ position: 'relative', marginBottom: 18 }}>
              <input
                id="cUrl"
                className="input"
                
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="https://its-pro.ucsd.edu"
                autoComplete="off"
                spellCheck={false}
              />
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
              {outlookConnected || outlookSkipped ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {outlookConnected ? (
                    <>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--success-400)', display: 'inline-block' }}></span>
                      <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--success-600)' }}>Successfully connected to Outlook</span>
                    </>
                  ) : (
                    <span style={{ fontSize: 13, color: 'var(--slate-400)' }}>Outlook skipped ? you can connect it later in Settings.</span>
                  )}
                </div>
              ) : (
                <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--navy)' }}>Connect Outlook (optional)</span>
                <span style={{ fontSize: 13, color: 'var(--slate-400)' }}>Auto-import your calendar meetings</span>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => { window.location.href = '/api/outlook/auth/start'; }}
                >
                  Connect Outlook
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  style={{ textTransform: 'none', letterSpacing: 0 }}
                  onClick={() => { if (pat) { finishConnect(); } else { setOutlookSkipped(true); } }}
                >
                  Skip for now
                </button>
                </div>
              </>
              )}
            </div>

            <div style={{ marginTop: 22, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <button className="btn btn-navy btn-lg" onClick={finishConnect} disabled={testing || !pat}>
                {testing ? 'Testing...' : 'Test & Connect'}
              </button>
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
      <BottomStatus />
    </div>
  );
}