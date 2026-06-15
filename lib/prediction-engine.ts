import type { Game } from './supabase';
import {
  computeNumberStats,
  computeCooccurrence,
  NumberStats,
} from './analysis';
import { computeEV, PRIZE_TABLE } from './keno-odds';

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EXPECTED_HIT_RATE = 20 / 80; // 0.25 — any number's random baseline per draw

// ── Types ────────────────────────────────────────────────────────────────────

export interface PredictionSignal {
  name: string;
  score: number;    // 0–1
  weight: number;
  contribution: number; // score × weight
  description: string;
}

export interface NumberPrediction {
  number: number;
  signals: PredictionSignal[];
  finalScore: number; // 0–1 weighted sum
  confidence: number; // 0–100
  recommendation: 'Strong Play' | 'Play' | 'Monitor' | 'Avoid';
  rank: number;
}

export interface PlayRecommendation {
  picks: NumberPrediction[];
  spotCount: number;
  overallConfidence: number; // 0–100
  whenToPlay: string;        // day label
  bestDow: number;
  howManyGames: number;
  howMuchToWager: number;    // $ amount
  bonusType: 'none' | 'bonus' | 'super';
  reasoning: string[];
  predictedMatchRate: number; // expected avg matches per draw
}

export interface MomentumEntry {
  number: number;
  recentCount: number;
  priorCount: number;
  momentumNorm: number; // 0–1 (0.5 = neutral)
  trend: 'rising' | 'stable' | 'falling';
}

