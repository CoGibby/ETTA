'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { AllocationCard, AllocRow, fmtHrsMin } from '@/components/review/AllocationCard';
import { CalendarSection } from '@/components/review/CalendarSection';
import { AddProjectModal } from '@/components/review/AddProjectModal';
import { useSharedData } from '@/lib/data-context';
import { useConnection } from '@/lib/connection-context';
import Link from 'next/link';

interface ApiEntry {
  id: number;
  source_type: 'email' | 'meeting' | 'manual';
  title: string;
  date: string;
  duration_minutes: number;
  context_minutes: number;
  jira_issue: string | null;
  jira_name: string | null;
  status: 'pending' | 'pushed' | 'excluded';
}

function toIso(d: Date) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function mondayOf(offset: number): Date {
  const d = new Date(); const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff + offset * 7); d.setHours(0, 0, 0, 0); return d;
}
const mins = (e: ApiEntry) => e.duration_minutes + (e.context_minutes || 0);
const toH = (m: number) => Math.round((m / 60) * 10) / 10;

export default function ReviewPage() {
  const { favorites, refreshFavorites } = useSharedData();
  const { outlookConnected } = useConnection();
  const autoPopulated = useRef(false);
  const [dayOffset, setDayOffset] = useState(0);
  const selectedDate = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    return d;
  }, [dayOffset]);
  const selectedDateKey = toIso(selectedDate);

  const [rows, setRows] = useState<AllocRow[]>(() => {
    try {
      const saved = localStorage.getItem('etta-alloc-rows-today');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          autoPopulated.current = true;
          return parsed;
        }
      }
    } catch { /* ignore */ }
    return [];
  });
  const [totalHours, setTotalHours] = useState(() => {
    try {
      const saved = localStorage.getItem('etta-alloc-total');
      if (saved) return parseFloat(saved) || 8;
    } catch { /* ignore */ }
    return 8;
  });
  const [meetingsHours, setMeetingsHours] = useState(0);
  const [tempoHours, setTempoHours] = useState(0);
  const [tempoEntries, setTempoEntries] = useState<{ issueKey: string; minutes: number; date: string }[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [loading, setLoading] = useState(true);
  const [weekStats, setWeekStats] = useState({ captured: 0, meetings: 0, pushed: 0, review: 0, autoCoded: 0, total: 0 });
  const [hasData, setHasData] = useState(false);
  const [weekTempoByDay, setWeekTempoByDay] = useState<Record<string, { issueKey: string; minutes: number }[]>>({});
  const [estimates, setEstimates] = useState<Record<string, { remaining: number; hasEstimate: boolean; issueType: string; isOpen: boolean; statusName: string }>>({});
  const estimatesRef = useRef(estimates);
  useEffect(() => { estimatesRef.current = estimates; }, [estimates]);

  // Auto-refresh estimates every 5 minutes so warnings stay current
  useEffect(() => {
    const interval = setInterval(() => {
      estimatesRef.current = {};
      setEstimates({});
    }, 300000);
    return () => clearInterval(interval);
  }, []);

  // Load/save allocation state per day in localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(`etta-alloc-rows-${selectedDateKey}`);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          setRows(parsed);
          autoPopulated.current = true;
          return;
        }
      }
      setRows([]);
      autoPopulated.current = false;
    } catch { /* ignore */ }
  }, [selectedDateKey]);

  useEffect(() => {
    try {
      localStorage.setItem(`etta-alloc-rows-${selectedDateKey}`, JSON.stringify(rows));
      localStorage.setItem('etta-alloc-total', String(totalHours));
    } catch { /* ignore */ }
  }, [rows, totalHours, selectedDateKey]);

  // Fetch time estimates for active issue keys (for over-estimate warnings)
  useEffect(() => {
    if (rows.length === 0) return;
    const keysToFetch = rows.map((r) => r.key).filter((k) => !(k.toUpperCase() in estimatesRef.current));
    if (keysToFetch.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/jira/estimate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keys: keysToFetch }),
        });
        const data = await res.json();
        if (!cancelled && data.success && data.estimates) {
          const upperEstimates: Record<string, { remaining: number; hasEstimate: boolean; issueType: string; isOpen: boolean; statusName: string }> = {};
          for (const [k, v] of Object.entries(data.estimates)) {
            const ev = v as { remaining: number; hasEstimate: boolean; issueType: string };
            upperEstimates[k.toUpperCase()] = ev;
          }
          setEstimates((prev) => ({ ...prev, ...upperEstimates }));
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const activeKeys = useMemo(() => new Set(rows.map((r) => r.key)), [rows]);
  const unassigned = useMemo(
    () => favorites.filter((f) => !activeKeys.has(f.jira_key)).map((f) => ({ id: f.id, key: f.jira_key, name: f.short_name || f.jira_name })),
    [favorites, activeKeys]
  );

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setTempoHours(0);
    setTempoEntries([]);
    const mon = mondayOf(0);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    const selectedIso = toIso(selectedDate);
    try {
      const [weekRes, dayRes] = await Promise.all([
        fetch(`/api/entries?startDate=${toIso(mon)}&endDate=${toIso(sun)}`),
        fetch(`/api/entries?date=${selectedIso}`),
      ]);
      const weekData = await weekRes.json();
      const dayData = await dayRes.json();
      const weekEntries: ApiEntry[] = weekData.entries || [];
      const dayEntries: ApiEntry[] = dayData.entries || [];
      const weekHasData = weekEntries.length > 0;
      setHasData(weekHasData);

      // Fetch Tempo worklogs for the FULL WEEK so we can dedup both the
      // summary stats and the per-day meeting/tempo calculations.
      let weekTempoResult: { success: boolean; totalMinutes?: number; entries?: { issueKey: string; minutes: number; date: string }[]; error?: string } = { success: false };
      try {
        const tempoRes = await fetch('/api/jira/tempo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dateFrom: toIso(mon), dateTo: toIso(sun) }),
        });
        weekTempoResult = await tempoRes.json();
        if (!weekTempoResult.success && weekTempoResult.error) {
          console.log('Tempo fetch note:', weekTempoResult.error);
        }
      } catch (e) {
        console.log('Tempo not available:', e instanceof Error ? e.message : 'unknown');
      }

      // Build per-day Tempo map for the week
      const weekTempoEntries = weekTempoResult.entries || [];
      const tempoByDay: Record<string, { issueKey: string; minutes: number }[]> = {};
      for (const t of weekTempoEntries) {
        const dayPart = (t.date || '').length >= 10 ? (t.date || '').substring(0, 10) : (t.date || '');
        const d = new Date(dayPart + 'T00:00:00');
        const k = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
        (tempoByDay[k] = tempoByDay[k] || []).push({ issueKey: (t.issueKey || '').toUpperCase(), minutes: t.minutes || 0 });
      }
      setWeekTempoByDay(tempoByDay);

      // Check if a specific entry is already covered by Tempo for its day.
      // Uses the same multi-strategy matching as the allocation and calendar views.
      const isInTempo = (entry: ApiEntry, dayEntries: ApiEntry[]): boolean => {
        const d = new Date(entry.date + 'T00:00:00');
        const k = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
        const dayTempo = tempoByDay[k];
        if (!dayTempo || dayTempo.length === 0) return false;
        const entryKey = (entry.jira_issue || '').toUpperCase();
        const entryProject = entryKey.indexOf('-') > 0 ? entryKey.substring(0, entryKey.indexOf('-')) : '';
        const tempoKeys = new Set(dayTempo.map((t) => t.issueKey));
        const tempoProjects = new Set(dayTempo.map((t) => {
          const dash = t.issueKey.indexOf('-');
          return dash > 0 ? t.issueKey.substring(0, dash) : t.issueKey;
        }));
        if (entryKey && tempoKeys.has(entryKey)) return true;
        if (entryProject && tempoProjects.has(entryProject)) return true;
        const tempoTotalMin = dayTempo.reduce((s, t) => s + t.minutes, 0);
        const codedTotalMin = dayEntries
          .filter((e) => e.jira_issue && e.status !== 'excluded')
          .reduce((s, e) => s + mins(e), 0);
        if (tempoTotalMin > 0 && tempoTotalMin >= codedTotalMin) return true;
        return false;
      };

      // Group week entries by date string for per-day dedup checks
      const entriesByDate: Record<string, ApiEntry[]> = {};
      weekEntries.forEach((e) => {
        (entriesByDate[e.date] = entriesByDate[e.date] || []).push(e);
      });

      setWeekStats({
        captured: toH(weekEntries.reduce((s, e) => s + mins(e), 0)),
        meetings: toH(weekEntries.filter((e) => e.source_type === 'meeting').reduce((s, e) => s + mins(e), 0)),
        pushed: toH(weekEntries.filter((e) => e.status === 'pushed' || (e.status === 'pending' && isInTempo(e, entriesByDate[e.date] || []))).reduce((s, e) => s + mins(e), 0)),
        review: toH(weekEntries.filter((e) => e.status === 'pending' && !isInTempo(e, entriesByDate[e.date] || [])).reduce((s, e) => s + mins(e), 0)),
        autoCoded: weekEntries.filter((e) => e.jira_issue).length,
        total: weekEntries.length,
      });

      // Filter Tempo to just the selected day for the per-day allocation logic
      const selectedTempoEntries = weekTempoEntries.filter((t) => {
        const dayPart = (t.date || '').length >= 10 ? (t.date || '').substring(0, 10) : (t.date || '');
        return dayPart === selectedIso;
      });
      const tempoResult = {
        success: weekTempoResult.success,
        totalMinutes: selectedTempoEntries.reduce((s, t) => s + (t.minutes || 0), 0),
        entries: selectedTempoEntries,
      };

      // Compute meetings hours, excluding meetings already logged in Tempo.
      // Three matching strategies detect if a calendar meeting was already
      // manually logged in Tempo (possibly under a different issue key):
      // 1. Exact issue key match (SVCOPS-652 == SVCOPS-652)
      // 2. Same project prefix (SVCOPS-652 matches SVCOPS-648 by "SVCOPS")
      // 3. Tempo total >= total meeting time (Tempo captured the full day)
      const dayMeetings = dayEntries.filter((e) => e.source_type === 'meeting');
      const tempoEntriesList = tempoResult.entries || [];
      const tempoIssueKeys = new Set(
        tempoEntriesList.map((t) => (t.issueKey || '').toUpperCase())
      );
      const tempoProjects = new Set(
        tempoEntriesList.map((t) => {
          const key = (t.issueKey || '').toUpperCase();
          const dash = key.indexOf('-');
          return dash > 0 ? key.substring(0, dash) : key;
        })
      );
      const tempoTotalMin = tempoResult.totalMinutes || 0;
      const totalMeetingMin = dayMeetings.reduce((s, m) => s + mins(m), 0);
      const tempoCapturedAll = tempoTotalMin > 0 && tempoTotalMin >= totalMeetingMin;

      let newMeetingMinutes = 0;
      for (const m of dayMeetings) {
        const mMinutes = mins(m);
        const mKey = (m.jira_issue || '').toUpperCase();
        const mProject = mKey.indexOf('-') > 0 ? mKey.substring(0, mKey.indexOf('-')) : '';
        const exactMatch = mKey && tempoIssueKeys.has(mKey);
        const projectMatch = mProject && tempoProjects.has(mProject);
        if (exactMatch || projectMatch || tempoCapturedAll) {
          // Meeting already accounted for in Tempo — skip it
        } else {
          newMeetingMinutes += mMinutes;
        }
      }
      setMeetingsHours(toH(newMeetingMinutes));
      setTempoHours(toH(tempoTotalMin));
      setTempoEntries(tempoEntriesList);

      // Auto-populate allocation bars from today's entries (only once)
      if (!autoPopulated.current && dayEntries.length > 0) {
        autoPopulated.current = true;
        const issueMap = new Map<string, { name: string; mins: number }>();
        dayEntries.forEach((e) => {
          if (!e.jira_issue) return;
          const cur = issueMap.get(e.jira_issue) || { name: e.jira_name || e.jira_issue, mins: 0 };
          cur.mins += mins(e);
          issueMap.set(e.jira_issue, cur);
        });
        if (issueMap.size > 0) {
          const totalIssueMins = Array.from(issueMap.values()).reduce((s, v) => s + v.mins, 0);
          const newRows: AllocRow[] = Array.from(issueMap.entries()).map(([key, v]) => ({
            key,
            name: v.name,
            pct: totalIssueMins > 0 ? Math.round((v.mins / totalIssueMins) * 100 * 2) / 2 : 0,
            locked: false,
          }));
          setRows(newRows);
        }
      }
    } catch {
      setHasData(false);
    } finally {
      setLoading(false);
    }
  }, [selectedDate]);

  // Auto-sync calendar on load if Outlook is connected and no recent sync
  const autoSynced = useRef(false);
  useEffect(() => {
    if (autoSynced.current || loading) return;
    autoSynced.current = true;
    // Check if Outlook is connected before auto-syncing
    fetch('/api/outlook/status').then(res => res.json()).then(data => {
      if (data.connected) {
        const lastSync = localStorage.getItem('etta-last-sync');
        const now = Date.now();
        // Only auto-sync if no sync in the last 10 minutes
        if (!lastSync || now - parseInt(lastSync) > 600000) {
          syncCalendar();
        }
      }
    }).catch(() => { /* ignore */ });
  }, [loading]);

  useEffect(() => { fetchStats(); }, [fetchStats]);

  // Pre-populate favorites as allocation rows if user has favorites but no rows yet
  useEffect(() => {
    if (!autoPopulated.current && !loading && rows.length === 0 && favorites.length > 0 && !hasData) {
      autoPopulated.current = true;
      const top = favorites.slice(0, 3);
      const even = Math.round(100 / top.length * 2) / 2;
      setRows(top.map((f, i) => ({
        key: f.jira_key,
        name: f.short_name || f.jira_name,
        pct: i === top.length - 1 ? Math.round((100 - even * (top.length - 1)) * 2) / 2 : even,
        locked: false,
      })));
    }
  }, [favorites, rows.length, loading, hasData]);

  const onAddToActive = useCallback((key: string, name: string) => {}, []);
  const onRemoveFromActive = useCallback((key: string, name: string) => {}, []);

  const onDeleteUnassigned = useCallback(async (id: number, key: string) => {
    try {
      await fetch(`/api/favorites/${id}`, { method: 'DELETE' });
      await refreshFavorites();
    } catch {
      // ignore
    }
  }, [refreshFavorites]);

  const onAddedProject = useCallback((key: string, name: string) => {
    refreshFavorites();
  }, [refreshFavorites]);

  const syncCalendar = useCallback(async () => {
    setSyncing(true);
    setSyncMsg('');
    try {
      const mon = mondayOf(-3);
      const sun = new Date(mondayOf(0));
      sun.setDate(sun.getDate() + 6);
      const res = await fetch('/api/sources/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startDate: toIso(mon), endDate: toIso(sun) }),
      });
      if (res.ok) {
        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        let done = false;
        while (!done) {
          const chunk = await reader?.read();
          if (chunk?.done) { done = true; break; }
          const text = decoder.decode(chunk?.value || '');
          const lines = text.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.type === 'progress') {
                  setSyncMsg(data.message || 'Syncing...');
                } else if (data.type === 'complete') {
                  if (data.success) {
                    setSyncMsg(`Synced ${data.total} items. Generating entries...`);
                    // Now generate entries from the synced sources
                    try {
                      const genRes = await fetch('/api/entries/generate', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ startDate: toIso(mon), endDate: toIso(sun), overwrite: true }),
                      });
                      const genData = await genRes.json();
                      if (genData.success) {
                        setSyncMsg(`Synced ${data.total} items, generated ${genData.generated} entries (${genData.skipped} skipped).`);
                      } else {
                        setSyncMsg(`Synced ${data.total} items. Entry generation failed: ${genData.error || 'unknown error'}.`);
                      }
                    } catch {
                      setSyncMsg(`Synced ${data.total} items, but entry generation failed.`);
                    }
                  } else {
                    setSyncMsg(data.error || 'Sync completed with errors.');
                  }
                  await fetchStats();
                } else if (data.type === 'error') {
                  setSyncMsg(data.error || 'Sync failed.');
                }
              } catch { /* ignore parse */ }
            }
          }
        }
      } else {
        const data = await res.json().catch(() => ({}));
        setSyncMsg(data.error || 'Sync failed.');
      }
    } catch {
      setSyncMsg('Network error during sync.');
    } finally {
      setSyncing(false);
      localStorage.setItem('etta-last-sync', String(Date.now()));
    }
  }, [fetchStats]);

  const dateLabel = useMemo(() => {
    if (dayOffset === 0) return 'Today';
    return selectedDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }, [dayOffset, selectedDate]);

  if (loading) {
    return (
      <div style={{ maxWidth: 980, margin: '0 auto' }}>
        <h2 style={{ fontSize: 24, fontWeight: 700, color: 'var(--navy)', marginBottom: 4 }}>Review</h2>
        <p style={{ color: 'var(--slate-400)', fontSize: 13, marginBottom: 14 }}>Loading your week...</p>
        <div style={{ background: 'var(--slate-100)', borderRadius: 12, padding: 40, textAlign: 'center' }}>
          <div style={{ color: 'var(--slate-400)', fontSize: 14 }}>Gathering entries from your calendar and Jira...</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 980, margin: '0 auto' }}>
      <h2 style={{ fontSize: 24, fontWeight: 700, color: 'var(--navy)', marginBottom: 4 }}>Review</h2>
      <p style={{ color: 'var(--slate-500)', fontSize: 13, marginBottom: 14 }}>
        ETTA auto-gathers from Outlook and Jira. Review your day below, then push to Jira.
      </p>

      {!hasData && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, background: 'var(--blue-50)', border: '1px solid var(--blue-200)', borderRadius: 12, padding: 16, marginBottom: 18 }}>
          <div style={{ flexShrink: 0, marginTop: 1, color: 'var(--blue-600)' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
          </div>
          <div style={{ fontSize: 13.5, color: 'var(--slate-500)' }}>
            <b style={{ color: 'var(--navy)' }}>No calendar data yet.</b> <Link href="/settings" style={{ color: 'var(--blue-600)', fontWeight: 600, textDecoration: 'underline' }}>Connect Outlook in Settings</Link> to fill your weekly calendar automatically. You can still add projects and allocate time below.
          </div>
        </div>
      )}

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="btn btn-secondary btn-sm" onClick={() => setDayOffset(d => d - 1)}>Prev</button>
          {dayOffset === 0 ? (
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--navy)', padding: '4px 12px' }}>Today</span>
          ) : (
            <button className="btn btn-navy btn-sm" onClick={() => setDayOffset(0)} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span>Today</span>
              <span style={{ fontSize: 11, opacity: 0.7 }}>({dateLabel})</span>
            </button>
          )}
          <button className="btn btn-secondary btn-sm" onClick={() => setDayOffset(d => d + 1)} disabled={dayOffset >= 0}>Next</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {syncing && <span style={{ fontSize: 13, color: 'var(--slate-500)' }}>Syncing calendar...</span>}
          {syncMsg && !syncing && <span style={{ fontSize: 13, color: 'var(--slate-500)' }}>{syncMsg}</span>}
          {!syncing && !syncMsg && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button className="btn btn-secondary btn-sm" onClick={syncCalendar} style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>Re-sync</button>
            </div>
          )}
          {!outlookConnected && (
            <Link href="/settings" style={{ fontSize: 13, color: 'var(--danger-600)', fontWeight: 600, textDecoration: 'underline', display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 16 }}>!</span> Connect Outlook
            </Link>
          )}
        </div>
      </div>

      <AllocationCard
        rows={rows}
        setRows={setRows}
        totalHours={totalHours}
        meetingsHours={meetingsHours}
        tempoHours={tempoHours}
        setTotalHours={setTotalHours}
        unassigned={unassigned}
        onAddToActive={onAddToActive}
        onRemoveFromActive={onRemoveFromActive}
        onDeleteUnassigned={onDeleteUnassigned}
        onAddProject={() => setAddOpen(true)}
        dateLabel={dateLabel}
        selectedDateKey={selectedDateKey}
        estimates={estimates}
      />

      {/* Summary strip + calendar toggle */}
      <div style={{ marginTop: 20, marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--navy)' }}>Captured from calendar &amp; email</h3>
          <span style={{ fontSize: 13, color: 'var(--slate-400)' }}>Auto-gathered by ETTA</span>
          <button
            className="btn btn-secondary btn-sm"
            style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0, fontSize: 13 }}
            onClick={() => setCalendarOpen(!calendarOpen)}
          >
            {calendarOpen ? 'Hide meetings' : 'Review meetings'}
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 0, background: 'var(--slate-100)', borderRadius: 8, padding: '8px 14px' }}>
          {[
            { label: 'Auto-gathered', val: weekStats.captured + 'h', color: 'var(--blue-600)' },
            { label: 'Pushed', val: weekStats.pushed + 'h', color: 'var(--success-600)' },
            { label: 'To review', val: weekStats.review + 'h', color: 'var(--gold-600)' },
          ].map((s, i) => (
            <div key={i} style={{ textAlign: 'center', flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {i > 0 && <div style={{ width: 1, height: 24, background: 'var(--slate-200)', marginRight: 14 }}></div>}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <span style={{ fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.03em', color: s.color }}>{s.label}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: s.color, marginLeft: 4 }}>{s.val}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <CalendarSection open={calendarOpen} setOpen={setCalendarOpen} />

      <AddProjectModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={onAddedProject}
        existingKeys={favorites.map((f) => f.jira_key)}
      />
    </div>
  );
}
