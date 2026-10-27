import {
  CalendarJiraMapping,
  getMappedJiraIssue,
  getTempoCoverageForEntries,
  TempoCoverage,
  TempoWorklog,
} from './tempo-match';

/**
 * A minimal shape of an entry that the shared stats functions understand.
 * Callers (Review page, Metrics page) already have richer ApiEntry types;
 * pass those directly - they are structurally compatible.
 */
export interface StatsEntry {
  id: number;
  source_type?: string | null;
  title: string;
  date: string;
  duration_minutes: number;
  context_minutes?: number | null;
  jira_issue?: string | null;
  jira_name?: string | null;
  status?: string | null;
  jira_worklog_id?: string | null;
}

export interface WeekStatistics {
  capturedMinutes: number;
  meetingMinutes: number;
  pushedMinutes: number;
  reviewMinutes: number;
  inJiraCount: number;
  readyCount: number;
  needsCodeCount: number;
  entryCount: number;
}

function dayKey(dateIso: string): string {
  const d = new Date(dateIso.substring(0, 10) + 'T00:00:00');
  return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
}

const minsOf = (e: StatsEntry) => e.duration_minutes;

/** Group Tempo worklogs (with a date) into the same per-day map format the pages use. */
export function buildTempoByDay(
  worklogs: { issueKey: string; minutes: number; comment?: string; date: string }[]
): Record<string, TempoWorklog[]> {
  const tempoByDay: Record<string, TempoWorklog[]> = {};
  for (const t of worklogs) {
    const dayPart = (t.date || '').length >= 10 ? (t.date || '').substring(0, 10) : (t.date || '');
    const k = dayKey(dayPart);
    (tempoByDay[k] = tempoByDay[k] || []).push({
      issueKey: (t.issueKey || '').toUpperCase(),
      minutes: t.minutes || 0,
      comment: t.comment || '',
    });
  }
  return tempoByDay;
}

/**
 * Single source of truth for the "Pushed / In Jira / Needs code" totals used by both
 * the Review calendar header and the Metrics page. Counts are Tempo-reconciled so that
 * entries generated from Outlook that already have a matching worklog in Jira are
 * treated as pushed, in lock-step with what is actually logged.
 */
export function computeWeekStats(
  entries: StatsEntry[],
  tempoByDay: Record<string, TempoWorklog[]>,
  mappings: CalendarJiraMapping[] = []
): WeekStatistics {
  const active = entries.filter((entry) => entry.status !== 'excluded');

  const entriesByDay: Record<string, StatsEntry[]> = {};
  for (const entry of active) {
    const k = dayKey(entry.date);
    (entriesByDay[k] = entriesByDay[k] || []).push(entry);
  }

  const coverageByDay: Record<string, Record<number, TempoCoverage>> = {};
  for (const [dayK, dayEntries] of Object.entries(entriesByDay)) {
    coverageByDay[dayK] = getTempoCoverageForEntries(dayEntries, tempoByDay[dayK] || [], mappings);
  }

  const coverageOf = (entry: StatsEntry): TempoCoverage =>
    coverageByDay[dayKey(entry.date)]?.[entry.id] || 'none';
  const hasAssignableIssue = (entry: StatsEntry) =>
    Boolean(entry.jira_issue || getMappedJiraIssue(entry, mappings));

  const pushedMinutes = active
    .filter((e) => e.status === 'pushed' || (e.status === 'pending' && coverageOf(e) !== 'none'))
    .reduce((s, e) => s + minsOf(e), 0);
  const reviewMinutes = active
    .filter((e) => e.status === 'pending' && coverageOf(e) === 'none' && !hasAssignableIssue(e))
    .reduce((s, e) => s + minsOf(e), 0);

  return {
    capturedMinutes: active.reduce((s, e) => s + minsOf(e), 0),
    meetingMinutes: active.filter((e) => e.source_type === 'meeting').reduce((s, e) => s + minsOf(e), 0),
    pushedMinutes,
    reviewMinutes,
    inJiraCount: active.filter((e) => e.status === 'pushed' || (e.status === 'pending' && coverageOf(e) !== 'none')).length,
    readyCount: active.filter((e) => e.status === 'pending' && hasAssignableIssue(e) && coverageOf(e) === 'none').length,
    needsCodeCount: active.filter((e) => e.status === 'pending' && !hasAssignableIssue(e) && coverageOf(e) === 'none').length,
    entryCount: active.length,
  };
}
