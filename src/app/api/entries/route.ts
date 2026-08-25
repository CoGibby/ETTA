import { NextResponse } from 'next/server';
import { getEntries, createEntry, clearEntries, bulkUpdateEntries, getUnifiedRouteMap } from '@/lib/db';
import { classifySource } from '@/lib/classifier';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const date = searchParams.get('date') || undefined;
  const startDate = searchParams.get('startDate') || undefined;
  const endDate = searchParams.get('endDate') || undefined;
  const status = searchParams.get('status') as 'pending' | 'pushed' | 'excluded' | null;
  const hasJiraIssue = searchParams.get('hasJiraIssue');

  const entries = getEntries({
    date,
    startDate,
    endDate,
    status: status || undefined,
    hasJiraIssue: hasJiraIssue === 'true' ? true : hasJiraIssue === 'false' ? false : undefined,
  });

  return NextResponse.json({ entries, total: entries.length });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const { source_id, source_type, title, date, start_time, duration_minutes, jira_issue, jira_name, jira_source, project, project_source, task_type, task_type_source } = body;

    if (!source_type || !title || !date || duration_minutes === undefined) {
      return NextResponse.json(
        { error: 'Missing required fields: source_type, title, date, duration_minutes' },
        { status: 400 }
      );
    }

    // Initialize final values
    let finalProject = project ?? null;
    let finalProjectSource = project ? (project_source ?? 'manual') : null;
    let finalTaskType = task_type ?? null;
    let finalTaskTypeSource = task_type ? (task_type_source ?? 'manual') : null;
    let finalJiraIssue = jira_issue ?? null;
    const finalJiraName = jira_name ?? null;
    let finalJiraSource = jira_issue ? (jira_source ?? 'manual') : null;

    // For manual entries, run classification on title for unfilled fields
    if (source_type === 'manual') {
      const classification = classifySource(title, '', undefined);

      // Only apply classification if user didn't provide a value
      if (!project && classification.project) {
        finalProject = classification.project;
        finalProjectSource = classification.projectSource;
      }
      if (!task_type && classification.taskType) {
        finalTaskType = classification.taskType;
        finalTaskTypeSource = classification.taskTypeSource;
      }
      if (!jira_issue && classification.jiraIssue) {
        finalJiraIssue = classification.jiraIssue;
        finalJiraSource = classification.jiraSource;
      }

      // If user provided project and task_type but no jira, look up route
      // This ensures routes work for manual entries
      if (!finalJiraIssue && finalProject && finalTaskType) {
        const { twoFieldTaskType } = getUnifiedRouteMap();
        const routeKey = `${finalProject}|${finalTaskType}`;
        const route = twoFieldTaskType.get(routeKey);
        if (route) {
          finalJiraIssue = route.jiraKey;
          finalJiraSource = 'route';
        }
      }
    }

    const result = createEntry({
      source_id: source_id ?? null,
      source_type,
      title,
      date,
      start_time: start_time ?? null,
      duration_minutes,
      jira_issue: finalJiraIssue,
      jira_name: finalJiraName,
      jira_source: finalJiraSource,
      project: finalProject,
      project_source: finalProjectSource,
      task_type: finalTaskType,
      task_type_source: finalTaskTypeSource,
    });

    return NextResponse.json({ id: result.id });
  } catch (error) {
    console.error('Error creating entry:', error);
    return NextResponse.json({ error: 'Failed to create entry' }, { status: 500 });
  }
}

export async function DELETE() {
  const result = clearEntries();
  return NextResponse.json({ deleted: result.changes });
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const { ids, updates } = body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: 'ids array required' }, { status: 400 });
    }

    if (!updates || typeof updates !== 'object') {
      return NextResponse.json({ error: 'updates object required' }, { status: 400 });
    }

    const result = bulkUpdateEntries(ids, updates);
    return NextResponse.json({ updated: result.changes });
  } catch (error) {
    console.error('Error bulk updating entries:', error);
    return NextResponse.json({ error: 'Failed to update entries' }, { status: 500 });
  }
}
