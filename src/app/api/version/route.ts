import { NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import path from 'path';

export function GET() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    return NextResponse.json({ version: pkg.version ?? 'unknown' });
  } catch {
    return NextResponse.json({ version: 'unknown' });
  }
}
