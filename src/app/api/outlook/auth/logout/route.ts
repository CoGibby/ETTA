import { NextResponse } from 'next/server';
import { logout } from '@/lib/outlook-graph';

export async function POST() {
  try {
    logout();
    return NextResponse.json({ success: true, message: 'Signed out.' });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to sign out',
      },
      { status: 500 }
    );
  }
}