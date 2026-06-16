import { createServiceClient } from '@/lib/supabase-server';
import { lookupPrize } from '@/lib/keno/prizes';

/**
 * Scores every `pending_predictions` row whose target game has already
 * landed in the `games` table, regardless of whether that game arrived via
 * a single /api/poll insert or via /api/sync's multi-game backfill.
 *
 * Bonus logic: each pending prediction carries a bonus_type ('none', 'bonus',
 * or 'super_bonus') inherited from the champion strategy's genome. The drawn
 * bonus/super_bonus multiplier comes from the game row itself and is applied
 * to the base prize. Wager cost is 1/2/3 respectively.
 */
export async function scorePendingPredictions(
  db: ReturnType<typeof createServiceClient>
): Promise<number> {
  const { data: pending } = await db
    .from('pending_predictions')
    .select('id,strategy_id,spot_count,picks,predicted_for_game_num,bonus_type')
    .eq('scored', false);

  if (!pending || pending.length === 0) return 0;

  const gameNums = [...new Set(pending.map(p => p.predicted_for_game_num as number))];
  const { data: games } = await db
    .from('games')
    .select('game_num,hits,bonus,super_bonus')
    .in('game_num', gameNums);

  interface GameRow { game_num: number; hits: number[]; bonus: number | null; super_bonus: number | null }
  const gamesByNum = new Map<number, GameRow>();
  for (const g of games ?? []) gamesByNum.set(g.game_num as number, g as GameRow);

  const strategyUpdates = new Map<number, { plays: number; pnl: number }>();
  let scoredCount = 0;

  for (const pred of pending) {
    const game = gamesByNum.get(pred.predicted_for_game_num as number);
    if (!game) continue; // game hasn't landed in the DB yet — leave pending

    const picks: number[] = pred.picks as number[];
    const hitSet = new Set(game.hits);
    let matches = 0;
    for (const p of picks) if (hitSet.has(p)) matches++;

    const bonusType = (pred.bonus_type ?? 'none') as string;
    const wagerCost = bonusType === 'super_bonus' ? 3 : bonusType === 'bonus' ? 2 : 1;
    const drawnMultiplier = bonusType === 'bonus'
      ? (game.bonus ?? 1)
      : bonusType === 'super_bonus'
      ? (game.super_bonus ?? 1)
      : 1;

    const basePrize = lookupPrize(pred.spot_count as number, matches);
    const effectivePrize = basePrize > 0 ? basePrize * drawnMultiplier : 0;
    const pnl = effectivePrize - wagerCost;

    await db.from('live_results').insert({
      strategy_id: pred.strategy_id,
      game_num: pred.predicted_for_game_num,
      spot_count: pred.spot_count,
      picks,
      actual_hits: game.hits,
      matches,
      prize: effectivePrize,
      pnl,
      is_shadow_play: true,
      bonus_type: bonusType,
      bonus_multiplier: drawnMultiplier,
    });

    await db.from('pending_predictions').update({ scored: true }).eq('id', pred.id);

    const strategyId = pred.strategy_id as number;
    const existing = strategyUpdates.get(strategyId) ?? { plays: 0, pnl: 0 };
    strategyUpdates.set(strategyId, { plays: existing.plays + 1, pnl: existing.pnl + pnl });

    const bonusLabel = bonusType !== 'none' ? ` [${bonusType.replace('_', ' ')} ×${drawnMultiplier}]` : '';
    await db.from('system_events').insert({
      event_type: 'prediction_scored',
      severity: pnl > 0 ? 'success' : 'info',
      message: `${pred.spot_count}-spot strategy #${pred.strategy_id}: ${matches} matches${bonusLabel}, P&L $${pnl.toFixed(2)}`,
      metadata: {
        strategy_id: pred.strategy_id,
        spot_count: pred.spot_count,
        matches,
        prize: effectivePrize,
        pnl,
        bonus_type: bonusType,
        bonus_multiplier: drawnMultiplier,
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
