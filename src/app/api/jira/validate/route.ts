import { NextResponse } from 'next/server';
import { getJiraCredentials, validateJiraIssue } from '@/lib/jira';

export async function POST(request: Request) {
  try {
    const { jira_key } = await request.json();

    if (!jira_key) {
      return NextResponse.json(
        { valid: false, error: 'jira_key is required' },
        { status: 400 }
      );
    }

    const creds = getJiraCredentials();
    if (!creds) {
      return NextResponse.json(
        { valid: false, error: 'Jira credentials not configured. Please set up Jira in Settings.' },
        { status: 400 }
      );
    }

    const result = await validateJiraIssue(creds, jira_key);

    return NextResponse.json({
      valid: result.valid,
      jira_key: result.valid ? jira_key : undefined,
      jira_name: result.jiraName,
      error: result.error,
    });
  } catch (error) {
    console.error('Error validating Jira issue:', error);
    const msg = error instanceof Error ? error.message : 'Failed to validate issue';
    return NextResponse.json(
      { valid: false, error: msg },
      { status: 500 }
    );
  }
}