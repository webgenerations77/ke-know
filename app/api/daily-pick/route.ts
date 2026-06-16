import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-server';
import { generatePicks } from '@/lib/evolution/fitness';
import type { StrategyGenome } from '@/lib/evolution/genome';
import type { Game } from '@/lib/supabase';

export const maxDuration = 60;

export async function GET() {
  const db = createServiceClient();
  const today = new Date().toLocaleDateString('en-CA');
  const { data, error } = await db
    .from('daily_picks')
    .select('*')
    .eq('pick_date', today)
    .maybeSingle();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, pick: data ?? null });
}

export async function POST() {
  const db = createServiceClient();
  const today = new Date().toLocaleDateString('en-CA');

  // Load all promoted champions
  const { data: champions, error: champErr } = await db
    .from('strategies')
    .select('id, spot_count, genome')
    .eq('status', 'promoted');

  if (champErr || !champions?.length) {
    return NextResponse.json(
      { ok: false, error: 'No champions found — run Evolution first' },
      { status: 400 }
    );
  }

  // Get latest fitness for each champion (ordered desc so first row per id = latest)
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

  // Select champion with highest fitness score
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
    return NextResponse.json({ ok: false, error: 'Could not determine best champion' }, { status: 500 });
  }

  const genome = bestChamp.genome as StrategyGenome;
  const spotCount = bestChamp.spot_count as number;

  // Load all games for pick generation
  const { data: games, error: gamesErr } = await db
    .from('games')
    .select('game_num,draw_date,draw_iso,draw_dow,bonus,super_bonus,hits')
    .order('game_num', { ascending: true });

  if (gamesErr || !games?.length) {
    return NextResponse.json({ ok: false, error: 'Failed to load games' }, { status: 500 });
  }

  const picks = generatePicks(genome, spotCount, games as Game[]);

  // Analyze live_results by ET hour (12–18) to find the best play window
  const { data: liveResults } = await db
    .from('live_results')
    .select('game_num, pnl, prize')
    .eq('strategy_id', bestChamp.id as number);

  let bestHour = 14; // default: 2 PM ET

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

    // UTC-4 = EDT (Maryland summer); acceptable approximation year-round
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

  const { error: upsertErr } = await db.from('daily_picks').upsert(
    {
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
    },
    { onConflict: 'pick_date' }
  );

  if (upsertErr) {
    return NextResponse.json({ ok: false, error: upsertErr.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    pick_date: today,
    spot_count: spotCount,
    picks,
    bonus_type: bonusType,
    wager_per_game: wagerPerGame,
    recommended_games: recommendedGames,
    best_hour: bestHour,
    expected_pnl_per_game: expectedPpg,
    expected_total_pnl: expectedPpg * recommendedGames,
    fitness_score: bestFitness,
  });
}
