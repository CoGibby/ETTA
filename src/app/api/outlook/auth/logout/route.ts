import { NextResponse } from 'next/server';
import { logout } from '@/lib/outlook-graph';
import { clearTransientData } from '@/lib/db';

export async function POST() {
  try {
    logout();
    clearTransientData();
    return NextResponse.json({ success: true, message: 'Signed out. Imported calendar history was cleared.' });
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
