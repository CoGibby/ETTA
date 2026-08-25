'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useConnection } from '@/lib/connection-context';
import { useSharedData } from '@/lib/data-context';
import { cleanJiraUrl, DEFAULT_JIRA_URL } from '@/components/AppShell';

interface Keyword {
  id: number;
  word: string;
  frequency: number;
  source_type: string;
  assigned_projects: { id: number; name: string }[];
  assigned_task_types: { id: number; name: string }[];
}
interface Route {
  id: number;
  project_id: number | null;
  task_type_id: number | null;
  source_type: string | null;
  jira_key: string;
  jira_name: string;
  project_name: string | null;
  task_type_name: string | null;
}

export default function SettingsPage() {
  const router = useRouter();
  const { jiraUrl, email, refresh } = useConnection();
  const { projects, taskTypes, refreshAll } = useSharedData();
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [automateOpen, setAutomateOpen] = useState(true);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetText, setResetText] = useState('');
  const [resetDone, setResetDone] = useState(false);
  const [showServerEdit, setShowServerEdit] = useState(false);
  const [serverInput, setServerInput] = useState('');
  const [serverSaved, setServerSaved] = useState(false);
  const [showUnassigned, setShowUnassigned] = useState(false);

  const fetchRules = useCallback(async () => {
    try {
      const [kwRes, rtRes] = await Promise.all([fetch('/api/keywords'), fetch('/api/routes')]);
      const kwData = await kwRes.json();
      const rtData = await rtRes.json();
      setKeywords(kwData.keywords || []);
      setRoutes(rtData.routes || []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchRules(); }, [fetchRules]);

  // Split keywords into assigned and unassigned
  const { assignedKeywords, unassignedKeywords } = useMemo(() => {
    const assigned: Keyword[] = [];
    const unassigned: Keyword[] = [];
    for (const kw of keywords) {
      if (kw.assigned_projects.length > 0 || kw.assigned_task_types.length > 0) {
        assigned.push(kw);
      } else {
        unassigned.push(kw);
      }
    }
    return { assignedKeywords: assigned, unassignedKeywords: unassigned };
  }, [keywords]);

  const removeKeyword = async (id: number) => {
    await fetch(`/api/keywords/${id}`, { method: 'DELETE' });
    fetchRules();
  };
  const removeRoute = async (id: number) => {
    await fetch(`/api/routes/${id}`, { method: 'DELETE' });
    fetchRules();
  };

  const disconnectJira = async () => {
    await fetch('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jira_url: '', jira_pat: '' }),
    });
    await refresh();
    router.push('/');
  };

  const saveServerUrl = async () => {
    const cleaned = cleanJiraUrl(serverInput);
    if (!cleaned) return;
    await fetch('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jira_url: cleaned }),
    });
    await refresh();
    setShowServerEdit(false);
    setServerSaved(true);
    setTimeout(() => setServerSaved(false), 3000);
  };

  const doReset = async () => {
    await fetch('/api/reset-entries', { method: 'DELETE' });
    setResetDone(true);
    setResetText('');
    setTimeout(() => { setResetOpen(false); setResetDone(false); }, 2500);
  };

  const host = jiraUrl ? jiraUrl.replace(/^https?:\/\//, '').replace(/\/$/, '') : null;

  // Keywords to show: assigned always, unassigned only if toggled (limit to top 20 by frequency)
  const visibleKeywords = showUnassigned
    ? [...assignedKeywords, ...unassignedKeywords.slice(0, 20)]
    : assignedKeywords;

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <h2 style={{ fontSize: 24, fontWeight: 700, color: 'var(--navy)', marginBottom: 20 }}>Settings</h2>

      {/* Automate (collapsible, first, expanded) */}
      <div className={'collapse-entry' + (automateOpen ? ' open' : '')}>
        <div className="collapse-head" onClick={() => setAutomateOpen(!automateOpen)}>
          <div>
            <div className="collapse-title">Automate</div>
            <div className="collapse-summary">Set rules so ETTA codes your recurring work automatically - less manual entry each day.</div>
          </div>
          <span className="collapse-arrow">{'>'}</span>
        </div>
        <div className="collapse-body">
          {/* Match by keyword */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 8, marginTop: 8 }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--navy)' }}>Match by keyword</h3>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ minWidth: 560 }}>
              <thead><tr><th style={{ width: '30%' }}>Keyword</th><th>Assigned to</th><th>Matched</th><th></th></tr></thead>
              <tbody>
                {visibleKeywords.length === 0 && (
                  <tr><td colSpan={4} style={{ color: 'var(--slate-400)' }}>No keywords assigned yet. ETTA extracts keywords from your imported calendar and email - assign them to projects to automate coding.</td></tr>
                )}
                {visibleKeywords.map((kw) => {
                  const assign = [...kw.assigned_projects, ...kw.assigned_task_types].map((a) => a.name).join(', ') || 'Unassigned';
                  const isAssigned = kw.assigned_projects.length > 0 || kw.assigned_task_types.length > 0;
                  return (
                    <tr key={kw.id}>
                      <td style={{ fontWeight: 600 }}>{kw.word}</td>
                      <td>{isAssigned ? assign : <span style={{ color: 'var(--slate-400)' }}>Unassigned</span>}</td>
                      <td><span className={'status-pill ' + (isAssigned ? 'sp-green' : 'sp-gray')}>{kw.frequency}x</span></td>
                      <td style={{ textAlign: 'right' }}><button className="btn btn-secondary btn-sm" onClick={() => removeKeyword(kw.id)}>Remove</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {/* Unassigned keyword summary */}
          {unassignedKeywords.length > 0 && (
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: 'var(--slate-500)' }}>
                ETTA found <b>{unassignedKeywords.length}</b> unassigned keyword{unassignedKeywords.length === 1 ? '' : 's'} from your calendar and email.
              </span>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowUnassigned(!showUnassigned)}>
                {showUnassigned ? 'Hide unassigned' : 'Show unassigned'}
              </button>
            </div>
          )}
          {showUnassigned && unassignedKeywords.length > 20 && (
            <div style={{ fontSize: 12.5, color: 'var(--slate-400)', marginTop: 6 }}>Showing top 20 by frequency. The rest are available once you assign these.</div>
          )}
          <div style={{ fontSize: 13, color: 'var(--slate-400)', marginTop: 10 }}>Keywords are auto-extracted from your calendar and email. Assign them to projects above to automate coding.</div>

          {/* Recurring rules */}
          <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 8 }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--navy)' }}>Recurring rules</h3>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ minWidth: 600 }}>
              <thead><tr><th>Rule</th><th>Jira code</th><th>Source</th><th></th></tr></thead>
              <tbody>
                {routes.length === 0 && (
                  <tr><td colSpan={4} style={{ color: 'var(--slate-400)' }}>No recurring rules yet.</td></tr>
                )}
                {routes.map((rt) => (
                  <tr key={rt.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{[rt.project_name, rt.task_type_name].filter(Boolean).join(' - ') || 'General'}</div>
                    </td>
                    <td><span className="issue-key">{rt.jira_key}</span></td>
                    <td>{rt.source_type ? (rt.source_type === 'email' ? 'Email' : 'Meeting') : 'Any'}</td>
                    <td style={{ textAlign: 'right' }}><button className="btn btn-secondary btn-sm" onClick={() => removeRoute(rt.id)}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Jira */}
      <div className="card" style={{ padding: '18px 20px', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--navy)' }}>Jira</h3>
            <div style={{ fontSize: 13, color: 'var(--slate-500)' }}>{host || 'Not configured'}{email ? ' - ' + email : ''}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="status-pill sp-green">Connected</span>
            <button className="btn btn-secondary btn-sm" onClick={disconnectJira}>Disconnect</button>
          </div>
        </div>
        <div style={{ marginTop: 10 }}>
          {!showServerEdit ? (
            <button className="btn btn-secondary btn-sm" onClick={() => { setShowServerEdit(true); setServerInput(jiraUrl || DEFAULT_JIRA_URL); }}>
              Change server
            </button>
          ) : (
            <div style={{ borderTop: '1px solid var(--slate-200)', paddingTop: 12 }}>
              <label className="field-label">Jira server address</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <input
                  className="input"
                  value={serverInput}
                  onChange={(e) => setServerInput(e.target.value)}
                  placeholder="https://its-pro.ucsd.edu"
                  style={{ flex: 1, minWidth: 240 }}
                />
                <button className="btn btn-navy btn-sm" onClick={saveServerUrl}>Save</button>
                <button className="btn btn-secondary btn-sm" onClick={() => setShowServerEdit(false)}>Cancel</button>
              </div>
              <div className="field-hint">
                ETTA will use: <b style={{ fontFamily: 'ui-monospace,Consolas,monospace', fontSize: 12.5 }}>{cleanJiraUrl(serverInput) || '--'}</b>
              </div>
            </div>
          )}
          {serverSaved && <div style={{ fontSize: 13, color: 'var(--success-600)', marginTop: 6 }}>Server updated.</div>}
        </div>
      </div>

      {/* Outlook */}
      <div className="card" style={{ padding: '18px 20px', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--navy)' }}>Outlook</h3>
            <div style={{ fontSize: 13, color: 'var(--slate-500)' }}>UCSD calendar &amp; mailbox</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="status-pill sp-gray">Coming soon</span>
            <button className="btn btn-secondary btn-sm" onClick={() => alert('Outlook integration arrives in the next step.')}>Connect Outlook</button>
          </div>
        </div>
      </div>

      {/* Reset */}
      <div className="card" style={{ padding: '18px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--navy)' }}>Reset entries</h3>
          {!resetOpen && <button className="btn btn-danger btn-sm" onClick={() => setResetOpen(true)}>Reset entries...</button>}
        </div>
        {resetOpen && (
          <div style={{ marginTop: 14 }}>
            <p style={{ fontSize: 13, color: 'var(--slate-500)', marginBottom: 10 }}>
              This clears all entries stored on this computer. Already-pushed time in Jira is unaffected. Type <b>RESET</b> to confirm.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input className="input" placeholder="Type RESET" autoComplete="off" style={{ maxWidth: 200 }}
                value={resetText} onChange={(e) => setResetText(e.target.value)} />
              <button className="btn btn-danger btn-sm" disabled={resetText.trim().toUpperCase() !== 'RESET'} onClick={doReset}>Confirm reset</button>
              <button className="btn btn-secondary btn-sm" onClick={() => { setResetOpen(false); setResetText(''); }}>Cancel</button>
            </div>
            {resetDone && <div aria-live="polite" style={{ marginTop: 10, fontSize: 13, color: 'var(--success-600)' }}>Done. Local entries cleared - nothing in Jira was changed.</div>}
          </div>
        )}
      </div>
    </div>
  );
}