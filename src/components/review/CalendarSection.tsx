'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

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
  status: 'pending' | 'pushed' | 'excluded';
  pushed_at: string | null;
  source_status: 'active' | 'stale' | null;
}

type CellStatus = 'cloud' | 'local' | 'need' | 'block' | 'empty';

function statusOf(e: ApiEntry): CellStatus {
  if (e.status === 'pushed') return 'cloud';
  if (e.status === 'excluded') return 'block';
  if (e.jira_issue) return 'local';
  return 'need';
}

const STATUS_META: Record<CellStatus, { cls: string; label: string }> = {
  cloud: { cls: 's-pushed', label: 'Pushed to Jira' },
  local: { cls: 's-hascode', label: 'Has a Jira code, not pushed' },
  need: { cls: 's-need', label: 'Needs a Jira code' },
  block: { cls: 's-block', label: 'Blocked' },
  empty: { cls: 's-empty', label: 'No entries' },
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
function hoursOf(list: ApiEntry[]) { return Math.round(list.reduce((t, e) => t + (e.duration_minutes + (e.context_minutes || 0)) / 60, 0) * 100) / 100; }

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
  if (st === 'cloud') return ['sp-green', 'Pushed'];
  if (st === 'local') return ['sp-navy', 'Ready to push'];
  if (st === 'need') return ['sp-gold', 'Needs a code'];
  return ['sp-red', 'Blocked'];
}

