import type { StrategyGenome } from './genome';
import type { Game } from '@/lib/supabase';
import { lookupPrize } from '@/lib/keno/prizes';

export interface SimResult {
  training_pnl: number;
  training_pnl_per_game: number;
  training_games: number;
  test_pnl: number;
  test_pnl_per_game: number;
  test_games: number;
  win_rate: number;
  avg_matches: number;
  best_single_win: number;
  max_losing_streak: number;
  picks_snapshot: number[];
}

function computeWeight(genome: StrategyGenome, pos: number): number {
  let w: number;
  if (genome.weighting_method === 'raw') {
    w = 1.0;
  } else if (genome.weighting_method === 'linear_decay') {
    w = Math.max(0, 1.0 - pos / genome.lookback_games);
  } else {
    w = Math.exp(-genome.decay_rate * pos);
  }
  if (pos < genome.recency_boost_cutoff) w *= genome.recency_boost_multiplier;
  return w;
}

/**
 * Score all 80 numbers using the lookback window ending just before evalIdx.
 * Returns an array indexed 1-80 (index 0 unused).
 * `lastSeenScratch` is a caller-owned Int32Array(81) reused across calls to
 * avoid allocating on every evaluation — this function runs up to ~allGames.length
 * times per strategy, so per-call allocations here dominate evolution runtime.
 */
function scoreNumbers(
  genome: StrategyGenome,
  allGames: Game[],
  evalIdx: number,
  scores: Float64Array,
  lastSeenScratch: Int32Array
): void {
  scores.fill(0);
  const lookback = genome.lookback_games;
  const startIdx = Math.max(0, evalIdx - lookback);

  for (let j = startIdx; j < evalIdx; j++) {
    const pos = evalIdx - 1 - j; // 0 = most recent
    const w = computeWeight(genome, pos);
    const hits = allGames[j].hits;
    for (let k = 0; k < hits.length; k++) {
      scores[hits[k]] += w;
    }
  }

  // Gap bonus: reward numbers not seen recently
  if (genome.gap_weight > 0) {
    lastSeenScratch.fill(-1);
    for (let j = startIdx; j < evalIdx; j++) {
      const pos = evalIdx - 1 - j;
      const hits = allGames[j].hits;
      for (let k = 0; k < hits.length; k++) {
        const n = hits[k];
        if (lastSeenScratch[n] === -1) lastSeenScratch[n] = pos;
      }
    }
    for (let n = 1; n <= 80; n++) {
      const gap = lastSeenScratch[n] === -1 ? 999 : lastSeenScratch[n];
      if (gap > genome.gap_threshold) {
        scores[n] += genome.gap_weight * (scores[n] + 0.001);
      }
    }
  }
}

/**
 * Select the top N numbers by score via a small insertion-sort into caller-owned
 * scratch buffers — avoids the object-array allocation + full sort of all 80
 * candidates that a naive `[...].sort()` would do on every evaluation.
 */
function selectTopNInto(
  scores: Float64Array,
  n: number,
  topIdx: Int32Array,
  topScore: Float64Array
): void {
  for (let i = 0; i < n; i++) topScore[i] = -Infinity;
  for (let num = 1; num <= 80; num++) {
    const s = scores[num];
    if (s > topScore[n - 1]) {
      let pos = n - 1;
      while (pos > 0 && topScore[pos - 1] < s) {
        topScore[pos] = topScore[pos - 1];
        topIdx[pos] = topIdx[pos - 1];
        pos--;
      }
      topScore[pos] = s;
      topIdx[pos] = num;
    }
  }
}

/**
 * Full strategy simulation. Games must be sorted ASC by game_num.
 * trainingEndIdx: last index (exclusive) of training set in allGames
 * testStartIdx: first index (inclusive) of test set in allGames
 */
