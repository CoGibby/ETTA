'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { CalendarJiraMapping, getMappedJiraIssue, getTempoCoverageForEntries, TempoCoverage, TempoWorklog } from '@/lib/tempo-match';
import { JiraIssueAutocomplete } from './JiraIssueAutocomplete';

interface ApiEntry {
  id: number;
  source_type: 'email' | 'meeting' | 'manual';
  title: string;
  date: string;
  start_time: string | null;
  duration_minutes: number;
  context_minutes: number;
  jira_issue: string | null;
  jira_name: string | null;
  jira_source: string | null;
  status: 'pending' | 'pushed' | 'excluded';
  pushed_at: string | null;
  jira_worklog_id: string | null;
  source_status: 'active' | 'stale' | null;
}

type CellStatus = 'cloud' | 'likely' | 'local' | 'need' | 'block' | 'empty' | 'partial' | 'excluded';

function statusOf(e: ApiEntry): CellStatus {
  if (e.status === 'pushed') return 'cloud';
  if (e.status === 'excluded') return 'excluded';
  if (e.jira_issue) return 'local';
  return 'need';
}

const STATUS_META: Record<CellStatus, { cls: string; label: string }> = {
  cloud: { cls: 's-pushed', label: 'Pushed to Jira' },
  likely: { cls: 's-pushed', label: 'Likely in Jira' },
  local: { cls: 's-hascode', label: 'Has a Jira code, not pushed' },
  need: { cls: 's-need', label: 'Needs a Jira code' },
  block: { cls: 's-block', label: 'Blocked' },
  empty: { cls: 's-empty', label: 'No entries' },
  partial: { cls: 's-partial', label: 'Partly in Jira' },
  excluded: { cls: 's-excluded', label: 'Not work' },
};

const DOWS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const FULLDOWS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORTMON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtDate(d: Date) {
  return { month: MONTHS[d.getMonth()], short: SHORTMON[d.getMonth()], num: d.getDate(), year: d.getFullYear(), dow: FULLDOWS[(d.getDay() + 6) % 7], sdow: DOWS[(d.getDay() + 6) % 7] };
}
function dateKey(d: Date) { return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }
function toIso(d: Date) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function hoursOf(list: ApiEntry[]) {
  return Math.round(
    list
      .filter((entry) => entry.status !== 'excluded')
      .reduce((total, entry) => total + (entry.duration_minutes + (entry.context_minutes || 0)) / 60, 0) * 100
  ) / 100;
}

function mondayOf(offset: number): Date {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff + offset * 7);
  d.setHours(0, 0, 0, 0);
  return d;
}

interface DayData { date: ReturnType<typeof fmtDate>; entries: ApiEntry[]; }

function pillFor(st: CellStatus): [string, string] {
  if (st === 'cloud') return ['sp-green', 'In Jira'];
  if (st === 'likely') return ['sp-green', 'Likely in Jira'];
  if (st === 'local') return ['sp-navy', 'Ready to push'];
  if (st === 'need') return ['sp-gold', 'Needs a code'];
  if (st === 'partial') return ['sp-grey', 'Partly in Jira'];
  if (st === 'excluded') return ['sp-grey', 'Not work'];
  return ['sp-red', 'Blocked'];
}

