'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { CalendarJiraMapping, getMappedJiraIssue, getTempoCoverageForEntries, TempoCoverage, TempoWorklog } from '@/lib/tempo-match';
import { useConnection } from '@/lib/connection-context';
import { JiraIssueAutocomplete } from './JiraIssueAutocomplete';
import { IconCalendarEvent, IconMail, IconUser } from '@tabler/icons-react';
import { cleanEmailTitle } from '@/lib/title-clean';

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
  conversation_id: string | null;
  external_id: string | null;
}

interface DisplayEntry extends ApiEntry {
  entryIds: number[];
  emailCount: number;
  underlying: ApiEntry[];
}

interface ExclusionRule {
  id: number;
  title: string;
  sourceType: 'meeting' | 'email' | 'manual' | 'all';
  externalId: string | null;
}

type CellStatus = 'cloud' | 'likely' | 'local' | 'need' | 'block' | 'empty' | 'partial' | 'excluded';

function statusOf(e: DisplayEntry): CellStatus {
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
function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const remainder = total % 60;
  if (hours === 0) return remainder + 'm';
  if (remainder === 0) return hours + 'h';
  return hours + 'h ' + remainder + 'm';
}

function totalMinutes(list: DisplayEntry[]): number {
  return list
    .filter((entry) => entry.status !== 'excluded')
    .reduce((total, entry) => total + entry.duration_minutes, 0);
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function mondayOfDate(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() - day + (day === 0 ? -6 : 1));
  d.setHours(0, 0, 0, 0);
  return d;
}

function weekOffsetForDate(date: Date): number {
  return Math.round((mondayOfDate(date).getTime() - mondayOf(0).getTime()) / (7 * 24 * 60 * 60 * 1000));
}

function mondayOf(offset: number): Date {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff + offset * 7);
  d.setHours(0, 0, 0, 0);
  return d;
}

interface DayData { date: ReturnType<typeof fmtDate>; entries: DisplayEntry[]; }

function toDisplayEntry(entry: ApiEntry): DisplayEntry {
  return { ...entry, entryIds: [entry.id], emailCount: 1, underlying: [entry] };
}

function groupEntriesForDay(entries: ApiEntry[]): DisplayEntry[] {
  const emailGroups = new Map<string, ApiEntry[]>();
  const standalone: DisplayEntry[] = [];

  for (const entry of entries) {
    if (entry.source_type !== 'email') {
      standalone.push(toDisplayEntry(entry));
      continue;
    }
    const key = entry.conversation_id || 'subject:' + normalizeTitle(entry.title);
    const group = emailGroups.get(key) || [];
    group.push(entry);
    emailGroups.set(key, group);
  }

  for (const group of emailGroups.values()) {
    if (group.length === 1) {
      standalone.push(toDisplayEntry(group[0]));
      continue;
    }

    const primary = [...group].sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''))[0];
    const issueValues = Array.from(new Set(group.map((entry) => entry.jira_issue).filter(Boolean))) as string[];
    const worklogValues = Array.from(new Set(group.map((entry) => entry.jira_worklog_id).filter(Boolean))) as string[];
    const allExcluded = group.every((entry) => entry.status === 'excluded');
    const allPushed = group.every((entry) => entry.status === 'pushed');

    standalone.push({
      ...primary,
      duration_minutes: group.reduce((total, entry) => total + entry.duration_minutes, 0),
      context_minutes: 0,
      status: allExcluded ? 'excluded' : allPushed ? 'pushed' : 'pending',
      jira_issue: issueValues.length === 1 ? issueValues[0] : null,
      jira_worklog_id: worklogValues.length === 1 ? worklogValues[0] : null,
      entryIds: group.map((entry) => entry.id),
      emailCount: group.length,
      underlying: group,
    });
  }

  return standalone;
}

function displayTitle(entry: DisplayEntry): string {
  return entry.emailCount > 1 ? `${cleanEmailTitle(entry.title)} (${entry.emailCount} emails)` : cleanEmailTitle(entry.title);
}

