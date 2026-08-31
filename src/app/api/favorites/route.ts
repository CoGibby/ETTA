import { NextResponse } from 'next/server';
import { getFavorites, createFavorite } from '@/lib/db';

export async function GET() {
  const favorites = getFavorites();
  return NextResponse.json({ favorites });
}

export async function POST(request: Request) {
  const { jira_key, jira_name, short_name } = await request.json();

  if (!jira_key || !jira_name) {
    return NextResponse.json({ error: 'jira_key and jira_name required' }, { status: 400 });
  }

  try {
    const result = createFavorite(jira_key, jira_name, short_name);
    return NextResponse.json({ id: result.id, jira_key, jira_name, short_name });
  } catch {
    return NextResponse.json({ error: 'Favorite with this Jira key already exists' }, { status: 409 });
  }
}
