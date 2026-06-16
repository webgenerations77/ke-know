import { createServiceClient } from '@/lib/supabase-server';
import type { Game } from '@/lib/supabase';
import {
  randomGenome, mutateGenome, crossoverGenome, type StrategyGenome,
} from './genome';
import { simulateStrategy, computeFitness, generatePicks } from './fitness';

const POP_SIZE = 20;      // strategies per spot count
const SURVIVORS = 10;     // keep top N per sub-pop
const SPOT_COUNTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const TEST_WINDOW = 1000; // most recent games reserved for test set

interface StrategyRow {
  id: number;
  generation: number;
  spot_count: number;
  genome: StrategyGenome;
  status: string;
  real_world_plays: number;
  real_world_pnl: number;
}

interface LiveStat {
  strategy_id: number;
  count: number;
  total_pnl: number;
}

async function loadAllGames(db: ReturnType<typeof createServiceClient>): Promise<Game[]> {
  const { data, error } = await db
    .from('games')
    .select('game_num,draw_date,draw_iso,draw_dow,bonus,super_bonus,hits')
    .order('game_num', { ascending: true });
  if (error) throw new Error(`Failed to load games: ${error.message}`);
  return (data ?? []) as Game[];
}

async function loadLiveStats(
  db: ReturnType<typeof createServiceClient>,
  strategyIds: number[]
): Promise<Map<number, LiveStat>> {
  const map = new Map<number, LiveStat>();
  if (strategyIds.length === 0) return map;

  const { data } = await db
    .from('live_results')
    .select('strategy_id, pnl')
    .in('strategy_id', strategyIds);

  for (const row of data ?? []) {
    const id = row.strategy_id as number;
    const pnl = row.pnl as number;
    const existing = map.get(id) ?? { strategy_id: id, count: 0, total_pnl: 0 };
    existing.count++;
    existing.total_pnl += pnl;
    map.set(id, existing);
  }
  return map;
}

function getMutationParams(generation: number): { mutationRate: number; largeMutationProb: number } {
  if (generation <= 10) return { mutationRate: 0.40, largeMutationProb: 0.60 };
  if (generation <= 30) return { mutationRate: 0.20, largeMutationProb: 0.30 };
  return { mutationRate: 0.08, largeMutationProb: 0.05 };
}