function entryTypeLabel(entry: DisplayEntry): string {
  if (entry.status === 'excluded') return 'Non-work ' + entry.source_type;
  if (entry.emailCount > 1) return 'Email thread';
  return entry.source_type;
}

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
  initialSelectedDate,
  issueNames,
}: {
  open: boolean;
  setOpen: (v: boolean) => void;
  refreshToken: number;
  onDataChange?: () => void;
  initialSelectedDate?: Date;
  issueNames?: Record<string, string>;
}) {
  const [weekOffset, setWeekOffset] = useState(0);
  const [selIdx, setSelIdx] = useState(0);
  const [days, setDays] = useState<DayData[]>([]);
  const [exclusionRules, setExclusionRules] = useState<ExclusionRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [pushing, setPushing] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [coverageByDay, setCoverageByDay] = useState<Record<string, Record<number, TempoCoverage>>>({});
  const { outlookConnected } = useConnection();
  const [mappings, setMappings] = useState<CalendarJiraMapping[]>([]);
  const [expandedEntryIds, setExpandedEntryIds] = useState<Set<number>>(new Set());
  const [invalidIssueIds, setInvalidIssueIds] = useState<Set<number>>(new Set());
  const [syncingWeek, setSyncingWeek] = useState(false);
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

      try {
        const exclusionsRes = await fetch('/api/calendar-exclusions');
        const exclusionsData = await exclusionsRes.json();
        setExclusionRules(exclusionsData.rules || []);
      } catch {
        setExclusionRules([]);
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
        built.push({ date: fmtDate(d), entries: groupEntriesForDay(map[dateKey(d)] || []) });
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

  const initializedOpenRef = useRef(false);
  useEffect(() => {
    if (!open) {
      initializedOpenRef.current = false;
      return;
    }
    if (initializedOpenRef.current || !initialSelectedDate) return;
    initializedOpenRef.current = true;
    setWeekOffset(weekOffsetForDate(initialSelectedDate));
    setSelIdx((initialSelectedDate.getDay() + 6) % 7);
  }, [open, initialSelectedDate]);

  useEffect(() => {
    if (!open) return;

    fetchWeek(weekOffset);
  }, [open, weekOffset, fetchWeek, refreshToken]);

  const weekLabel = (() => {
    if (days.length === 0) return '';
    const w0 = days[0].date, w6 = days[6].date;
    const w0f = w0.short + ' ' + w0.num;
    const w6f = w0.month === w6.month ? String(w6.num) : w6.short + ' ' + w6.num;
    return w0f + ' to ' + w6f + ', ' + w0.year;
  })();

  const hasEntries = days.some((d) => d.entries.length > 0);

  const shiftWeek = (d: number) => { setWeekOffset((w) => Math.min(0, Math.max(-4, w + d))); setSelIdx(0); };

  const syncWeek = useCallback(async () => {
    if (syncingWeek) return;
    setSyncingWeek(true);
    const mon = mondayOf(weekOffset);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    const showBanner = (message: string) => {
      setBanner(message);
      setTimeout(() => setBanner(null), 6000);
    };
    try {
      const res = await fetch('/api/sources/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startDate: toIso(mon), endDate: toIso(sun) }),
      });
      let total: number | null = null;
      let syncError: string | null = null;
      if (res.ok && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let done = false;
        while (!done) {
          const chunk = await reader.read();
          if (chunk.done) { done = true; break; }
          const text = decoder.decode(chunk.value);
          for (const line of text.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === 'complete') {
                if (data.success) total = data.total;
                else syncError = data.error || 'Sync completed with errors.';
              } else if (data.type === 'error') {
                syncError = data.error || 'Sync failed.';
              }
            } catch { /* ignore malformed lines */ }
          }
        }
      } else {
        syncError = 'Sync failed.';
      }
      if (syncError) { showBanner(syncError); return; }
      try {
        const genRes = await fetch('/api/entries/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ startDate: toIso(mon), endDate: toIso(sun), overwrite: true }),
        });
        const genData = await genRes.json();
        if (genData.success) {
          showBanner(total === 0
            ? 'No calendar activity found for this week.'
            : `Synced ${total} items, generated ${genData.generated} entries.`);
        } else {
          showBanner('Entry generation failed: ' + (genData.error || 'unknown error'));
        }
      } catch {
        showBanner('Entry generation failed.');
      }
    } catch {
      showBanner('Network error during sync.');
    } finally {
      setSyncingWeek(false);
      fetchWeek(weekOffset);
      onDataChange?.();
    }
  }, [weekOffset, syncingWeek, fetchWeek, onDataChange]);

  const patchEntry = async (id: number, updates: Record<string, unknown>) => {
    await fetch('/api/entries', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id], updates }),
    });
  };

  const patchEntries = async (ids: number[], updates: Record<string, unknown>) => {
    await fetch('/api/entries', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, updates }),
    });
  };

  const mappingFor = (entry: DisplayEntry): CalendarJiraMapping | null => {
    return getMappedJiraIssue(entry, mappings);
  };

  const exclusionRuleFor = (entry: DisplayEntry): ExclusionRule | null => {
    const normalizedTitle = normalizeTitle(entry.title);
    return exclusionRules.find((rule) =>
      normalizeTitle(rule.title) === normalizedTitle &&
      (rule.sourceType === 'all' || rule.sourceType === entry.source_type)
    ) || null;
  };

  const updateLocalEntry = (id: number, updates: Partial<DisplayEntry>) => {
    setDays((current) => current.map((day) => ({
      ...day,
      entries: day.entries.map((entry) => entry.id === id ? { ...entry, ...updates } : entry),
    })));
  };

  const updateLocalEntryDeep = (id: number, updates: Partial<DisplayEntry>) => {
    setDays((current) => current.map((day) => ({
      ...day,
      entries: day.entries.map((entry) => {
        if (entry.id !== id) return entry;
        return {
          ...entry,
          ...updates,
          underlying: entry.underlying.map((item) => ({ ...item, ...updates })),
        };
      }),
    })));
  };

  const clearJiraIssue = (id: number) => {
    setInvalidIssueIds((current) => new Set(current).add(id));
    const entry = days.flatMap((day) => day.entries).find((item) => item.id === id);
    const ids = entry?.entryIds || [id];
    const updates = { jira_issue: null, jira_name: null, jira_source: null, jira_worklog_id: null };
    updateLocalEntryDeep(id, updates);
    patchEntries(ids, updates).catch(() => {});
  };

  const toggleEntryDetails = (id: number) => {
    setExpandedEntryIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const materializeMappedIssue = async (entry: DisplayEntry) => {
    const mapping = mappingFor(entry);
    if (!mapping) return;
    if (entry.underlying.every((item) => item.jira_issue)) return;
    await patchEntries(entry.entryIds, {
      jira_issue: mapping.jiraIssue,
      jira_name: mapping.jiraName || null,
      jira_source: 'source_route',
      jira_worklog_id: null,
    });
  };

  const saveJiraForEntry = async (entry: DisplayEntry, issue: string) => {
    setInvalidIssueIds((current) => {
      if (!current.has(entry.id)) return current;
      const next = new Set(current);
      next.delete(entry.id);
      return next;
    });
    const updates = { jira_issue: issue, jira_name: null, jira_source: 'manual', jira_worklog_id: null };
    updateLocalEntryDeep(entry.id, updates);
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
    await patchEntries(entry.entryIds, updates);
    fetchWeek(weekOffset);
  };

  const forgetMapping = async (entry: DisplayEntry) => {
    const mapping = mappingFor(entry);
    if (!mapping?.id) return;
    try {
      await fetch(`/api/calendar-mappings/${mapping.id}`, { method: 'DELETE' });
      setMappings((current) => current.filter((item) => item.id !== mapping.id));
      if (entry.jira_source === 'source_route') {
        await patchEntries(entry.entryIds, {
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

  const markNotWork = async (entry: DisplayEntry) => {
    try {
      const res = await fetch('/api/calendar-exclusions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: entry.title,
          sourceType: entry.source_type,
          externalId: entry.external_id,
        }),
      });
      const data = await res.json();
      if (data.success && data.rule) {
        setExclusionRules((current) => [data.rule, ...current.filter((rule) => rule.id !== data.rule.id)]);
        setBanner(`Marked as not work. Similar future ${entry.source_type}s will be excluded automatically.`);
      } else {
        setBanner(data.error || 'Could not save the not-work rule.');
      }
    } catch {
      setBanner('Network error while saving the not-work rule.');
    } finally {
      fetchWeek(weekOffset);
      onDataChange?.();
      setTimeout(() => setBanner(null), 5000);
    }
  };

  const includeEntry = async (entry: DisplayEntry) => {
    await patchEntries(entry.entryIds, { status: 'pending' });
    fetchWeek(weekOffset);
  };

  const stopExcluding = async (entry: DisplayEntry) => {
    const rule = exclusionRuleFor(entry);
    if (!rule) return;
    try {
      await fetch(`/api/calendar-exclusions/${rule.id}`, { method: 'DELETE' });
      setExclusionRules((current) => current.filter((item) => item.id !== rule.id));
      setBanner('Future entries with this title will no longer be excluded automatically.');
    } catch {
      setBanner('Could not remove the not-work rule.');
    } finally {
      fetchWeek(weekOffset);
      setTimeout(() => setBanner(null), 5000);
    }
  };

  const pushEntry = async (entry: DisplayEntry) => {
    if (invalidIssueIds.has(entry.id)) return;
    await materializeMappedIssue(entry);
    const mapping = mappingFor(entry);
    if (!entry.jira_issue && !mapping?.jiraIssue) {
      setBanner('This entry needs a Jira issue before it can be pushed.');
      setTimeout(() => setBanner(null), 4000);
      return;
    }
    setPushing(true);
    try {
      const res = await fetch('/api/jira/push', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entryGroups: [entry.entryIds] }),
      });
      const data = await res.json();
      setBanner(data.success ? 'Pushed to Jira.' : (data.error || 'Push failed.'));
    } catch { setBanner('Network error.'); }
    finally { setPushing(false); fetchWeek(weekOffset); onDataChange?.(); setTimeout(() => setBanner(null), 4000); }
  };

  const pushReady = async () => {
    const day = days[selIdx];
    if (!day) return;
    const readyEntries = day.entries.filter((entry) => displayStatusOf(entry) === 'local' && !invalidIssueIds.has(entry.id) && entry.jira_issue);
    if (readyEntries.length === 0) return;
    for (const entry of readyEntries) {
      await materializeMappedIssue(entry);
    }
    const groups = readyEntries.map((entry) => entry.entryIds);
    setPushing(true);
    try {
      const res = await fetch('/api/jira/push', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entryGroups: groups }),
      });
      const data = await res.json();
      setBanner(data.success ? `Pushed ${readyEntries.length} entr${readyEntries.length === 1 ? 'y' : 'ies'} to Jira.` : (data.error || 'Push failed.'));
    } catch { setBanner('Network error.'); }
    finally { setPushing(false); fetchWeek(weekOffset); onDataChange?.(); setTimeout(() => setBanner(null), 4000); }
  };

  const selDay = days[selIdx];

  const tempoCoverageFor = (entry: ApiEntry): TempoCoverage => {
    const d = new Date(entry.date + 'T00:00:00');
    const k = dateKey(d);
    return coverageByDay[k]?.[entry.id] || 'none';
  };

  const displayStatusOf = (entry: DisplayEntry): CellStatus => {
    if (entry.status === 'excluded') return 'excluded';

    const activeEntries = entry.underlying.filter((item) => item.status !== 'excluded');
    if (activeEntries.length === 0) return 'excluded';

    const coverages = activeEntries.map((item) => tempoCoverageFor(item));
    if (coverages.every((coverage) => coverage === 'full')) return 'cloud';
    if (coverages.some((coverage) => coverage === 'full' || coverage === 'likely')) return 'partial';

    const issueValues = new Set(activeEntries.map((item) => item.jira_issue).filter(Boolean));
    const mappedIssue = mappingFor(entry);
    if (issueValues.size === 0 && !mappedIssue) return 'need';
    if (activeEntries.some((item) => !item.jira_issue) && !mappedIssue) return 'need';
    if (issueValues.size > 1) return 'need';
    return 'local';
  };

  const setEntryDuration = async (entry: DisplayEntry, minutes: number) => {
    const ids = entry.entryIds;
    if (ids.length === 1) {
      await patchEntry(ids[0], { duration_minutes: minutes });
    } else {
      const base = Math.floor(minutes / ids.length);
      let remainder = minutes - base * ids.length;
      await Promise.all(ids.map((id) => {
        const duration = base + (remainder > 0 ? 1 : 0);
        if (remainder > 0) remainder--;
        return patchEntry(id, { duration_minutes: duration });
      }));
    }

    updateLocalEntry(entry.id, { duration_minutes: minutes });

    if (entry.status === 'pushed' && entry.jira_issue && entry.jira_worklog_id) {
      try {
        await fetch('/api/jira/update-worklog', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            issueKey: entry.jira_issue,
            worklogId: entry.jira_worklog_id,
            timeSpentMinutes: minutes,
            startedDate: entry.date,
          }),
        });
      } catch {
        // Keep the local edit visible; Jira reconciliation will surface a mismatch later.
      }
    }
  };

  const readyCount = selDay
    ? selDay.entries.filter((entry) => displayStatusOf(entry) === 'local' && !invalidIssueIds.has(entry.id) && entry.jira_issue).length
    : 0;

  return (
    <>
      <div id="calendar-section" className={'detail-toggle-body' + (open ? ' open' : '')}>
        <div className="calhead">
          <div className="weeknav">
            <button className="btn btn-secondary btn-sm" onClick={() => shiftWeek(-1)} disabled={weekOffset <= -4}>Prev</button>
            <button className="btn btn-secondary btn-sm" onClick={() => shiftWeek(1)}>Next</button>
            <button className="btn btn-navy btn-sm" onClick={() => { setWeekOffset(0); setSelIdx(0); }}>This week</button>
            <span className="text-muted" aria-live="polite" aria-atomic="true" style={{ minWidth: 150, textAlign: 'center' }}>{weekLabel}</span>
            {weekOffset < 0 && (
              <button className="btn btn-navy btn-sm" onClick={syncWeek} disabled={syncingWeek}>
                {syncingWeek ? 'Syncing...' : 'Sync this week'}
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <p className="text-muted" style={{ padding: 12 }}>Loading...</p>
        ) : !hasEntries && !outlookConnected ? (
          <div className="cal-empty">
            <span><b>No entries yet</b><br />ETTA is gathering your calendar and email. Connect Outlook in Settings to populate your week.</span>
          </div>
        ) : (
          <>
            <div className="calwrap">
              <div className="calGrid" ref={gridRef} role="grid" aria-label="Weekly calendar">
                {days.map((day, idx) => {
                  const total = totalMinutes(day.entries);
                  const isToday = day.date.num === today.getDate() && day.date.month === MONTHS[today.getMonth()] && day.date.year === today.getFullYear();
                  let st: CellStatus = 'empty';
                  if (day.entries.length > 0) {
                    if (day.entries.some((entry) => displayStatusOf(entry) === 'need')) st = 'need';
                    else if (day.entries.some((entry) => displayStatusOf(entry) === 'partial')) st = 'partial';
                    else if (day.entries.some((entry) => displayStatusOf(entry) === 'local')) st = 'local';
                    else if (day.entries.some((entry) => displayStatusOf(entry) === 'likely')) st = 'likely';
                    else if (day.entries.every((entry) => displayStatusOf(entry) === 'excluded')) st = 'excluded';
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
                      <div className="dsum">{total > 0 ? formatDuration(total) : 'No entries'}</div>
                      <div style={{ maxHeight: 280, overflowY: 'auto', paddingRight: 4 }}>
                        {day.entries.map((entry) => {
                          const expanded = expandedEntryIds.has(entry.id);
                          return (
                            <div key={entry.id} className={'ent st-' + displayStatusOf(entry)}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                <button
                                  type="button"
                                  title={entry.title}
                                  onClick={(event) => { event.stopPropagation(); setSelIdx(idx); }}
                                  style={{ all: 'unset', cursor: 'pointer', display: 'block', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                >
                                  {displayTitle(entry)}
                                </button>
                                <button
                                  type="button"
                                  aria-expanded={expanded}
                                  aria-label={expanded ? 'Collapse entry details' : 'Expand entry details'}
                                  onClick={(event) => { event.stopPropagation(); toggleEntryDetails(entry.id); }}
                                  style={{ all: 'unset', cursor: 'pointer', color: 'var(--navy)', fontWeight: 700, padding: '0 4px', display: 'inline-flex', alignItems: 'center' }}
                                >
                                  {entry.source_type === 'meeting' ? (
                                    <IconCalendarEvent size={14} style={{ display: 'block', transition: 'transform 180ms ease', transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }} />
                                  ) : entry.source_type === 'email' ? (
                                    <IconMail size={14} style={{ display: 'block', transition: 'transform 180ms ease', transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }} />
                                  ) : (
                                    <IconUser size={14} style={{ display: 'block', transition: 'transform 180ms ease', transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }} />
                                  )}
                                </button>
                              </div>
                              {expanded && (
                                <div className="row2" style={{ whiteSpace: 'normal' }}>
                                  {entryTypeLabel(entry)}{entry.emailCount > 1 ? ` - ${entry.emailCount} emails` : ''} - {formatDuration(entry.duration_minutes)}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
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
                        <thead><tr><th>Entry</th><th style={{ width: 230 }}>Jira activity</th><th>Hours</th><th>Action</th></tr></thead>
                        <tbody>
                          {selDay.entries.map((e) => {
                            const st = displayStatusOf(e);
                            const mapping = mappingFor(e);
                            const rule = exclusionRuleFor(e);
                            const canPushRemaining = st === 'partial' && e.underlying.some((item) => item.status !== 'pushed' && item.status !== 'excluded' && (item.jira_issue || mapping?.jiraIssue));
                            // "Push rest" is only honest when part of this entry's time is
                            // confirmed in Jira. A likely Tempo match alone (ETTA-113) means
                            // nothing was pushed from this entry, so the primary action is Push.
                            const hasConfirmedPush = e.underlying.some((item) => item.status !== 'excluded' && tempoCoverageFor(item) === 'full');
                            return (
                              <tr key={e.id}>
                                <td>
                                  <div style={{ fontWeight: 600 }}>{e.title}</div>
                                  <div className="text-muted">{entryTypeLabel(e)}{e.emailCount > 1 ? ` - ${e.emailCount} emails` : ''}</div>
                                </td>
                                <td>
                                  {st === 'cloud' || st === 'partial' ? (
                                    <>
                                      <span className="issue-key">{e.jira_issue || mapping?.jiraIssue || '--'}</span>
                                      {(() => {
                                      const pushedKey = (e.jira_issue || mapping?.jiraIssue || '').toUpperCase();
                                      const pushedName = pushedKey ? issueNames?.[pushedKey] : undefined;
                                      return pushedName ? (
                                        <div className="text-muted" style={{ fontSize: 12, marginTop: 2 }}>{pushedName}</div>
                                      ) : null;
                                      })()}
                                    </>
                                  ) : (
                                    <>
                                      <JiraInput entry={e} suggestedIssue={mapping?.jiraIssue} helperText={mapping ? 'Auto-filled from your previous entry for this meeting.' : 'Review the Jira issue before pushing.'} onSave={(issue) => saveJiraForEntry(e, issue)} onClear={clearJiraIssue} />
                                      {mapping?.id && (
                                        <button className="btn btn-secondary btn-sm" style={{ marginTop: 6 }} onClick={() => forgetMapping(e)}>Forget mapping</button>
                                      )}
                                    </>
                                  )}
                                </td>
                                <td>
                                  <DurationInput entry={e} disabled={st === 'cloud' || st === 'likely' || st === 'partial' || st === 'excluded'} onSave={(_, minutes) => setEntryDuration(e, minutes)} />
                                </td>
                                <td style={{ minWidth: 150 }}>
                                  {st === 'cloud' && <span className="text-muted">Already pushed</span>}
                                  {st === 'likely' && <span className="text-muted">Likely in Jira</span>}
                                  {st === 'partial' && !canPushRemaining && <span className="text-muted">Partly logged</span>}
                                  {st === 'partial' && canPushRemaining && (
                                    <div>
                                      <button className="btn btn-primary btn-sm" disabled={pushing} title={hasConfirmedPush ? 'Send only the time not yet in Jira' : 'Send this time to Jira; time already logged is skipped automatically'} onClick={() => pushEntry(e)}>{hasConfirmedPush ? 'Push rest' : 'Push'}</button>
                                      <div className="text-muted" style={{ fontSize: 12, marginTop: 3 }}>{hasConfirmedPush ? 'Logs remaining time only' : 'Skips time already in Jira'}</div>
                                    </div>
                                  )}
                                  {st === 'local' && (
                                    <button className="btn btn-primary btn-sm" disabled={pushing || invalidIssueIds.has(e.id)} title="Send this time to Jira" onClick={() => pushEntry(e)}>Push</button>
                                  )}
                                  {st === 'need' && (
                                    <div>
                                      <button className="btn btn-primary btn-sm" disabled title="Add a valid Jira issue first">Push</button>
                                      <div className="text-muted" style={{ fontSize: 12, marginTop: 3 }}>Needs Jira issue</div>
                                    </div>
                                  )}
                                  {(st === 'local' || st === 'need') && (
                                    <button className="btn btn-secondary btn-sm" style={{ marginTop: 6 }} title="Exclude this and similar entries from tracking" onClick={() => markNotWork(e)}>Not work</button>
                                  )}
                                  {st === 'excluded' && (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                      <span className="text-muted">Not work</span>
                                      <button className="btn btn-secondary btn-sm" onClick={() => includeEntry(e)}>Include</button>
                                      {rule && <button className="btn btn-secondary btn-sm" onClick={() => stopExcluding(e)}>Stop excluding</button>}
                                    </div>
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

function DurationInput({ entry, onSave, disabled = false }: { entry: DisplayEntry; onSave: (id: number, minutes: number) => void; disabled?: boolean }) {
  const toHours = (minutes: number) => String(Math.round((minutes / 60) * 4) / 4);
  const [value, setValue] = useState(toHours(entry.duration_minutes));
  const roundToQuarter = (hours: number) => Math.max(0.25, Math.round(hours * 4) / 4);

  const commit = () => {
    if (disabled) return;
    const hours = parseFloat(value);
    if (!isNaN(hours)) {
      const rounded = roundToQuarter(hours);
      const minutes = Math.round(rounded * 60);
      if (minutes !== entry.duration_minutes) {
        onSave(entry.id, minutes);
        setValue(String(rounded));
        return;
      }
    }
    setValue(toHours(entry.duration_minutes));
  };

  const step = (direction: 1 | -1) => {
    if (disabled) return;
    const hours = parseFloat(value);
    const base = isNaN(hours) ? entry.duration_minutes / 60 : hours;
    setValue(String(Math.max(0.25, roundToQuarter(base) + direction * 0.25)));
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <input
        type="number"
        className="input"
        style={{ width: 80, padding: '5px 8px' }}
        value={value}
        min={0.25}
        step={0.25}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'ArrowUp') { event.preventDefault(); step(1); }
          if (event.key === 'ArrowDown') { event.preventDefault(); step(-1); }
        }}
      />
      <span className="text-muted" style={{ fontSize: 12 }}>hr</span>
    </span>
  );
}
function JiraInput({
  entry,
  onSave,
  suggestedIssue,
  helperText,
  onClear,
}: {
  entry: ApiEntry;
  onSave: (issue: string) => void;
  suggestedIssue?: string;
  helperText?: string;
  onClear: (id: number) => void;
}) {
  const [val, setVal] = useState(entry.jira_issue || suggestedIssue || '');
  const [status, setStatus] = useState<'idle' | 'validating' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');
  const lastValidIssue = useRef((entry.jira_issue || suggestedIssue || '').trim().toUpperCase());

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
      lastValidIssue.current = issue.trim().toUpperCase();
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
          if (lastValidIssue.current && nextValue.trim().toUpperCase() !== lastValidIssue.current) {
            onClear(entry.id);
          }
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
