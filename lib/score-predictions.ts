import { createServiceClient } from '@/lib/supabase-server';
import { lookupPrize } from '@/lib/keno/prizes';

/**
 * Scores every `pending_predictions` row whose target game has already
 * landed in the `games` table, regardless of whether that game arrived via
 * a single /api/poll insert or via /api/sync's multi-game backfill.
 *
 * Previously, scoring only happened inline inside /api/poll right after it
 * inserted a single new "latest" game. Any games that arrived instead via
 * sync's backfill (e.g. because poll missed a draw, or cron-job.org skipped
 * an invocation) were never scored — their pending_predictions sat with
 * scored=false forever, showing up as blank rows in the Live Monitor feed.
 * Calling this after *any* game insert (poll or sync) closes that gap.
 */
export async function scorePendingPredictions(
  db: ReturnType<typeof createServiceClient>
): Promise<number> {
  const { data: pending } = await db
    .from('pending_predictions')
    .select('id,strategy_id,spot_count,picks,predicted_for_game_num')
    .eq('scored', false);

  if (!pending || pending.length === 0) return 0;

  const gameNums = [...new Set(pending.map(p => p.predicted_for_game_num as number))];
  const { data: games } = await db
    .from('games')
    .select('game_num,hits')
    .in('game_num', gameNums);

  const hitsByGame = new Map<number, number[]>();
  for (const g of games ?? []) hitsByGame.set(g.game_num as number, g.hits as number[]);

  const strategyUpdates = new Map<number, { plays: number; pnl: number }>();
  let scoredCount = 0;

  for (const pred of pending) {
    const actualHits = hitsByGame.get(pred.predicted_for_game_num as number);
    if (!actualHits) continue; // game hasn't landed in the DB yet — leave pending

    const picks: number[] = pred.picks as number[];
    const hitSet = new Set(actualHits);
    let matches = 0;
    for (const p of picks) if (hitSet.has(p)) matches++;

    const prize = lookupPrize(pred.spot_count as number, matches);
    const pnl = prize - 1;

    await db.from('live_results').insert({
      strategy_id: pred.strategy_id,
      game_num: pred.predicted_for_game_num,
      spot_count: pred.spot_count,
      picks,
      actual_hits: actualHits,
      matches,
      prize,
      pnl,
      is_shadow_play: true,
    });

    await db.from('pending_predictions').update({ scored: true }).eq('id', pred.id);

    const strategyId = pred.strategy_id as number;
    const existing = strategyUpdates.get(strategyId) ?? { plays: 0, pnl: 0 };
    strategyUpdates.set(strategyId, { plays: existing.plays + 1, pnl: existing.pnl + pnl });

    await db.from('system_events').insert({
      event_type: 'prediction_scored',
      severity: pnl > 0 ? 'success' : 'info',
      message: `${pred.spot_count}-spot strategy #${pred.strategy_id}: ${matches} matches, P&L $${pnl.toFixed(2)}`,
      metadata: {
        strategy_id: pred.strategy_id,
        spot_count: pred.spot_count,
        matches,
        prize,
        pnl,
        game_num: pred.predicted_for_game_num,
      },
    });

    scoredCount++;
  }

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

  return scoredCount;
}
