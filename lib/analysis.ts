import type { Game } from './supabase';

export interface NumberStats {
  number: number;
  count: number;
  pct: number;
  deviation: number;
  lastSeen: number | null; // games ago (0 = most recent)
  streak: number;
  compositeScore: number;
  recencyScore: number;
  gapScore: number;
  overdueBonus: number;
  rank: number;
  status: 'Hot' | 'Cold' | 'Overdue' | 'On Streak' | 'Normal';
}

const TOTAL_NUMBERS = 80;
const DRAWS_PER_GAME = 20;

export function computeNumberStats(games: Game[]): NumberStats[] {
  if (games.length === 0) return [];

  const n = games.length;
  // Sort newest first
  const sorted = [...games].sort((a, b) => b.game_num - a.game_num);

  const freq = new Map<number, number>();
  const lastSeenMap = new Map<number, number>(); // game index (0 = most recent)
  const streakMap = new Map<number, number>();
  const recencyScore = new Map<number, number>();

  for (let i = 1; i <= TOTAL_NUMBERS; i++) {
    freq.set(i, 0);
    recencyScore.set(i, 0);
    streakMap.set(i, 0);
  }

  // Pass 1: frequency, last seen, recency-weighted score
  for (let gi = 0; gi < sorted.length; gi++) {
    const weight = Math.exp(-gi / n); // exponential decay
    for (const num of sorted[gi].hits) {
      freq.set(num, (freq.get(num) ?? 0) + 1);
      if (!lastSeenMap.has(num)) lastSeenMap.set(num, gi);
      recencyScore.set(num, (recencyScore.get(num) ?? 0) + weight);
    }
  }

  // Pass 2: streak (consecutive appearances in most recent games)
  for (let i = 1; i <= TOTAL_NUMBERS; i++) {
    let streak = 0;
    for (const game of sorted) {
      if (game.hits.includes(i)) streak++;
      else break;
    }
    streakMap.set(i, streak);
  }

  // Normalise recency scores
  const maxRecency = Math.max(...Array.from(recencyScore.values()));

  const expectedPerGame = DRAWS_PER_GAME / TOTAL_NUMBERS; // 0.25
  const expectedTotal = expectedPerGame * n;

  const results: NumberStats[] = [];

  for (let num = 1; num <= TOTAL_NUMBERS; num++) {
    const count = freq.get(num) ?? 0;
    const pct = n > 0 ? (count / n) * 100 : 0;
    const deviation = n > 0 ? ((count - expectedTotal) / expectedTotal) * 100 : 0;
    const lastSeen = lastSeenMap.get(num) ?? null;
    const streak = streakMap.get(num) ?? 0;

    // Normalised sub-scores [0,1]
    const maxFreq = Math.max(...Array.from(freq.values()));
    const freqNorm = maxFreq > 0 ? count / maxFreq : 0;
    const recNorm = maxRecency > 0 ? (recencyScore.get(num) ?? 0) / maxRecency : 0;

    // Gap analysis: higher score = more overdue (last seen further back)
    const gapGames = lastSeen === null ? n : lastSeen;
    const expectedGap = n / (expectedTotal || 1);
    const gapNorm = Math.min(gapGames / (expectedGap * 3), 1);

    // Overdue bonus: extra weight if significantly past expected gap
    const overdueBonusVal = gapGames > expectedGap * 1.5 ? Math.min((gapGames - expectedGap) / expectedGap, 1) : 0;

    const compositeScore =
      freqNorm * 0.3 +
      recNorm * 0.4 +
      gapNorm * 0.2 +
      overdueBonusVal * 0.1;

    let status: NumberStats['status'] = 'Normal';
    if (deviation > 10) status = 'Hot';
    else if (deviation < -10) status = 'Cold';
    else if (gapGames > expectedGap * 2) status = 'Overdue';
    else if (streak >= 3) status = 'On Streak';

    results.push({
      number: num,
      count,
      pct,
      deviation,
      lastSeen,
      streak,
      compositeScore,
      recencyScore: recNorm,
      gapScore: gapNorm,
      overdueBonus: overdueBonusVal,
      rank: 0,
      status,
    });
  }

  // Rank by composite score (descending)
  results.sort((a, b) => b.compositeScore - a.compositeScore);
  results.forEach((r, i) => (r.rank = i + 1));

  return results;
}

export type Strategy = 'hot' | 'balanced' | 'cold' | 'streak';

