import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-server';
import { performSync } from '@/lib/sync';

export const maxDuration = 60;

export async function POST() {
  const db = createServiceClient();

  try {
    const result = await performSync(db);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
