import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-server';
import { fetchDrawings, parseDrawing } from '@/lib/lottery-api';
import { generatePicks } from '@/lib/evolution/fitness';
import { scorePendingPredictions } from '@/lib/score-predictions';
import type { StrategyGenome } from '@/lib/evolution/genome';
import type { Game } from '@/lib/supabase';

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const auth = req.headers.get('Authorization') ?? '';
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = createServiceClient();

  try {
    // 1. Find current max game already stored
    const { data: maxRow } = await db
      .from('games')
      .select('game_num')
      .order('game_num', { ascending: false })
      .limit(1)
      .maybeSingle();
    const maxInDb: number = maxRow?.game_num ?? 0;

    // 2. Check the latest drawing from the API
    const latest = await fetchDrawings(1);
    if (!latest.length) {
      await logEvent(db, 'poll_error', 'error', 'API returned no drawings');
      return NextResponse.json({ ok: true, action: 'no_data' });
    }
    const latestNum = parseInt(latest[0].drawNumber, 10);

    // 3. Catch up on every game missed since the last poll/sync — not just
    // the single most recent draw. If poll runs every 4 min but a draw lands
    // every 4 min too, drift or a missed cron-job.org invocation can mean
    // more than one new game is waiting; inserting only the latest would
    // silently skip the rest (they'd never get scored or shown).
    let insertedCount = 0;
    if (latestNum > maxInDb) {
      let cursor = latestNum;
      const MAX_BATCHES = 20;
      const allNew: ReturnType<typeof parseDrawing>[] = [];

      for (let i = 0; i < MAX_BATCHES; i++) {
        const drawings = await fetchDrawings(100, cursor);
        if (!drawings.length) break;

        const newDrawings = drawings.filter(d => parseInt(d.drawNumber, 10) > maxInDb);
        allNew.push(...newDrawings.map(parseDrawing));

        if (newDrawings.length < drawings.length) break;

        const lowestInBatch = Math.min(...drawings.map(d => parseInt(d.drawNumber, 10)));
        if (lowestInBatch <= maxInDb) break;
        cursor = lowestInBatch - 1;
      }

      if (allNew.length > 0) {
        const { error: insertErr } = await db
          .from('games')
          .upsert(allNew, { onConflict: 'game_num', ignoreDuplicates: true });
        if (insertErr) throw new Error(`Failed to insert games: ${insertErr.message}`);
        insertedCount = allNew.length;

        await logEvent(db, 'poll_success', 'success',
          `Poll ingested ${insertedCount} new game(s) up to #${latestNum}`,
          { count: insertedCount, latest_game_num: latestNum });
      }
    }

    if (insertedCount === 0) {
      await logEvent(db, 'poll_no_new_game', 'info',
        `Poll: already up to date at game #${maxInDb}`, { game_num: maxInDb });
    }

    // 4. Score every outstanding pending prediction whose target game now
    // exists — covers games inserted just now by this poll *and* any
    // inserted earlier by sync's backfill that never got scored.
    const scoredCount = await scorePendingPredictions(db);

    // 5. Commit predictions for the game right after the true current max
    const { data: maxAfterRow } = await db
      .from('games')
      .select('game_num')
      .order('game_num', { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextGameNum = (maxAfterRow?.game_num ?? maxInDb) + 1;

    const { data: promoted } = await db
      .from('strategies')
      .select('id,spot_count,genome')
      .eq('status', 'promoted');

    if (promoted && promoted.length > 0) {
      const { data: recentGames } = await db
        .from('games')
        .select('game_num,draw_date,draw_iso,draw_dow,bonus,super_bonus,hits')
        .order('game_num', { ascending: true })
        .limit(5000);

      const games = (recentGames ?? []) as Game[];

      const newPredictions = promoted.map(s => ({
        strategy_id: s.id,
        spot_count: s.spot_count,
        predicted_for_game_num: nextGameNum,
        picks: generatePicks(s.genome as StrategyGenome, s.spot_count, games),
        bonus_type: (s.genome as StrategyGenome).bonus_type ?? 'none',
      }));

      await db.from('pending_predictions').upsert(newPredictions, {
        onConflict: 'strategy_id,predicted_for_game_num',
        ignoreDuplicates: true,
      });

      await logEvent(db, 'prediction_committed', 'info',
        `Committed ${newPredictions.length} predictions for game #${nextGameNum}`,
        { game_num: nextGameNum, count: newPredictions.length });
    }

    return NextResponse.json({
      ok: true,
      action: insertedCount > 0 ? 'new_games' : 'no_new_game',
      games_added: insertedCount,
      latest_game_num: latestNum,
      predictions_scored: scoredCount,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logEvent(db, 'poll_error', 'error', `Poll error: ${msg}`, { error: msg }).catch(() => {});
    return NextResponse.json({ ok: true, error: msg }, { status: 200 }); // always 200
  }
}

async function logEvent(
  db: ReturnType<typeof createServiceClient>,
  event_type: string,
  severity: string,
  message: string,
  metadata?: object
) {
  await db.from('system_events').insert({ event_type, severity, message, metadata: metadata ?? null });
}
