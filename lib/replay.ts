import { createServiceClient } from '@/lib/supabase-server';
import { generatePicks } from '@/lib/evolution/fitness';
import { lookupPrize } from '@/lib/keno/prizes';
import type { StrategyGenome } from '@/lib/evolution/genome';
import type { Game } from '@/lib/supabase';

const MAX_NEW_RESULTS_PER_RUN = 500;
const BATCH_INSERT_SIZE = 100;

interface ReplayResult {
  totalNew: number;
  championsProcessed: number;
}

/**
 * Replays all promoted champion strategies against historical games they
 * haven't been scored on yet. Writes results directly to live_results so
 * the fitness function picks them up on the next evolution run.
 *
 * Key constraint: when generating picks for game N, only games before N
 * are used as context — no look-ahead bias.
 */
export async function replayChampions(
  db: ReturnType<typeof createServiceClient>
): Promise<ReplayResult> {
  const { data: champions } = await db
    .from('strategies')
    .select('id, spot_count, genome, real_world_plays, real_world_pnl')
    .eq('status', 'promoted');

  if (!champions || champions.length === 0) {
    return { totalNew: 0, championsProcessed: 0 };
  }

  const { data: gamesData } = await db
    .from('games')
    .select('game_num, draw_date, draw_iso, draw_dow, bonus, super_bonus, hits')
    .order('game_num', { ascending: true });

  const allGames = (gamesData ?? []) as Game[];
  if (allGames.length < 20) {
    return { totalNew: 0, championsProcessed: 0 };
  }

  let totalNew = 0;

  for (const champ of champions) {
    if (totalNew >= MAX_NEW_RESULTS_PER_RUN) break;

    const strategyId = champ.id as number;
    const spotCount = champ.spot_count as number;
    const genome = champ.genome as unknown as StrategyGenome;
    const bonusType = genome.bonus_type ?? 'none';
    const wagerCost = bonusType === 'super_bonus' ? 3 : bonusType === 'bonus' ? 2 : 1;

    const { data: existingResults } = await db
      .from('live_results')
      .select('game_num')
      .eq('strategy_id', strategyId);

    const scoredGames = new Set(
      (existingResults ?? []).map(r => r.game_num as number)
    );

    const minLookback = Math.max(genome.lookback_games ?? 50, 20);
    const unscoredGames: number[] = [];
    for (let i = minLookback; i < allGames.length; i++) {
      if (!scoredGames.has(allGames[i].game_num)) {
        unscoredGames.push(i);
      }
    }

    if (unscoredGames.length === 0) continue;

    const cap = Math.min(unscoredGames.length, MAX_NEW_RESULTS_PER_RUN - totalNew);
    const toProcess = unscoredGames.slice(0, cap);

    const rows: {
      strategy_id: number;
      game_num: number;
      spot_count: number;
      picks: number[];
      actual_hits: number[];
      matches: number;
      prize: number;
      pnl: number;
      is_shadow_play: boolean;
      bonus_type: string;
      bonus_multiplier: number;
    }[] = [];

    let addedPnl = 0;

    for (const gameIdx of toProcess) {
      const game = allGames[gameIdx];
      const context = allGames.slice(0, gameIdx);
      const picks = generatePicks(genome, spotCount, context);

      const hitSet = new Set(game.hits);
      let matches = 0;
      for (const p of picks) if (hitSet.has(p)) matches++;

      const drawnMultiplier = bonusType === 'bonus'
        ? (game.bonus ?? 1)
        : bonusType === 'super_bonus'
        ? (game.super_bonus ?? 1)
        : 1;

      const basePrize = lookupPrize(spotCount, matches);
      const effectivePrize = basePrize > 0 ? basePrize * drawnMultiplier : 0;
      const pnl = effectivePrize - wagerCost;

      rows.push({
        strategy_id: strategyId,
        game_num: game.game_num,
        spot_count: spotCount,
        picks,
        actual_hits: game.hits,
        matches,
        prize: effectivePrize,
        pnl,
        is_shadow_play: true,
        bonus_type: bonusType,
        bonus_multiplier: drawnMultiplier,
      });

      addedPnl += pnl;

      if (rows.length >= BATCH_INSERT_SIZE) {
        await db.from('live_results').upsert(rows, {
          onConflict: 'strategy_id,game_num',
          ignoreDuplicates: true,
        });
        totalNew += rows.length;
        rows.length = 0;
      }
    }

    if (rows.length > 0) {
      await db.from('live_results').upsert(rows, {
        onConflict: 'strategy_id,game_num',
        ignoreDuplicates: true,
      });
      totalNew += rows.length;
    }

    const newPlays = (champ.real_world_plays as number) + toProcess.length;
    const newPnl = (champ.real_world_pnl as number) + addedPnl;
    await db.from('strategies').update({
      real_world_plays: newPlays,
      real_world_pnl: newPnl,
    }).eq('id', strategyId);
  }

  return { totalNew, championsProcessed: champions.length };
}
