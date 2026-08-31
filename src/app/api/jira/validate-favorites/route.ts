import { NextResponse } from 'next/server';
import { getJiraCredentials, validateFavorites } from '@/lib/jira';

export async function POST(request: Request) {
  try {
    const { keys } = await request.json();

    if (!Array.isArray(keys)) {
      return NextResponse.json(
        { success: false, error: 'keys array is required.' },
        { status: 400 }
      );
    }

    const creds = getJiraCredentials();
    if (!creds) {
      return NextResponse.json(
        { success: false, error: 'Jira credentials not configured.' },
        { status: 400 }
      );
    }

    const result = await validateFavorites(creds, keys);

    return NextResponse.json(result);
  } catch (error) {
    console.error('Error validating favorites:', error);
    const msg = error instanceof Error ? error.message : 'Failed to validate favorites';
    return NextResponse.json(
      { success: false, error: msg },
      { status: 500 }
    );
  }
}