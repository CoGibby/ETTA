import { NextResponse } from 'next/server';
import { getJiraCredentials, pushWorklogs, validateJiraIssue, fetchTempoWorklogs, WorklogInput } from '@/lib/jira';
import { getEntry, updateEntry, upsertCalendarJiraMapping } from '@/lib/db';

let isPushInProgress = false;

async function validateIssueKeys(issueKeys: string[]) {
  const errors: Record<string, string> = {};
  const uniqueKeys = Array.from(new Set(issueKeys.map((key) => key.toUpperCase())));
  const credentials = getJiraCredentials();
  if (!credentials) return errors;

  for (const issueKey of uniqueKeys) {
    const result = await validateJiraIssue(credentials, issueKey);
    if (!result.valid) errors[issueKey] = result.error || 'This issue cannot receive time.';
  }
  return errors;
}

/**
 * Reconcile a list of pending worklogs against time already logged in Tempo for the
 * same issue + date. This prevents double-logging when time was entered manually in
 * Jira/Tempo (or during an earlier split).
 *
 * - existing >= requested  -> skipped with "All time already allocated"
 * - 0 < existing < requested -> push only the remaining difference
 * - existing === 0 -> push the full amount
 */
async function dedupWorklogsAgainstTempo(
  creds: NonNullable<ReturnType<typeof getJiraCredentials>>,
  worklogs: WorklogInput[]
): Promise<{
  toPush: WorklogInput[];
  skipped: { issueKey: string; date: string; timeSpentMinutes: number; reason: string }[];
  partial: { issueKey: string; date: string; requested: number; existing: number; pushed: number }[];
  error?: string;
}> {
  const kept: WorklogInput[] = [];
  const skipped: { issueKey: string; date: string; timeSpentMinutes: number; reason: string }[] = [];
  const partial: { issueKey: string; date: string; requested: number; existing: number; pushed: number }[] = [];

  // Group by date so we only call the Tempo API once per day.
  const byDate = new Map<string, WorklogInput[]>();
  for (const w of worklogs) {
    const start = (w.startedDate || '').substring(0, 10);
    if (!start) { kept.push(w); continue; }
    const list = byDate.get(start) || [];
    list.push(w);
    byDate.set(start, list);
  }

  for (const [date, dayWorklogs] of byDate) {
    let tempoEntries: { issueKey: string; minutes: number; date: string }[] = [];
    try {
      const tempoResult = await fetchTempoWorklogs(creds, date, date);
      if (tempoResult.success) tempoEntries = tempoResult.entries || [];
    } catch {
      // Network/API failure during dedup: still push (same behavior as before) so we
      // never silently drop work the user asked to log.
      kept.push(...dayWorklogs);
      continue;
    }

    // Sum existing Tempo minutes for this issue on this day.
    const existingByIssue = new Map<string, number>();
    for (const t of tempoEntries) {
      const key = (t.issueKey || '').toUpperCase();
      if (!key) continue;
      existingByIssue.set(key, (existingByIssue.get(key) || 0) + (t.minutes || 0));
    }

    for (const w of dayWorklogs) {
      const issueKey = (w.issueKey || '').toUpperCase();
      const existing = existingByIssue.get(issueKey) || 0;
      const requested = w.timeSpentMinutes;

      if (existing >= requested) {
        skipped.push({ issueKey, date, timeSpentMinutes: requested, reason: 'All time already allocated' });
      } else if (existing > 0) {
        const remaining = requested - existing;
        kept.push({ ...w, timeSpentMinutes: remaining, comment: w.comment });
        partial.push({ issueKey, date, requested, existing, pushed: remaining });
      } else {
        kept.push(w);
      }
    }
  }

  return { toPush: kept, skipped, partial };
}

