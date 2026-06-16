export {
  PRIZE_TABLE,
  OVERALL_ODDS,
  BONUS_DIST,
  SUPER_BONUS_DIST,
  hypergeoPMF,
  computeEV,
  expectedBonusMultiplier,
  THEORETICAL_BONUS_EV_MULT,
  THEORETICAL_SUPER_BONUS_EV_MULT,
} from '@/lib/keno-odds';

import { PRIZE_TABLE } from '@/lib/keno-odds';

/** Returns the prize amount for a given spot count and match count ($1 wager). */
export function lookupPrize(spots: number, matches: number): number {
  const table = PRIZE_TABLE[spots] ?? [];
  return table.find(e => e.catches === matches)?.prize ?? 0;
}