export interface PlayPerformance {
  numbers: number[];
  totalGames: number;
  avgMatches: number;
  hitRate: number;       // % games with at least 1 match
  bestMatch: number;
  currentScore: number;  // composite score of these numbers right now (0–100)
  statusLabel: string;
  isHot: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function freqMap(games: Game[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const g of games) for (const h of g.hits) m.set(h, (m.get(h) ?? 0) + 1);
  return m;
}

// ── Momentum (Signal 2) ───────────────────────────────────────────────────────
export function computeMomentum(games: Game[]): MomentumEntry[] {
  const sorted = [...games].sort((a, b) => a.game_num - b.game_num);
  const half = Math.min(250, Math.floor(sorted.length / 2));
  const recent = sorted.slice(-half);
  const prior = sorted.slice(-half * 2, -half);

  const rFreq = freqMap(recent);
  const pFreq = freqMap(prior);

  const results: MomentumEntry[] = [];
  for (let n = 1; n <= 80; n++) {
    const r = rFreq.get(n) ?? 0;
    const p = pFreq.get(n) ?? 0;
    // Normalised momentum: tanh maps ℝ → (-1,1); shift to (0,1)
    const rawMomentum = prior.length > 0 ? (r - p) / (prior.length * EXPECTED_HIT_RATE + 1) : 0;
    const momentumNorm = (Math.tanh(rawMomentum * 4) + 1) / 2;
    results.push({
      number: n,
      recentCount: r,
      priorCount: p,
      momentumNorm,
      trend: momentumNorm > 0.55 ? 'rising' : momentumNorm < 0.45 ? 'falling' : 'stable',
    });
  }
  return results;
}

// ── DOW alignment score per number (Signal 3) ─────────────────────────────────
function dowAlignmentScore(games: Game[], number: number, targetDow: number): number {
  const dowGames = games.filter(g => g.draw_dow === targetDow);
  if (dowGames.length < 10) return 0.5; // not enough data
  const hits = dowGames.filter(g => g.hits.includes(number)).length;
  const lift = hits / dowGames.length / EXPECTED_HIT_RATE;
  return Math.min(1, lift / 2); // cap at 1; lift of 2 = score of 1
}

// ── Main prediction engine ───────────────────────────────────────────────────

export function computePrediction(
  games: Game[],
  targetSpots: number = 8,
  targetDow?: number
): PlayRecommendation {
  if (games.length < 50) {
    return emptyRecommendation(targetSpots);
  }

  const todayDow = targetDow ?? new Date().getDay();
  const stats = computeNumberStats(games);
  const momentum = computeMomentum(games);
  const momentumMap = new Map(momentum.map(m => [m.number, m.momentumNorm]));
  const statsMap = new Map(stats.map(s => [s.number, s]));

  // Signal weights (must sum to 1.0)
  const W = {
    composite:  0.35, // historical frequency + recency + gap
    momentum:   0.20, // recent trend vs prior period
    dowAlign:   0.15, // performance on today's day of week
    gapUrgency: 0.15, // how overdue the number is
    streak:     0.15, // active consecutive-appearance streak
  };

  const predictions: NumberPrediction[] = [];

  for (let n = 1; n <= 80; n++) {
    const s = statsMap.get(n);
    if (!s) continue;

    const sigComposite:   PredictionSignal = {
      name: 'Historical Score',
      score: s.compositeScore,
      weight: W.composite,
      contribution: s.compositeScore * W.composite,
      description: 'Frequency + recency-decay + gap analysis combined',
    };

    const momentumNorm = momentumMap.get(n) ?? 0.5;
    const sigMomentum:   PredictionSignal = {
      name: 'Recent Momentum',
      score: momentumNorm,
      weight: W.momentum,
      contribution: momentumNorm * W.momentum,
      description: 'Frequency trend — recent 250 games vs prior 250',
    };

    const dowScore = dowAlignmentScore(games, n, todayDow);
    const sigDow:        PredictionSignal = {
      name: 'Day Alignment',
      score: dowScore,
      weight: W.dowAlign,
      contribution: dowScore * W.dowAlign,
      description: `Strength on ${DOW_LABELS[todayDow]}s vs baseline`,
    };

    const urgency = Math.min(1, s.overdueBonus * 0.6 + s.gapScore * 0.4);
    const sigUrgency:    PredictionSignal = {
      name: 'Gap Urgency',
      score: urgency,
      weight: W.gapUrgency,
      contribution: urgency * W.gapUrgency,
      description: 'How far past its expected gap this number is',
    };

    // Streak: sweet spot is 2–4 consecutive appearances; longer streaks may revert
    const streakRaw = s.streak >= 2 && s.streak <= 4
      ? s.streak / 4
      : s.streak > 4
      ? Math.max(0.1, 1 - (s.streak - 4) * 0.15)
      : 0;
    const sigStreak:     PredictionSignal = {
      name: 'Streak Signal',
      score: streakRaw,
      weight: W.streak,
      contribution: streakRaw * W.streak,
      description: `${s.streak > 0 ? `Active ${s.streak}-game streak` : 'No active streak'}`,
    };

    const finalScore =
      sigComposite.contribution +
      sigMomentum.contribution +
      sigDow.contribution +
      sigUrgency.contribution +
      sigStreak.contribution;

    const confidence = Math.min(99, Math.round(finalScore * 130));

    predictions.push({
      number: n,
      signals: [sigComposite, sigMomentum, sigDow, sigUrgency, sigStreak],
      finalScore,
      confidence,
      recommendation:
        finalScore > 0.60 ? 'Strong Play'
        : finalScore > 0.45 ? 'Play'
        : finalScore > 0.30 ? 'Monitor'
        : 'Avoid',
      rank: 0,
    });
  }

  // Rank by finalScore
  predictions.sort((a, b) => b.finalScore - a.finalScore);
  predictions.forEach((p, i) => (p.rank = i + 1));

  // Co-occurrence boost (Signal 6): reward numbers that cluster with other top candidates
  const pairs = computeCooccurrence(games);
  const topPool = predictions.slice(0, Math.max(30, targetSpots * 3));
  const topNums = new Set(topPool.map(p => p.number));

  for (const pred of topPool) {
    const partnerLifts = pairs
      .filter(p => (p.a === pred.number || p.b === pred.number) && p.lift > 1.05)
      .map(p => ({ partner: p.a === pred.number ? p.b : p.a, lift: p.lift }))
      .filter(x => topNums.has(x.partner));

    if (partnerLifts.length > 0) {
      const avgLift = partnerLifts.reduce((s, x) => s + x.lift, 0) / partnerLifts.length;
      pred.finalScore = Math.min(1, pred.finalScore + (avgLift - 1) * 0.04);
    }
  }

  // Re-sort and pick top targetSpots
  topPool.sort((a, b) => b.finalScore - a.finalScore);
  const picks = topPool.slice(0, targetSpots);

  // ── When to play ────────────────────────────────────────────────────────────
  // Find which DOW these picks collectively perform best on
  const dowAvgScores = Array.from({ length: 7 }, (_, dow) => {
    const dowGames = games.filter(g => g.draw_dow === dow);
    if (dowGames.length < 5) return 0;
    const hitRates = picks.map(p => {
      const h = dowGames.filter(g => g.hits.includes(p.number)).length;
      return h / dowGames.length;
    });
    return hitRates.reduce((a, b) => a + b, 0) / hitRates.length;
  });
  const bestDow = dowAvgScores.indexOf(Math.max(...dowAvgScores));

  // ── How many games to play ──────────────────────────────────────────────────
  const avgStreak = picks.reduce((s, p) => {
    const st = statsMap.get(p.number)?.streak ?? 0;
    return s + st;
  }, 0) / picks.length;

  const avgUrgency = picks.reduce((s, p) => {
    const sig = p.signals.find(x => x.name === 'Gap Urgency');
    return s + (sig?.score ?? 0);
  }, 0) / picks.length;

  const avgMomentum = picks.reduce((s, p) => {
    const sig = p.signals.find(x => x.name === 'Recent Momentum');
    return s + (sig?.score ?? 0.5);
  }, 0) / picks.length;

  let howManyGames = 10;
  if (avgStreak > 3) howManyGames = 5;        // streak likely ending
  else if (avgUrgency > 0.6) howManyGames = 8; // overdue: short burst
  else if (avgMomentum > 0.65) howManyGames = 15; // strong momentum
  else if (picks[0]?.finalScore > 0.70) howManyGames = 20;

  // ── How much to wager / bonus type ─────────────────────────────────────────
  // Use best EV spot to recommend wager amount (default: match targetSpots)
  const evs = Array.from({ length: 10 }, (_, i) => computeEV(i + 1));
  const bestEVSpot = evs.indexOf(Math.max(...evs)) + 1;
  const howMuchToWager = targetSpots === bestEVSpot ? 2 : 1;

  // Bonus: recommend bonus if expected multiplier improves return ratio
  const baseRatio = computeEV(targetSpots);
  const bonusType: 'none' | 'bonus' | 'super' = baseRatio > 0.7 ? 'bonus' : 'none';

  // ── Confidence ─────────────────────────────────────────────────────────────
  const avgFinal = picks.reduce((s, p) => s + p.finalScore, 0) / picks.length;
  const overallConfidence = Math.min(94, Math.round(avgFinal * 130));

  // ── Predicted match rate ────────────────────────────────────────────────────
  // How many of our picks statistically appear in a draw
  const predictedMatchRate = picks.reduce((s, p) => {
    const st = statsMap.get(p.number);
    return s + (st ? st.pct / 100 : EXPECTED_HIT_RATE);
  }, 0);

  // ── Reasoning ──────────────────────────────────────────────────────────────
  const strongCount = picks.filter(p => p.recommendation === 'Strong Play').length;
  const risingCount = picks.filter(p => {
    const sig = p.signals.find(x => x.name === 'Recent Momentum');
    return (sig?.score ?? 0) > 0.55;
  }).length;
  const overdueCount = picks.filter(p => {
    const sig = p.signals.find(x => x.name === 'Gap Urgency');
    return (sig?.score ?? 0) > 0.5;
  }).length;

  const reasoning = [
    `${strongCount} of ${targetSpots} picks rated "Strong Play" — top score ${(picks[0]?.finalScore * 100).toFixed(1)}/100`,
    `${risingCount}/${targetSpots} picks show rising momentum (recent 250 games vs prior 250)`,
    overdueCount > 0
      ? `${overdueCount} picks are overdue based on gap analysis — statistically due for a hit`
      : 'No picks are significantly overdue — based on frequency momentum',
    `Best day for these picks: ${DOW_LABELS[bestDow]} (${(dowAvgScores[bestDow] * 100).toFixed(1)}% avg hit rate)`,
    `Day-of-week alignment for ${DOW_LABELS[todayDow]}: ${(dowAvgScores[todayDow] * 100).toFixed(1)}% avg hit rate`,
    `Co-occurrence analysis boosted ${topPool.filter(p => p.finalScore > predictions.find(x => x.number === p.number)?.finalScore!).length} picks for strong pair patterns`,
    `Recommended session: ${howManyGames} games based on ${avgStreak > 2 ? 'active streak (may revert)' : avgUrgency > 0.5 ? 'overdue urgency' : 'momentum profile'}`,
    `Expected avg matches per draw: ${predictedMatchRate.toFixed(1)} (random baseline: 5.0 for 20-spot pick)`,
  ];

  return {
    picks,
    spotCount: targetSpots,
    overallConfidence,
    whenToPlay: DOW_LABELS[bestDow],
    bestDow,
    howManyGames,
    howMuchToWager,
    bonusType,
    reasoning,
    predictedMatchRate,
  };
}

// ── Evaluate a set of numbers against historical draws ─────────────────────
export function evaluatePlay(numbers: number[], games: Game[]): PlayPerformance {
  if (!games.length || !numbers.length) {
    return { numbers, totalGames: 0, avgMatches: 0, hitRate: 0, bestMatch: 0, currentScore: 0, statusLabel: 'No data', isHot: false };
  }

  const sorted = [...games].sort((a, b) => b.game_num - a.game_num).slice(0, 200);
  let totalMatches = 0;
  let gamesWithHit = 0;
  let bestMatch = 0;

  for (const g of sorted) {
    const m = g.hits.filter(h => numbers.includes(h)).length;
    totalMatches += m;
    if (m > 0) gamesWithHit++;
    if (m > bestMatch) bestMatch = m;
  }

  const avgMatches = totalMatches / sorted.length;
  const hitRate = (gamesWithHit / sorted.length) * 100;

  // Current composite score for these numbers (avg of their individual scores)
  const stats = computeNumberStats(games);
  const statsMap = new Map(stats.map(s => [s.number, s]));
  const avgComposite = numbers.reduce((s, n) => {
    return s + (statsMap.get(n)?.compositeScore ?? 0);
  }, 0) / numbers.length;

  const currentScore = Math.round(avgComposite * 100);
  const isHot = currentScore > 55 && avgMatches > EXPECTED_HIT_RATE * numbers.length;
  const statusLabel =
    currentScore > 65 ? 'Optimal — Play Now'
    : currentScore > 50 ? 'Good Conditions'
    : currentScore > 35 ? 'Neutral'
    : 'Cold — Consider Waiting';

  return {
    numbers,
    totalGames: sorted.length,
    avgMatches,
    hitRate,
    bestMatch,
    currentScore,
    statusLabel,
    isHot,
  };
}

// ── Simulate picks against historical games ──────────────────────────────────
export interface SimRound {
  gameNum: number;
  drawDate: string;
  picks: number[];
  hits: number[];
  matches: number;
  wagered: number;
  won: number;
  bankroll: number;
}

export function simulateSession(
  picks: number[],
  games: Game[],
  wager: number,
  bonusType: 'none' | 'bonus' | 'super',
  startingBudget: number,
  maxGames: number
): SimRound[] {
  const prizeTable = PRIZE_TABLE[picks.length] ?? [];
  const sorted = [...games].sort((a, b) => b.game_num - a.game_num).slice(0, maxGames);
  const costPerGame = wager * (bonusType === 'super' ? 3 : bonusType === 'bonus' ? 2 : 1);

  let bankroll = startingBudget;
  const rounds: SimRound[] = [];

  for (const g of sorted) {
    if (bankroll < costPerGame) break;
    bankroll -= costPerGame;

    const hits = g.hits.filter(h => picks.includes(h));
    const matches = hits.length;

    const entry = prizeTable.find(p => p.catches === matches);
    let basePrize = entry ? entry.prize * wager : 0;

    if (bonusType === 'bonus' && g.bonus) basePrize *= g.bonus;
    if (bonusType === 'super' && g.super_bonus) basePrize *= g.super_bonus;

    bankroll += basePrize;

    rounds.push({
      gameNum: g.game_num,
      drawDate: g.draw_date,
      picks,
      hits: g.hits,
      matches,
      wagered: costPerGame,
      won: basePrize,
      bankroll: Math.round(bankroll * 100) / 100,
    });

    if (bankroll <= 0) break;
  }

  return rounds;
}

function emptyRecommendation(spotCount: number): PlayRecommendation {
  return {
    picks: [],
    spotCount,
    overallConfidence: 0,
    whenToPlay: '—',
    bestDow: new Date().getDay(),
    howManyGames: 10,
    howMuchToWager: 1,
    bonusType: 'none',
    reasoning: ['Not enough data — run the backfill on the Data Ingestion page first.'],
    predictedMatchRate: 0,
  };
}

export { DOW_LABELS };
