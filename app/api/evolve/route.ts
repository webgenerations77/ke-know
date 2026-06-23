import { NextResponse } from 'next/server';
import { runEvolution } from '@/lib/evolution/evolve';

export const maxDuration = 300;

export async function POST() {
  try {
    const result = await runEvolution();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
