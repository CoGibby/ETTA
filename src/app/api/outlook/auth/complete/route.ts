import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json(
    { success: false, error: 'Device code flow is no longer supported. Use the redirect flow instead.' },
    { status: 400 }
  );
}