import { NextResponse } from 'next/server';
import { getJiraCredentials, pushWorklogs, validateJiraIssue, WorklogInput } from '@/lib/jira';
import { getEntry, updateEntry, upsertCalendarJiraMapping } from '@/lib/db';

// Server-side lock to prevent concurrent pushes
let isPushInProgress = false;

async function validateIssueKeys(issueKeys: string[]) {
  const errors: Record<string, string> = {};
  const uniqueKeys = Array.from(new Set(issueKeys.map((key) => key.toUpperCase())));

  const credentials = getJiraCredentials();
  if (!credentials) return errors;

  for (const issueKey of uniqueKeys) {
    const result = await validateJiraIssue(credentials, issueKey);
    if (!result.valid) {
      errors[issueKey] = result.error || 'This issue cannot receive time.';
    }
  }

  return errors;
}

export async function POST(request: Request) {
  // Check if a push is already in progress
  if (isPushInProgress) {
    return NextResponse.json(
      { success: false, error: 'A push is already in progress. Please wait for it to complete.' },
      { status: 409 }
    );
  }

  isPushInProgress = true;
  try {
    const { entryIds, worklogs: directWorklogs } = await request.json();

    // Allow two modes:
    // 1. entryIds ? push DB entries by their IDs
    // 2. worklogs ? push direct worklog objects (from allocation bars)
    const hasEntryIds = entryIds && Array.isArray(entryIds) && entryIds.length > 0;
    const hasDirectWorklogs = Array.isArray(directWorklogs) && directWorklogs.length > 0;

    if (!hasEntryIds && !hasDirectWorklogs) {
      return NextResponse.json(
        { success: false, error: 'Provide entryIds or worklogs to push.' },
        { status: 400 }
      );
    }

    // Get Jira credentials
    const creds = getJiraCredentials();
    if (!creds) {
      return NextResponse.json(
        { success: false, error: 'Jira credentials not configured. Please go to Settings.' },
        { status: 400 }
      );
    }

    // Get entries and validate
    const worklogs: { entryId: number; worklog: WorklogInput }[] = [];
    const skipped: { entryId: number; reason: string }[] = [];
    const entriesById = new Map<number, NonNullable<ReturnType<typeof getEntry>>>();

    for (const entryId of (entryIds || [])) {
      const entry = getEntry(entryId);

      if (!entry) {
        skipped.push({ entryId, reason: 'Entry not found' });
        continue;
      }
      entriesById.set(entryId, entry);

      if (!entry.jira_issue) {
        skipped.push({ entryId, reason: 'No Jira issue assigned' });
        continue;
      }

      if (entry.status === 'pushed') {
        skipped.push({ entryId, reason: 'Already pushed' });
        continue;
      }

      worklogs.push({
        entryId,
        worklog: {
          issueKey: entry.jira_issue,
          timeSpentMinutes: entry.duration_minutes + (entry.context_minutes || 0),
          startedDate: entry.date,
          comment: entry.title,
        },
      });
    }

    if (worklogs.length === 0 && Array.isArray(directWorklogs) && directWorklogs.length > 0) {
      // Direct worklogs from allocation bars (no DB entries)
      const validWorklogs = directWorklogs
        .filter((worklog: WorklogInput) => worklog.issueKey && worklog.timeSpentMinutes > 0)
        .map((worklog: WorklogInput) => ({
          ...worklog,
          issueKey: worklog.issueKey.trim().toUpperCase(),
        }));
      if (validWorklogs.length === 0) {
        return NextResponse.json({ success: false, error: 'No valid worklogs to push' });
      }

      const invalidIssues = await validateIssueKeys(validWorklogs.map((worklog: WorklogInput) => worklog.issueKey));
      if (Object.keys(invalidIssues).length > 0) {
        return NextResponse.json({
          success: false,
          error: 'One or more Jira issues are not valid. Fix them before logging time.',
          invalidIssues,
        }, { status: 400 });
      }

      const result = await pushWorklogs(creds, validWorklogs);
      return NextResponse.json({
        success: result.pushed > 0,
        pushed: result.pushed,
        failed: result.failed,
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

    // Push to Jira
    const result = await pushWorklogs(
      creds,
      worklogs.map((w) => w.worklog)
    );

    // Update entry statuses based on results
    const pushedAt = new Date().toISOString();
    let successfulCount = 0;
    const failedEntries: { entryId: number; error: string }[] = [];

    result.results.forEach((resultItem, index) => {
      const entryId = worklogs[index].entryId;
      if (resultItem.result.success) {
        updateEntry(entryId, {
          status: 'pushed',
          pushed_at: pushedAt,
          jira_worklog_id: resultItem.result.worklogId || null,
        });
        const entry = entriesById.get(entryId);
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
        failedEntries.push({ entryId, error: resultItem.result.error || 'Unknown error' });
      }
    });

    // Build response - partial success is still success, but with warnings
    const hasFailures = failedEntries.length > 0;
    const hasSuccesses = successfulCount > 0;

    // Only fail completely if nothing succeeded
    const success = hasSuccesses;

    // Build error message for any failures
    let error: string | undefined;
    if (hasFailures) {
      const failureMessages = failedEntries.map(f => `Entry ${f.entryId}: ${f.error}`);
      error = `${failedEntries.length} entries failed to push:\n${failureMessages.join('\n')}`;
    }

    return NextResponse.json({
      success,
      pushed: result.pushed,
      failed: result.failed,
      skipped: skipped.length,
      failedEntries,
      skippedEntries: skipped,
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