export function simulateStrategy(
  genome: StrategyGenome,
  spotCount: number,
  allGames: Game[],
  trainingEndIdx: number,
  testStartIdx: number
): SimResult {
  const scores = new Float64Array(81);
  const lastSeenScratch = new Int32Array(81);
  const topIdx = new Int32Array(spotCount);
  const topScore = new Float64Array(spotCount);
  const lastPicksBuf = new Int32Array(spotCount);

  let trainPnl = 0, trainGames = 0, trainWins = 0;
  let testPnl = 0, testGames = 0, testWins = 0;
  let totalMatches = 0;
  let bestWin = 0;
  let losingStreak = 0, maxLosingStreak = 0;

  for (let i = 0; i < allGames.length; i++) {
    const inTraining = i < trainingEndIdx;
    const inTest = i >= testStartIdx;
    if (!inTraining && !inTest) continue;

    scoreNumbers(genome, allGames, i, scores, lastSeenScratch);
    selectTopNInto(scores, spotCount, topIdx, topScore);
    lastPicksBuf.set(topIdx);

    const hits = allGames[i].hits;
    let matches = 0;
    for (let p = 0; p < spotCount; p++) {
      const pick = topIdx[p];
      for (let h = 0; h < hits.length; h++) {
        if (hits[h] === pick) { matches++; break; }
      }
    }

    const prize = lookupPrize(spotCount, matches);
    const pnl = prize - 1;

    totalMatches += matches;
    if (prize > bestWin) bestWin = prize;

    if (inTraining) {
      trainPnl += pnl;
      trainGames++;
      if (prize > 0) { trainWins++; losingStreak = 0; }
      else { losingStreak++; if (losingStreak > maxLosingStreak) maxLosingStreak = losingStreak; }
    } else {
      testPnl += pnl;
      testGames++;
      if (prize > 0) { testWins++; losingStreak = 0; }
      else { losingStreak++; if (losingStreak > maxLosingStreak) maxLosingStreak = losingStreak; }
    }
  }

  const totalGames = trainGames + testGames;
  const totalWins = trainWins + testWins;
  const lastPicks = Array.from(lastPicksBuf);

  return {
    training_pnl: trainPnl,
    training_pnl_per_game: trainGames > 0 ? trainPnl / trainGames : 0,
    training_games: trainGames,
    test_pnl: testPnl,
    test_pnl_per_game: testGames > 0 ? testPnl / testGames : 0,
    test_games: testGames,
    win_rate: totalGames > 0 ? totalWins / totalGames : 0,
    avg_matches: totalGames > 0 ? totalMatches / totalGames : 0,
    best_single_win: bestWin,
    max_losing_streak: maxLosingStreak,
    picks_snapshot: lastPicks,
  };
}

/**
 * Compute picks for the NEXT game using all available games as context.
 * Used to generate pending_predictions.
 */
export function generatePicks(
  genome: StrategyGenome,
  spotCount: number,
  allGames: Game[]
): number[] {
  const scores = new Float64Array(81);
  const lastSeenScratch = new Int32Array(81);
  const topIdx = new Int32Array(spotCount);
  const topScore = new Float64Array(spotCount);
  scoreNumbers(genome, allGames, allGames.length, scores, lastSeenScratch);
  selectTopNInto(scores, spotCount, topIdx, topScore);
  return Array.from(topIdx);
}

/**
 * Compute composite fitness score from a SimResult + live play stats.
 */
export function computeFitness(
  result: SimResult,
  liveResultCount: number,
  liveTotalPnl: number,
  realWorldPlays: number,
  realWorldPnl: number
): number {
  const testPpg = result.test_pnl_per_game;
  const livePpg = liveResultCount >= 10 ? liveTotalPnl / liveResultCount : 0;
  const winRate = result.win_rate;
  const consistency = 1.0 / (1.0 + result.max_losing_streak / 10.0);
  const rwBonus = realWorldPlays >= 10 ? (realWorldPnl / realWorldPlays) * 1.5 : 0;

  return (testPpg * 0.50) + (livePpg * 0.30) + (winRate * 0.10) + (consistency * 0.05) + (rwBonus * 0.05);
}
