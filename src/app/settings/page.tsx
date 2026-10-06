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
interface CalendarMapping {
  id: number;
  title: string;
  sourceType: string;
  jiraIssue: string;
  jiraName: string | null;
}

export default function SettingsPage() {
  const router = useRouter();
  const { connected, jiraUrl, email, refresh, refreshOutlook } = useConnection();
  const { projects, taskTypes, refreshAll } = useSharedData();
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [calendarMappings, setCalendarMappings] = useState<CalendarMapping[]>([]);
  const [automateOpen, setAutomateOpen] = useState(true);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetText, setResetText] = useState('');
  const [resetDone, setResetDone] = useState(false);
  const [showServerEdit, setShowServerEdit] = useState(false);
  const [serverInput, setServerInput] = useState('');
  const [serverSaved, setServerSaved] = useState(false);
  const [showEmailEdit, setShowEmailEdit] = useState(false);
  const [outlookStatus, setOutlookStatus] = useState<{ connected: boolean; account: string | null } | null>(null);
  const [outlookLoading, setOutlookLoading] = useState(false);
  const [outlookMsg, setOutlookMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [showUnassigned, setShowUnassigned] = useState(false);
  const [ruleMsg, setRuleMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [newMapping, setNewMapping] = useState({ title: '', sourceType: 'all', jiraIssue: '' });
  const [newRoute, setNewRoute] = useState({ projectId: '', taskTypeId: '', sourceType: '', jiraKey: '' });
  const [keywordAssign, setKeywordAssign] = useState({ keywordId: '', projectId: '', taskTypeId: '' });

  const fetchRules = useCallback(async () => {
    try {
      const [kwRes, rtRes, mappingRes] = await Promise.all([
        fetch('/api/keywords'),
        fetch('/api/routes'),
        fetch('/api/calendar-mappings'),
      ]);
      const kwData = await kwRes.json();
      const rtData = await rtRes.json();
      const mappingData = await mappingRes.json();
      setKeywords(kwData.keywords || []);
      setRoutes(rtData.routes || []);
      setCalendarMappings(mappingData.mappings || []);
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
  const removeCalendarMapping = async (id: number) => {
    await fetch(`/api/calendar-mappings/${id}`, { method: 'DELETE' });
    fetchRules();
  };

  const addCalendarMapping = async () => {
    setRuleMsg(null);
    try {
      const res = await fetch('/api/calendar-mappings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newMapping),
      });
      const data = await res.json();
      if (data.success) {
        setRuleMsg({ ok: true, text: 'Calendar title rule saved.' });
        setNewMapping({ title: '', sourceType: 'all', jiraIssue: '' });
        fetchRules();
      } else {
        setRuleMsg({ ok: false, text: data.error || 'Could not save the rule.' });
      }
    } catch {
      setRuleMsg({ ok: false, text: 'Network error while saving the rule.' });
    }
  };

  const addRoute = async () => {
    setRuleMsg(null);
    try {
      const res = await fetch('/api/routes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: newRoute.projectId ? Number(newRoute.projectId) : null,
          task_type_id: newRoute.taskTypeId ? Number(newRoute.taskTypeId) : null,
          source_type: newRoute.sourceType || null,
          jira_key: newRoute.jiraKey.trim().toUpperCase(),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setRuleMsg({ ok: true, text: 'Recurring rule saved.' });
        setNewRoute({ projectId: '', taskTypeId: '', sourceType: '', jiraKey: '' });
        fetchRules();
      } else {
        setRuleMsg({ ok: false, text: data.error || 'Could not save the rule.' });
      }
    } catch {
      setRuleMsg({ ok: false, text: 'Network error while saving the rule.' });
    }
  };

  const assignKeyword = async () => {
    setRuleMsg(null);
    if (!keywordAssign.keywordId) {
      setRuleMsg({ ok: false, text: 'Choose a keyword first.' });
      return;
    }
    try {
      const res = await fetch(`/api/keywords/${keywordAssign.keywordId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: keywordAssign.projectId ? Number(keywordAssign.projectId) : null,
          taskTypeId: keywordAssign.taskTypeId ? Number(keywordAssign.taskTypeId) : null,
        }),
      });
      if (res.ok) {
        setRuleMsg({ ok: true, text: 'Keyword assignment saved.' });
        setKeywordAssign({ keywordId: '', projectId: '', taskTypeId: '' });
        fetchRules();
      } else {
        setRuleMsg({ ok: false, text: 'Could not assign the keyword.' });
      }
    } catch {
      setRuleMsg({ ok: false, text: 'Network error while assigning the keyword.' });
    }
  };

  const disconnectJira = async () => {
    // refresh will be called after
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

  // Fetch Outlook status on mount
  const refreshOutlookStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/outlook/status');
      if (res.ok) {
        const data = await res.json();
        setOutlookStatus({ connected: data.connected, account: data.account });
      }
    } catch { /* ignore */ }
    await refreshOutlook();
  }, [refreshOutlook]);

  // Check URL params for Outlook callback results
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('outlook_connected')) {
      setOutlookMsg({ ok: true, text: 'Outlook connected successfully.' });
      refreshOutlookStatus();
      window.history.replaceState({}, '', '/settings');
    }
    if (params.get('outlook_error')) {
      setOutlookMsg({ ok: false, text: decodeURIComponent(params.get('outlook_error') || 'Sign-in failed.') });
      window.history.replaceState({}, '', '/settings');
    }
  }, [refreshOutlookStatus]);

  useEffect(() => { refreshOutlookStatus(); }, [refreshOutlookStatus]);

  useEffect(() => {
    const handleVisible = () => {
      if (document.visibilityState === 'visible') refreshOutlookStatus();
    };
    window.addEventListener('focus', refreshOutlookStatus);
    document.addEventListener('visibilitychange', handleVisible);
    return () => {
      window.removeEventListener('focus', refreshOutlookStatus);
      document.removeEventListener('visibilitychange', handleVisible);
    };
  }, [refreshOutlookStatus]);

  const startOutlookConnect = (changeAccount = false) => {
    const url = changeAccount
      ? '/api/outlook/auth/start?prompt=select_account'
      : '/api/outlook/auth/start';
    window.open(url, '_blank');
  };





  const disconnectOutlook = async () => {
    setOutlookLoading(true);
    try {
      await fetch('/api/outlook/auth/logout', { method: 'POST' });
      localStorage.removeItem('etta-last-sync');
      setOutlookStatus({ connected: false, account: null });
      setOutlookMsg({ ok: true, text: 'Disconnected. Calendar history was cleared.' });
      await refreshOutlook();
    } catch {
      setOutlookMsg({ ok: false, text: 'Failed to disconnect.' });
    } finally {
      setOutlookLoading(false);
    }
  };

  return (
    <div className="settings-page">
      <h2 style={{ fontSize: 28, fontWeight: 700, color: 'var(--navy)', marginBottom: 0 }}>Settings</h2>

      {/* Automate (collapsible, first, expanded) */}
      <div className={'collapse-entry' + (automateOpen ? ' open' : '')}>
        <button type="button" className="collapse-head" onClick={() => setAutomateOpen(!automateOpen)} aria-expanded={automateOpen}>
          <div>
            <div className="collapse-title">Automate</div>
            <div className="collapse-summary">Set rules so ETTA codes your recurring work automatically - less manual entry each day.</div>
          </div>
          <span className="collapse-arrow">{'>'}</span>
        </button>
        <div className="collapse-body">
          {ruleMsg && (
            <div style={{ marginBottom: 12, fontSize: 13.5, fontWeight: 600, color: ruleMsg.ok ? 'var(--success-600)' : 'var(--danger-600)' }}>
              {ruleMsg.text}
            </div>
          )}

          {/* Create a calendar title rule */}
          <div className="card" style={{ padding: 16, marginBottom: 16 }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--navy)', marginBottom: 10 }}>Create a calendar title rule</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto', gap: 8, alignItems: 'end' }}>
              <div>
                <label style={{ fontSize: 12.5, color: 'var(--slate-500)', display: 'block', marginBottom: 4 }}>Calendar title</label>
                <input className="input" value={newMapping.title} onChange={(e) => setNewMapping({ ...newMapping, title: e.target.value })} placeholder="Weekly team sync" />
              </div>
              <div>
                <label style={{ fontSize: 12.5, color: 'var(--slate-500)', display: 'block', marginBottom: 4 }}>Source</label>
                <select className="input" value={newMapping.sourceType} onChange={(e) => setNewMapping({ ...newMapping, sourceType: e.target.value })}>
                  <option value="all">Any</option>
                  <option value="meeting">Meeting</option>
                  <option value="email">Email</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12.5, color: 'var(--slate-500)', display: 'block', marginBottom: 4 }}>Jira issue</label>
                <input className="input" value={newMapping.jiraIssue} onChange={(e) => setNewMapping({ ...newMapping, jiraIssue: e.target.value })} placeholder="SVC-123" />
              </div>
              <button className="btn btn-navy btn-sm" onClick={addCalendarMapping}>Add rule</button>
            </div>
          </div>

          {/* Create a recurring route */}
          <div className="card" style={{ padding: 16, marginBottom: 16 }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--navy)', marginBottom: 10 }}>Create a recurring rule</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr auto', gap: 8, alignItems: 'end' }}>
              <div>
                <label style={{ fontSize: 12.5, color: 'var(--slate-500)', display: 'block', marginBottom: 4 }}>Project</label>
                <select className="input" value={newRoute.projectId} onChange={(e) => setNewRoute({ ...newRoute, projectId: e.target.value })}>
                  <option value="">Any</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12.5, color: 'var(--slate-500)', display: 'block', marginBottom: 4 }}>Task type</label>
                <select className="input" value={newRoute.taskTypeId} onChange={(e) => setNewRoute({ ...newRoute, taskTypeId: e.target.value })}>
                  <option value="">Any</option>
                  {taskTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12.5, color: 'var(--slate-500)', display: 'block', marginBottom: 4 }}>Source</label>
                <select className="input" value={newRoute.sourceType} onChange={(e) => setNewRoute({ ...newRoute, sourceType: e.target.value })}>
                  <option value="">Any</option>
                  <option value="meeting">Meeting</option>
                  <option value="email">Email</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12.5, color: 'var(--slate-500)', display: 'block', marginBottom: 4 }}>Jira issue</label>
                <input className="input" value={newRoute.jiraKey} onChange={(e) => setNewRoute({ ...newRoute, jiraKey: e.target.value })} placeholder="SVC-123" />
              </div>
              <button className="btn btn-navy btn-sm" onClick={addRoute}>Add rule</button>
            </div>
          </div>

          {/* Assign a keyword */}
          {unassignedKeywords.length > 0 && (
            <div className="card" style={{ padding: 16, marginBottom: 16 }}>
              <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--navy)', marginBottom: 10 }}>Assign a keyword</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: 8, alignItems: 'end' }}>
                <div>
                  <label style={{ fontSize: 12.5, color: 'var(--slate-500)', display: 'block', marginBottom: 4 }}>Keyword</label>
                  <select className="input" value={keywordAssign.keywordId} onChange={(e) => setKeywordAssign({ ...keywordAssign, keywordId: e.target.value })}>
                    <option value="">Choose a keyword</option>
                    {unassignedKeywords.slice(0, 50).map((kw) => <option key={kw.id} value={kw.id}>{kw.word}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12.5, color: 'var(--slate-500)', display: 'block', marginBottom: 4 }}>Project</label>
                  <select className="input" value={keywordAssign.projectId} onChange={(e) => setKeywordAssign({ ...keywordAssign, projectId: e.target.value })}>
                    <option value="">None</option>
                    {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12.5, color: 'var(--slate-500)', display: 'block', marginBottom: 4 }}>Task type</label>
                  <select className="input" value={keywordAssign.taskTypeId} onChange={(e) => setKeywordAssign({ ...keywordAssign, taskTypeId: e.target.value })}>
                    <option value="">None</option>
                    {taskTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
                <button className="btn btn-navy btn-sm" onClick={assignKeyword}>Assign</button>
              </div>
            </div>
          )}

          {/* Match by keyword */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 8, marginTop: 8 }}>
            <h3 style={{ fontSize: 16.5, fontWeight: 700, color: 'var(--navy)' }}>Match by keyword</h3>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ minWidth: 760 }}>
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
              <span style={{ fontSize: 14, color: 'var(--slate-500)' }}>
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
          <div style={{ fontSize: 14, color: 'var(--slate-400)', marginTop: 10 }}>Keywords are auto-extracted from your calendar and email. Assign them to projects above to automate coding.</div>

          {/* Recurring rules */}
          <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 8 }}>
            <h3 style={{ fontSize: 16.5, fontWeight: 700, color: 'var(--navy)' }}>Recurring rules</h3>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ minWidth: 720 }}>
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

      {/* Calendar title rules */}
      <div style={{ marginTop: 18 }}>
        <h3 style={{ fontSize: 16.5, fontWeight: 700, color: 'var(--navy)', marginBottom: 8 }}>Calendar title rules</h3>
        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ minWidth: 760 }}>
            <thead><tr><th>Calendar title</th><th>Jira code</th><th>Source</th><th></th></tr></thead>
            <tbody>
              {calendarMappings.length === 0 && (
                <tr><td colSpan={4} style={{ color: 'var(--slate-400)' }}>No title rules yet. ETTA creates one when you assign or push a calendar entry.</td></tr>
              )}
              {calendarMappings.map((mapping) => (
                <tr key={mapping.id}>
                  <td style={{ fontWeight: 600 }}>{mapping.title}</td>
                  <td><span className="issue-key">{mapping.jiraIssue}</span></td>
                  <td>{mapping.sourceType === 'all' ? 'Any' : mapping.sourceType}</td>
                  <td style={{ textAlign: 'right' }}><button className="btn btn-secondary btn-sm" onClick={() => removeCalendarMapping(mapping.id)}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {connected && !outlookStatus?.connected && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'var(--blue-50)', border: '1px solid var(--blue-200)', borderRadius: 12, padding: 16, marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--navy)' }}>Connect your Outlook calendar</div>
            <div style={{ fontSize: 14, color: 'var(--slate-500)' }}>Auto-import your meetings so you don&apos;t have to log them manually.</div>
          </div>
          <button className="btn btn-navy btn-sm" onClick={() => startOutlookConnect()} disabled={outlookLoading}>
            {outlookLoading ? 'Starting...' : 'Connect now'}
          </button>
        </div>
      )}

      <div className="settings-connections">
            {/* Jira */}
      <div className="card" style={{ padding: '22px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <h3 style={{ fontSize: 16.5, fontWeight: 700, color: 'var(--navy)' }}>Jira</h3>
            <div style={{ fontSize: 14, color: 'var(--slate-500)' }}>Server: {host || 'Not configured'}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="conn-chip green"><span className="dot"></span> Connected</span>
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
          {serverSaved && <div style={{ fontSize: 14, color: 'var(--success-600)', marginTop: 6 }}>Server updated.</div>}
        </div>
      </div>

      {/* Outlook */}
      <div className="card" style={{ padding: '22px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <h3 style={{ fontSize: 16.5, fontWeight: 700, color: 'var(--navy)' }}>Outlook</h3>
            <div style={{ fontSize: 14, color: 'var(--slate-500)' }}>{outlookStatus?.connected ? outlookStatus.account || 'UCSD calendar & mailbox' : 'UCSD calendar & mailbox'}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {outlookStatus?.connected ? (
              <>
                <span className="conn-chip green"><span className="dot"></span> Connected</span>
                <button className="btn btn-secondary btn-sm" onClick={disconnectOutlook} disabled={outlookLoading}>Disconnect</button>
              </>
            ) : (
              <>
                <span className="conn-chip red"><span className="dot"></span> Not connected</span>
                <button className="btn btn-secondary btn-sm" onClick={() => startOutlookConnect()} disabled={outlookLoading}>
                  {outlookLoading ? 'Starting...' : 'Connect'}
                </button>
              </>
            )}
          </div>
        </div>


        {outlookMsg && (
          <div style={{
            marginTop: 10, fontSize: 14,
            color: outlookMsg.ok ? 'var(--success-600)' : 'var(--danger-600)',
          }}>
            {outlookMsg.text}
          </div>
        )}
        {outlookStatus?.connected && (
          <div style={{ marginTop: 10 }}>
            {!showEmailEdit ? (
              <button className="btn btn-secondary btn-sm" onClick={() => setShowEmailEdit(true)}>
                Change email
              </button>
            ) : (
              <div style={{ borderTop: '1px solid var(--slate-200)', paddingTop: 12 }}>
                <label className="field-label">Current account</label>
                <div style={{ fontSize: 14.5, color: 'var(--navy)', marginBottom: 8 }}>
                  {outlookStatus.account || 'UCSD calendar & mailbox'}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn btn-navy btn-sm" onClick={() => startOutlookConnect(true)} disabled={outlookLoading}>
                    Sign in with another account
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setShowEmailEdit(false)}>
                    Cancel
                  </button>
                </div>
                <div className="field-hint">
                  Microsoft will ask you to choose an account. Your current connection stays active until the new sign-in finishes.
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Reset */}
      </div>

      <div className="card" style={{ padding: '22px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <h3 style={{ fontSize: 16.5, fontWeight: 700, color: 'var(--navy)' }}>Reset entries</h3>
          {!resetOpen && <button className="btn btn-danger btn-sm" onClick={() => setResetOpen(true)}>Reset entries...</button>}
        </div>
        {resetOpen && (
          <div style={{ marginTop: 14 }}>
            <p style={{ fontSize: 14, color: 'var(--slate-500)', marginBottom: 10 }}>
              This clears all entries stored on this computer. Already-pushed time in Jira is unaffected. Type <b>RESET</b> to confirm.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input className="input" placeholder="Type RESET" autoComplete="off" style={{ maxWidth: 240 }}
                value={resetText} onChange={(e) => setResetText(e.target.value)} />
              <button className="btn btn-danger btn-sm" disabled={resetText.trim().toUpperCase() !== 'RESET'} onClick={doReset}>Confirm reset</button>
              <button className="btn btn-secondary btn-sm" onClick={() => { setResetOpen(false); setResetText(''); }}>Cancel</button>
            </div>
            {resetDone && <div aria-live="polite" style={{ marginTop: 10, fontSize: 14, color: 'var(--success-600)' }}>Done. Local entries cleared - nothing in Jira was changed.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