export function pickNumbers(stats: NumberStats[], count: number, strategy: Strategy): NumberStats[] {
  const sorted = [...stats];
  switch (strategy) {
    case 'hot':
      sorted.sort((a, b) => b.count - a.count);
      break;
    case 'balanced':
      sorted.sort((a, b) => b.compositeScore - a.compositeScore);
      break;
    case 'cold':
      sorted.sort((a, b) => a.count - b.count);
      break;
    case 'streak':
      sorted.sort((a, b) => b.streak - a.streak || b.compositeScore - a.compositeScore);
      break;
  }
  return sorted.slice(0, count);
}

export interface BonusFreqEntry {
  multiplier: number;
  count: number;
  prob: number;
}

export function computeBonusDist(
  games: Game[],
  field: 'bonus' | 'super_bonus'
): BonusFreqEntry[] {
  const counts = new Map<number, number>();
  let total = 0;
  for (const g of games) {
    const val = g[field];
    if (val != null && val > 0) {
      counts.set(val, (counts.get(val) ?? 0) + 1);
      total++;
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([multiplier, count]) => ({
      multiplier,
      count,
      prob: total > 0 ? count / total : 0,
    }));
}

export function expectedMultiplierFromDist(dist: BonusFreqEntry[]): number {
  const totalProb = dist.reduce((s, x) => s + x.prob, 0);
  if (totalProb === 0) return 1;
  const weightedSum = dist.reduce((s, x) => s + x.multiplier * x.prob, 0);
  const noMultProb = Math.max(0, 1 - totalProb);
  return weightedSum + noMultProb * 1;
}

// ── Co-occurrence analysis ────────────────────────────────────────────────────

export interface PairEntry {
  a: number;
  b: number;
  count: number;
  expected: number;
  lift: number;   // count / expected — >1 means stronger than chance
  pct: number;    // % of games they appeared together
}

/**
 * Compute co-occurrence counts for all C(80,2) = 3,160 possible pairs.
 * For 5,000 games × C(20,2)=190 pairs each = ~950,000 iterations — fast enough for the browser.
 * Baseline: any two numbers have P(both drawn) = C(78,18)/C(80,20) = (20×19)/(80×79) ≈ 6.01%
 */
export function computeCooccurrence(games: Game[]): PairEntry[] {
  if (games.length === 0) return [];

  // Encode pair as lo*100 + hi (works for 1–80)
  const counts = new Map<number, number>();

  for (const g of games) {
    const hits = g.hits;
    for (let i = 0; i < hits.length; i++) {
      for (let j = i + 1; j < hits.length; j++) {
        const lo = Math.min(hits[i], hits[j]);
        const hi = Math.max(hits[i], hits[j]);
        const key = lo * 100 + hi;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }

  const n = games.length;
  // Hypergeometric: P(both a and b drawn when 20 of 80 chosen) = (20/80)*(19/79)
  const expectedPerGame = (20 / 80) * (19 / 79);
  const expected = n * expectedPerGame;

  const results: PairEntry[] = [];
  for (const [key, count] of counts) {
    const a = Math.floor(key / 100);
    const b = key % 100;
    results.push({ a, b, count, expected, lift: count / expected, pct: (count / n) * 100 });
  }

  return results.sort((x, y) => y.count - x.count);
}

/** Filter the full pair list to entries involving a specific number, sorted by count. */
export function pairsForNumber(
  pairs: PairEntry[],
  num: number
): Array<PairEntry & { partner: number }> {
  return pairs
    .filter(p => p.a === num || p.b === num)
    .map(p => ({ ...p, partner: p.a === num ? p.b : p.a }))
    .sort((a, b) => b.count - a.count);
}

/** Day-of-week frequency breakdown (0=Sun…6=Sat) from draw_date */
export interface DowEntry { dow: number; label: string; count: number }
const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function computeDowFreq(games: Game[]): DowEntry[] {
  const counts = Array.from({ length: 7 }, (_, i) => ({ dow: i, label: DOW_LABELS[i], count: 0 }));
  for (const g of games) if (g.draw_dow !== null) counts[g.draw_dow].count++;
  return counts;
}

/** Hottest numbers for a given day of week */
export function hotNumbersByDow(games: Game[], dow: number): { number: number; count: number; pct: number }[] {
  const sub = games.filter(g => g.draw_dow === dow);
  if (!sub.length) return [];
  const freq = new Map<number, number>();
  for (const g of sub) for (const h of g.hits) freq.set(h, (freq.get(h) ?? 0) + 1);
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([number, count]) => ({ number, count, pct: (count / sub.length) * 100 }));
}
