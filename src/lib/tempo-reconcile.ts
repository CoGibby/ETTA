import { getEntries, updateEntry } from './db';
import type { TempoWorklog } from './tempo-match';

interface ReconcileResult {
  checked: number;
  confirmed: number;
  restored: number;
}

type ReconcileWorklog = TempoWorklog & { date: string };

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function dateOnly(value: string): string {
  return value.length >= 10 ? value.slice(0, 10) : value;
}

export function reconcilePushedEntries(
  dateFrom: string,
  dateTo: string,
  tempoWorklogs: ReconcileWorklog[]
): ReconcileResult {
  const pushedEntries = getEntries({
    startDate: dateFrom,
    endDate: dateTo,
    status: 'pushed',
  });

  const worklogsById = new Map<string, ReconcileWorklog>();
  for (const worklog of tempoWorklogs) {
    if (worklog.worklogId) {
      worklogsById.set(worklog.worklogId, worklog);
    }
  }

  const usedFallbackWorklogs = new Set<number>();
  let confirmed = 0;
  let restored = 0;

  for (const entry of pushedEntries) {
    const storedWorklogId = entry.jira_worklog_id;

    if (storedWorklogId) {
      if (worklogsById.has(storedWorklogId)) {
        confirmed++;
        continue;
      }

      updateEntry(entry.id, {
        status: 'pending',
        pushed_at: null,
      });
      restored++;
      continue;
    }

    const entryMinutes = entry.duration_minutes;
    const entryTitle = normalizeText(entry.title);
    const fallbackIndex = tempoWorklogs.findIndex((worklog, index) => {
      if (usedFallbackWorklogs.has(index)) return false;
      if ((worklog.issueKey || '').toUpperCase() !== (entry.jira_issue || '').toUpperCase()) return false;
      if (dateOnly(worklog.date || '') !== entry.date) return false;
      if ((worklog.minutes || 0) !== entryMinutes) return false;

      const comment = normalizeText(worklog.comment || '');
      return entryTitle.length > 0 && comment.includes(entryTitle);
    });

    if (fallbackIndex >= 0) {
      usedFallbackWorklogs.add(fallbackIndex);
      const worklogId = tempoWorklogs[fallbackIndex].worklogId;
      if (worklogId) {
        updateEntry(entry.id, { jira_worklog_id: worklogId });
      }
      confirmed++;
      continue;
    }

    updateEntry(entry.id, {
      status: 'pending',
      pushed_at: null,
    });
    restored++;
  }

  return {
    checked: pushedEntries.length,
    confirmed,
    restored,
  };
}
