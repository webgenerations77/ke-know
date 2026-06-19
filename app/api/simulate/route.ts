import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-server';
import { replayChampions } from '@/lib/replay';

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization');
  const secret = process.env.CRON_SECRET;
  const isAuthed = secret && auth === `Bearer ${secret}`;
  const isInternal = req.headers.get('x-internal') === '1';

  if (!isAuthed && !isInternal) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const db = createServiceClient();
    const result = await replayChampions(db);

    if (result.totalNew > 0) {
      await db.from('system_events').insert({
        event_type: 'simulator_replay',
        severity: 'info',
        message: `Simulator replay: ${result.totalNew} new results across ${result.championsProcessed} champions`,
        metadata: result,
      });
    }

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
