import { NextResponse } from 'next/server';
import { exchangeAuthCode } from '@/lib/outlook-graph';

function getRedirectUri(origin: string): string {
  const configuredRedirectUri = process.env.OUTLOOK_REDIRECT_URI?.trim();
  return configuredRedirectUri || `${origin}/api/outlook/auth/callback`;
}

function successPage(): NextResponse {
  return new NextResponse(
    '<!DOCTYPE html><html><head><title>ETTA - Outlook Connected</title></head><body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0fdf4"><div style="text-align:center"><h2 style="color:#16a34a;margin:0 0 8px">Outlook connected!</h2><p style="color:#334155">You can close this tab and return to ETTA.</p><script>setTimeout(function(){window.close()},1500)</script></div></body></html>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

function errorPage(message: string): NextResponse {
  const safe = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return new NextResponse(
    `<!DOCTYPE html><html><head><title>ETTA - Sign-in Failed</title></head><body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fef2f2"><div style="text-align:center;max-width:420px"><h2 style="color:#dc2626;margin:0 0 8px">Outlook sign-in failed</h2><p style="color:#334155">${safe}</p><p style="color:#64748b;font-size:14px">Close this tab and try again from ETTA.</p></div></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      const errorDesc = url.searchParams.get('error_description') || error;
      return errorPage(errorDesc);
    }

    if (!code) {
      return errorPage('No authorization code was returned.');
    }

    const redirectUri = getRedirectUri(url.origin);
    const result = await exchangeAuthCode(code, redirectUri);

    if (result.success) {
      return successPage();
    } else {
      return errorPage(result.error || 'Sign-in failed.');
    }
  } catch (error) {
    console.error('Error in Outlook auth callback:', error);
    const msg = error instanceof Error ? error.message : 'Callback failed';
    return errorPage(msg);
  }
}