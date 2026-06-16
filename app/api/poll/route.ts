import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-server';
import { fetchDrawings, parseDrawing } from '@/lib/lottery-api';
import { lookupPrize } from '@/lib/keno/prizes';
import { generatePicks } from '@/lib/evolution/fitness';
import type { StrategyGenome } from '@/lib/evolution/genome';
import type { Game } from '@/lib/supabase';

export async function POST(req: NextRequest) {
  const auth = req.headers.get('Authorization') ?? '';
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = createServiceClient();

  try {
    // 1. Fetch latest game from API
    const latest = await fetchDrawings(1);
    if (!latest.length) {
      await logEvent(db, 'poll_error', 'error', 'API returned no drawings');
      return NextResponse.json({ ok: true, action: 'no_data' });
    }

    const gameNum = parseInt(latest[0].drawNumber, 10);

    // 2. Check if already in DB
    const { data: existing } = await db
      .from('games')
      .select('game_num')
      .eq('game_num', gameNum)
      .maybeSingle();

    if (existing) {
      await logEvent(db, 'poll_no_new_game', 'info',
        `Poll: game #${gameNum} already stored`, { game_num: gameNum });
      return NextResponse.json({ ok: true, action: 'no_new_game', game_num: gameNum });
    }

    // 3. Insert new game
    const row = parseDrawing(latest[0]);
    const { error: insertErr } = await db.from('games').insert(row);
    if (insertErr) throw new Error(`Failed to insert game: ${insertErr.message}`);

    await logEvent(db, 'poll_success', 'success',
      `New game #${gameNum} ingested (${row.draw_date})`,
      { game_num: gameNum, draw_date: row.draw_date });

    const actualHits: number[] = latest[0].results.hits;

    // 4. Score pending predictions for this game
    const { data: pending } = await db
      .from('pending_predictions')
      .select('id,strategy_id,spot_count,picks')
      .eq('predicted_for_game_num', gameNum)
      .eq('scored', false);

    const strategyUpdates: Map<number, { plays: number; pnl: number }> = new Map();

    for (const pred of pending ?? []) {
      const picks: number[] = pred.picks;
      const hitSet = new Set(actualHits);
      let matches = 0;
      for (const p of picks) if (hitSet.has(p)) matches++;

      const prize = lookupPrize(pred.spot_count, matches);
      const pnl = prize - 1;

      // Insert live result
      await db.from('live_results').insert({
        strategy_id: pred.strategy_id,
        game_num: gameNum,
        spot_count: pred.spot_count,
        picks,
        actual_hits: actualHits,
        matches,
        prize,
        pnl,
        is_shadow_play: true,
      });

      // Mark prediction scored
      await db.from('pending_predictions').update({ scored: true }).eq('id', pred.id);

      // Accumulate strategy stat updates
      const existing = strategyUpdates.get(pred.strategy_id) ?? { plays: 0, pnl: 0 };
      strategyUpdates.set(pred.strategy_id, { plays: existing.plays + 1, pnl: existing.pnl + pnl });

      await logEvent(db, 'prediction_scored', pnl > 0 ? 'success' : 'info',
        `${pred.spot_count}-spot strategy #${pred.strategy_id}: ${matches} matches, P&L $${pnl.toFixed(2)}`,
        { strategy_id: pred.strategy_id, spot_count: pred.spot_count, matches, prize, pnl, game_num: gameNum });
    }

    // 5. Update strategy stats in bulk
    for (const [strategyId, stats] of strategyUpdates) {
      const { data: current } = await db
        .from('strategies')
        .select('real_world_plays,real_world_pnl')
        .eq('id', strategyId)
        .maybeSingle();

      if (current) {
        await db.from('strategies').update({
          real_world_plays: (current.real_world_plays ?? 0) + stats.plays,
          real_world_pnl: (current.real_world_pnl ?? 0) + stats.pnl,
        }).eq('id', strategyId);
      }
    }

    // 6. Commit predictions for next game
    const nextGameNum = gameNum + 1;

    const { data: promoted } = await db
      .from('strategies')
      .select('id,spot_count,genome')
      .eq('status', 'promoted');

    if (promoted && promoted.length > 0) {
      // Load recent games for pick generation
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
      action: 'new_game',
      game_num: gameNum,
      predictions_scored: pending?.length ?? 0,
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