export function CalendarSection({ open, setOpen }: { open: boolean; setOpen: (v: boolean) => void }) {
  const [weekOffset, setWeekOffset] = useState(0);
  const [selIdx, setSelIdx] = useState(0);
  const [days, setDays] = useState<DayData[]>([]);
  const [loading, setLoading] = useState(true);
  const [pushing, setPushing] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [tempoByDay, setTempoByDay] = useState<Record<string, { issueKey: string; minutes: number }[]>>({});
  const today = new Date();
  const gridRef = useRef<HTMLDivElement>(null);

  const fetchWeek = useCallback(async (offset: number) => {
    setLoading(true);
    const mon = mondayOf(offset);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    try {
      const res = await fetch(`/api/entries?startDate=${toIso(mon)}&endDate=${toIso(sun)}`);
      const data = await res.json();
      const entries: ApiEntry[] = data.entries || [];
      const map: Record<string, ApiEntry[]> = {};
      entries.forEach((e) => {
        const d = new Date(e.date + 'T00:00:00');
        const k = dateKey(d);
        (map[k] = map[k] || []).push(e);
      });
      const built: DayData[] = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(mon); d.setDate(mon.getDate() + i);
        built.push({ date: fmtDate(d), entries: map[dateKey(d)] || [] });
      }
      setDays(built);

      // Fetch Tempo worklogs for the same week to detect already-logged entries
      try {
        const tempoRes = await fetch('/api/jira/tempo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dateFrom: toIso(mon), dateTo: toIso(sun) }),
        });
        const tempoData = await tempoRes.json();
        if (tempoData.success && tempoData.entries) {
          const byDay: Record<string, { issueKey: string; minutes: number }[]> = {};
          for (const t of tempoData.entries) {
            const rawDate = t.date || '';
            const dayPart = rawDate.length >= 10 ? rawDate.substring(0, 10) : rawDate;
            const d = new Date(dayPart + 'T00:00:00');
            const k = dateKey(d);
            (byDay[k] = byDay[k] || []).push({ issueKey: (t.issueKey || '').toUpperCase(), minutes: t.minutes || 0 });
          }
          setTempoByDay(byDay);
        } else {
          setTempoByDay({});
        }
      } catch {
        setTempoByDay({});
      }
    } catch {
      setDays([]);
      setTempoByDay({});
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchWeek(weekOffset); }, [weekOffset, fetchWeek]);

  const weekLabel = (() => {
    if (days.length === 0) return '';
    const w0 = days[0].date, w6 = days[6].date;
    const w0f = w0.short + ' ' + w0.num;
    const w6f = w0.month === w6.month ? String(w6.num) : w6.short + ' ' + w6.num;
    return w0f + ' – ' + w6f + ', ' + w0.year;
  })();

  const hasEntries = days.some((d) => d.entries.length > 0);

  const shiftWeek = (d: number) => { setWeekOffset((w) => w + d); setSelIdx(0); };

  const updateEntry = async (id: number, updates: Record<string, unknown>) => {
    await fetch('/api/entries', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id], updates }),
    });
    fetchWeek(weekOffset);
  };

  const pushEntry = async (id: number) => {
    setPushing(true);
    try {
      const res = await fetch('/api/jira/push', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entryIds: [id] }),
      });
      const data = await res.json();
      if (data.success) { setBanner('Pushed to Jira.'); }
      else { setBanner(data.error || 'Push failed.'); }
    } catch { setBanner('Network error.'); }
    finally { setPushing(false); fetchWeek(weekOffset); setTimeout(() => setBanner(null), 4000); }
  };

  const pushReady = async () => {
    const day = days[selIdx];
    if (!day) return;
    const ready = day.entries.filter((e) => statusOf(e) === 'local' && !isAlreadyInTempo(e, day.entries)).map((e) => e.id);
    if (ready.length === 0) return;
    setPushing(true);
    try {
      const res = await fetch('/api/jira/push', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entryIds: ready }),
      });
      const data = await res.json();
      setBanner(data.success ? `Pushed ${ready.length} entr${ready.length === 1 ? 'y' : 'ies'} to Jira.` : (data.error || 'Push failed.'));
    } catch { setBanner('Network error.'); }
    finally { setPushing(false); fetchWeek(weekOffset); setTimeout(() => setBanner(null), 4000); }
  };

  const selDay = days[selIdx];

  // Check if a calendar entry was already manually logged in Tempo.
  // Uses the same multi-strategy matching as the allocation page:
  // 1. Exact issue key match
  // 2. Same project prefix (e.g. SVCOPS-652 matches SVCOPS-648)
  // 3. Tempo total for the day >= total entry time (day fully covered)
  const isAlreadyInTempo = (entry: ApiEntry, dayEntries: ApiEntry[]): boolean => {
    const d = new Date(entry.date + 'T00:00:00');
    const k = dateKey(d);
    const tempoEntries = tempoByDay[k];
    if (!tempoEntries || tempoEntries.length === 0) return false;

    const entryKey = (entry.jira_issue || '').toUpperCase();
    const entryProject = entryKey.indexOf('-') > 0 ? entryKey.substring(0, entryKey.indexOf('-')) : '';
    const tempoKeys = new Set(tempoEntries.map((t) => t.issueKey));
    const tempoProjects = new Set(tempoEntries.map((t) => {
      const dash = t.issueKey.indexOf('-');
      return dash > 0 ? t.issueKey.substring(0, dash) : t.issueKey;
    }));

    if (entryKey && tempoKeys.has(entryKey)) return true;
    if (entryProject && tempoProjects.has(entryProject)) return true;

    // Total coverage: Tempo captured at least as much time as all coded entries
    const tempoTotalMin = tempoEntries.reduce((s, t) => s + t.minutes, 0);
    const codedTotalMin = dayEntries
      .filter((e) => e.jira_issue && e.status !== 'pushed' && e.status !== 'excluded')
      .reduce((s, e) => s + e.duration_minutes + (e.context_minutes || 0), 0);
    if (tempoTotalMin > 0 && tempoTotalMin >= codedTotalMin) return true;

    return false;
  };

  const readyCount = selDay ? selDay.entries.filter((e) => statusOf(e) === 'local' && !isAlreadyInTempo(e, selDay.entries)).length : 0;

  return (
    <>
      <div className={'detail-toggle-body' + (open ? ' open' : '')}>
        <div className="callegend" aria-label="Calendar status legend" style={{ display: 'flex', justifyContent: 'center', gap: 0, fontSize: 12, color: 'var(--slate-500)', marginBottom: 10, background: 'var(--slate-100)', borderRadius: 8, padding: '6px 14px' }}>
          <span style={{ flex: 1, textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}><i className="sw" style={{ background: 'var(--blue-50)', border: '1px solid var(--blue-200)' }}></i> Ready</span>
          <span style={{ flex: 1, textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}><i className="sw" style={{ background: 'var(--success-50)', border: '1px solid #bfe5cd' }}></i> In Jira</span>
          <span style={{ flex: 1, textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}><i className="sw" style={{ background: 'var(--gold-50)', border: '1px solid #eed9a0' }}></i> Needs code</span>
        </div>
        <div className="calhead">
          <div className="weeknav">
            <button className="btn btn-secondary btn-sm" onClick={() => shiftWeek(-1)}>Prev</button>
            <button className="btn btn-secondary btn-sm" onClick={() => shiftWeek(1)}>Next</button>
            <button className="btn btn-navy btn-sm" onClick={() => { setWeekOffset(0); setSelIdx(0); }}>This week</button>
            <span aria-live="polite" aria-atomic="true" style={{ fontWeight: 700, color: 'var(--slate-500)', fontSize: 13, minWidth: 150, textAlign: 'center' }}>{weekLabel}</span>
          </div>
        </div>

        {loading ? (
          <p style={{ color: 'var(--slate-400)', fontSize: 13, padding: 12 }}>Loading…</p>
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
                    if (day.entries.some((e) => statusOf(e) === 'block')) st = 'block';
                    else if (day.entries.some((e) => statusOf(e) === 'need')) st = 'need';
                    else if (day.entries.some((e) => statusOf(e) === 'local')) st = 'local';
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
                        <div key={i} className={'ent st-' + (isAlreadyInTempo(en, day.entries) ? 'cloud' : statusOf(en))}>
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
                    <p style={{ color: 'var(--slate-400)', padding: '10px 0' }}>No entries for this day.</p>
                  ) : (
                    <div style={{ overflowX: 'auto' }}>
                      <table className="table" style={{ minWidth: 760 }}>
                        <thead><tr><th>Entry</th><th>Status</th><th style={{ width: 230 }}>Jira activity</th><th>Hours</th><th>Action</th></tr></thead>
                        <tbody>
                          {selDay.entries.map((e) => {
                            const st = statusOf(e);
                            const [pillCls, pillLabel] = pillFor(st);
                            const hrs = Math.round((e.duration_minutes + (e.context_minutes || 0)) / 60 * 10) / 10;
                            return (
                              <tr key={e.id}>
                                <td>
                                  <div style={{ fontWeight: 600 }}>{e.title}</div>
                                  <div style={{ fontSize: 13, color: 'var(--slate-500)' }}>{e.source_type}</div>
                                </td>
                                <td><span className={'status-pill ' + (isAlreadyInTempo(e, selDay.entries) ? 'sp-green' : pillCls)}>{isAlreadyInTempo(e, selDay.entries) ? 'In Jira' : pillLabel}</span></td>
                                <td>
                                  {st === 'cloud' ? (
                                    <span className="issue-key">{e.jira_issue}</span>
                                  ) : isAlreadyInTempo(e, selDay.entries) ? (
                                    <span className="issue-key">{e.jira_issue || '--'}</span>
                                  ) : (
                                    <JiraInput entry={e} onSave={(issue) => updateEntry(e.id, { jira_issue: issue, jira_source: 'manual' })} />
                                  )}
                                </td>
                                <td>{hrs}h</td>
                                <td>
                                  {st === 'cloud' && <span className="status-pill sp-green">Pushed</span>}
                                  {st === 'local' && isAlreadyInTempo(e, selDay.entries) && <span className="status-pill sp-green">In Jira</span>}
                                  {st === 'local' && !isAlreadyInTempo(e, selDay.entries) && <button className="btn btn-primary btn-sm" disabled={pushing} onClick={() => pushEntry(e.id)}>Push</button>}
                                  {st === 'need' && <span className="status-pill sp-gold">Needs code</span>}
                                  {st === 'block' && <span className="status-pill sp-red">Blocked</span>}
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
                        Push {readyCount} ready entr{readyCount === 1 ? 'y' : 'ies'}
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

function JiraInput({ entry, onSave }: { entry: ApiEntry; onSave: (issue: string) => void }) {
  const [val, setVal] = useState(entry.jira_issue || '');
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
      <input
        className="input"
        style={{ padding: '7px 10px', borderColor: status === 'error' ? 'var(--danger-600)' : entry.jira_issue ? undefined : 'var(--gold-600)' }}
        value={val}
        onChange={(e) => { setVal(e.target.value); setStatus('idle'); setError(''); }}
        onBlur={() => validateAndSave(val)}
        onKeyDown={(e) => { if (e.key === 'Enter') validateAndSave(val); }}
        placeholder="Type a Jira issue..."
      />
      {status === 'validating' && <div style={{ fontSize: 13, color: 'var(--slate-500)', marginTop: 3 }}>Checking...</div>}
      {status === 'saved' && <div style={{ fontSize: 13, color: 'var(--success-600)', marginTop: 3 }}>Saved.</div>}
      {status === 'error' && <div style={{ fontSize: 13, color: 'var(--danger-600)', marginTop: 3 }}>{error}</div>}
    </div>
  );
}