export function CalendarSection({
  open,
  setOpen,
  refreshToken,
  onDataChange,
}: {
  open: boolean;
  setOpen: (v: boolean) => void;
  refreshToken: number;
  onDataChange?: () => void;
}) {
  const [weekOffset, setWeekOffset] = useState(0);
  const [selIdx, setSelIdx] = useState(0);
  const [days, setDays] = useState<DayData[]>([]);
  const [loading, setLoading] = useState(true);
  const [pushing, setPushing] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [coverageByDay, setCoverageByDay] = useState<Record<string, Record<number, TempoCoverage>>>({});
  const [mappings, setMappings] = useState<CalendarJiraMapping[]>([]);
  const today = new Date();
  const gridRef = useRef<HTMLDivElement>(null);
  const fetchRequestRef = useRef(0);

  const fetchWeek = useCallback(async (offset: number) => {
    const requestId = ++fetchRequestRef.current;
    setLoading(true);
    const mon = mondayOf(offset);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    try {
      // Fetch Tempo first. The API reconciles pushed entries before ETTA
      // reads them, so deleted Tempo worklogs cannot leak stale statuses.
      let byDay: Record<string, TempoWorklog[]> = {};
      try {
        const tempoRes = await fetch('/api/jira/tempo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dateFrom: toIso(mon), dateTo: toIso(sun) }),
        });
        const tempoData = await tempoRes.json();
        if (tempoData.success && tempoData.entries) {
          byDay = {};
          for (const t of tempoData.entries) {
            const rawDate = t.date || '';
            const dayPart = rawDate.length >= 10 ? rawDate.substring(0, 10) : rawDate;
            const d = new Date(dayPart + 'T00:00:00');
            const k = dateKey(d);
            (byDay[k] = byDay[k] || []).push({
              issueKey: (t.issueKey || '').toUpperCase(),
              minutes: t.minutes || 0,
              comment: t.comment || '',
            });
          }
        }
      } catch {
        byDay = {};
      }

      let weekMappings: CalendarJiraMapping[] = [];
      try {
        const mappingsRes = await fetch('/api/calendar-mappings');
        const mappingsData = await mappingsRes.json();
        weekMappings = mappingsData.mappings || [];
        setMappings(weekMappings);
      } catch {
        weekMappings = [];
      }

      if (requestId !== fetchRequestRef.current) return;

      const res = await fetch(`/api/entries?startDate=${toIso(mon)}&endDate=${toIso(sun)}`);
      const data = await res.json();
      const entries: ApiEntry[] = data.entries || [];
      const map: Record<string, ApiEntry[]> = {};
      entries.forEach((entry) => {
        const d = new Date(entry.date + 'T00:00:00');
        const k = dateKey(d);
        (map[k] = map[k] || []).push(entry);
      });
      const built: DayData[] = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(mon); d.setDate(mon.getDate() + i);
        built.push({ date: fmtDate(d), entries: map[dateKey(d)] || [] });
      }

      const nextCoverage: Record<string, Record<number, TempoCoverage>> = {};
      for (const [dayKey, dayEntries] of Object.entries(map)) {
        nextCoverage[dayKey] = getTempoCoverageForEntries(dayEntries, byDay[dayKey] || [], weekMappings);
      }
      setDays(built);
      setCoverageByDay(nextCoverage);
    } catch {
      setDays([]);
      setCoverageByDay({});
    } finally {
      if (requestId === fetchRequestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;

    fetchWeek(weekOffset);
  }, [open, weekOffset, fetchWeek, refreshToken]);

  const weekLabel = (() => {
    if (days.length === 0) return '';
    const w0 = days[0].date, w6 = days[6].date;
    const w0f = w0.short + ' ' + w0.num;
    const w6f = w0.month === w6.month ? String(w6.num) : w6.short + ' ' + w6.num;
    return w0f + ' – ' + w6f + ', ' + w0.year;
  })();

  const hasEntries = days.some((d) => d.entries.length > 0);

  const shiftWeek = (d: number) => { setWeekOffset((w) => w + d); setSelIdx(0); };

  const patchEntry = async (id: number, updates: Record<string, unknown>) => {
    await fetch('/api/entries', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id], updates }),
    });
  };

  const updateEntry = async (id: number, updates: Record<string, unknown>) => {
    await patchEntry(id, updates);
    fetchWeek(weekOffset);
  };

  const mappingFor = (entry: ApiEntry): CalendarJiraMapping | null => {
    return getMappedJiraIssue(entry, mappings);
  };

  const materializeMappedIssue = async (entry: ApiEntry) => {
    const mapping = mappingFor(entry);
    if (!mapping || entry.jira_issue) return;
    await patchEntry(entry.id, {
      jira_issue: mapping.jiraIssue,
      jira_name: mapping.jiraName || null,
      jira_source: 'source_route',
      jira_worklog_id: null,
    });
  };

  const saveJiraForEntry = async (entry: ApiEntry, issue: string) => {
    try {
      const res = await fetch('/api/calendar-mappings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: entry.title,
          sourceType: entry.source_type,
          jiraIssue: issue,
        }),
      });
      const data = await res.json();
      if (data.success && data.mapping) {
        const savedMapping = data.mapping as CalendarJiraMapping;
        setMappings((current) => [
          savedMapping,
          ...current.filter((mapping) => mapping.id !== savedMapping.id),
        ]);
      }
    } catch {
      // The entry can still be saved even if the reusable mapping cannot.
    }
    await updateEntry(entry.id, {
      jira_issue: issue,
      jira_name: null,
      jira_source: 'manual',
      jira_worklog_id: null,
    });
  };

  const forgetMapping = async (entry: ApiEntry) => {
    const mapping = mappingFor(entry);
    if (!mapping?.id) return;
    try {
      await fetch(`/api/calendar-mappings/${mapping.id}`, { method: 'DELETE' });
      setMappings((current) => current.filter((item) => item.id !== mapping.id));
      if (entry.jira_source === 'source_route') {
        await patchEntry(entry.id, {
          jira_issue: null,
          jira_name: null,
          jira_source: null,
          jira_worklog_id: null,
        });
      }
    } finally {
      fetchWeek(weekOffset);
    }
  };

  const pushEntry = async (entry: ApiEntry) => {
    await materializeMappedIssue(entry);
    setPushing(true);
    try {
      const res = await fetch('/api/jira/push', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entryIds: [entry.id] }),
      });
      const data = await res.json();
      if (data.success) { setBanner('Pushed to Jira.'); }
      else { setBanner(data.error || 'Push failed.'); }
    } catch { setBanner('Network error.'); }
    finally { setPushing(false); fetchWeek(weekOffset); onDataChange?.(); setTimeout(() => setBanner(null), 4000); }
  };

  const pushReady = async () => {
    const day = days[selIdx];
    if (!day) return;
    const readyEntries = day.entries.filter((entry) => displayStatusOf(entry) === 'local');
    if (readyEntries.length === 0) return;
    for (const entry of readyEntries) {
      await materializeMappedIssue(entry);
    }
    const ready = readyEntries.map((entry) => entry.id);
    setPushing(true);
    try {
      const res = await fetch('/api/jira/push', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entryIds: ready }),
      });
      const data = await res.json();
      setBanner(data.success ? `Pushed ${ready.length} entr${ready.length === 1 ? 'y' : 'ies'} to Jira.` : (data.error || 'Push failed.'));
    } catch { setBanner('Network error.'); }
    finally { setPushing(false); fetchWeek(weekOffset); onDataChange?.(); setTimeout(() => setBanner(null), 4000); }
  };

  const selDay = days[selIdx];

  const tempoCoverageFor = (entry: ApiEntry): TempoCoverage => {
    const d = new Date(entry.date + 'T00:00:00');
    const k = dateKey(d);
    return coverageByDay[k]?.[entry.id] || 'none';
  };

  const displayStatusOf = (entry: ApiEntry): CellStatus => {
    if (statusOf(entry) === 'excluded') return 'excluded';
    const coverage = tempoCoverageFor(entry);
    if (coverage === 'full') return 'cloud';
    if (coverage === 'likely') return 'likely';
    if (coverage === 'partial') return 'partial';
    if (statusOf(entry) === 'need' && mappingFor(entry)) return 'local';
    return statusOf(entry);
  };

  const readyCount = selDay
    ? selDay.entries.filter((entry) => displayStatusOf(entry) === 'local').length
    : 0;

  return (
    <>
      <div className={'detail-toggle-body' + (open ? ' open' : '')}>
        <div className="calhead">
          <div className="weeknav">
            <button className="btn btn-secondary btn-sm" onClick={() => shiftWeek(-1)}>Prev</button>
            <button className="btn btn-secondary btn-sm" onClick={() => shiftWeek(1)}>Next</button>
            <button className="btn btn-navy btn-sm" onClick={() => { setWeekOffset(0); setSelIdx(0); }}>This week</button>
            <span className="text-muted" aria-live="polite" aria-atomic="true" style={{ minWidth: 150, textAlign: 'center' }}>{weekLabel}</span>
          </div>
        </div>

        {loading ? (
          <p className="text-muted" style={{ padding: 12 }}>Loading…</p>
        ) : !hasEntries ? (
          <div className="cal-empty">
            <span><b>No entries yet</b><br />ETTA is gathering your calendar and email. Connect Outlook in Settings to populate your week.</span>
          </div>
        ) : (
          <>
            <div className="calwrap">
              <div className="calGrid" ref={gridRef} role="grid" aria-label="Weekly calendar">
                {days.map((day, idx) => {
                  const total = hoursOf(day.entries);
                  const isToday = day.date.num === today.getDate() && day.date.month === MONTHS[today.getMonth()];
                  let st: CellStatus = 'empty';
                  if (day.entries.length > 0) {
                    if (day.entries.some((entry) => displayStatusOf(entry) === 'need')) st = 'need';
                    else if (day.entries.some((entry) => displayStatusOf(entry) === 'partial')) st = 'partial';
                    else if (day.entries.some((entry) => displayStatusOf(entry) === 'local')) st = 'local';
                    else if (day.entries.some((entry) => displayStatusOf(entry) === 'likely')) st = 'likely';
                    else st = 'cloud';
                  }
                  return (
                    <div key={idx}
                      className={'day' + (idx === selIdx ? ' selected' : '') + (isToday ? ' today' : '')}
                      role="gridcell" tabIndex={idx === selIdx ? 0 : -1}
                      onClick={() => setSelIdx(idx)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelIdx(idx); }
                        if (e.key === 'ArrowRight') { e.preventDefault(); setSelIdx(Math.min(idx + 1, 6)); }
                        if (e.key === 'ArrowLeft') { e.preventDefault(); setSelIdx(Math.max(idx - 1, 0)); }
                      }}>
                      <div className="dhead"><span className="ddow">{day.date.sdow}</span><span className="dnum">{day.date.num}</span></div>
                      <div className="dsum">{total > 0 ? total + 'h' : 'No entries'}</div>
                      {day.entries.slice(0, 4).map((en, i) => (
                        <div key={i} className={'ent st-' + displayStatusOf(en)}>
                          {en.title}
                          <div className="row2">{en.source_type} · {Math.round((en.duration_minutes + (en.context_minutes || 0)) / 60 * 10) / 10}h</div>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Detail panel */}
            <div aria-live="polite" style={{ marginTop: 16 }}>
              {selDay && (
                <div className="card" style={{ padding: 22 }}>
                  <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--navy)', marginBottom: 6 }}>
                    {selDay.date.dow}, {selDay.date.month} {selDay.date.num}
                  </h3>
                  {banner && (
                    <div style={{ marginTop: 8, marginBottom: 8, background: 'var(--success-50)', border: '1px solid #bfe5cd', borderRadius: 8, padding: '8px 10px', fontSize: 13, color: 'var(--success-600)' }}>{banner}</div>
                  )}
                  {selDay.entries.length === 0 ? (
                    <p className="text-muted" style={{ padding: '10px 0' }}>No entries for this day.</p>
                  ) : (
                    <div style={{ overflowX: 'auto' }}>
                      <table className="table" style={{ minWidth: 760 }}>
                        <thead><tr><th>Entry</th><th>Status</th><th style={{ width: 230 }}>Jira activity</th><th>Hours</th><th>Action</th></tr></thead>
                        <tbody>
                          {selDay.entries.map((e) => {
                            const st = displayStatusOf(e);
                            const [pillCls, pillLabel] = pillFor(st);
                            const hrs = Math.round((e.duration_minutes + (e.context_minutes || 0)) / 60 * 10) / 10;
                            const mapping = mappingFor(e);
                            return (
                              <tr key={e.id}>
                                <td>
                                  <div style={{ fontWeight: 600 }}>{e.title}</div>
                                  <div className="text-muted">{e.source_type}</div>
                                </td>
                                <td><span className={'status-pill ' + pillCls}>{pillLabel}</span></td>
                                <td>
                                  {st === 'cloud' || st === 'partial' ? (
                                    <span className="issue-key">{e.jira_issue || mapping?.jiraIssue || '--'}</span>
                                  ) : (
                                    <>
                                      <JiraInput entry={e} suggestedIssue={mapping?.jiraIssue} helperText={mapping ? 'Reused from this calendar title.' : 'Review the Jira issue before pushing.'} onSave={(issue) => saveJiraForEntry(e, issue)} />
                                      {mapping?.id && (
                                        <button className="btn btn-secondary btn-sm" style={{ marginTop: 6 }} onClick={() => forgetMapping(e)}>Forget mapping</button>
                                      )}
                                    </>
                                  )}
                                </td>
                                <td>{hrs}h</td>
                                <td>
                                  {st === 'cloud' && <span className="status-pill sp-green">In Jira</span>}
                                  {st === 'likely' && <span className="status-pill sp-green">Likely in Jira</span>}
                                  {st === 'partial' && <span className="status-pill sp-grey">Partly in Jira</span>}
                                  {st === 'local' && <button className="btn btn-primary btn-sm" disabled={pushing} onClick={() => pushEntry(e)}>Push</button>}
                                  {st === 'need' && <span className="status-pill sp-gold">Needs code</span>}
                                  {st === 'excluded' && (
                                    <button className="btn btn-secondary btn-sm" onClick={() => updateEntry(e.id, { status: 'pending' })}>Include</button>
                                  )}
                                  {st !== 'excluded' && st !== 'cloud' && st !== 'partial' && (
                                    <button className="btn btn-secondary btn-sm" onClick={() => updateEntry(e.id, { status: 'excluded' })}>Not work</button>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {selDay.entries.length > 0 && readyCount > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginTop: 18 }}>
                      <button className="btn btn-navy btn-lg" disabled={pushing} onClick={pushReady}>
                        Push all ({readyCount})
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}

function JiraInput({
  entry,
  onSave,
  suggestedIssue,
  helperText,
}: {
  entry: ApiEntry;
  onSave: (issue: string) => void;
  suggestedIssue?: string;
  helperText?: string;
}) {
  const [val, setVal] = useState(entry.jira_issue || suggestedIssue || '');
  const [status, setStatus] = useState<'idle' | 'validating' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');

  const validateAndSave = async (issue: string) => {
    if (!issue || issue === entry.jira_issue) return;
    setStatus('validating');
    setError('');
    try {
      const res = await fetch('/api/jira/validate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jira_key: issue.trim().toUpperCase() }),
      });
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        setStatus('error');
        setError('Could not reach Jira.');
        return;
      }
      const data = await res.json();
      if (!data.valid) {
        setStatus('error');
        setError(data.error || 'Issue not found.');
        return;
      }
      setStatus('saved');
      onSave(issue.trim().toUpperCase());
      setTimeout(() => setStatus('idle'), 2000);
    } catch {
      setStatus('error');
      setError('Could not reach Jira.');
    }
  };

  return (
    <div>
      <JiraIssueAutocomplete
        value={val}
        onChange={(nextValue) => {
          setVal(nextValue);
          setStatus('idle');
          setError('');
        }}
        onSelect={(issue) => {
          setVal(issue.key);
          validateAndSave(issue.key);
        }}
        onSubmitNoMatch={validateAndSave}
        onBlur={validateAndSave}
        placeholder="Search Jira issue"
        helperText={helperText || 'Review the Jira issue before pushing.'}
        inputStyle={{
          padding: '7px 10px',
          borderColor: status === 'error' ? 'var(--danger-600)' : entry.jira_issue ? undefined : 'var(--gold-600)',
        }}
        usePortal
      />
      {status === 'validating' && <div className="text-muted" style={{ marginTop: 3 }}>Checking...</div>}
      {status === 'saved' && <div style={{ fontSize: 13, color: 'var(--success-600)', marginTop: 3 }}>Saved.</div>}
      {status === 'error' && <div style={{ fontSize: 13, color: 'var(--danger-600)', marginTop: 3 }}>{error}</div>}
    </div>
  );
}
