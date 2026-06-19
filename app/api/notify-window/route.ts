import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-server';
import { notifyPlayWindow } from '@/lib/notify';

export async function POST(req: NextRequest) {
  const auth = req.headers.get('Authorization') ?? '';
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = createServiceClient();
  const today = new Date().toLocaleDateString('en-CA');

  const { data: pick } = await db
    .from('daily_picks')
    .select('spot_count, best_hour')
    .eq('pick_date', today)
    .maybeSingle();

  if (!pick?.best_hour) {
    return NextResponse.json({ ok: true, action: 'no_window' });
  }

  const etHour = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
  const currentHourET = parseInt(etHour, 10);

  if (currentHourET === (pick.best_hour as number)) {
    await notifyPlayWindow(pick.spot_count as number, pick.best_hour as number);
    return NextResponse.json({ ok: true, action: 'notified' });
  }

  return NextResponse.json({ ok: true, action: 'not_yet', currentHourET, bestHour: pick.best_hour });
}
