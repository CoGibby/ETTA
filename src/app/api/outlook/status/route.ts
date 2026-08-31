import { NextResponse } from 'next/server';
import { getAuthStatus } from '@/lib/outlook-graph';

export async function GET() {
  try {
    const status = await getAuthStatus();
    return NextResponse.json({ backend: 'graph', ...status });
  } catch (error) {
    return NextResponse.json(
      {
        backend: 'graph',
        configured: false,
        connected: false,
        account: null,
        message: error instanceof Error ? error.message : 'Outlook status check failed',
      },
      { status: 500 }
    );
  }
}