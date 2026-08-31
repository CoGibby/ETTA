import { NextResponse } from 'next/server';
import { getJiraCredentials, fetchTempoWorklogs } from '@/lib/jira';

export async function POST(request: Request) {
  try {
    const { dateFrom, dateTo } = await request.json();

    if (!dateFrom || !dateTo) {
      return NextResponse.json(
        { success: false, error: 'dateFrom and dateTo are required.' },
        { status: 400 }
      );
    }

    const creds = getJiraCredentials();
    if (!creds) {
      return NextResponse.json(
        { success: false, error: 'Jira credentials not configured. Please set up Jira first.' },
        { status: 400 }
      );
    }

    const result = await fetchTempoWorklogs(creds, dateFrom, dateTo);

    return NextResponse.json(result);
  } catch (error) {
    console.error('Error fetching Tempo worklogs:', error);
    const msg = error instanceof Error ? error.message : 'Failed to fetch Tempo worklogs';
    return NextResponse.json(
      { success: false, error: msg },
      { status: 500 }
    );
  }
}