import { NextResponse } from 'next/server';
import { buildAuthUrl } from '@/lib/outlook-graph';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const origin = url.origin;
    const redirectUri = `${origin}/api/outlook/auth/callback`;
    const prompt = url.searchParams.get('prompt');
    const authUrl = buildAuthUrl(
      redirectUri,
      prompt === 'select_account' ? { prompt } : undefined
    );
    return NextResponse.redirect(authUrl);
  } catch (error) {
    console.error('Error starting Outlook auth:', error);
    const msg = error instanceof Error ? error.message : 'Failed to start sign-in';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
