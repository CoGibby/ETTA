import { NextResponse } from 'next/server';
import {
  getSourcesForGeneration,
  createEntry,
  getEntryBySourceId,
  deleteEntry,
  deleteStaleEntriesWithoutManualChanges,
  getSetting,
  findCalendarExclusionRule,
  Source,
} from '@/lib/db';
import { classifySource, calculateEmailDuration } from '@/lib/classifier';
import { cleanEmailTitle } from '@/lib/title-clean';

// Helper to parse meeting end time
function getMeetingEndTime(source: Source): Date | null {
  if (source.type !== 'meeting' || !source.duration_minutes) return null;
  const startTime = new Date(source.date);
  return new Date(startTime.getTime() + source.duration_minutes * 60 * 1000);
}

// Check if two meetings are back-to-back (within 5 minute tolerance)
function areBackToBack(meeting1: Source, meeting2: Source): boolean {
  const end1 = getMeetingEndTime(meeting1);
  const start2 = new Date(meeting2.date);
  if (!end1) return false;
  const gapMinutes = (start2.getTime() - end1.getTime()) / (60 * 1000);
  return gapMinutes >= -5 && gapMinutes <= 5; // Allow 5 min overlap or gap
}

// Calculate context time for a meeting considering back-to-back meetings
function calculateContextTime(
  sources: Source[],
  index: number,
  contextBefore: number,
  contextAfter: number
): number {
  const current = sources[index];
  if (current.type !== 'meeting') return 0;

  let totalContext = 0;

  // Check if previous source is a back-to-back meeting
  const prev = index > 0 ? sources[index - 1] : null;
  const hasPrevBackToBack = prev && prev.type === 'meeting' && areBackToBack(prev, current);

  // Check if next source is a back-to-back meeting
  const next = index < sources.length - 1 ? sources[index + 1] : null;
  const hasNextBackToBack = next && next.type === 'meeting' && areBackToBack(current, next);

  // Add context before only if not back-to-back with previous meeting
  if (!hasPrevBackToBack) {
    totalContext += contextBefore;
  }

  // Add context after only if not back-to-back with next meeting
  if (!hasNextBackToBack) {
    totalContext += contextAfter;
  }

  return totalContext;
}

export async function POST(request: Request) {
  try {
    const { startDate, endDate, overwrite = false } = await request.json();

    // Get context switching settings
    const contextBefore = parseInt(getSetting('context_before_minutes') || '10', 10);
    const contextAfter = parseInt(getSetting('context_after_minutes') || '10', 10);

    // Clean up entries from stale sources that don't have manual changes
    const staleCleanup = deleteStaleEntriesWithoutManualChanges({ startDate, endDate });

    // Get all sources in date range (excludes stale sources)
    const sources = getSourcesForGeneration({ startDate, endDate });

    if (sources.length === 0) {
      return NextResponse.json({
        success: true,
        message: staleCleanup.deleted > 0
          ? `No sources found in date range. Cleaned up ${staleCleanup.deleted} stale entries.`
          : 'No sources found in date range',
        generated: 0,
        skipped: 0,
        staleDeleted: staleCleanup.deleted
      });
    }


    let generated = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      try {
        // Check if entry already exists for this source
        const existingEntry = getEntryBySourceId(source.id);

        // Preserve manual assignments and status if they exist
        let preservedJiraIssue: string | null = null;
        let preservedJiraSource: string | null = null;
        let preservedProject: string | null = null;
        let preservedProjectSource: string | null = null;
        let preservedTaskType: string | null = null;
        let preservedTaskTypeSource: string | null = null;
        let preservedStatus: 'pending' | 'pushed' | 'excluded' = 'pending';
        const exclusionRule = findCalendarExclusionRule({
          title: source.subject || '',
          sourceType: source.type,
          externalId: source.external_id,
        });
        if (exclusionRule) preservedStatus = 'excluded';

        if (existingEntry) {
          if (!overwrite) {
            skipped++;
            continue;
          }
          // Never delete/recreate pushed entries - they represent completed work sent to Jira
          if (existingEntry.status === 'pushed') {
            skipped++;
            continue;
          }
          // Save manual assignments before deleting
          if (existingEntry.jira_source === 'manual') {
            preservedJiraIssue = existingEntry.jira_issue;
            preservedJiraSource = existingEntry.jira_source;
          }
          if (existingEntry.project_source === 'manual') {
            preservedProject = existingEntry.project;
            preservedProjectSource = existingEntry.project_source;
          }
          if (existingEntry.task_type_source === 'manual') {
            preservedTaskType = existingEntry.task_type;
            preservedTaskTypeSource = existingEntry.task_type_source;
          }
          // Preserve excluded status (user explicitly excluded this entry)
          if (existingEntry.status === 'excluded') {
            preservedStatus = 'excluded';
          }
          // Delete existing entry before creating new one
          deleteEntry(existingEntry.id);
        }

        // Classify the source (pass source type for source-based routing fallback)
        const classification = classifySource(source.subject || '', source.body || '', source.type);

        // Calculate duration and context time
        let durationMinutes: number;
        if (source.type === 'meeting') {
          // Use meeting's exact duration from Outlook â€” no rounding, no context time
          durationMinutes = source.duration_minutes || 60;
        } else {
          // Emails get duration based on character count from settings (not rounded)
          durationMinutes = calculateEmailDuration(source.body || '');
        }
        // Total duration includes context time (context time is not rounded separately)
        const totalDuration = durationMinutes;

        // Extract date and time from source date
        // source.date is in format "YYYY-MM-DDTHH:MM:SS" (local time from Outlook)
        // Parse directly to avoid timezone conversion issues
        const [dateStr, timePart] = source.date.split('T');
        const timeStr = timePart ? timePart.slice(0, 5) : '09:00'; // HH:MM

        // Create the entry - use sent time for emails too
        // Use preserved manual assignments if they existed, otherwise use classification
        createEntry({
          source_id: source.id,
          source_type: source.type,
          title: cleanEmailTitle(source.subject) || '(No subject)',
          date: dateStr,
          start_time: timeStr,
          duration_minutes: totalDuration,
          context_minutes: 0,
          jira_issue: preservedJiraIssue ?? classification.jiraIssue,
          jira_source: (preservedJiraSource as 'manual' | 'route' | 'source_route' | 'extracted' | null) ?? classification.jiraSource,
          project: preservedProject ?? classification.project,
          project_source: (preservedProjectSource as 'manual' | 'keyword' | 'route' | null) ?? classification.projectSource,
          task_type: preservedTaskType ?? classification.taskType,
          task_type_source: (preservedTaskTypeSource as 'manual' | 'keyword' | 'route' | null) ?? classification.taskTypeSource,
          status: preservedStatus,
        });

        generated++;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        errors.push(`Source ${source.id}: ${errorMsg}`);
      }
    }

    return NextResponse.json({
      success: true,
      message: `Generated ${generated} entries, skipped ${skipped} (already exist)` +
        (staleCleanup.deleted > 0 ? `, cleaned up ${staleCleanup.deleted} stale entries` : ''),
      generated,
      skipped,
      staleDeleted: staleCleanup.deleted,
      total: sources.length,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('Error generating entries:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to generate entries' },
      { status: 500 }
    );
  }
}
