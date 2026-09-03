export interface TempoWorklog {
  issueKey: string;
  minutes: number;
  comment?: string;
  worklogId?: string;
}

export interface CalendarJiraMapping {
  id?: number;
  title: string;
  sourceType: 'meeting' | 'email' | 'manual' | 'all';
  jiraIssue: string;
  jiraName?: string | null;
}

interface MatchableEntry {
  title: string;
  source_type?: string | null;
  jira_issue?: string | null;
  jira_worklog_id?: string | null;
  duration_minutes: number;
  context_minutes?: number | null;
  status?: string | null;
}

interface IdentifiableEntry extends MatchableEntry {
  id: number;
}

export type TempoCoverage = 'none' | 'partial' | 'full' | 'likely';

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function entryMinutes(entry: MatchableEntry): number {
  return entry.duration_minutes + (entry.context_minutes || 0);
}

function hasDirectCommentMatch(entry: MatchableEntry, worklog: TempoWorklog): boolean {
  const entryTitle = normalizeText(entry.title);
  const comment = normalizeText(worklog.comment || '');
  return entryTitle.length > 0 && comment.includes(entryTitle);
}

function mappingMatchesEntry(entry: MatchableEntry, mapping: CalendarJiraMapping): boolean {
  if (normalizeText(mapping.title) !== normalizeText(entry.title)) return false;
  return mapping.sourceType === 'all' || mapping.sourceType === entry.source_type;
}

export function getMappedJiraIssue(
  entry: MatchableEntry,
  mappings: CalendarJiraMapping[] = []
): CalendarJiraMapping | null {
  return mappings.find((mapping) => mappingMatchesEntry(entry, mapping)) || null;
}

function effectiveIssue(entry: MatchableEntry, mappings: CalendarJiraMapping[]): string {
  const directIssue = (entry.jira_issue || '').toUpperCase();
  if (directIssue) return directIssue;
  return (getMappedJiraIssue(entry, mappings)?.jiraIssue || '').toUpperCase();
}

export function getTempoCoverageForEntries(
  entries: IdentifiableEntry[],
  tempoWorklogs: TempoWorklog[],
  mappings: CalendarJiraMapping[] = []
): Record<number, TempoCoverage> {
  const coverage: Record<number, TempoCoverage> = {};
  const currentWorklogIds = new Set(
    tempoWorklogs
      .map((worklog) => worklog.worklogId)
      .filter((worklogId): worklogId is string => Boolean(worklogId))
  );

  for (const entry of entries) {
    coverage[entry.id] =
      entry.status === 'pushed' || (entry.jira_worklog_id && currentWorklogIds.has(entry.jira_worklog_id))
        ? 'full'
        : 'none';
  }

  const issueKeys = new Set(entries.map((entry) => effectiveIssue(entry, mappings)).filter(Boolean));

  for (const issueKey of issueKeys) {
    const issueEntries = entries.filter(
      (entry) =>
        effectiveIssue(entry, mappings) === issueKey &&
        coverage[entry.id] === 'none'
    );
    if (issueEntries.length === 0) continue;

    const availableWorklogs = tempoWorklogs
      .filter((worklog) => worklog.issueKey.toUpperCase() === issueKey)
      .map((worklog) => ({ ...worklog, availableMinutes: worklog.minutes || 0 }));

    if (availableWorklogs.length === 0) continue;

    for (const entry of issueEntries) {
      const matchedWorklog = availableWorklogs.find(
        (worklog) => worklog.availableMinutes > 0 && hasDirectCommentMatch(entry, worklog)
      );
      if (!matchedWorklog) continue;

      coverage[entry.id] = 'full';
      matchedWorklog.availableMinutes = Math.max(
        0,
        matchedWorklog.availableMinutes - entryMinutes(entry)
      );
    }

    let remainingMinutes = availableWorklogs.reduce(
      (total, worklog) => total + worklog.availableMinutes,
      0
    );

    for (const entry of issueEntries) {
      if (coverage[entry.id] !== 'none') continue;
      const minutes = entryMinutes(entry);
      const mappedIssue = getMappedJiraIssue(entry, mappings);

      if (remainingMinutes >= minutes) {
        coverage[entry.id] = mappedIssue ? 'likely' : 'full';
        remainingMinutes -= minutes;
      } else if (remainingMinutes > 0) {
        coverage[entry.id] = 'partial';
        remainingMinutes = 0;
      }
    }
  }

  return coverage;
}

export function getTempoCoverage(
  entry: MatchableEntry,
  tempoWorklogs: TempoWorklog[],
  mappings: CalendarJiraMapping[] = []
): TempoCoverage {
  const coverage = getTempoCoverageForEntries(
    [{ ...entry, id: 0 }],
    tempoWorklogs,
    mappings
  );
  return coverage[0] || 'none';
}
