import { NextResponse } from 'next/server';
import {
  findCalendarExclusionRule,
  getEntries,
  getCalendarExclusionRules,
  upsertCalendarExclusionRule,
  updateEntry,
} from '@/lib/db';

export async function GET() {
  return NextResponse.json({ rules: getCalendarExclusionRules() });
}

export async function POST(request: Request) {
  try {
    const { title, sourceType, externalId } = await request.json();
    if (!title || !sourceType) {
      return NextResponse.json({ success: false, error: 'title and sourceType are required.' }, { status: 400 });
    }
    if (!['meeting', 'email', 'manual'].includes(sourceType)) {
      return NextResponse.json({ success: false, error: 'Invalid sourceType.' }, { status: 400 });
    }

    const rule = upsertCalendarExclusionRule({ title, sourceType, externalId });
    let excludedCount = 0;
    for (const entry of getEntries()) {
      if (entry.status !== 'pending') continue;
      const match = findCalendarExclusionRule({
        title: entry.title,
        sourceType: entry.source_type,
        externalId: entry.external_id,
      });
      if (!match || match.id !== rule.id) continue;
      updateEntry(entry.id, { status: 'excluded' });
      excludedCount++;
    }

    return NextResponse.json({ success: true, rule, excludedCount });
  } catch (error) {
    console.error('Error saving exclusion rule:', error);
    return NextResponse.json({ success: false, error: 'Failed to save exclusion rule.' }, { status: 500 });
  }
}
