import { NextResponse } from 'next/server';
import { getJiraCredentials, fetchTempoWorklogs } from '@/lib/jira';
import { setSetting } from '@/lib/db';
import { reconcilePushedEntries } from '@/lib/tempo-reconcile';

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
    if (result.success && result.username) {
      setSetting('jira_username', result.username);
    }
    const reconciliation = result.success
      ? reconcilePushedEntries(dateFrom, dateTo, result.entries || [])
      : undefined;

    return NextResponse.json({ ...result, reconciliation });
  } catch (error) {
    console.error('Error fetching Tempo worklogs:', error);
    const msg = error instanceof Error ? error.message : 'Failed to fetch Tempo worklogs';
    return NextResponse.json(
      { success: false, error: msg },
      { status: 500 }
    );
  }
}
