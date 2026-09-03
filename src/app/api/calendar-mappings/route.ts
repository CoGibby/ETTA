import { NextResponse } from 'next/server';
import { getCalendarJiraMappings, upsertCalendarJiraMapping } from '@/lib/db';
import { getJiraCredentials, validateJiraIssue } from '@/lib/jira';

const SOURCE_TYPES = ['meeting', 'email', 'manual', 'all'] as const;

export async function GET() {
  return NextResponse.json({ mappings: getCalendarJiraMappings() });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const sourceType = body.sourceType || 'all';
    const jiraIssue = typeof body.jiraIssue === 'string' ? body.jiraIssue.trim().toUpperCase() : '';

    if (!title || !jiraIssue) {
      return NextResponse.json(
        { success: false, error: 'A calendar title and Jira issue are required.' },
        { status: 400 }
      );
    }

    if (!SOURCE_TYPES.includes(sourceType)) {
      return NextResponse.json(
        { success: false, error: 'Invalid source type.' },
        { status: 400 }
      );
    }

    const credentials = getJiraCredentials();
    if (!credentials) {
      return NextResponse.json(
        { success: false, error: 'Connect Jira before saving a calendar mapping.' },
        { status: 400 }
      );
    }

    const validation = await validateJiraIssue(credentials, jiraIssue);
    if (!validation.valid) {
      return NextResponse.json(
        { success: false, error: validation.error || 'That Jira issue cannot receive time.' },
        { status: 400 }
      );
    }

    const mapping = upsertCalendarJiraMapping({
      title,
      sourceType,
      jiraIssue,
      jiraName: validation.jiraName || null,
    });

    return NextResponse.json({ success: true, mapping });
  } catch (error) {
    console.error('Error saving calendar mapping:', error);
    return NextResponse.json(
      { success: false, error: 'Could not save the calendar mapping.' },
      { status: 500 }
    );
  }
}
