import { NextResponse } from 'next/server';
import { getJiraCredentials, searchJiraIssues } from '@/lib/jira';

export async function POST(request: Request) {
  try {
    const { query } = await request.json();

    if (!query || query.trim().length < 1) {
      return NextResponse.json({ success: true, issues: [] });
    }

    const creds = getJiraCredentials();
    if (!creds) {
      return NextResponse.json(
        { success: false, error: 'Jira credentials not configured. Please set up Jira first.' },
        { status: 400 }
      );
    }

    const result = await searchJiraIssues(creds, query.trim());

    return NextResponse.json({
      success: result.success,
      issues: result.issues || [],
      error: result.error,
    });
  } catch (error) {
    console.error('Error searching Jira issues:', error);
    const msg = error instanceof Error ? error.message : 'Failed to search issues';
    return NextResponse.json(
      { success: false, error: msg, issues: [] },
      { status: 500 }
    );
  }
}