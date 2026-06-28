import { createServiceClient } from '@/lib/supabase-server';
import { lookupPrize } from '@/lib/keno/prizes';

/**
 * Daily-pick plays live in their own table (daily_pick_plays), fully decoupled
 * from the champion's continuous shadow play in live_results. This keeps the
 * daily pick's hard per-day cap (recommended_games, window-only) and its
 * Daily Pick Record W-L/P&L uncontaminated by the champion's normal evolution
 * play — which must stay unbounded for fitness scoring.
 */

/**
 * Recomputes daily_picks.games_played and status from the actual number of
 * daily_pick_plays rows for a date. Single source of truth: the play rows.
 * This is what keeps the progress bar and the Record card in agreement.
 */
export async function syncDailyPickCounter(
  db: ReturnType<typeof createServiceClient>,
  date: string,
): Promise<number> {
  const { count } = await db
    .from('daily_pick_plays')
    .select('id', { count: 'exact', head: true })
    .eq('pick_date', date);

  const played = count ?? 0;

  const { data: pick } = await db
    .from('daily_picks')
    .select('recommended_games')
    .eq('pick_date', date)
    .maybeSingle();

  const rec = (pick?.recommended_games as number) ?? 20;
  const status = played >= rec ? 'complete' : played > 0 ? 'playing' : 'pending';

  await db.from('daily_picks')
    .update({ games_played: played, status })
    .eq('pick_date', date);

  return played;
}

/**
 * Scores every unscored daily-pick play whose target game has now been drawn.
 * Called from /api/poll and /api/sync alongside scorePendingPredictions.
 */
export async function scoreDailyPickPlays(
  db: ReturnType<typeof createServiceClient>,
): Promise<number> {
  const { data: pending } = await db
    .from('daily_pick_plays')
    .select('id, pick_date, game_num, spot_count, picks, bonus_type, base_wager, wager_per_game')
    .eq('scored', false);

  if (!pending || pending.length === 0) return 0;

  const gameNums = [...new Set(pending.map(p => p.game_num as number))];
  const { data: games } = await db
    .from('games')
    .select('game_num,hits,bonus,super_bonus')
    .in('game_num', gameNums);

  interface GameRow { game_num: number; hits: number[]; bonus: number | null; super_bonus: number | null }
  const gamesByNum = new Map<number, GameRow>();
  for (const g of games ?? []) gamesByNum.set(g.game_num as number, g as GameRow);

  const affectedDates = new Set<string>();
  let scored = 0;

  for (const play of pending) {
    const game = gamesByNum.get(play.game_num as number);
    if (!game) continue; // target game not drawn yet — leave unscored

    const picks = play.picks as number[];
    const hitSet = new Set(game.hits);
    let matches = 0;
    for (const p of picks) if (hitSet.has(p)) matches++;

    const bonusType = (play.bonus_type ?? 'none') as string;
    const drawnMultiplier = bonusType === 'bonus'
      ? (game.bonus ?? 1)
      : bonusType === 'super_bonus'
      ? (game.super_bonus ?? 1)
      : 1;

    const basePrize = lookupPrize(play.spot_count as number, matches);
    const baseWager = (play.base_wager as number) ?? 1;
    const wagerPerGame = (play.wager_per_game as number) ?? baseWager;
    const effectivePrize = basePrize > 0 ? basePrize * baseWager * drawnMultiplier : 0;
    const pnl = effectivePrize - wagerPerGame;

    await db.from('daily_pick_plays').update({
      matches,
      prize: effectivePrize,
      pnl,
      bonus_multiplier: drawnMultiplier,
      scored: true,
      scored_at: new Date().toISOString(),
    }).eq('id', play.id);

    affectedDates.add(play.pick_date as string);
    scored++;
  }

  for (const date of affectedDates) {
    await syncDailyPickCounter(db, date);
  }

  return scored;
}