export async function runEvolution(): Promise<{
  generation: number;
  promotions: number;
  newStrategies: number;
  durationMs: number;
}> {
  const start = Date.now();
  const db = createServiceClient();

  // --- Load state ---
  const { data: stateRow } = await db
    .from('evolution_state')
    .select('*')
    .eq('id', 1)
    .single();
  const currentGen: number = stateRow?.current_generation ?? 0;
  const nextGen = currentGen + 1;

  // --- Load all games ---
  const allGames = await loadAllGames(db);
  if (allGames.length < 100) {
    throw new Error('Not enough games to run evolution (need at least 100)');
  }

  // Train/test split
  const testCount = Math.min(TEST_WINDOW, Math.floor(allGames.length * 0.2));
  const trainingEndIdx = allGames.length - testCount;
  const testStartIdx = trainingEndIdx;

  // --- GENERATION 0: seed population ---
  if (currentGen === 0) {
    await db.from('system_events').insert({
      event_type: 'evolution_complete',
      severity: 'info',
      message: 'Seeding generation 0 — creating 200 random strategies',
    });

    const seedRows = SPOT_COUNTS.flatMap(spotCount =>
      Array.from({ length: POP_SIZE }, () => ({
        generation: 1,
        spot_count: spotCount,
        genome: randomGenome(),
        status: 'active',
      }))
    );

    const { data: inserted, error: seedErr } = await db
      .from('strategies')
      .insert(seedRows)
      .select('id,generation,spot_count,genome,status,real_world_plays,real_world_pnl');
    if (seedErr) throw new Error(`Seed insert failed: ${seedErr.message}`);

    await db.from('evolution_state').update({
      total_strategies_ever: seedRows.length,
    }).eq('id', 1);

    // Score all new strategies immediately
    await scoreStrategies(
      db, (inserted ?? []) as StrategyRow[], allGames, trainingEndIdx, testStartIdx, nextGen
    );
  }

  // --- Load active strategies ---
  const { data: activeStrategies, error: loadErr } = await db
    .from('strategies')
    .select('id,generation,spot_count,genome,status,real_world_plays,real_world_pnl')
    .in('status', ['active', 'promoted'])
    .order('spot_count')
    .order('id');
  if (loadErr) throw new Error(`Failed to load strategies: ${loadErr.message}`);

  const strategies = (activeStrategies ?? []) as StrategyRow[];
  const strategyIds = strategies.map(s => s.id);

  // --- Load live stats ---
  const liveStats = await loadLiveStats(db, strategyIds);

  // --- Score all strategies ---
  const fitnessMap = await scoreStrategies(
    db, strategies, allGames, trainingEndIdx, testStartIdx, nextGen, liveStats
  );

  // --- Per spot count: selection + breeding ---
  let totalPromotions = 0;
  let totalNewStrategies = 0;
  const { mutationRate, largeMutationProb } = getMutationParams(nextGen);

  for (const spotCount of SPOT_COUNTS) {
    const subPop = strategies.filter(s => s.spot_count === spotCount);
    if (subPop.length === 0) continue;

    // Rank by fitness
    const ranked = subPop
      .map(s => ({ s, fitness: fitnessMap.get(s.id) ?? -999 }))
      .sort((a, b) => b.fitness - a.fitness);

    // Retire bottom half
    const toRetire = ranked.slice(SURVIVORS).map(r => r.s.id);
    if (toRetire.length > 0) {
      await db.from('strategies').update({ status: 'retired' }).in('id', toRetire);
    }

    const survivors = ranked.slice(0, SURVIVORS).map(r => r.s);

    // Breed 10 children
    const childRows: { generation: number; spot_count: number; genome: StrategyGenome; status: string; parent_ids: number[]; mutation_log: { action: string; details: string[] } }[] = [];
    for (let i = 0; i < SURVIVORS; i++) {
      const useCrossover = Math.random() < 0.40;
      let newGenome: StrategyGenome;
      let parentIds: number[];
      let log: string[];

      if (useCrossover && survivors.length >= 2) {
        const [pA, pB] = [...survivors].sort(() => Math.random() - 0.5).slice(0, 2);
        const result = crossoverGenome(pA.genome, pB.genome);
        newGenome = result.genome;
        parentIds = [pA.id, pB.id];
        log = result.log;
      } else {
        const parent = survivors[Math.floor(Math.random() * survivors.length)];
        const numParams = Math.floor(Math.random() * 3) + 1;
        const result = mutateGenome(parent.genome, mutationRate, largeMutationProb, numParams);
        newGenome = result.genome;
        parentIds = [parent.id];
        log = result.log;
      }

      childRows.push({
        generation: nextGen,
        spot_count: spotCount,
        genome: newGenome,
        status: 'active',
        parent_ids: parentIds,
        mutation_log: { action: useCrossover ? 'crossover' : 'mutation', details: log },
      });
    }

    const { data: newChildren, error: childErr } = await db
      .from('strategies')
      .insert(childRows)
      .select('id,generation,spot_count,genome,status,real_world_plays,real_world_pnl');
    if (childErr) throw new Error(`Child insert failed: ${childErr.message}`);

    totalNewStrategies += (newChildren ?? []).length;

    // Score new children
    const childFitnessMap = await scoreStrategies(
      db, (newChildren ?? []) as StrategyRow[], allGames, trainingEndIdx, testStartIdx, nextGen
    );

    // Find best child
    const bestChild = (newChildren ?? [] as StrategyRow[]).reduce<StrategyRow | null>((best, child) => {
      const fit = childFitnessMap.get((child as StrategyRow).id) ?? -999;
      const bestFit = best ? childFitnessMap.get(best.id) ?? -999 : -999;
      return fit > bestFit ? (child as StrategyRow) : best;
    }, null);

    // Find current champion
    const currentChampion = subPop.find(s => s.status === 'promoted');

    // Check if best child should be promoted
    const bestChildFitness = bestChild ? childFitnessMap.get(bestChild.id) ?? -999 : -999;
    const champFitness = currentChampion ? fitnessMap.get(currentChampion.id) ?? -999 : -999;

    // Load test_pnl_per_game for bestChild to check eligibility
    const { data: bestChildResult } = bestChild
      ? await db.from('strategy_results')
          .select('test_pnl_per_game')
          .eq('strategy_id', bestChild.id)
          .order('evaluated_at', { ascending: false })
          .limit(1)
          .maybeSingle()
      : { data: null };

    const bestChildTestPpg = bestChildResult?.test_pnl_per_game ?? -999;
    const liveOk = !bestChild
      ? false
      : (liveStats.get(bestChild.id)?.count ?? 0) < 10 ||
        (liveStats.get(bestChild.id)?.total_pnl ?? 0) >= 0;

    const eligible = bestChild &&
      bestChildTestPpg > 0 &&
      liveOk &&
      bestChildFitness > champFitness;

    if (eligible && bestChild) {
      // Demote current champion
      if (currentChampion) {
        await db.from('strategies').update({ status: 'active' }).eq('id', currentChampion.id);
      }
      // Promote new champion
      await db.from('strategies').update({
        status: 'promoted',
        promoted_at: new Date().toISOString(),
      }).eq('id', bestChild.id);

      await db.from('system_events').insert({
        event_type: 'strategy_promoted',
        severity: 'success',
        message: `Strategy #${bestChild.id} promoted as ${spotCount}-spot champion (gen ${nextGen}, fitness ${bestChildFitness.toFixed(4)})`,
        metadata: { strategy_id: bestChild.id, spot_count: spotCount, generation: nextGen, fitness: bestChildFitness },
      });
      totalPromotions++;
    } else if (!currentChampion) {
      // Bootstrap: promote the best survivor if no champion exists
      const bestSurvivor = survivors[0];
      if (bestSurvivor) {
        await db.from('strategies').update({
          status: 'promoted',
          promoted_at: new Date().toISOString(),
        }).eq('id', bestSurvivor.id);
      }
    }
  }

  // --- Commit pending predictions for all promoted strategies ---
  const { data: promotedStrategies } = await db
    .from('strategies')
    .select('id,spot_count,genome')
    .eq('status', 'promoted');

  const { data: maxGameRow } = await db
    .from('games')
    .select('game_num')
    .order('game_num', { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextGameNum = (maxGameRow?.game_num ?? 0) + 1;

  const predictions = (promotedStrategies ?? []).map(s => ({
    strategy_id: s.id,
    spot_count: s.spot_count,
    predicted_for_game_num: nextGameNum,
    picks: generatePicks(s.genome as StrategyGenome, s.spot_count, allGames),
  }));

  if (predictions.length > 0) {
    await db.from('pending_predictions').upsert(predictions, {
      onConflict: 'strategy_id,predicted_for_game_num',
      ignoreDuplicates: true,
    });
    await db.from('system_events').insert({
      event_type: 'prediction_committed',
      severity: 'info',
      message: `Committed ${predictions.length} predictions for game #${nextGameNum} (gen ${nextGen})`,
      metadata: { game_num: nextGameNum, count: predictions.length, generation: nextGen },
    });
  }

  // --- Update evolution state ---
  const durationMs = Date.now() - start;
  await db.from('evolution_state').update({
    current_generation: nextGen,
    last_run_at: new Date().toISOString(),
    last_run_duration_ms: durationMs,
    total_strategies_ever: (stateRow?.total_strategies_ever ?? 0) + totalNewStrategies,
  }).eq('id', 1);

  await db.from('system_events').insert({
    event_type: 'evolution_complete',
    severity: 'success',
    message: `Generation ${nextGen} complete — ${totalPromotions} new champions, ${totalNewStrategies} new strategies (${durationMs}ms)`,
    metadata: { generation: nextGen, promotions: totalPromotions, new_strategies: totalNewStrategies, duration_ms: durationMs },
  });

  return { generation: nextGen, promotions: totalPromotions, newStrategies: totalNewStrategies, durationMs };
}

async function scoreStrategies(
  db: ReturnType<typeof createServiceClient>,
  strategies: StrategyRow[],
  allGames: Game[],
  trainingEndIdx: number,
  testStartIdx: number,
  generation: number,
  liveStats?: Map<number, LiveStat>
): Promise<Map<number, number>> {
  const fitnessMap = new Map<number, number>();
  if (strategies.length === 0) return fitnessMap;

  const resultRows: object[] = [];

  for (const strategy of strategies) {
    const simResult = simulateStrategy(
      strategy.genome,
      strategy.spot_count,
      allGames,
      trainingEndIdx,
      testStartIdx
    );

    const live = liveStats?.get(strategy.id) ?? { count: 0, total_pnl: 0 };
    const fitness = computeFitness(
      simResult,
      live.count,
      live.total_pnl,
      strategy.real_world_plays,
      strategy.real_world_pnl
    );
    fitnessMap.set(strategy.id, fitness);

    resultRows.push({
      strategy_id: strategy.id,
      generation,
      spot_count: strategy.spot_count,
      games_in_training: simResult.training_games,
      games_in_test: simResult.test_games,
      training_pnl: simResult.training_pnl,
      training_pnl_per_game: simResult.training_pnl_per_game,
      test_pnl: simResult.test_pnl,
      test_pnl_per_game: simResult.test_pnl_per_game,
      win_rate: simResult.win_rate,
      avg_matches: simResult.avg_matches,
      best_single_win: simResult.best_single_win,
      max_losing_streak: simResult.max_losing_streak,
      fitness_score: fitness,
      picks_snapshot: simResult.picks_snapshot,
    });
  }

  // Batch insert results
  if (resultRows.length > 0) {
    const { error } = await db.from('strategy_results').insert(resultRows);
    if (error) console.error('[evolve] strategy_results insert error:', error.message);
  }

  return fitnessMap;
}
