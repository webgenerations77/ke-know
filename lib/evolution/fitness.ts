import { getWagerCost, type StrategyGenome } from './genome';
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
  wager_per_game: number;
}

export interface CrossValResult {
  oos_ppg: number;
  training_ppg: number;
  overfit_gap: number;
  fold_ppgs: number[];
  win_rate: number;
  avg_matches: number;
  best_single_win: number;
  max_losing_streak: number;
  picks_snapshot: number[];
  wager_per_game: number;
  total_games: number;
}

function computeWeight(genome: StrategyGenome, pos: number, lookback: number): number {
  let w: number;
  if (genome.weighting_method === 'raw') {
    w = 1.0;
  } else if (genome.weighting_method === 'linear_decay') {
    w = Math.max(0, 1.0 - pos / lookback);
  } else {
    w = Math.exp(-genome.decay_rate * pos);
  }
  if (pos < genome.recency_boost_cutoff) w *= genome.recency_boost_multiplier;
  return w;
}

function scoreNumbers(
  genome: StrategyGenome,
  allGames: Game[],
  evalIdx: number,
  scores: Float64Array,
  lastSeenScratch: Int32Array,
  pairScratch: Float64Array | null
): void {
  scores.fill(0);
  const lookback = genome.lookback_games;
  const step = genome.lookback_step ?? 1;
  const startIdx = Math.max(0, evalIdx - lookback);
  const hotCold = genome.hot_cold_balance ?? 0;

  for (let j = startIdx; j < evalIdx; j += step) {
    const pos = evalIdx - 1 - j;
    const w = computeWeight(genome, pos, lookback);
    const hits = allGames[j].hits;
    for (let k = 0; k < hits.length; k++) {
      scores[hits[k]] += w;
    }
  }

  // Hot/cold balance: when negative, invert frequency signal
  if (hotCold < 0) {
    let maxScore = 0;
    for (let n = 1; n <= 80; n++) if (scores[n] > maxScore) maxScore = scores[n];
    if (maxScore > 0) {
      const strength = -hotCold;
      for (let n = 1; n <= 80; n++) {
        const inverted = maxScore - scores[n];
        scores[n] = scores[n] * (1 - strength) + inverted * strength;
      }
    }
  } else if (hotCold > 0) {
    // Amplify frequency differences
    for (let n = 1; n <= 80; n++) {
      scores[n] *= (1 + hotCold);
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

  // Pair co-occurrence: boost numbers that co-occur with current top candidates
  const pairWeight = genome.pair_weight ?? 0;
  if (pairWeight > 0.05 && pairScratch) {
    // Find top 3 numbers by current score as "anchors"
    const anchors: number[] = [];
    for (let a = 0; a < 3; a++) {
      let bestN = -1, bestS = -Infinity;
      for (let n = 1; n <= 80; n++) {
        if (scores[n] > bestS && !anchors.includes(n)) {
          bestS = scores[n]; bestN = n;
        }
      }
      if (bestN > 0) anchors.push(bestN);
    }

    // Count co-occurrences with anchors
    pairScratch.fill(0);
    for (let j = startIdx; j < evalIdx; j += step) {
      const hits = allGames[j].hits;
      const hitSet = new Set(hits);
      const hasAnchor = anchors.some(a => hitSet.has(a));
      if (hasAnchor) {
        for (let k = 0; k < hits.length; k++) {
          if (!anchors.includes(hits[k])) pairScratch[hits[k]]++;
        }
      }
    }

    // Normalize and blend
    let maxPair = 0;
    for (let n = 1; n <= 80; n++) if (pairScratch[n] > maxPair) maxPair = pairScratch[n];
    if (maxPair > 0) {
      for (let n = 1; n <= 80; n++) {
        scores[n] += pairWeight * (pairScratch[n] / maxPair) * (scores[n] + 0.001);
      }
    }
  }
}

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

function applyPickNoise(topIdx: Int32Array, spotCount: number, pickNoise: number): void {
  if (pickNoise <= 0) return;
  const used = new Set<number>();
  for (let i = 0; i < spotCount; i++) used.add(topIdx[i]);

  for (let i = 0; i < spotCount; i++) {
    if (Math.random() < pickNoise) {
      used.delete(topIdx[i]);
      let replacement: number;
      do {
        replacement = Math.floor(Math.random() * 80) + 1;
      } while (used.has(replacement));
      topIdx[i] = replacement;
      used.add(replacement);
    }
  }
}

function simulateRange(
  genome: StrategyGenome,
  spotCount: number,
  allGames: Game[],
  startIdx: number,
  endIdx: number,
  scores: Float64Array,
  lastSeenScratch: Int32Array,
  pairScratch: Float64Array | null,
  topIdx: Int32Array,
  topScore: Float64Array
): { pnl: number; games: number; wins: number; totalMatches: number; bestWin: number; maxLosingStreak: number } {
  const bonusType = (genome.bonus_type ?? 'none') as string;
  const wagerCost = getWagerCost(genome);
  let pnl = 0, games = 0, wins = 0, totalMatches = 0, bestWin = 0;
  let losingStreak = 0, maxLosingStreak = 0;

  for (let i = startIdx; i < endIdx; i++) {
    scoreNumbers(genome, allGames, i, scores, lastSeenScratch, pairScratch);
    selectTopNInto(scores, spotCount, topIdx, topScore);
    applyPickNoise(topIdx, spotCount, genome.pick_noise ?? 0);

    const hits = allGames[i].hits;
    let matches = 0;
    for (let p = 0; p < spotCount; p++) {
      for (let h = 0; h < hits.length; h++) {
        if (hits[h] === topIdx[p]) { matches++; break; }
      }
    }

    const basePrize = lookupPrize(spotCount, matches);
    const baseWager = genome.wager ?? 1;
    const multiplier = bonusType === 'bonus'
      ? (allGames[i].bonus ?? 1)
      : bonusType === 'super_bonus'
      ? (allGames[i].super_bonus ?? 1)
      : 1;
    const effectivePrize = basePrize > 0 ? basePrize * baseWager * multiplier : 0;
    const gamePnl = effectivePrize - wagerCost;

    pnl += gamePnl;
    games++;
    totalMatches += matches;
    if (effectivePrize > bestWin) bestWin = effectivePrize;
    if (effectivePrize > 0) { wins++; losingStreak = 0; }
    else { losingStreak++; if (losingStreak > maxLosingStreak) maxLosingStreak = losingStreak; }
  }

  return { pnl, games, wins, totalMatches, bestWin, maxLosingStreak };
}

/**
 * 3-fold temporal cross-validation. Games are split into 3 chronological
 * chunks. For each fold, 2 chunks are training, 1 is the test set.
 * Returns the average out-of-sample PPG across folds plus diagnostics.
 */
export function crossValidateStrategy(
  genome: StrategyGenome,
  spotCount: number,
  allGames: Game[]
): CrossValResult {
  const scores = new Float64Array(81);
  const lastSeenScratch = new Int32Array(81);
  const pairScratch = (genome.pair_weight ?? 0) > 0.05 ? new Float64Array(81) : null;
  const topIdx = new Int32Array(spotCount);
  const topScore = new Float64Array(spotCount);

  const n = allGames.length;
  const third = Math.floor(n / 3);
  const foldBounds = [
    [0, third],
    [third, third * 2],
    [third * 2, n],
  ];

  const wagerCost = getWagerCost(genome);

  let totalTrainPnl = 0, totalTrainGames = 0;
  let totalTestPnl = 0, totalTestGames = 0;
  const foldPpgs: number[] = [];
  let totalWins = 0, totalGamesAll = 0, totalMatchesAll = 0;
  let bestWinAll = 0, maxLosingStreakAll = 0;

  for (let testFold = 0; testFold < 3; testFold++) {
    const [testStart, testEnd] = foldBounds[testFold];

    // Training: simulate the two non-test folds
    for (let f = 0; f < 3; f++) {
      if (f === testFold) continue;
      const [s, e] = foldBounds[f];
      const r = simulateRange(genome, spotCount, allGames, s, e, scores, lastSeenScratch, pairScratch, topIdx, topScore);
      totalTrainPnl += r.pnl;
      totalTrainGames += r.games;
      totalWins += r.wins;
      totalGamesAll += r.games;
      totalMatchesAll += r.totalMatches;
      if (r.bestWin > bestWinAll) bestWinAll = r.bestWin;
      if (r.maxLosingStreak > maxLosingStreakAll) maxLosingStreakAll = r.maxLosingStreak;
    }

    // Test: simulate the test fold
    const testResult = simulateRange(genome, spotCount, allGames, testStart, testEnd, scores, lastSeenScratch, pairScratch, topIdx, topScore);
    totalTestPnl += testResult.pnl;
    totalTestGames += testResult.games;
    foldPpgs.push(testResult.games > 0 ? testResult.pnl / testResult.games : 0);
    totalWins += testResult.wins;
    totalGamesAll += testResult.games;
    totalMatchesAll += testResult.totalMatches;
    if (testResult.bestWin > bestWinAll) bestWinAll = testResult.bestWin;
    if (testResult.maxLosingStreak > maxLosingStreakAll) maxLosingStreakAll = testResult.maxLosingStreak;
  }

  const oosPpg = foldPpgs.reduce((s, v) => s + v, 0) / 3;
  const trainPpg = totalTrainGames > 0 ? totalTrainPnl / totalTrainGames : 0;
  const winRate = totalGamesAll > 0 ? totalWins / totalGamesAll : 0;
  const avgMatches = totalGamesAll > 0 ? totalMatchesAll / totalGamesAll : 0;

  // Generate current picks snapshot using all games
  scoreNumbers(genome, allGames, allGames.length, scores, lastSeenScratch, pairScratch);
  selectTopNInto(scores, spotCount, topIdx, topScore);
  const picksSnapshot = Array.from(topIdx);

  return {
    oos_ppg: oosPpg,
    training_ppg: trainPpg,
    overfit_gap: Math.abs(trainPpg - oosPpg),
    fold_ppgs: foldPpgs,
    win_rate: winRate,
    avg_matches: avgMatches,
    best_single_win: bestWinAll,
    max_losing_streak: maxLosingStreakAll,
    picks_snapshot: picksSnapshot,
    wager_per_game: wagerCost,
    total_games: totalGamesAll,
  };
}

/**
 * Legacy single-split simulation for backward compatibility with replay system.
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
  const pairScratch = (genome.pair_weight ?? 0) > 0.05 ? new Float64Array(81) : null;
  const topIdx = new Int32Array(spotCount);
  const topScore = new Float64Array(spotCount);

  const wagerCost = getWagerCost(genome);

  const trainResult = simulateRange(genome, spotCount, allGames, 0, trainingEndIdx, scores, lastSeenScratch, pairScratch, topIdx, topScore);
  const testResult = simulateRange(genome, spotCount, allGames, testStartIdx, allGames.length, scores, lastSeenScratch, pairScratch, topIdx, topScore);

  const totalGames = trainResult.games + testResult.games;
  const totalWins = trainResult.wins + testResult.wins;

  scoreNumbers(genome, allGames, allGames.length, scores, lastSeenScratch, pairScratch);
  selectTopNInto(scores, spotCount, topIdx, topScore);

  return {
    training_pnl: trainResult.pnl,
    training_pnl_per_game: trainResult.games > 0 ? trainResult.pnl / trainResult.games : 0,
    training_games: trainResult.games,
    test_pnl: testResult.pnl,
    test_pnl_per_game: testResult.games > 0 ? testResult.pnl / testResult.games : 0,
    test_games: testResult.games,
    win_rate: totalGames > 0 ? totalWins / totalGames : 0,
    avg_matches: totalGames > 0 ? (trainResult.totalMatches + testResult.totalMatches) / totalGames : 0,
    best_single_win: Math.max(trainResult.bestWin, testResult.bestWin),
    max_losing_streak: Math.max(trainResult.maxLosingStreak, testResult.maxLosingStreak),
    picks_snapshot: Array.from(topIdx),
    wager_per_game: wagerCost,
  };
}

/**
 * Compute picks for the NEXT game using all available games as context.
 */
export function generatePicks(
  genome: StrategyGenome,
  spotCount: number,
  allGames: Game[]
): number[] {
  const scores = new Float64Array(81);
  const lastSeenScratch = new Int32Array(81);
  const pairScratch = (genome.pair_weight ?? 0) > 0.05 ? new Float64Array(81) : null;
  const topIdx = new Int32Array(spotCount);
  const topScore = new Float64Array(spotCount);
  scoreNumbers(genome, allGames, allGames.length, scores, lastSeenScratch, pairScratch);
  selectTopNInto(scores, spotCount, topIdx, topScore);
  return Array.from(topIdx);
}

/**
 * Compute composite fitness from cross-validation result + live play stats.
 *
 * fitness = (oos_ppg * 0.35) + (live_ppg_scaled * 0.35) + (overfit_penalty * 0.15)
 *         + (risk_adjusted * 0.10) + (diversity_bonus * 0.05)
 *
 * diversity_bonus is computed externally and passed in (requires population context).
 */
export function computeFitness(
  cvResult: CrossValResult,
  livePredictionCount: number,
  livePredictionPnl: number,
  diversityBonus: number
): number {
  const oosPpg = cvResult.oos_ppg;

  // Live PPG with trust scaling: sqrt(n/100), clamped to [0,1]
  let livePpgScaled = 0;
  let oosWeight = 0.35;
  let liveWeight = 0.35;
  if (livePredictionCount >= 10) {
    const trustFactor = Math.min(1.0, Math.sqrt(livePredictionCount / 100));
    livePpgScaled = (livePredictionPnl / livePredictionCount) * trustFactor;
  } else {
    // Redistribute live weight to OOS when no live data
    oosWeight = 0.70;
    liveWeight = 0;
  }

  // Overfit penalty: penalize training/test divergence
  const overfitPenalty = -cvResult.overfit_gap * 2.0;

  // Risk-adjusted return
  const riskAdjusted = oosPpg / (1 + cvResult.max_losing_streak / 20);

  return (oosPpg * oosWeight)
       + (livePpgScaled * liveWeight)
       + (overfitPenalty * 0.15)
       + (riskAdjusted * 0.10)
       + (diversityBonus * 0.05);
}

/**
 * Compute Jaccard similarity between two pick arrays.
 */
export function jaccardSimilarity(a: number[], b: number[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const n of setA) if (setB.has(n)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}
