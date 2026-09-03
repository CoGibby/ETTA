import { NextResponse } from 'next/server';
import { deleteCalendarJiraMapping } from '@/lib/db';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const mappingId = Number(id);

  if (!Number.isInteger(mappingId) || mappingId <= 0) {
    return NextResponse.json({ success: false, error: 'Invalid mapping ID.' }, { status: 400 });
  }

  const result = deleteCalendarJiraMapping(mappingId);
  if (result.changes === 0) {
    return NextResponse.json({ success: false, error: 'Mapping not found.' }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
