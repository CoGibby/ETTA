import { NextResponse } from 'next/server';
import { exchangeAuthCode } from '@/lib/outlook-graph';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      const errorDesc = url.searchParams.get('error_description') || error;
      return NextResponse.redirect(
        new URL(`/settings?outlook_error=${encodeURIComponent(errorDesc)}`, url.origin)
      );
    }

    if (!code) {
      return NextResponse.redirect(
        new URL('/settings?outlook_error=No+auth+code+returned', url.origin)
      );
    }

    const origin = url.origin;
    const redirectUri = `${origin}/api/outlook/auth/callback`;
    const result = await exchangeAuthCode(code, redirectUri);

    if (result.success) {
      return NextResponse.redirect(
        new URL('/settings?outlook_connected=1', url.origin)
      );
    } else {
      return NextResponse.redirect(
        new URL(`/settings?outlook_error=${encodeURIComponent(result.error || 'Sign-in failed')}`, url.origin)
      );
    }
  } catch (error) {
    console.error('Error in Outlook auth callback:', error);
    const msg = error instanceof Error ? error.message : 'Callback failed';
    return NextResponse.redirect(
      new URL(`/settings?outlook_error=${encodeURIComponent(msg)}`, url.origin)
    );
  }
}