import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-server';
import { generatePicks } from '@/lib/evolution/fitness';
import type { StrategyGenome } from '@/lib/evolution/genome';
import type { Game } from '@/lib/supabase';
import { notifyDailyPick } from '@/lib/notify';

export const maxDuration = 60;

async function generateDailyPick(db: ReturnType<typeof createServiceClient>) {
  const today = new Date().toLocaleDateString('en-CA');

  const { data: champions, error: champErr } = await db
    .from('strategies')
    .select('id, spot_count, genome')
    .eq('status', 'promoted');

  if (champErr || !champions?.length) {
    return { ok: false as const, error: 'No champions found — run Evolution first' };
  }

  const champIds = champions.map((c: any) => c.id as number);
  const { data: results } = await db
    .from('strategy_results')
    .select('strategy_id, fitness_score, test_pnl_per_game, win_rate, max_losing_streak')
    .in('strategy_id', champIds)
    .order('evaluated_at', { ascending: false });

  const resultMap = new Map<number, {
    fitness_score: number;
    test_pnl_per_game: number;
    win_rate: number;
    max_losing_streak: number;
  }>();
  for (const r of results ?? []) {
    const id = r.strategy_id as number;
    if (!resultMap.has(id)) {
      resultMap.set(id, {
        fitness_score: r.fitness_score ?? 0,
        test_pnl_per_game: r.test_pnl_per_game ?? 0,
        win_rate: r.win_rate ?? 0,
        max_losing_streak: r.max_losing_streak ?? 5,
      });
    }
  }

  let bestChamp: (typeof champions)[0] | null = null;
  let bestFitness = -Infinity;
  let bestResult: { fitness_score: number; test_pnl_per_game: number; win_rate: number; max_losing_streak: number } | undefined;

  for (const champ of champions) {
    const r = resultMap.get(champ.id as number);
    const fitness = r?.fitness_score ?? -999;
    if (fitness > bestFitness) {
      bestFitness = fitness;
      bestChamp = champ;
      bestResult = r;
    }
  }

  if (!bestChamp) {
    return { ok: false as const, error: 'Could not determine best champion' };
  }

  const genome = bestChamp.genome as StrategyGenome;
  const spotCount = bestChamp.spot_count as number;

  const { data: games, error: gamesErr } = await db
    .from('games')
    .select('game_num,draw_date,draw_iso,draw_dow,bonus,super_bonus,hits')
    .order('game_num', { ascending: true });

  if (gamesErr || !games?.length) {
    return { ok: false as const, error: 'Failed to load games' };
  }

  const picks = generatePicks(genome, spotCount, games as Game[]);

  const { data: liveResults } = await db
    .from('live_results')
    .select('game_num, pnl, prize')
    .eq('strategy_id', bestChamp.id as number);

  let bestHour = 14;

  const gameNums = (liveResults ?? []).map((r: any) => r.game_num as number);
  if (gameNums.length > 0) {
    const { data: drawTimes } = await db
      .from('games')
      .select('game_num, draw_iso')
      .in('game_num', gameNums);

    const timeMap = new Map<number, string>();
    for (const g of drawTimes ?? []) {
      timeMap.set(g.game_num as number, g.draw_iso as string);
    }

    const hourStats = new Map<number, { total: number; pnl: number; wins: number }>();
    for (const r of liveResults ?? []) {
      const iso = timeMap.get(r.game_num as number);
      if (!iso) continue;
      const etHour = (new Date(iso).getUTCHours() - 4 + 24) % 24;
      if (etHour < 12 || etHour > 18) continue;
      const stat = hourStats.get(etHour) ?? { total: 0, pnl: 0, wins: 0 };
      stat.total++;
      stat.pnl += r.pnl as number;
      if ((r.prize as number) > 0) stat.wins++;
      hourStats.set(etHour, stat);
    }

    let bestScore = -Infinity;
    for (const [hour, stat] of hourStats) {
      if (stat.total < 5) continue;
      const score = stat.pnl / stat.total;
      if (score > bestScore) {
        bestScore = score;
        bestHour = hour;
      }
    }
  }

  const bonusType = genome.bonus_type ?? 'none';
  const wagerPerGame = bonusType === 'super_bonus' ? 3 : bonusType === 'bonus' ? 2 : 1;
  const recommendedGames = 20;
  const expectedPpg = bestResult?.test_pnl_per_game ?? 0;

  const pickRow = {
    pick_date: today,
    generated_at: new Date().toISOString(),
    strategy_id: bestChamp.id,
    spot_count: spotCount,
    picks,
    bonus_type: bonusType,
    wager_per_game: wagerPerGame,
    recommended_games: recommendedGames,
    best_hour: bestHour,
    expected_pnl_per_game: expectedPpg,
    expected_total_pnl: expectedPpg * recommendedGames,
    fitness_score: bestFitness,
    reasoning: {
      champion_id: bestChamp.id,
      shadow_plays: liveResults?.length ?? 0,
      win_rate: bestResult?.win_rate ?? 0,
      max_losing_streak: bestResult?.max_losing_streak ?? 0,
    },
  };

  const { error: upsertErr } = await db
    .from('daily_picks')
    .upsert(pickRow, { onConflict: 'pick_date' });

  if (upsertErr) {
    return { ok: false as const, error: upsertErr.message };
  }

  return { ok: true as const, ...pickRow };
}

// GET: return today's pick — auto-generate if none exists (Vercel cron calls GET)
export async function GET() {
  const db = createServiceClient();
  const today = new Date().toLocaleDateString('en-CA');

  const { data: existing } = await db
    .from('daily_picks')
    .select('*')
    .eq('pick_date', today)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ ok: true, pick: existing });
  }

  // No pick for today — generate it automatically
  const result = await generateDailyPick(db);
  if (!result.ok) {
    return NextResponse.json({ ok: true, pick: null });
  }

  const { data: freshPick } = await db
    .from('daily_picks')
    .select('*')
    .eq('pick_date', today)
    .maybeSingle();

  if (freshPick) {
    await notifyDailyPick(
      freshPick.spot_count as number,
      freshPick.picks as number[],
      freshPick.best_hour as number | null,
    ).catch(() => {});
  }

  return NextResponse.json({ ok: true, pick: freshPick ?? null });
}

// POST: force-regenerate today's pick (manual refresh button)
export async function POST() {
  const db = createServiceClient();
  const result = await generateDailyPick(db);

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  }

  return NextResponse.json(result);
}
