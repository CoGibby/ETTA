import { NextResponse } from 'next/server';
import { getJiraCredentials, updateJiraWorklog } from '@/lib/jira';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { issueKey, worklogId, timeSpentMinutes, startedDate, comment } = body;
    if (!issueKey || !worklogId || !timeSpentMinutes || !startedDate) {
      return NextResponse.json({ success: false, error: 'Missing required fields' }, { status: 400 });
    }
    const credentials = await getJiraCredentials();
    if (!credentials) {
      return NextResponse.json({ success: false, error: 'Jira not connected' }, { status: 400 });
    }
    const result = await updateJiraWorklog(credentials, issueKey, worklogId, timeSpentMinutes, startedDate, comment);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ success: false, error: 'Failed to update worklog' }, { status: 500 });
  }
}