import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-server';
import { fetchDrawings, parseDrawing } from '@/lib/lottery-api';

export async function POST(req: NextRequest) {
  const auth = req.headers.get('Authorization') ?? '';
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (auth !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = createServiceClient();

  try {
    const { data: maxRow } = await db
      .from('games')
      .select('game_num')
      .order('game_num', { ascending: false })
      .limit(1)
      .maybeSingle();
    const maxInDb: number = maxRow?.game_num ?? 0;

    const latest = await fetchDrawings(1);
    if (!latest.length) {
      return NextResponse.json({ gamesAdded: 0, notes: 'API returned no drawings' });
    }
    const latestNum = parseInt(latest[0].drawNumber, 10);

    if (latestNum <= maxInDb) {
      await db.from('sync_log').insert({
        games_added: 0,
        source: 'auto',
        latest_game_num: latestNum,
        notes: 'Already up to date',
      });
      return NextResponse.json({ gamesAdded: 0 });
    }

    // Loop in batches until we've fetched all games newer than maxInDb.
    // The API returns games going backward from `start`, so we page down
    // until the batch contains nothing newer than maxInDb.
    let cursor = latestNum;
    let totalAdded = 0;
    const MAX_BATCHES = 50; // safety cap (~5000 games max per sync run)

    for (let i = 0; i < MAX_BATCHES; i++) {
      const drawings = await fetchDrawings(100, cursor);
      if (!drawings.length) break;

      const newDrawings = drawings.filter(
        d => parseInt(d.drawNumber, 10) > maxInDb
      );

      if (newDrawings.length > 0) {
        const rows = newDrawings.map(parseDrawing);
        const { error } = await db
          .from('games')
          .upsert(rows, { onConflict: 'game_num', ignoreDuplicates: true });
        if (error) throw error;
        totalAdded += rows.length;
      }

      // Stop if this batch contained games we already have — we're caught up
      if (newDrawings.length < drawings.length) break;

      // All 100 were new → there may be more; page down
      const lowestInBatch = Math.min(
        ...drawings.map(d => parseInt(d.drawNumber, 10))
      );
      if (lowestInBatch <= maxInDb) break;
      cursor = lowestInBatch - 1;
    }

    await db.from('sync_log').insert({
      games_added: totalAdded,
      source: 'auto',
      latest_game_num: latestNum,
      notes: totalAdded > 0 ? `Added ${totalAdded} games up to #${latestNum}` : 'Already up to date',
    });

    return NextResponse.json({ gamesAdded: totalAdded });
  } catch (err) {
    console.error('[sync]', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
