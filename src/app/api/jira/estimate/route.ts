import { NextResponse } from 'next/server';
import { getJiraCredentials } from '@/lib/jira';

export async function POST(request: Request) {
  try {
    const { keys } = await request.json();
    if (!Array.isArray(keys) || keys.length === 0) {
      return NextResponse.json({ success: true, estimates: {} });
    }

    const creds = getJiraCredentials();
    if (!creds) {
      return NextResponse.json(
        { success: false, error: 'Jira credentials not configured.' },
        { status: 400 }
      );
    }

    const cleanBaseUrl = creds.baseUrl.replace(/\/$/, '');
    const headers = {
      'Authorization': `Bearer ${creds.token}`,
      'Accept': 'application/json',
    };

    // Batch fetch all keys in one JQL query
    const keyList = keys.map((k: string) => k.toUpperCase()).join(',');
    const jql = `key in (${keyList})`;
    const url = `${cleanBaseUrl}/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=100&fields=summary,issuetype,timeestimate,aggregatetimeestimate,timeoriginalestimate,status`;

    const res = await fetch(url, { method: 'GET', headers });
    if (!res.ok) {
      return NextResponse.json(
        { success: false, error: `Jira request failed: ${res.statusText}` },
        { status: 500 }
      );
    }

    const data = await res.json();
    const estimates: Record<string, { remaining: number; hasEstimate: boolean; issueType: string; isOpen: boolean; statusName: string }> = {};
    for (const issue of (data.issues || [])) {
      const issueType = (issue.fields?.issuetype?.name || '').toLowerCase();
      if (issueType === 'epic' || issueType === 'milestone' || issueType === 'requirement') continue;
      const key = (issue.key || '').toUpperCase();
      const remaining = issue.fields?.timeestimate ?? issue.fields?.aggregatetimeestimate ?? 0;
      // Only flag as having an estimate if an original estimate was ever set
      const originalEstimate = issue.fields?.timeoriginalestimate;
      const hasEstimate = originalEstimate !== null && originalEstimate !== undefined;
      const statusCategory = issue.fields?.status?.statusCategory?.key || '';
      const statusName = issue.fields?.status?.name || '';
      const isOpen = statusCategory !== 'done';
      estimates[key] = { remaining, hasEstimate, issueType, isOpen, statusName };
    }

    return NextResponse.json({ success: true, estimates });
  } catch (error) {
    console.error('Error fetching estimates:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch estimates' },
      { status: 500 }
    );
  }
}
