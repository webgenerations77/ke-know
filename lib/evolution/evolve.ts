import { createServiceClient } from '@/lib/supabase-server';
import type { Game } from '@/lib/supabase';
import {
  randomGenome, heuristicGenome, mutateGenome, crossoverGenome, type StrategyGenome,
} from './genome';
import {
  crossValidateStrategy, computeFitness, generatePicks, jaccardSimilarity,
  type CrossValResult,
} from './fitness';

const POP_SIZE = 20;
const SURVIVORS = 10;
const IMMIGRANTS_PER_GEN = 2;
const SPOT_COUNTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

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

  // Only count genuine pre-committed predictions, not retroactive replays
  const { data } = await db
    .from('live_results')
    .select('strategy_id, pnl')
    .in('strategy_id', strategyIds)
    .eq('source', 'prediction');

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

function getMutationParams(generation: number): { mutationRate: number; largeMutationProb: number; numParams: number } {
  if (generation <= 5)  return { mutationRate: 0.50, largeMutationProb: 0.50, numParams: 3 };
  if (generation <= 15) return { mutationRate: 0.35, largeMutationProb: 0.30, numParams: 2 };
  if (generation <= 40) return { mutationRate: 0.20, largeMutationProb: 0.15, numParams: 2 };
  return { mutationRate: 0.12, largeMutationProb: 0.08, numParams: 1 };
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

  // --- GENERATION 0: seed population ---
  if (currentGen === 0) {
    await db.from('system_events').insert({
      event_type: 'evolution_complete',
      severity: 'info',
      message: 'Seeding generation 1 with overhauled algorithm — 200 strategies (60% random, 40% heuristic)',
    });

    const seedRows = SPOT_COUNTS.flatMap(spotCount => {
      const rows: { generation: number; spot_count: number; genome: StrategyGenome; status: string }[] = [];
      // 12 random
      for (let i = 0; i < 12; i++) {
        rows.push({ generation: 1, spot_count: spotCount, genome: randomGenome(), status: 'active' });
      }
      // 2 momentum
      rows.push({ generation: 1, spot_count: spotCount, genome: heuristicGenome('momentum'), status: 'active' });
      rows.push({ generation: 1, spot_count: spotCount, genome: heuristicGenome('momentum'), status: 'active' });
      // 2 contrarian
      rows.push({ generation: 1, spot_count: spotCount, genome: heuristicGenome('contrarian'), status: 'active' });
      rows.push({ generation: 1, spot_count: spotCount, genome: heuristicGenome('contrarian'), status: 'active' });
      // 2 balanced
      rows.push({ generation: 1, spot_count: spotCount, genome: heuristicGenome('balanced'), status: 'active' });
      rows.push({ generation: 1, spot_count: spotCount, genome: heuristicGenome('balanced'), status: 'active' });
      // 2 bonus hunters
      rows.push({ generation: 1, spot_count: spotCount, genome: heuristicGenome('bonus_hunter', 'bonus'), status: 'active' });
      rows.push({ generation: 1, spot_count: spotCount, genome: heuristicGenome('bonus_hunter', 'super_bonus'), status: 'active' });
      return rows;
    });

    const { data: inserted, error: seedErr } = await db
      .from('strategies')
      .insert(seedRows)
      .select('id,generation,spot_count,genome,status,real_world_plays,real_world_pnl');
    if (seedErr) throw new Error(`Seed insert failed: ${seedErr.message}`);

    await db.from('evolution_state').update({
      total_strategies_ever: seedRows.length,
    }).eq('id', 1);

    await scoreStrategiesCV(
      db, (inserted ?? []) as StrategyRow[], allGames, nextGen
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

  // --- Load live stats (pre-committed predictions only) ---
  const liveStats = await loadLiveStats(db, strategyIds);

  // --- Score all strategies with cross-validation ---
  const { fitnessMap, cvMap } = await scoreStrategiesCV(
    db, strategies, allGames, nextGen, liveStats
  );

  // --- Per spot count: selection + breeding ---
  let totalPromotions = 0;
  let totalNewStrategies = 0;
  const { mutationRate, largeMutationProb, numParams } = getMutationParams(nextGen);

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
    const survivorFitness = ranked.slice(0, SURVIVORS).map(r => r.fitness);

    // Breed children via SUS parent selection
    const childCount = SURVIVORS - IMMIGRANTS_PER_GEN;
    const childRows: { generation: number; spot_count: number; genome: StrategyGenome; status: string; parent_ids: number[]; mutation_log: { action: string; details: string[] } }[] = [];

    // SUS: compute cumulative fitness for parent selection
    const minFit = Math.min(...survivorFitness);
    const shifted = survivorFitness.map(f => f - minFit + 0.001);
    const totalFit = shifted.reduce((s, v) => s + v, 0);
    const cumulative: number[] = [];
    let cumSum = 0;
    for (const f of shifted) { cumSum += f / totalFit; cumulative.push(cumSum); }

    function selectParent(): StrategyRow {
      const r = Math.random();
      for (let i = 0; i < cumulative.length; i++) {
        if (r <= cumulative[i]) return survivors[i];
      }
      return survivors[survivors.length - 1];
    }

    for (let i = 0; i < childCount; i++) {
      const useCrossover = Math.random() < 0.40;
      let newGenome: StrategyGenome;
      let parentIds: number[];
      let log: string[];

      if (useCrossover && survivors.length >= 2) {
        const pA = selectParent();
        let pB = selectParent();
        let attempts = 0;
        while (pB.id === pA.id && attempts < 5) { pB = selectParent(); attempts++; }
        const result = crossoverGenome(pA.genome, pB.genome);
        newGenome = result.genome;
        parentIds = [pA.id, pB.id];
        log = result.log;
      } else {
        const parent = selectParent();
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

    // Add random immigrants
    for (let i = 0; i < IMMIGRANTS_PER_GEN; i++) {
      childRows.push({
        generation: nextGen,
        spot_count: spotCount,
        genome: randomGenome(),
        status: 'active',
        parent_ids: [],
        mutation_log: { action: 'immigration', details: ['random immigrant'] },
      });
    }

    const { data: newChildren, error: childErr } = await db
      .from('strategies')
      .insert(childRows)
      .select('id,generation,spot_count,genome,status,real_world_plays,real_world_pnl');
    if (childErr) throw new Error(`Child insert failed: ${childErr.message}`);

    totalNewStrategies += (newChildren ?? []).length;

    // Score new children
    const { fitnessMap: childFitnessMap } = await scoreStrategiesCV(
      db, (newChildren ?? []) as StrategyRow[], allGames, nextGen
    );

    // Find best candidate across children AND surviving parents
    const allCandidates: { strategy: StrategyRow; fitness: number; source: 'child' | 'survivor' }[] = [];

    for (const child of (newChildren ?? []) as StrategyRow[]) {
      allCandidates.push({
        strategy: child,
        fitness: childFitnessMap.get(child.id) ?? -999,
        source: 'child',
      });
    }
    for (const survivor of survivors) {
      allCandidates.push({
        strategy: survivor,
        fitness: fitnessMap.get(survivor.id) ?? -999,
        source: 'survivor',
      });
    }
    allCandidates.sort((a, b) => b.fitness - a.fitness);

    const currentChampion = subPop.find(s => s.status === 'promoted');
    const champFitness = currentChampion ? fitnessMap.get(currentChampion.id) ?? -999 : -999;

    // Promotion: best eligible candidate that outperforms current champion
    let promoted = false;
    for (const candidate of allCandidates) {
      if (currentChampion && candidate.strategy.id === currentChampion.id) continue;
      if (candidate.fitness <= champFitness) break;

      const { data: candResult } = await db.from('strategy_results')
        .select('test_pnl_per_game,oos_ppg')
        .eq('strategy_id', candidate.strategy.id)
        .order('evaluated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const candOosPpg = candResult?.oos_ppg ?? candResult?.test_pnl_per_game ?? -999;
      const candLiveOk =
        (liveStats?.get(candidate.strategy.id)?.count ?? 0) < 10 ||
        (liveStats?.get(candidate.strategy.id)?.total_pnl ?? 0) >= 0;

      const { data: champResult } = currentChampion
        ? await db.from('strategy_results')
            .select('test_pnl_per_game,oos_ppg')
            .eq('strategy_id', currentChampion.id)
            .order('evaluated_at', { ascending: false })
            .limit(1)
            .maybeSingle()
        : { data: null };
      const champOosPpg = champResult?.oos_ppg ?? champResult?.test_pnl_per_game ?? -999;
      const betterThanChamp = candOosPpg > champOosPpg && candidate.fitness > champFitness * 1.1;

      if ((candOosPpg > 0 && candLiveOk) || betterThanChamp) {
        if (currentChampion) {
          await db.from('strategies').update({ status: 'active' }).eq('id', currentChampion.id);
        }
        await db.from('strategies').update({
          status: 'promoted',
          promoted_at: new Date().toISOString(),
        }).eq('id', candidate.strategy.id);

        await db.from('system_events').insert({
          event_type: 'strategy_promoted',
          severity: 'success',
          message: `Strategy #${candidate.strategy.id} promoted as ${spotCount}-spot champion (gen ${nextGen}, fitness ${candidate.fitness.toFixed(4)}, ${candidate.source})`,
          metadata: { strategy_id: candidate.strategy.id, spot_count: spotCount, generation: nextGen, fitness: candidate.fitness, source: candidate.source },
        });
        totalPromotions++;
        promoted = true;
        break;
      }
    }

    if (!promoted && !currentChampion) {
      // Bootstrap: promote best candidate
      for (const candidate of allCandidates) {
        const { data: candResult } = await db.from('strategy_results')
          .select('oos_ppg,test_pnl_per_game')
          .eq('strategy_id', candidate.strategy.id)
          .order('evaluated_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if ((candResult?.oos_ppg ?? candResult?.test_pnl_per_game ?? -1) > 0) {
          await db.from('strategies').update({
            status: 'promoted',
            promoted_at: new Date().toISOString(),
          }).eq('id', candidate.strategy.id);
          break;
        }
      }
      if (allCandidates.length > 0) {
        const best = allCandidates[0];
        const { data: existCheck } = await db.from('strategies')
          .select('status')
          .eq('id', best.strategy.id)
          .maybeSingle();
        if (existCheck && existCheck.status !== 'promoted') {
          await db.from('strategies').update({
            status: 'promoted',
            promoted_at: new Date().toISOString(),
          }).eq('id', best.strategy.id);
        }
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
    bonus_type: (s.genome as StrategyGenome).bonus_type ?? 'none',
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

async function scoreStrategiesCV(
  db: ReturnType<typeof createServiceClient>,
  strategies: StrategyRow[],
  allGames: Game[],
  generation: number,
  liveStats?: Map<number, LiveStat>
): Promise<{ fitnessMap: Map<number, number>; cvMap: Map<number, CrossValResult> }> {
  const fitnessMap = new Map<number, number>();
  const cvMap = new Map<number, CrossValResult>();
  if (strategies.length === 0) return { fitnessMap, cvMap };

  // First pass: cross-validate all strategies and collect picks
  const picksMap = new Map<number, number[]>();
  const cvResults: { strategy: StrategyRow; cv: CrossValResult }[] = [];

  for (const strategy of strategies) {
    const cv = crossValidateStrategy(strategy.genome, strategy.spot_count, allGames);
    cvMap.set(strategy.id, cv);
    picksMap.set(strategy.id, cv.picks_snapshot);
    cvResults.push({ strategy, cv });
  }

  // Second pass: compute diversity bonus and final fitness
  // Group by spot count for diversity calculation
  const bySpot = new Map<number, { id: number; fitness_prelim: number; picks: number[] }[]>();
  for (const { strategy, cv } of cvResults) {
    const live = liveStats?.get(strategy.id) ?? { count: 0, total_pnl: 0 };
    // Preliminary fitness without diversity bonus
    const prelim = computeFitness(cv, live.count, live.total_pnl, 0);
    if (!bySpot.has(strategy.spot_count)) bySpot.set(strategy.spot_count, []);
    bySpot.get(strategy.spot_count)!.push({
      id: strategy.id,
      fitness_prelim: prelim,
      picks: cv.picks_snapshot,
    });
  }

  // Compute diversity bonus per strategy
  const diversityMap = new Map<number, number>();
  for (const [, group] of bySpot) {
    group.sort((a, b) => b.fitness_prelim - a.fitness_prelim);
    for (let i = 0; i < group.length; i++) {
      let maxJaccard = 0;
      for (let j = 0; j < i; j++) {
        const sim = jaccardSimilarity(group[i].picks, group[j].picks);
        if (sim > maxJaccard) maxJaccard = sim;
      }
      diversityMap.set(group[i].id, 1 - maxJaccard);
    }
  }

  // Final fitness and result rows
  const resultRows: object[] = [];
  for (const { strategy, cv } of cvResults) {
    const live = liveStats?.get(strategy.id) ?? { count: 0, total_pnl: 0 };
    const diversity = diversityMap.get(strategy.id) ?? 1;
    const fitness = computeFitness(cv, live.count, live.total_pnl, diversity);
    fitnessMap.set(strategy.id, fitness);

    resultRows.push({
      strategy_id: strategy.id,
      generation,
      spot_count: strategy.spot_count,
      games_in_training: cv.total_games,
      games_in_test: Math.floor(cv.total_games / 3),
      training_pnl: cv.training_ppg * cv.total_games,
      training_pnl_per_game: cv.training_ppg,
      test_pnl: cv.oos_ppg * Math.floor(cv.total_games / 3),
      test_pnl_per_game: cv.oos_ppg,
      oos_ppg: cv.oos_ppg,
      overfit_gap: cv.overfit_gap,
      win_rate: cv.win_rate,
      avg_matches: cv.avg_matches,
      best_single_win: cv.best_single_win,
      max_losing_streak: cv.max_losing_streak,
      fitness_score: fitness,
      picks_snapshot: cv.picks_snapshot,
      wager_assumed: cv.wager_per_game,
      diversity_bonus: diversity,
      live_trust_factor: live.count >= 10 ? Math.min(1.0, Math.sqrt(live.count / 100)) : 0,
    });
  }

  if (resultRows.length > 0) {
    const { error } = await db.from('strategy_results').insert(resultRows);
    if (error) console.error('[evolve] strategy_results insert error:', error.message);
  }

  return { fitnessMap, cvMap };
}
