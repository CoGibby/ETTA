import { NextResponse } from 'next/server';
import { testJiraConnection } from '@/lib/jira';

export async function POST(request: Request) {
  try {
    const { url, pat } = await request.json();

    if (!url || !pat) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields: url, pat' },
        { status: 400 }
      );
    }

    const result = await testJiraConnection(url, pat);

    return NextResponse.json({
      success: result.success,
      message: result.message,
      error: result.success ? undefined : result.message,
    });
  } catch (error) {
    console.error('Error testing Jira connection:', error);
    const msg = error instanceof Error ? error.message : 'Failed to test connection';
    return NextResponse.json(
      { success: false, error: msg, message: msg },
      { status: 500 }
    );
  }
}
