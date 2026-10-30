'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { AllocationCard, AllocRow } from '@/components/review/AllocationCard';
import { CalendarSection } from '@/components/review/CalendarSection';
import { AddProjectModal } from '@/components/review/AddProjectModal';
import { useSharedData } from '@/lib/data-context';
import { useConnection } from '@/lib/connection-context';
import { CalendarJiraMapping, getMappedJiraIssue, getTempoCoverageForEntries, TempoCoverage, TempoWorklog } from '@/lib/tempo-match';
import { computeWeekStats } from '@/lib/stats';
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
  jira_worklog_id: string | null;
}

function toIso(d: Date) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function mondayOf(offset: number): Date {
  const d = new Date(); const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff + offset * 7); d.setHours(0, 0, 0, 0); return d;
}
function mondayOfDate(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() - day + (day === 0 ? -6 : 1));
  d.setHours(0, 0, 0, 0);
  return d;
}
const mins = (e: ApiEntry) => e.duration_minutes;
const toH = (m: number) => Math.round((m / 60) * 10) / 10;

interface TempoHistoryCandidate {
  key: string;
  minutes: number;
  score: number;
  lastDate: string;
}

interface HistorySuggestion {
  key: string;
  name: string;
  score: number;
}

function buildTempoHistoryCandidates(
  worklogs: (TempoWorklog & { date: string })[],
  startDate: string,
  endDate: string
): TempoHistoryCandidate[] {
  const byIssue = new Map<string, TempoHistoryCandidate>();
  const startTime = new Date(startDate + 'T00:00:00').getTime();
  const endTime = new Date(endDate + 'T00:00:00').getTime();

  for (const worklog of worklogs) {
    const dayPart = (worklog.date || '').length >= 10 ? worklog.date.substring(0, 10) : worklog.date;
    if (!dayPart || dayPart < startDate || dayPart > endDate) continue;

    const key = (worklog.issueKey || '').toUpperCase();
    const minutes = worklog.minutes || 0;
    if (!key || minutes <= 0) continue;

    const daysAgo = Math.max(0, Math.round((endTime - new Date(dayPart + 'T00:00:00').getTime()) / 86400000));
    const recencyWeight = 1 / (daysAgo + 1);
    const current = byIssue.get(key) || { key, minutes: 0, score: 0, lastDate: dayPart };
    current.minutes += minutes;
    current.score += minutes * recencyWeight;
    if (dayPart > current.lastDate) current.lastDate = dayPart;
    byIssue.set(key, current);
  }

  return Array.from(byIssue.values())
    .filter((candidate) => candidate.score > 0 && candidate.lastDate >= startDate && startTime <= endTime)
    .sort((a, b) => b.score - a.score || b.lastDate.localeCompare(a.lastDate));
}

function proportionalPercents(scores: number[]): number[] {
  const total = scores.reduce((sum, score) => sum + score, 0);
  if (total <= 0) return scores.map(() => 0);
  const raw = scores.map((score) => Math.round((score / total) * 100 * 2) / 2);
  const assigned = raw.slice(0, -1).reduce((sum, pct) => sum + pct, 0);
  raw[raw.length - 1] = Math.round((100 - assigned) * 2) / 2;
  return raw;
}

