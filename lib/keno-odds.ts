export const PRIZE_TABLE: Record<number, { catches: number; prize: number }[]> = {
  1: [{ catches: 1, prize: 2 }],
  2: [{ catches: 2, prize: 10 }],
  3: [
    { catches: 2, prize: 2 },
    { catches: 3, prize: 25 },
  ],
  4: [
    { catches: 2, prize: 1 },
    { catches: 3, prize: 5 },
    { catches: 4, prize: 50 },
  ],
  5: [
    { catches: 3, prize: 2 },
    { catches: 4, prize: 15 },
    { catches: 5, prize: 300 },
  ],
  6: [
    { catches: 3, prize: 1 },
    { catches: 4, prize: 5 },
    { catches: 5, prize: 50 },
    { catches: 6, prize: 1000 },
  ],
  7: [
    { catches: 3, prize: 1 },
    { catches: 4, prize: 3 },
    { catches: 5, prize: 15 },
    { catches: 6, prize: 100 },
    { catches: 7, prize: 2500 },
  ],
  8: [
    { catches: 4, prize: 2 },
    { catches: 5, prize: 10 },
    { catches: 6, prize: 50 },
    { catches: 7, prize: 500 },
    { catches: 8, prize: 10000 },
  ],
  9: [
    { catches: 0, prize: 2 },
    { catches: 5, prize: 5 },
    { catches: 6, prize: 20 },
    { catches: 7, prize: 100 },
    { catches: 8, prize: 2500 },
    { catches: 9, prize: 25000 },
  ],
  10: [
    { catches: 0, prize: 4 },
    { catches: 5, prize: 2 },
    { catches: 6, prize: 10 },
    { catches: 7, prize: 50 },
    { catches: 8, prize: 400 },
    { catches: 9, prize: 4000 },
    { catches: 10, prize: 100000 },
  ],
};

export const OVERALL_ODDS: Record<number, number> = {
  1: 4,
  2: 16.6,
  3: 6.55,
  4: 3.86,
  5: 10.34,
  6: 6.19,
  7: 4.22,
  8: 9.77,
  9: 9.74,
  10: 9.05,
};

// Bonus multiplier distribution (theoretical)
export const BONUS_DIST: { multiplier: number; prob: number }[] = [
  { multiplier: 3, prob: 1 / 3 },
  { multiplier: 4, prob: 1 / 15 },
  { multiplier: 5, prob: 1 / 40 },
  { multiplier: 10, prob: 1 / 250 },
];
const bonusTotalProb = BONUS_DIST.reduce((s, x) => s + x.prob, 0);
BONUS_DIST.unshift({ multiplier: 1, prob: 1 - bonusTotalProb });

// Super Bonus multiplier distribution (theoretical)
export const SUPER_BONUS_DIST: { multiplier: number; prob: number }[] = [
  { multiplier: 2, prob: 1 / 2.4 },
  { multiplier: 3, prob: 1 / 7.1 },
  { multiplier: 4, prob: 1 / 3.9 },
  { multiplier: 5, prob: 1 / 7.4 },
  { multiplier: 6, prob: 1 / 28.2 },
  { multiplier: 10, prob: 1 / 160 },
  { multiplier: 12, prob: 1 / 310 },
  { multiplier: 20, prob: 1 / 930 },
];

function logFact(n: number): number {
  if (n <= 1) return 0;
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
}

function logC(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  return logFact(n) - logFact(k) - logFact(n - k);
}

/** Hypergeometric PMF: pick spots from 80, 20 drawn, probability of catching exactly k */
export function hypergeoPMF(spots: number, k: number): number {
  return Math.exp(logC(spots, k) + logC(80 - spots, 20 - k) - logC(80, 20));
}

/** Expected value per $1 wager for a given spot count */
export function computeEV(spots: number): number {
  const prizes = PRIZE_TABLE[spots] ?? [];
  let ev = 0;
  for (const { catches, prize } of prizes) {
    ev += hypergeoPMF(spots, catches) * prize;
  }
  return ev;
}

export function expectedBonusMultiplier(
  dist: { multiplier: number; prob: number }[]
): number {
  return dist.reduce((s, x) => s + x.multiplier * x.prob, 0);
}

export const THEORETICAL_BONUS_EV_MULT = expectedBonusMultiplier(BONUS_DIST);
export const THEORETICAL_SUPER_BONUS_EV_MULT = expectedBonusMultiplier(SUPER_BONUS_DIST);
