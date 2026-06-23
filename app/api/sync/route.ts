import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-server';
import { performSync } from '@/lib/sync';

// Backfill + one evolution generation can take longer than the platform default.
export const maxDuration = 300;

// GET: called by Vercel cron — no auth required (Vercel signs the request)
export async function GET() {
  const db = createServiceClient();
  try {
    const result = await performSync(db);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// POST: called by external cron services with Bearer auth
export async function POST(req: NextRequest) {
  const auth = req.headers.get('Authorization') ?? '';
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (auth !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = createServiceClient();

  try {
    const result = await performSync(db);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