export async function POST(request: Request) {
  if (isPushInProgress) {
    return NextResponse.json(
      { success: false, error: 'A push is already in progress. Please wait for it to complete.' },
      { status: 409 }
    );
  }

  isPushInProgress = true;
  try {
    const { entryIds, entryGroups, worklogs: directWorklogs } = await request.json();
    const legacyEntryIds = Array.isArray(entryIds) ? entryIds : [];
    const hasEntryGroups = Array.isArray(entryGroups) && entryGroups.length > 0;
    const hasLegacyEntryIds = legacyEntryIds.length > 0;
    const hasDirectWorklogs = Array.isArray(directWorklogs) && directWorklogs.length > 0;

    if (!hasEntryGroups && !hasLegacyEntryIds && !hasDirectWorklogs) {
      return NextResponse.json(
        { success: false, error: 'Provide entryIds, entryGroups, or worklogs to push.' },
        { status: 400 }
      );
    }

    const creds = getJiraCredentials();
    if (!creds) {
      return NextResponse.json(
        { success: false, error: 'Jira credentials not configured. Please go to Settings.' },
        { status: 400 }
      );
    }

    const groups: number[][] = hasEntryGroups
      ? entryGroups
      : legacyEntryIds.map((entryId: number) => [entryId]);
    const worklogs: { entryIds: number[]; worklog: WorklogInput }[] = [];
    const skipped: { entryId: number; reason: string }[] = [];
    const entriesById = new Map<number, NonNullable<ReturnType<typeof getEntry>>>();

    for (const group of groups) {
      if (!Array.isArray(group) || group.length === 0) continue;
      const ids = Array.from(new Set(group.map(Number).filter((id) => Number.isInteger(id) && id > 0)));
      if (ids.length === 0) continue;

      const entries = ids.map((id) => getEntry(id)).filter(Boolean) as NonNullable<ReturnType<typeof getEntry>>[];
      if (entries.length === 0) {
        skipped.push({ entryId: ids[0], reason: 'Entry not found' });
        continue;
      }

      for (const entry of entries) entriesById.set(entry.id, entry);
      const pendingEntries = entries.filter((entry) => entry.status !== 'pushed' && entry.status !== 'excluded');
      if (pendingEntries.length === 0) {
        skipped.push({ entryId: ids[0], reason: 'Already pushed' });
        continue;
      }

      const issueKeys = new Set(pendingEntries.map((entry) => entry.jira_issue?.toUpperCase()).filter(Boolean));
      if (issueKeys.size === 0 || pendingEntries.some((entry) => !entry.jira_issue)) {
        skipped.push({ entryId: ids[0], reason: 'No Jira issue assigned' });
        continue;
      }
      if (issueKeys.size > 1) {
        skipped.push({ entryId: ids[0], reason: 'Group has multiple Jira issues' });
        continue;
      }

      const issueKey = Array.from(issueKeys)[0] as string;
      const firstEntry = pendingEntries[0];
      const isEmailThread = pendingEntries.length > 1 && pendingEntries.every((entry) => entry.source_type === 'email');
      const comment = isEmailThread
        ? `${firstEntry.title} (${pendingEntries.length} emails)`
        : firstEntry.title;

      worklogs.push({
        entryIds: pendingEntries.map((entry) => entry.id),
        worklog: {
          issueKey,
          timeSpentMinutes: pendingEntries.reduce((total, entry) => total + entry.duration_minutes, 0),
          startedDate: firstEntry.date,
          comment,
        },
      });
    }

    // If no entry-derived worklogs, fall back to the raw worklogs sent by the UI
    // (e.g. the manual allocation card), but always run Tempo dedup on them.
    if (worklogs.length === 0 && hasDirectWorklogs) {
      const validWorklogs = (directWorklogs as WorklogInput[])
        .filter((worklog) => worklog.issueKey && worklog.timeSpentMinutes > 0)
        .map((worklog) => ({ ...worklog, issueKey: worklog.issueKey.trim().toUpperCase() }));
      if (validWorklogs.length === 0) {
        return NextResponse.json({ success: false, error: 'No valid worklogs to push' });
      }

      const invalidIssues = await validateIssueKeys(validWorklogs.map((worklog) => worklog.issueKey));
      if (Object.keys(invalidIssues).length > 0) {
        return NextResponse.json({
          success: false,
          error: 'One or more Jira issues are not valid. Fix them before logging time.',
          invalidIssues,
        }, { status: 400 });
      }

      const dedup = await dedupWorklogsAgainstTempo(creds, validWorklogs);
      if (dedup.toPush.length === 0) {
        return NextResponse.json({
          success: false,
          error: dedup.skipped.length > 0 ? 'All time already allocated in Tempo. Nothing to push.' : 'No valid worklogs to push.',
          skippedEntries: dedup.skipped,
          partial: dedup.partial,
        });
      }

      const result = await pushWorklogs(creds, dedup.toPush);
      return NextResponse.json({
        success: result.pushed > 0,
        pushed: result.pushed,
        failed: result.failed,
        skipped: dedup.skipped.length,
        skippedEntries: dedup.skipped,
        partial: dedup.partial,
        error: result.failed > 0 ? `${result.failed} worklogs failed to push.` : undefined,
      });
    }

    if (worklogs.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'No valid entries to push. Entries may be missing a Jira issue or already pushed.',
        skipped,
      });
    }

    const invalidIssues = await validateIssueKeys(worklogs.map((item) => item.worklog.issueKey));
    if (Object.keys(invalidIssues).length > 0) {
      return NextResponse.json({
        success: false,
        error: 'One or more Jira issues are not valid. Fix them before logging time.',
        invalidIssues,
      }, { status: 400 });
    }

    // Tempo-reconcile the entry-group pushes so splits against existing allocation
    // only log the remaining difference.
    const dedup = await dedupWorklogsAgainstTempo(creds, worklogs.map((item) => item.worklog));
    const worklogsByIdentity = new Map(worklogs.map((item) => [item.worklog.issueKey.toUpperCase() + '|' + (item.worklog.startedDate || '').substring(0, 10), item]));

    const finalGroups: { entryIds: number[]; worklog: WorklogInput }[] = [];
    for (const item of dedup.toPush) {
      const identity = item.issueKey.toUpperCase() + '|' + (item.startedDate || '').substring(0, 10);
      const original = worklogsByIdentity.get(identity);
      if (original) {
        finalGroups.push({ entryIds: original.entryIds, worklog: item });
      }
    }
    for (const sk of dedup.skipped) {
      const identity = sk.issueKey.toUpperCase() + '|' + sk.date.substring(0, 10);
      const original = worklogsByIdentity.get(identity);
      if (original && original.entryIds.length > 0) {
        skipped.push({ entryId: original.entryIds[0], reason: 'All time already allocated (Tempo)' });
      }
    }

    if (finalGroups.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'All time already allocated in Tempo. Nothing to push.',
        skipped,
        skippedEntries: skipped,
        partial: dedup.partial,
      });
    }

    const result = await pushWorklogs(creds, finalGroups.map((item) => item.worklog));
    const pushedAt = new Date().toISOString();
    let successfulCount = 0;
    const failedEntries: { entryId: number; error: string }[] = [];

    result.results.forEach((resultItem, index) => {
      const groupEntryIds = finalGroups[index].entryIds;
      if (resultItem.result.success) {
        for (const entryId of groupEntryIds) {
          updateEntry(entryId, {
            status: 'pushed',
            pushed_at: pushedAt,
            jira_worklog_id: resultItem.result.worklogId || null,
          });
        }

        const entry = entriesById.get(groupEntryIds[0]);
        if (entry) {
          upsertCalendarJiraMapping({
            title: entry.title,
            sourceType: entry.source_type,
            jiraIssue: entry.jira_issue || '',
            jiraName: entry.jira_name,
          });
        }
        successfulCount++;
      } else {
        failedEntries.push({ entryId: groupEntryIds[0], error: resultItem.result.error || 'Unknown error' });
      }
    });

    const hasFailures = failedEntries.length > 0;
    const hasSuccesses = successfulCount > 0;
    let error: string | undefined;
    if (hasFailures) {
      const failureMessages = failedEntries.map((failure) => `Entry ${failure.entryId}: ${failure.error}`);
      error = `${failedEntries.length} entries failed to push:\n${failureMessages.join('\n')}`;
    }

    return NextResponse.json({
      success: hasSuccesses,
      pushed: result.pushed,
      failed: result.failed,
      skipped: skipped.length + dedup.skipped.length,
      failedEntries,
      skippedEntries: skipped,
      partial: dedup.partial,
      error,
    });
  } catch (error) {
    console.error('Error pushing to Jira:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to push to Jira' },
      { status: 500 }
    );
  } finally {
    isPushInProgress = false;
  }
}