export default function ReviewPage() {
  const { favorites, refreshFavorites } = useSharedData();
  const { outlookConnected } = useConnection();
  const [dayOffset, setDayOffset] = useState(0);
  const selectedDate = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    return d;
  }, [dayOffset]);
  const selectedDateKey = toIso(selectedDate);

  const [rows, setRows] = useState<AllocRow[]>([]);
  const rowsRef = useRef<AllocRow[]>([]);
  const [totalHours, setTotalHours] = useState(() => {
    try {
      const saved = localStorage.getItem('etta-alloc-total');
      if (saved) return parseFloat(saved) || 8;
    } catch { /* ignore */ }
    return 8;
  });
  const [meetingsHours, setMeetingsHours] = useState(0);
  const [tempoHours, setTempoHours] = useState(0);
  const [statsRefreshToken, setStatsRefreshToken] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [loading, setLoading] = useState(true);
  const [weekStats, setWeekStats] = useState({ captured: 0, meetings: 0, pushed: 0, review: 0, autoCoded: 0, total: 0 });
  const [weekStatuses, setWeekStatuses] = useState({ inJira: 0, ready: 0, needsCode: 0 });
  const [hasData, setHasData] = useState(false);
  const [dataRefreshToken, setDataRefreshToken] = useState(0);
  const hasLoadedOnceRef = useRef(false);
  const [estimates, setEstimates] = useState<Record<string, { remaining: number; hasEstimate: boolean; issueType: string; isOpen: boolean; statusName: string }>>({});
  const [historySuggestions, setHistorySuggestions] = useState<HistorySuggestion[]>([]);
  const statsRequestRef = useRef(0);
  const estimatesRef = useRef(estimates);
  useEffect(() => { estimatesRef.current = estimates; }, [estimates]);
  const favoritesRef = useRef(favorites);
  useEffect(() => { favoritesRef.current = favorites; }, [favorites]);
  useEffect(() => { rowsRef.current = rows; }, [rows]);

  useEffect(() => {
    try {
      if (localStorage.getItem('etta-calendar-open') === '1') {
        setCalendarOpen(true);
      }
    } catch { /* Keep the calendar closed if storage is unavailable. */ }
  }, []);

  // Auto-refresh estimates every 5 minutes so warnings stay current
  useEffect(() => {
    const interval = setInterval(() => {
      estimatesRef.current = {};
      setEstimates({});
    }, 300000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const refreshTempo = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => setStatsRefreshToken((token) => token + 1), 5000);
    };
    const handleVisible = () => {
      if (document.visibilityState === 'visible') refreshTempo();
    };
    window.addEventListener('focus', refreshTempo);
    document.addEventListener('visibilitychange', handleVisible);
    const interval = setInterval(refreshTempo, 60000);
    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      window.removeEventListener('focus', refreshTempo);
      document.removeEventListener('visibilitychange', handleVisible);
      clearInterval(interval);
    };
  }, []);

  // Load/save allocation state per day in localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(`etta-alloc-rows-${selectedDateKey}`);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          setRows(parsed);
          rowsRef.current = parsed;
          return;
        }
      }
      setRows([]);
      rowsRef.current = [];
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
            const ev = v as { remaining: number; hasEstimate: boolean; issueType: string; isOpen: boolean; statusName: string };
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
    const requestId = ++statsRequestRef.current;
    if (!hasLoadedOnceRef.current) setLoading(true);
    if (!hasLoadedOnceRef.current) {
      setTempoHours(0);
      setMeetingsHours(0);
    }
    const mon = mondayOfDate(selectedDate);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    const selectedIso = toIso(selectedDate);
    try {
      // Fetch Tempo worklogs for the FULL WEEK so we can dedup both the
      // summary stats and the per-day meeting/tempo calculations.
      let weekTempoResult: { success: boolean; totalMinutes?: number; entries?: (TempoWorklog & { date: string })[]; error?: string } = { success: false };
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
      if (requestId !== statsRequestRef.current) return;

      let calendarMappings: CalendarJiraMapping[] = [];
      try {
        const mappingsRes = await fetch('/api/calendar-mappings');
        const mappingsData = await mappingsRes.json();
        calendarMappings = mappingsData.mappings || [];
      } catch {
        calendarMappings = [];
      }
      if (requestId !== statsRequestRef.current) return;

      // Recent Tempo history seeds an empty allocation card with the issues
      // the user actually worked on most recently.
      const historyEnd = new Date(selectedDate);
      historyEnd.setDate(historyEnd.getDate() - 1);
      const historyStart = new Date(historyEnd);
      historyStart.setDate(historyStart.getDate() - 29);
      const windowStart = new Date();
      windowStart.setDate(windowStart.getDate() - 29);
      if (historyStart < windowStart) historyStart.setTime(windowStart.getTime());
      let recentTempoResult: { success: boolean; entries?: (TempoWorklog & { date: string })[] } = { success: false };
      try {
        const recentRes = await fetch('/api/jira/tempo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dateFrom: toIso(historyStart), dateTo: toIso(historyEnd) }),
        });
        recentTempoResult = await recentRes.json();
      } catch { /* Favorites remain the fallback. */ }

      const [weekRes, dayRes] = await Promise.all([
        fetch(`/api/entries?startDate=${toIso(mon)}&endDate=${toIso(sun)}`),
        fetch(`/api/entries?date=${selectedIso}`),
      ]);
      const weekData = await weekRes.json();
      const dayData = await dayRes.json();
      const weekEntries: ApiEntry[] = (weekData.entries || []).filter((entry: ApiEntry) => entry.status !== 'excluded');
      const dayEntries: ApiEntry[] = (dayData.entries || []).filter((entry: ApiEntry) => entry.status !== 'excluded');
      const weekHasData = weekEntries.length > 0;
      if (requestId !== statsRequestRef.current) return;
      setHasData(weekHasData);

      // Build per-day Tempo map for the week
      const weekTempoEntries = weekTempoResult.entries || [];
      const tempoByDay: Record<string, TempoWorklog[]> = {};
      for (const t of weekTempoEntries) {
        const dayPart = (t.date || '').length >= 10 ? (t.date || '').substring(0, 10) : (t.date || '');
        const d = new Date(dayPart + 'T00:00:00');
        const k = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
        (tempoByDay[k] = tempoByDay[k] || []).push({
          issueKey: (t.issueKey || '').toUpperCase(),
          minutes: t.minutes || 0,
          comment: t.comment || '',
        });
      }

      const entriesByDay: Record<string, ApiEntry[]> = {};
      for (const entry of weekEntries) {
        const d = new Date(entry.date + 'T00:00:00');
        const k = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
        (entriesByDay[k] = entriesByDay[k] || []).push(entry);
      }
      const coverageByDay: Record<string, Record<number, TempoCoverage>> = {};
      for (const [dayKey, dayEntriesForCoverage] of Object.entries(entriesByDay)) {
        coverageByDay[dayKey] = getTempoCoverageForEntries(
          dayEntriesForCoverage,
          tempoByDay[dayKey] || [],
          calendarMappings
        );
      }
      const coverageOf = (entry: ApiEntry): TempoCoverage => {
        const d = new Date(entry.date + 'T00:00:00');
        const k = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
        return coverageByDay[k]?.[entry.id] || 'none';
      };
      const hasAssignableIssue = (entry: ApiEntry) =>
        Boolean(entry.jira_issue || getMappedJiraIssue(entry, calendarMappings));

      const sharedStats = computeWeekStats(weekEntries, tempoByDay, calendarMappings);
      setWeekStats({
        captured: toH(sharedStats.capturedMinutes),
        meetings: toH(sharedStats.meetingMinutes),
        pushed: toH(sharedStats.pushedMinutes),
        review: toH(sharedStats.reviewMinutes),
        autoCoded: weekEntries.filter((e) => hasAssignableIssue(e)).length,
        total: sharedStats.entryCount,
      });

      setWeekStatuses({
        inJira: sharedStats.inJiraCount,
        ready: sharedStats.readyCount,
        needsCode: sharedStats.needsCodeCount,
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

      // Count only meetings that do not already have a matching Tempo worklog.
      const dayMeetings = dayEntries.filter((e) => e.source_type === 'meeting');
      const tempoTotalMin = tempoResult.totalMinutes || 0;

      let newMeetingMinutes = 0;
      const selectedCoverage = coverageByDay[
        selectedDate.getFullYear() + '-' + selectedDate.getMonth() + '-' + selectedDate.getDate()
      ] || {};
      for (const meeting of dayMeetings) {
        if (selectedCoverage[meeting.id] === 'none') {
          newMeetingMinutes += mins(meeting);
        }
      }
      setMeetingsHours(newMeetingMinutes / 60);
      setTempoHours(tempoTotalMin / 60);

      const hasSavedRows = rowsRef.current.some((row) => row.key.trim().length > 0);
      if (requestId !== statsRequestRef.current) return;
      const recentTempoCandidates = recentTempoResult.success
        ? buildTempoHistoryCandidates(
            recentTempoResult.entries || [],
            toIso(historyStart),
            toIso(historyEnd)
          )
        : [];

      // Recent Tempo history is the strongest signal of what a user works on.
      // Validate the top candidates once so both the empty-card seeding and the
      // fill-to-8-hours suggestion can rely on real issue names.
      const favoriteMap = new Map(
        favoritesRef.current.map((favorite) => [favorite.jira_key.toUpperCase(), favorite.short_name || favorite.jira_name])
      );
      const selected: HistorySuggestion[] = [];
      for (const candidate of recentTempoCandidates) {
        if (selected.some((item) => item.key === candidate.key)) continue;
        const favoriteName = favoriteMap.get(candidate.key);

        if (favoriteName) {
          selected.push({ key: candidate.key, name: favoriteName, score: candidate.score });
        } else {
          try {
            const validateRes = await fetch('/api/jira/validate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jira_key: candidate.key }),
            });
            const validateData = await validateRes.json().catch(() => ({ valid: false }));
            if (!validateData.valid) continue;
            const name = validateData.jira_name || candidate.key;
            selected.push({ key: candidate.key, name, score: candidate.score });
            if (!hasSavedRows) {
              await fetch('/api/favorites', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jira_key: candidate.key, jira_name: name }),
              }).catch(() => {});
            }
          } catch { continue; }
        }
        if (selected.length === 3) break;
      }
      if (requestId !== statsRequestRef.current) return;
      setHistorySuggestions(selected);

      // Seed the card whenever the selected day has no saved allocation rows.
      let seeded = false;
      if (!hasSavedRows && selected.length > 0) {
        if (requestId !== statsRequestRef.current) return;
        const percentages = proportionalPercents(selected.map((item) => item.score));
        const seededRows = selected.map((item, index) => ({
          key: item.key,
          name: item.name,
          pct: percentages[index],
          locked: false,
        }));
        rowsRef.current = seededRows;
        setRows(seededRows);
        await refreshFavorites();
        seeded = true;
      }

      if (!hasSavedRows && !seeded && dayEntries.length > 0) {
        const issueMap = new Map<string, { name: string; mins: number }>();
        dayEntries.forEach((entry) => {
          if (!entry.jira_issue || entry.status === 'excluded') return;
          const current = issueMap.get(entry.jira_issue) || { name: entry.jira_name || entry.jira_issue, mins: 0 };
          current.mins += mins(entry);
          issueMap.set(entry.jira_issue, current);
        });

        if (issueMap.size > 0) {
          const totalIssueMins = Array.from(issueMap.values()).reduce((sum, value) => sum + value.mins, 0);
          const seededRows = Array.from(issueMap.entries()).map(([key, value]) => ({
            key,
            name: value.name,
            pct: totalIssueMins > 0 ? Math.round((value.mins / totalIssueMins) * 100 * 2) / 2 : 0,
            locked: false,
          }));
          rowsRef.current = seededRows;
          setRows(seededRows);
          seeded = true;
        }
      }

      if (!hasSavedRows && !seeded && favoritesRef.current.length > 0) {
        const top = favoritesRef.current.slice(0, 3);
        const even = Math.round((100 / top.length) * 2) / 2;
        const seededRows = top.map((favorite, index) => ({
          key: favorite.jira_key,
          name: favorite.short_name || favorite.jira_name,
          pct: index === top.length - 1 ? Math.round((100 - even * (top.length - 1)) * 2) / 2 : even,
          locked: false,
        }));
        rowsRef.current = seededRows;
        setRows(seededRows);
      }
    } catch {
      if (requestId !== statsRequestRef.current) return;
      setHasData(false);
    } finally {
      if (requestId === statsRequestRef.current) {
        if (!hasLoadedOnceRef.current) setLoading(false);
        hasLoadedOnceRef.current = true;
      }
    }
  }, [selectedDate, refreshFavorites, statsRefreshToken]);

  useEffect(() => {
    const refresh = () => fetchStats();
    const interval = setInterval(refresh, 300000);
    return () => {
      clearInterval(interval);
    };
  }, [fetchStats]);

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

  const syncCalendar = useCallback(async (rangeStart?: Date, rangeEnd?: Date) => {
    setSyncing(true);
    setSyncMsg('');
    try {
      const mon = new Date(rangeStart || new Date(new Date().setDate(new Date().getDate() - 13)));
      mon.setHours(0, 0, 0, 0);
      const sun = new Date(rangeEnd || new Date());
      sun.setHours(23, 59, 59, 999);
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
          const text = decoder.decode(chunk?.value);
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
                        setDataRefreshToken((token) => token + 1);
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

  // Backfill older weeks on demand: navigating past the 14-day auto-sync window
  // pulls that week's calendar data once per session, per Chris's request that
  // PREV "sync one more week at a time" (ETTA-117).
  const backfillKeyRef = useRef<string | null>(null);
  const selectedWeekStart = useMemo(() => mondayOfDate(selectedDate), [selectedDate]);
  const selectedWeekNeedsSync = useMemo(() => {
    const coveredStart = new Date();
    coveredStart.setDate(coveredStart.getDate() - 13);
    coveredStart.setHours(0, 0, 0, 0);
    return selectedWeekStart.getTime() < coveredStart.getTime();
  }, [selectedWeekStart]);

  useEffect(() => {
    if (!outlookConnected || !selectedWeekNeedsSync) return;
    const key = toIso(selectedWeekStart);
    if (backfillKeyRef.current === key) return;
    backfillKeyRef.current = key;
    const sun = new Date(selectedWeekStart);
    sun.setDate(selectedWeekStart.getDate() + 6);
    sun.setHours(23, 59, 59, 999);
    void syncCalendar(selectedWeekStart, sun);
  }, [outlookConnected, selectedWeekNeedsSync, selectedWeekStart, syncCalendar]);

  const dateLabel = useMemo(() => {
    return selectedDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  }, [selectedDate]);
  const selectedDateLabel = dayOffset === 0 ? `Today - ${dateLabel}` : dateLabel;

  const toggleCalendar = () => {
    const nextOpen = !calendarOpen;
    setCalendarOpen(nextOpen);
    try {
      localStorage.setItem('etta-calendar-open', nextOpen ? '1' : '0');
    } catch { /* Ignore storage failures. */ }
  };

  if (loading) {
    return (
      <div>
        <div style={{ background: 'var(--slate-100)', borderRadius: 12, padding: 40, textAlign: 'center' }}>
          <div className="text-muted">Gathering entries from your calendar and Jira...</div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {!hasData && !outlookConnected && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, background: 'var(--blue-50)', border: '1px solid var(--blue-200)', borderRadius: 12, padding: 16, marginBottom: 18 }}>
          <div className="text-muted">
            <b style={{ color: 'var(--navy)' }}>No calendar data yet.</b> <Link href="/settings" style={{ color: 'var(--blue-600)', fontWeight: 600, textDecoration: 'underline' }}>Connect Outlook in Settings</Link> to fill your weekly calendar automatically. You can still add projects and allocate time below.
          </div>
        </div>
      )}

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="btn btn-secondary btn-sm" onClick={() => setDayOffset(d => Math.max(d - 1, -29))} disabled={dayOffset < -28}>Prev</button>
          <span aria-live="polite" aria-atomic="true" style={{ fontSize: 15, fontWeight: 700, color: 'var(--navy)', padding: '4px 10px', minWidth: 170, textAlign: 'center' }}>{selectedDateLabel}</span>
          {dayOffset !== 0 && (
            <button className="btn btn-navy btn-sm" onClick={() => setDayOffset(0)}>Jump to today</button>
          )}
          <button className="btn btn-secondary btn-sm" onClick={() => setDayOffset(d => d + 1)} disabled={dayOffset >= 0}>Next</button>
          {selectedWeekNeedsSync && (
            <button
              className="btn btn-navy btn-sm"
              onClick={() => {
                const sun = new Date(selectedWeekStart);
                sun.setDate(selectedWeekStart.getDate() + 6);
                sun.setHours(23, 59, 59, 999);
                void syncCalendar(selectedWeekStart, sun);
              }}
              disabled={syncing}
            >
              {syncing ? 'Syncing...' : 'Sync this week'}
            </button>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {syncing && <span className="text-muted">Syncing calendar...</span>}
          {syncMsg && !syncing && <span className="text-muted">{syncMsg}</span>}
          {outlookConnected && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button className="btn btn-secondary btn-sm" onClick={() => void syncCalendar()} style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>Re-sync</button>
              <span className="text-muted" style={{ fontSize: 13 }}>Calendar auto-refreshes every 5 min</span>
            </div>
          )}
          {!outlookConnected && (
            <Link href="/settings" style={{ fontSize: 13, color: 'var(--danger-600)', fontWeight: 600, textDecoration: 'underline', display: 'flex', alignItems: 'center', gap: 4 }}>
              Connect Outlook
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
        historySuggestions={historySuggestions}
        setTotalHours={setTotalHours}
        unassigned={unassigned}
        onAddToActive={onAddToActive}
        onRemoveFromActive={onRemoveFromActive}
        onDeleteUnassigned={onDeleteUnassigned}
        onAddProject={() => setAddOpen(true)}
        selectedDateKey={selectedDateKey}
        estimates={estimates}
        onPushed={fetchStats}
      />

      {/* Calendar summary + toggle */}
      <div className="calendar-summary" style={{ marginTop: 12, marginBottom: 10 }}>
        {[
          {
            label: 'Auto-gathered',
            value: weekStats.captured + 'h',
            color: 'var(--blue-600)',
            status: {
              className: 'sp-navy',
              text: 'Ready',
              title: `${weekStatuses.ready} entr${weekStatuses.ready === 1 ? 'y' : 'ies'} ready to push`,
            },
          },
          {
            label: 'Pushed',
            value: weekStats.pushed + 'h',
            color: 'var(--success-600)',
            status: {
              className: 'sp-green',
              text: 'In Jira',
              title: `${weekStatuses.inJira} entr${weekStatuses.inJira === 1 ? 'y' : 'ies'} already in Jira`,
            },
          },
          {
            label: 'To review',
            value: weekStats.review + 'h',
            color: 'var(--gold-600)',
            status: {
              className: 'sp-gold',
              text: 'Needs code',
              title: `${weekStatuses.needsCode} entr${weekStatuses.needsCode === 1 ? 'y' : 'ies'} need a code`,
            },
          },
        ].map((summary) => (
          <div key={summary.label} className="calendar-summary-cell">
            <div className="calendar-summary-head">
              <span style={{ color: summary.color }}>{summary.label}</span>
              {summary.status && (
                <span className={'status-pill ' + summary.status.className} title={summary.status.title}>
                  {summary.status.text}
                </span>
              )}
            </div>
            <span className="calendar-summary-value" style={{ color: summary.color }}>{summary.value}</span>
          </div>
        ))}
        <button
          className="btn btn-secondary btn-sm"
          style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}
          onClick={toggleCalendar}
          aria-expanded={calendarOpen}
          aria-controls="calendar-section"
          title={calendarOpen ? 'Hide meetings' : 'Review meetings'}
        >
          <span>{calendarOpen ? 'Hide meetings' : 'Review meetings'}</span>
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
            style={{ transition: 'transform 180ms ease', transform: calendarOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}
          >
            <path d="M3 6l5 5 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <CalendarSection open={calendarOpen} setOpen={setCalendarOpen} refreshToken={dataRefreshToken} onDataChange={fetchStats} initialSelectedDate={selectedDate} />

      <AddProjectModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={onAddedProject}
        existingKeys={favorites.map((f) => f.jira_key)}
      />
    </div>
  );
}

