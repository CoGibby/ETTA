import { NextResponse } from 'next/server';
import { deleteCalendarExclusionRule } from '@/lib/db';

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ruleId = Number(id);
  if (!Number.isInteger(ruleId) || ruleId <= 0) {
    return NextResponse.json({ success: false, error: 'Invalid rule ID.' }, { status: 400 });
  }
  const result = deleteCalendarExclusionRule(ruleId);
  return NextResponse.json({ success: result.changes > 0, changes: result.changes });
}
