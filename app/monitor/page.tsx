'use client';

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import type { SystemEvent, LiveResult, Game, EvolutionState } from '@/lib/supabase';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';

const EVENT_ICONS: Record<string, string> = {
  success: '🟢',
  info: '🔵',
  warning: '🟡',
  error: '🔴',
};

function fmt(ts: string | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString();
}

function fmtDate(ts: string | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

function minutesAgo(ts: string | null | undefined): number {
  if (!ts) return 9999;
  return (Date.now() - new Date(ts).getTime()) / 60000;
}

function Dot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block w-2.5 h-2.5 rounded-full mr-2 ${ok ? 'bg-green-400' : 'bg-red-500'}`}
    />
  );
}

interface ArthurContext {
  evoState: EvolutionState | null;
  champions: { spot_count: number; fitness_score: number | null; id: number; generation: number }[];
  bToday: PerformanceBucket;
  bAll: PerformanceBucket;
  b24: PerformanceBucket;
  events: SystemEvent[];
  allLiveResults: LiveResult[];
  dailyMap: Map<string, PerformanceBucket>;
}

interface ArthurOutput {
  main: string;
  mood: 'fire' | 'good' | 'steady' | 'down' | 'waiting';
  observations: string[];
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function computeArthurFull(ctx: ArthurContext): ArthurOutput {
  const { evoState, champions, bToday, bAll, b24, events, allLiveResults, dailyMap } = ctx;

  if (!evoState || evoState.current_generation === 0) {
    return {
      main: pick([
        "I'm brand new here — haven't had my first look at the data yet. Hit that evolution button and let me start learning.",
        "Just woke up. No data to chew on yet — run evolution and I'll start building my playbook.",
        "Fresh install, zero experience. I need my first evolution cycle before I can start making moves.",
      ]),
      mood: 'waiting',
      observations: [],
    };
  }

  const gen = evoState.current_generation;
  const champCount = champions.length;
  const now = Date.now();

  const lastEvoEvt = events.find(e => e.event_type === 'evolution_complete');
  const evoRecent = lastEvoEvt && (now - new Date(lastEvoEvt.occurred_at).getTime()) < 30 * 60 * 1000;

  const recentSorted = [...allLiveResults]
    .sort((a, b) => new Date(b.scored_at).getTime() - new Date(a.scored_at).getTime());
  const lastResult = recentSorted[0] ?? null;

  let streakType: 'win' | 'loss' | null = null;
  let streakCount = 0;
  for (const r of recentSorted) {
    const isWin = r.prize > 0;
    if (streakType === null) {
      streakType = isWin ? 'win' : 'loss';
      streakCount = 1;
    } else if ((isWin && streakType === 'win') || (!isWin && streakType === 'loss')) {
      streakCount++;
    } else {
      break;
    }
  }

  const todayBySpot = new Map<number, PerformanceBucket>();
  const todayKey = new Date().toLocaleDateString('en-CA');
  for (const r of allLiveResults) {
    if (new Date(r.scored_at).toLocaleDateString('en-CA') !== todayKey) continue;
    const b = todayBySpot.get(r.spot_count) ?? emptyBucket();
    b.total++; b.pnl += r.pnl;
    if (r.prize > 0) b.wins++;
    if (r.prize > b.best) b.best = r.prize;
    todayBySpot.set(r.spot_count, b);
  }

  const weekBySpot = new Map<number, PerformanceBucket>();
  const weekAgo = now - 7 * 86400000;
  for (const r of allLiveResults) {
    if (new Date(r.scored_at).getTime() < weekAgo) continue;
    const b = weekBySpot.get(r.spot_count) ?? emptyBucket();
    b.total++; b.pnl += r.pnl;
    if (r.prize > 0) b.wins++;
    if (r.prize > b.best) b.best = r.prize;
    weekBySpot.set(r.spot_count, b);
  }

  let bestWeekSpot = 0, worstWeekSpot = 0;
  let bestWeekPpg = -Infinity, worstWeekPpg = Infinity;
  for (const [spot, b] of weekBySpot) {
    if (b.total < 5) continue;
    const ppg = b.pnl / b.total;
    if (ppg > bestWeekPpg) { bestWeekPpg = ppg; bestWeekSpot = spot; }
    if (ppg < worstWeekPpg) { worstWeekPpg = ppg; worstWeekSpot = spot; }
  }

  let bestTodaySpot = 0;
  let bestTodayPpg = -Infinity;
  for (const [spot, b] of todayBySpot) {
    if (b.total < 3) continue;
    const ppg = b.pnl / b.total;
    if (ppg > bestTodayPpg) { bestTodayPpg = ppg; bestTodaySpot = spot; }
  }

  const yesterday = new Date(now - 86400000).toLocaleDateString('en-CA');
  const bYesterday = dailyMap.get(yesterday);

  const allTimeBest = allLiveResults.length > 0
    ? allLiveResults.reduce((best, r) => r.prize > best.prize ? r : best, allLiveResults[0])
    : null;

  const dailyEntries = [...dailyMap.entries()];
  const profitableDays = dailyEntries.filter(([, b]) => b.pnl > 0).length;
  const totalDays = dailyEntries.length;

  const hour = new Date().getHours();
  const timeOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayOfWeek = dayNames[new Date().getDay()];

  const activeSpots = new Set(champions.map(c => c.spot_count));

  // ── Build observations (secondary insights) ──
  const observations: { text: string; weight: number }[] = [];

  if (streakType === 'win' && streakCount >= 3) {
    observations.push({ weight: 10, text: pick([
      `${streakCount}-game win streak rolling. Momentum is real.`,
      `${streakCount} wins in a row — can't miss right now.`,
      `Hot streak: ${streakCount} consecutive wins and counting.`,
      `${streakCount} straight wins. This is the zone.`,
    ])});
  } else if (streakType === 'loss' && streakCount >= 10) {
    observations.push({ weight: 10, text: pick([
      `Brutal ${streakCount}-game cold streak. This is exactly why I track max cold streaks in fitness — need strategies that survive this.`,
      `${streakCount} losses deep. Painful, but cold streaks end. My evolution accounts for this.`,
    ])});
  } else if (streakType === 'loss' && streakCount >= 5) {
    observations.push({ weight: 7, text: pick([
      `${streakCount} losses in a row — cold stretch, but I've weathered worse.`,
      `Down ${streakCount} straight. The math hasn't changed, just variance doing its thing.`,
      `Cold streak at ${streakCount}. Part of the game — staying patient.`,
    ])});
  }

  if (bestWeekSpot > 0 && bestWeekPpg > 0 && weekBySpot.get(bestWeekSpot)!.total >= 10) {
    observations.push({ weight: 6, text: pick([
      `${bestWeekSpot}-spot has been my best play this week — averaging +$${bestWeekPpg.toFixed(2)}/game.`,
      `Leaning into ${bestWeekSpot}-spot plays this week. +$${bestWeekPpg.toFixed(2)}/game over ${weekBySpot.get(bestWeekSpot)!.total} games.`,
      `${bestWeekSpot}-spot is carrying the portfolio this week at +$${bestWeekPpg.toFixed(2)} per game.`,
    ])});
  }

  if (worstWeekSpot > 0 && worstWeekPpg < -0.5 && bestWeekSpot !== worstWeekSpot && weekBySpot.get(worstWeekSpot)!.total >= 10) {
    observations.push({ weight: 5, text: pick([
      `${worstWeekSpot}-spot is struggling this week. Might need a strategy shake-up there.`,
      `Rough week for ${worstWeekSpot}-spot plays. Next evolution cycle should adapt.`,
      `${worstWeekSpot}-spot is my weakest link right now — $${worstWeekPpg.toFixed(2)}/game.`,
    ])});
  }

  if (bestTodaySpot > 0 && bestTodayPpg > 0.5 && todayBySpot.get(bestTodaySpot)!.total >= 5) {
    observations.push({ weight: 8, text: pick([
      `${bestTodaySpot}-spot is on fire today — $${bestTodayPpg.toFixed(2)}/game across ${todayBySpot.get(bestTodaySpot)!.total} plays.`,
      `Today's MVP: ${bestTodaySpot}-spot at +$${bestTodayPpg.toFixed(2)} per game.`,
      `${bestTodaySpot}-spot is printing today. ${todayBySpot.get(bestTodaySpot)!.total} plays, all trending up.`,
    ])});
  }

  if (bYesterday && bYesterday.total >= 10 && bToday.total >= 10) {
    const yPpg = bYesterday.pnl / bYesterday.total;
    const tPpg = bToday.pnl / bToday.total;
    if (tPpg > yPpg + 0.1) {
      observations.push({ weight: 5, text: pick([
        `Running better than yesterday — that's the kind of trend line I want to see.`,
        `Outpacing yesterday's numbers. The strategies are adapting.`,
        `Day-over-day improvement. Small edges compound.`,
      ])});
    } else if (tPpg < yPpg - 0.3) {
      observations.push({ weight: 4, text: pick([
        `Yesterday was stronger. Keno doesn't owe me consistency, but I take notes.`,
        `Trailing yesterday's pace. Not worried — variance is part of the game.`,
        `Slower day than yesterday. I adjust, I don't chase.`,
      ])});
    }
  }

  if (totalDays >= 5) {
    const pct = Math.round((profitableDays / totalDays) * 100);
    if (pct >= 50) {
      observations.push({ weight: 4, text: pick([
        `Profitable on ${profitableDays} of ${totalDays} days tracked (${pct}%). Not bad for a game designed to beat you.`,
        `${pct}% of tracked days finished green. The evolution engine is earning its keep.`,
        `More winning days than losing — ${profitableDays} out of ${totalDays}. The system works.`,
      ])});
    } else if (pct < 30 && totalDays >= 7) {
      observations.push({ weight: 3, text: pick([
        `Only ${profitableDays} profitable days out of ${totalDays}. Each evolution cycle sharpens the edge.`,
        `${pct}% profitable days — room to improve. That's what evolution is for.`,
      ])});
    }
  }

  if (allTimeBest && allTimeBest.prize >= 10) {
    observations.push({ weight: 3, text: pick([
      `Best hit ever: $${allTimeBest.prize} on ${allTimeBest.spot_count}-spot (${allTimeBest.matches}/${allTimeBest.spot_count}). Always chasing the next one.`,
      `Personal record: $${allTimeBest.prize} from a ${allTimeBest.spot_count}-spot play. That's the kind of catch that makes it all worth it.`,
      `All-time best: $${allTimeBest.prize}. ${allTimeBest.spot_count}-spot, ${allTimeBest.matches} matches. I remember every big win.`,
    ])});
  }

  if (lastResult && (now - new Date(lastResult.scored_at).getTime()) < 10 * 60 * 1000) {
    if (lastResult.prize >= 50) {
      observations.push({ weight: 10, text: pick([
        `Just hit $${lastResult.prize} on ${lastResult.spot_count}-spot! ${lastResult.matches}/${lastResult.spot_count} matches. That's what I'm talking about.`,
        `Big catch! $${lastResult.prize} on a ${lastResult.spot_count}-spot play just now. The strategy called it.`,
        `$${lastResult.prize} winner just landed — ${lastResult.matches}/${lastResult.spot_count} on a ${lastResult.spot_count}-spot. Love it.`,
      ])});
    } else if (lastResult.prize > 0) {
      observations.push({ weight: 6, text: pick([
        `Small win last game — $${lastResult.prize} on ${lastResult.spot_count}-spot. Keeps the bankroll ticking.`,
        `$${lastResult.prize} on the last draw. Not a headline, but every win counts.`,
        `Picked up $${lastResult.prize} on that last ${lastResult.spot_count}-spot play. Steady progress.`,
      ])});
    }
  }

  if (gen >= 10) {
    observations.push({ weight: 2, text: pick([
      `Gen ${gen} — ${gen} rounds of evolution behind these picks. Each generation learns from the last.`,
      `${gen} generations deep now. The strategies have been tested against thousands of games.`,
      `I've evolved through ${gen} generations. The weak strategies got culled, the strong survived.`,
    ])});
  }

  if (champCount >= 5) {
    observations.push({ weight: 2, text: pick([
      `Running champions across ${activeSpots.size} different spot counts. Diversification is defense.`,
      `${champCount} active champions covering ${activeSpots.size} spot counts. Broad coverage.`,
    ])});
  }

  // Shuffle + weight-sort, take top 3
  const shuffled = observations
    .map(o => ({ ...o, r: Math.random() * o.weight }))
    .sort((a, b) => b.r - a.r);
  const topObs = shuffled.slice(0, 3).map(o => o.text);

  // ── Build main thought ──
  let main = '';
  let mood: ArthurOutput['mood'] = 'steady';

  if (evoRecent && champCount > 0) {
    const best = champions.reduce((a, c) =>
      (c.fitness_score ?? -999) > (a.fitness_score ?? -999) ? c : a, champions[0]);
    const fit = (best.fitness_score ?? 0).toFixed(3);
    main = pick([
      `Fresh out of evolution — gen ${gen} just dropped. Leading with ${best.spot_count}-spot (fitness: ${fit}). Let's see what this batch can do.`,
      `Gen ${gen} is live. New strategies, new confidence. My top pick is ${best.spot_count}-spot at ${fit} fitness. Time to prove it on real draws.`,
      `Just evolved to gen ${gen}. Strongest play: ${best.spot_count}-spot with a ${fit} fitness rating. The higher that number, the more I trust the picks.`,
    ]);
    mood = 'good';
  } else if (bToday.total >= 10) {
    const todayWR = (bToday.wins / bToday.total * 100).toFixed(1);
    const allWR = bAll.total > 0 ? (bAll.wins / bAll.total * 100) : 0;
    if (bToday.pnl > 2) {
      main = pick([
        `Good ${timeOfDay}. Up $${bToday.pnl.toFixed(2)} across ${bToday.total} plays — ${todayWR}% win rate. Gen ${gen} is delivering.`,
        `${dayOfWeek}'s treating me well. +$${bToday.pnl.toFixed(2)} on ${bToday.total} shadow plays so far. ${todayWR}% hit rate.`,
        `Solid ${timeOfDay} — ${todayWR}% wins, +$${bToday.pnl.toFixed(2)} net. The gen ${gen} strategies are reading these draws well.`,
      ]);
      mood = bToday.pnl > 5 ? 'fire' : 'good';
    } else if (allWR > 0 && (bToday.wins / bToday.total * 100) > allWR * 1.1) {
      main = pick([
        `Outperforming my lifetime average — ${todayWR}% today vs ${allWR.toFixed(1)}% overall. ${bToday.total} plays in and gen ${gen} is sharp.`,
        `Beating the baseline. ${todayWR}% win rate today, normally ${allWR.toFixed(1)}%. ${bToday.total} games tracked this ${timeOfDay}.`,
      ]);
      mood = 'good';
    } else if (bToday.pnl < -5) {
      const absLoss = Math.abs(bToday.pnl).toFixed(2);
      main = pick([
        `Tough ${dayOfWeek} — down $${absLoss} across ${bToday.total} plays. The draws aren't cooperating, but I don't panic. I adapt.`,
        `Rough ${timeOfDay}. -$${absLoss} on ${bToday.total} shadow plays. Variance hits hard sometimes. Next evolution will learn from today.`,
        `Down $${absLoss} today. ${bToday.total} plays, and the numbers aren't falling my way. That's Keno — the edge is in the long game.`,
      ]);
      mood = 'down';
    } else if (bToday.pnl < -1) {
      main = pick([
        `Grinding through a flat spot — ${bToday.pnl >= 0 ? '+' : ''}$${bToday.pnl.toFixed(2)} across ${bToday.total} plays. ${todayWR}% win rate. Need the bigger catches to start landing.`,
        `Slightly underwater this ${timeOfDay}. ${todayWR}% win rate isn't bad — just need a couple hits to swing positive.`,
        `Treading water at ${bToday.pnl >= 0 ? '+' : ''}$${bToday.pnl.toFixed(2)} on ${bToday.total} games. Close to the edge — one good catch flips it.`,
      ]);
      mood = 'steady';
    } else {
      main = pick([
        `Steady ${dayOfWeek} so far — ${todayWR}% win rate, ${bToday.pnl >= 0 ? '+' : ''}$${bToday.pnl.toFixed(2)} net. Playing the long game with gen ${gen}.`,
        `Nothing flashy this ${timeOfDay}. ${todayWR}% hit rate, ${bToday.pnl >= 0 ? '+' : ''}$${bToday.pnl.toFixed(2)} across ${bToday.total} plays. Consistency beats fireworks.`,
        `Quiet ${timeOfDay} — breaking even at ${bToday.pnl >= 0 ? '+' : ''}$${bToday.pnl.toFixed(2)}. ${bToday.total} games in. Sometimes steady is the play.`,
      ]);
      mood = 'steady';
    }
  } else if (b24.total > 0) {
    const wr24 = (b24.wins / b24.total * 100).toFixed(1);
    main = pick([
      `${b24.total} games tracked in the last 24 hours — ${wr24}% win rate, ${b24.pnl >= 0 ? '+' : ''}$${b24.pnl.toFixed(2)} P&L. Still building today's picture.`,
      `Last 24h: ${b24.total} plays, ${wr24}% wins, ${b24.pnl >= 0 ? '+' : ''}$${b24.pnl.toFixed(2)} net. Gathering data to see how gen ${gen} handles ${dayOfWeek}.`,
    ]);
    mood = b24.pnl >= 0 ? 'good' : 'steady';
  } else if (champCount > 0) {
    const best = champions.reduce((a, c) =>
      (c.fitness_score ?? -999) > (a.fitness_score ?? -999) ? c : a, champions[0]);
    const fit = (best.fitness_score ?? 0).toFixed(3);
    main = pick([
      `${champCount} champion${champCount !== 1 ? 's' : ''} ready from gen ${gen}. Strongest: ${best.spot_count}-spot at ${fit} fitness. Waiting on live draws to keep score.`,
      `Gen ${gen} loaded — ${champCount} strategies primed and tested. Top play is ${best.spot_count}-spot (${fit} fitness). Need real draws to start proving it.`,
    ]);
    mood = 'waiting';
  } else {
    main = pick([
      `Gen ${gen} strategies locked in. Waiting on live draws to score against.`,
      `Standing by for results. Gen ${gen} is ready — just need the draws to start flowing.`,
    ]);
    mood = 'waiting';
  }

  return { main, mood, observations: topObs };
}

function StatCard({
  label, value, sub, ok, onClick,
}: { label: string; value: string; sub?: string; ok?: boolean; onClick?: () => void }) {
  return (
    <div
      className={`bg-surface rounded-xl p-4 flex flex-col gap-1 ${onClick ? 'cursor-pointer hover:border-crimson/40 border border-transparent transition-colors' : ''}`}
      onClick={onClick}
    >
      <div className="flex items-center text-xs text-slate-400 gap-1">
        {ok !== undefined && <Dot ok={ok} />}
        {label}
        {onClick && <span className="ml-auto text-slate-600 text-[10px]">▼ details</span>}
      </div>
      <div className="text-lg font-bold text-white truncate">{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

interface PerformanceBucket {
  total: number;
  wins: number;
  pnl: number;
  best: number;
}

function emptyBucket(): PerformanceBucket {
  return { total: 0, wins: 0, pnl: 0, best: 0 };
}

function PerfCol({
  label, bucket, bySpot,
}: { label: string; bucket: PerformanceBucket; bySpot: Map<number, PerformanceBucket> }) {
  return (
    <div>
      <div className="text-xs font-semibold text-slate-400 mb-3">{label}</div>
      <div className="space-y-1 text-xs">
        <div className="flex justify-between">
          <span className="text-slate-500">Predictions</span>
          <span className="font-mono">{bucket.total}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Win rate</span>
          <span className="font-mono">
            {bucket.total > 0 ? ((bucket.wins / bucket.total) * 100).toFixed(1) : 0}%
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">P&L / game</span>
          <span className={`font-mono ${bucket.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {bucket.total > 0 ? `$${(bucket.pnl / bucket.total).toFixed(2)}` : '—'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Best win</span>
          <span className="font-mono">${bucket.best}</span>
        </div>
      </div>
      <div className="mt-3 space-y-0.5">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(s => {
          const b = bySpot.get(s);
          if (!b || b.total === 0) return null;
          return (
            <div key={s} className="flex justify-between text-xs">
              <span className="text-slate-600">{s}-spot</span>
              <span className={b.pnl >= 0 ? 'text-green-500' : 'text-red-500'}>
                ${(b.pnl / b.total).toFixed(2)}/g
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function MonitorPage() {
  const [events, setEvents] = useState<SystemEvent[]>([]);
  const [liveResults, setLiveResults] = useState<LiveResult[]>([]);
  const [allLiveResults, setAllLiveResults] = useState<LiveResult[]>([]);
  const [dailyBreakdownOpen, setDailyBreakdownOpen] = useState(false);
  const [recentGames, setRecentGames] = useState<Game[]>([]);
  const [evoState, setEvoState] = useState<EvolutionState | null>(null);
  const [fitnessByGen, setFitnessByGen] = useState<{ generation: number; [key: string]: number }[]>([]);
  const [champions, setChampions] = useState<{ spot_count: number; fitness_score: number | null; id: number; generation: number }[]>([]);
  const [totalGames, setTotalGames] = useState(0);
  const [latestGameTs, setLatestGameTs] = useState<string | null>(null);
  const [expandedEvent, setExpandedEvent] = useState<number | null>(null);
  const [expandedPick, setExpandedPick] = useState<string | null>(null);
  const [eventsPage, setEventsPage] = useState(1);
  const [mounted, setMounted] = useState(false);
  const [evoDetailOpen, setEvoDetailOpen] = useState(false);
  const [biggestWinOpen, setBiggestWinOpen] = useState(false);
  const [stratGenMap, setStratGenMap] = useState<Map<number, number>>(new Map());
  const [timeFilter, setTimeFilter] = useState<'today' | 'week' | 'month' | 'all'>('today');
  const [activityLogOpen, setActivityLogOpen] = useState(false);
  const [rollingPerfOpen, setRollingPerfOpen] = useState(false);
  const [cronHealthOpen, setCronHealthOpen] = useState(false);

  const loadAll = useCallback(async () => {
    const [
      { data: evts },
      { data: results },
      { data: games },
      { data: evo },
      { data: champs },
      { data: genFitness },
      { count },
      { data: latestGame },
    ] = await Promise.all([
      supabase.from('system_events').select('*').order('occurred_at', { ascending: false }).limit(100),
      supabase.from('live_results').select('*').order('scored_at', { ascending: false }).limit(200),
      supabase.from('games').select('*').order('game_num', { ascending: false }).limit(20),
      supabase.from('evolution_state').select('*').eq('id', 1).single(),
      supabase.from('strategies').select('id,spot_count,generation').eq('status', 'promoted').order('spot_count'),
      supabase.from('strategy_results').select('generation,spot_count,fitness_score')
        .order('generation', { ascending: true }).limit(500),
      supabase.from('games').select('game_num', { count: 'exact', head: true }),
      supabase.from('games').select('draw_iso').order('game_num', { ascending: false }).limit(1).maybeSingle(),
    ]);

    const allResults: LiveResult[] = [];
    let offset = 0;
    const PAGE = 1000;
    while (true) {
      const { data: page } = await supabase
        .from('live_results')
        .select('*')
        .order('scored_at', { ascending: false })
        .range(offset, offset + PAGE - 1);
      if (!page || page.length === 0) break;
      allResults.push(...(page as LiveResult[]));
      if (page.length < PAGE) break;
      offset += PAGE;
    }

    if (evts) setEvents(evts as SystemEvent[]);
    if (results) setLiveResults(results as LiveResult[]);
    setAllLiveResults(allResults);
    if (games) setRecentGames(games as Game[]);
    if (evo) setEvoState(evo as EvolutionState);
    if (count !== null) setTotalGames(count);
    if (latestGame) setLatestGameTs(latestGame.draw_iso);

    // Load strategy→generation mapping for all strategies that have live results
    const stratIds = [...new Set(allResults.map(r => r.strategy_id))];
    if (stratIds.length > 0) {
      const genMap = new Map<number, number>();
      for (let i = 0; i < stratIds.length; i += 100) {
        const batch = stratIds.slice(i, i + 100);
        const { data: strats } = await supabase
          .from('strategies')
          .select('id,generation')
          .in('id', batch);
        for (const s of strats ?? []) {
          genMap.set(s.id as number, s.generation as number);
        }
      }
      setStratGenMap(genMap);
    }

    if (champs) {
      const champData = await Promise.all(
        (champs as { id: number; spot_count: number; generation: number }[]).map(async c => {
          const { data: r } = await supabase
            .from('strategy_results')
            .select('fitness_score')
            .eq('strategy_id', c.id)
            .order('evaluated_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          return { ...c, fitness_score: r?.fitness_score ?? null };
        })
      );
      setChampions(champData);
    }

    if (genFitness) {
      const byGen = new Map<number, Map<number, number>>();
      for (const row of genFitness as { generation: number; spot_count: number; fitness_score: number | null }[]) {
        if (!byGen.has(row.generation)) byGen.set(row.generation, new Map());
        const genMap = byGen.get(row.generation)!;
        const current = genMap.get(row.spot_count) ?? -999;
        if ((row.fitness_score ?? -999) > current) {
          genMap.set(row.spot_count, row.fitness_score ?? 0);
        }
      }
      const last48 = [...byGen.entries()].sort((a, b) => a[0] - b[0]).slice(-48);
      setFitnessByGen(last48.map(([gen, spotMap]) => {
        const entry: { generation: number; [key: string]: number } = { generation: gen };
        for (const [spot, fit] of spotMap) entry[`s${spot}`] = fit;
        return entry;
      }));
    }
  }, []);

  useEffect(() => {
    setMounted(true);
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    const ch1 = supabase
      .channel('monitor_events')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'system_events' },
        payload => {
          setEvents(prev => [payload.new as SystemEvent, ...prev].slice(0, 100));
          if (['sync_complete', 'evolution_complete', 'poll_success'].includes(
            (payload.new as SystemEvent).event_type
          )) {
            loadAll();
          }
        })
      .subscribe();

    const ch2 = supabase
      .channel('monitor_live_results')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'live_results' },
        payload => {
          setLiveResults(prev => [payload.new as LiveResult, ...prev].slice(0, 200));
          setAllLiveResults(prev => [payload.new as LiveResult, ...prev]);
        })
      .subscribe();

    const ch3 = supabase
      .channel('monitor_games')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'games' },
        payload => {
          setRecentGames(prev => [payload.new as Game, ...prev].slice(0, 20));
          setTotalGames(n => n + 1);
          setLatestGameTs((payload.new as Game).draw_iso);
        })
      .subscribe();

    return () => {
      supabase.removeChannel(ch1);
      supabase.removeChannel(ch2);
      supabase.removeChannel(ch3);
    };
  }, [loadAll]);

  const now = Date.now();
  const h24 = 24 * 3600 * 1000;
  const d7 = 7 * h24;

  const computeBucket = (
    cutoff: number,
    source: LiveResult[] = liveResults
  ): { all: PerformanceBucket; bySpot: Map<number, PerformanceBucket> } => {
    const all = emptyBucket();
    const bySpot = new Map<number, PerformanceBucket>();
    for (const r of source) {
      if (cutoff !== 0 && now - new Date(r.scored_at).getTime() > cutoff) continue;
      all.total++;
      all.pnl += r.pnl;
      if (r.prize > 0) all.wins++;
      if (r.prize > all.best) all.best = r.prize;

      const sb = bySpot.get(r.spot_count) ?? emptyBucket();
      sb.total++;
      sb.pnl += r.pnl;
      if (r.prize > 0) sb.wins++;
      if (r.prize > sb.best) sb.best = r.prize;
      bySpot.set(r.spot_count, sb);
    }
    return { all, bySpot };
  };

  const { all: b24, bySpot: bs24 } = computeBucket(h24, allLiveResults);
  const { all: b7d, bySpot: bs7d } = computeBucket(d7, allLiveResults);
  const { all: bAll, bySpot: bsAll } = computeBucket(0, allLiveResults);

  const m30 = 30 * 24 * 3600 * 1000;
  const { all: b30d, bySpot: bs30d } = computeBucket(m30, allLiveResults);

  const todayKey = new Date().toLocaleDateString('en-CA');
  const dailyMap = new Map<string, PerformanceBucket>();
  for (const r of allLiveResults) {
    const dateKey = new Date(r.scored_at).toLocaleDateString('en-CA');
    const b = dailyMap.get(dateKey) ?? emptyBucket();
    b.total++;
    b.pnl += r.pnl;
    if (r.prize > 0) b.wins++;
    if (r.prize > b.best) b.best = r.prize;
    dailyMap.set(dateKey, b);
  }
  const bToday = dailyMap.get(todayKey) ?? emptyBucket();
  const dailyRows = [...dailyMap.entries()].sort((a, b) => b[0].localeCompare(a[0]));

  const bsTodayMap = new Map<number, PerformanceBucket>();
  for (const r of allLiveResults) {
    if (new Date(r.scored_at).toLocaleDateString('en-CA') !== todayKey) continue;
    const sb = bsTodayMap.get(r.spot_count) ?? emptyBucket();
    sb.total++; sb.pnl += r.pnl;
    if (r.prize > 0) sb.wins++;
    if (r.prize > sb.best) sb.best = r.prize;
    bsTodayMap.set(r.spot_count, sb);
  }

  const filteredBucket = { today: bToday, week: b7d, month: b30d, all: bAll }[timeFilter] ?? bToday;
  const filteredBySpot = { today: bsTodayMap, week: bs7d, month: bs30d, all: bsAll }[timeFilter] ?? bsTodayMap;
  const filterLabel = { today: 'Today', week: 'This Week', month: 'This Month', all: 'All Time' }[timeFilter];

  const lastPoll = events.find(e => e.event_type === 'poll_success' || e.event_type === 'poll_no_new_game');
  const lastSync = events.find(e => e.event_type === 'sync_complete');
  const lastEvo = events.find(e => e.event_type === 'evolution_complete');

  const resultsByGame = new Map<number, LiveResult[]>();
  for (const r of liveResults) {
    const arr = resultsByGame.get(r.game_num) ?? [];
    arr.push(r);
    resultsByGame.set(r.game_num, arr);
  }

  // Biggest win: all-time best from allLiveResults
  const biggestWinResult = allLiveResults.length > 0
    ? allLiveResults.reduce((best, r) => r.prize > best.prize ? r : best, allLiveResults[0])
    : null;

  // Biggest win per day for past 14 days
  const biggestWinByDay: { date: string; prize: number; spotCount: number; matches: number; gameNum: number }[] = [];
  const last14Days = new Map<string, LiveResult>();
  for (const r of allLiveResults) {
    const dateKey = new Date(r.scored_at).toLocaleDateString('en-CA');
    const existing = last14Days.get(dateKey);
    if (!existing || r.prize > existing.prize) {
      last14Days.set(dateKey, r);
    }
  }
  const sortedDays = [...last14Days.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14);
  for (const [date, r] of sortedDays) {
    biggestWinByDay.push({
      date,
      prize: r.prize,
      spotCount: r.spot_count,
      matches: r.matches,
      gameNum: r.game_num,
    });
  }

  // Evolution generation breakdown from allLiveResults using full strategy→generation map
  const genBreakdown = new Map<number, { wins: number; losses: number; pnl: number; total: number }>();
  for (const r of allLiveResults) {
    const gen = stratGenMap.get(r.strategy_id) ?? 0;
    const entry = genBreakdown.get(gen) ?? { wins: 0, losses: 0, pnl: 0, total: 0 };
    entry.total++;
    entry.pnl += r.pnl;
    if (r.prize > 0) entry.wins++;
    else entry.losses++;
    genBreakdown.set(gen, entry);
  }
  const genRows = [...genBreakdown.entries()]
    .filter(([gen]) => gen > 0)
    .sort((a, b) => b[0] - a[0]);

  const SPOT_COLORS = ['#ef4444','#f97316','#eab308','#22c55e','#14b8a6','#3b82f6','#8b5cf6','#ec4899','#94a3b8','#f1f5f9'];

  if (!mounted) return null;

  const arthur = computeArthurFull({
    evoState, champions, bToday, bAll, b24, events, allLiveResults, dailyMap,
  });

  const moodGradient = {
    fire: 'rgba(239,68,68,0.08)',
    good: 'rgba(34,197,94,0.06)',
    steady: 'rgba(139,26,74,0.06)',
    down: 'rgba(239,68,68,0.04)',
    waiting: 'rgba(100,116,139,0.04)',
  }[arthur.mood];

  const moodDotColor = {
    fire: 'bg-red-400',
    good: 'bg-green-400',
    steady: 'bg-green-500/70',
    down: 'bg-amber-400',
    waiting: 'bg-slate-500',
  }[arthur.mood];

  const moodPingColor = {
    fire: 'bg-red-400',
    good: 'bg-green-400',
    steady: 'bg-green-400',
    down: 'bg-amber-400',
    waiting: 'bg-slate-400',
  }[arthur.mood];

  const moodLabel = {
    fire: 'On Fire',
    good: 'Feeling Good',
    steady: 'Locked In',
    down: 'Grinding',
    waiting: 'Standing By',
  }[arthur.mood];

  return (
    <div className="space-y-4 sm:space-y-6">
      <h1 className="text-xl sm:text-2xl font-bold">Live Monitor</h1>

      {/* ── Arthur's Current Thought ── */}
      <div className="relative rounded-xl border border-[#2a2a2e] bg-surface overflow-hidden">
        <div className="absolute inset-0 pointer-events-none"
          style={{ background: `radial-gradient(ellipse 80% 100% at 0% 50%, ${moodGradient} 0%, transparent 60%)` }} />
        <div className="relative flex items-start gap-3 sm:gap-4 px-4 sm:px-5 py-3 sm:py-4">
          <div className="shrink-0 mt-0.5 flex items-center justify-center w-8 h-8 rounded-full bg-crimson/10 border border-crimson/20">
            <span className="text-crimson text-xs font-bold tracking-tight">A</span>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[10px] font-semibold text-crimson/70 uppercase tracking-widest">Arthur</span>
              <span className="relative flex h-1.5 w-1.5">
                <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${moodPingColor} opacity-40`} />
                <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${moodDotColor}`} />
              </span>
              <span className="text-[10px] text-slate-600">{moodLabel}</span>
              {evoState?.current_generation ? (
                <span className="text-[10px] text-slate-700">· Gen {evoState.current_generation}</span>
              ) : null}
            </div>
            <p className="text-sm text-slate-300 leading-relaxed">{arthur.main}</p>
            {arthur.observations.length > 0 && (
              <div className="mt-3 pt-3 border-t border-[#1e1e24] space-y-1.5">
                {arthur.observations.map((obs, i) => (
                  <p key={i} className="text-xs text-slate-500 leading-relaxed flex items-start gap-2">
                    <span className="text-slate-700 mt-0.5 shrink-0">{'>'}</span>
                    {obs}
                  </p>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Time Filter ── */}
      <div className="flex items-center gap-1 sm:gap-2">
        {(['today', 'week', 'month', 'all'] as const).map(f => (
          <button
            key={f}
            onClick={() => setTimeFilter(f)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              timeFilter === f
                ? 'bg-crimson text-white'
                : 'text-slate-400 hover:text-white bg-surface hover:bg-[#1e1e24]'
            }`}
          >
            {{ today: 'Today', week: 'Week', month: 'Month', all: 'All Time' }[f]}
          </button>
        ))}
      </div>

      {/* ── Win/Loss Summary (filtered) ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => setDailyBreakdownOpen(o => !o)}
          className="bg-surface rounded-xl p-4 sm:p-5 border border-[#2a2a2e] text-left hover:border-crimson/40 transition-colors cursor-pointer"
        >
          <div className="text-xs text-slate-400 mb-1 flex items-center justify-between">
            <span>{filterLabel} Win/Loss</span>
            <span className="text-slate-600">{dailyBreakdownOpen ? '▲' : '▼'}</span>
          </div>
          <div className="text-2xl sm:text-3xl font-bold">
            <span className="text-green-400">{filteredBucket.wins}W</span>
            <span className="text-slate-500 mx-1.5">–</span>
            <span className="text-red-400">{filteredBucket.total - filteredBucket.wins}L</span>
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {filteredBucket.total.toLocaleString()} shadow plays ·{' '}
            {filteredBucket.total > 0 ? ((filteredBucket.wins / filteredBucket.total) * 100).toFixed(1) : '0.0'}% win rate
          </div>
        </button>
        <button
          type="button"
          onClick={() => setDailyBreakdownOpen(o => !o)}
          className="bg-surface rounded-xl p-4 sm:p-5 border border-[#2a2a2e] text-left hover:border-crimson/40 transition-colors cursor-pointer"
        >
          <div className="text-xs text-slate-400 mb-1 flex items-center justify-between">
            <span>{filterLabel} P&amp;L</span>
            <span className="text-slate-600">{dailyBreakdownOpen ? '▲' : '▼'}</span>
          </div>
          <div className={`text-2xl sm:text-3xl font-bold ${filteredBucket.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {filteredBucket.pnl >= 0 ? '+' : ''}${filteredBucket.pnl.toFixed(2)}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Net P&amp;L · ${filteredBucket.total > 0 ? (filteredBucket.pnl / filteredBucket.total).toFixed(3) : '0.000'}/game avg
          </div>
        </button>
      </div>

      {/* ── Daily history drill-down ── */}
      {dailyBreakdownOpen && (
        <div className="bg-surface rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-[#2a2a2e] flex items-center justify-between">
            <h2 className="font-semibold text-sm">Daily Win/Loss History</h2>
            <span className="text-xs text-slate-500">{dailyRows.length} days</span>
          </div>
          <div className="overflow-x-auto max-h-96">
            {dailyRows.length === 0 ? (
              <p className="px-4 py-6 text-slate-500 text-sm">No scored shadow plays yet.</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-surface z-10">
                  <tr className="text-slate-500 border-b border-[#2a2a2e]">
                    <th className="px-3 py-2 text-left">Date</th>
                    <th className="px-3 py-2 text-left">W–L</th>
                    <th className="px-3 py-2 text-right">Win %</th>
                    <th className="px-3 py-2 text-right">P&amp;L</th>
                    <th className="px-3 py-2 text-right hidden sm:table-cell">P&amp;L/g</th>
                    <th className="px-3 py-2 text-right hidden sm:table-cell">Best</th>
                  </tr>
                </thead>
                <tbody>
                  {dailyRows.map(([date, b]) => (
                    <tr key={date} className={`border-b border-[#1e1e24] hover:bg-[#1e1e24] ${date === todayKey ? 'bg-[#16161a]' : ''}`}>
                      <td className="px-3 py-2 font-mono text-slate-300 whitespace-nowrap">
                        {date}
                        {date === todayKey && <span className="ml-1 text-crimson text-[9px] font-semibold">TODAY</span>}
                      </td>
                      <td className="px-3 py-2">
                        <span className="text-green-400">{b.wins}W</span>
                        <span className="text-slate-500 mx-0.5">–</span>
                        <span className="text-red-400">{b.total - b.wins}L</span>
                      </td>
                      <td className="px-3 py-2 text-right">{b.total > 0 ? `${((b.wins / b.total) * 100).toFixed(1)}%` : '—'}</td>
                      <td className={`px-3 py-2 text-right font-mono ${b.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {b.pnl >= 0 ? '+' : ''}${b.pnl.toFixed(2)}
                      </td>
                      <td className={`px-3 py-2 text-right font-mono hidden sm:table-cell ${b.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        ${b.total > 0 ? (b.pnl / b.total).toFixed(3) : '0.000'}
                      </td>
                      <td className="px-3 py-2 text-right hidden sm:table-cell">${b.best}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ── Database + Evolution ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <StatCard
          label="Database"
          value={`${totalGames.toLocaleString()} games`}
          sub={latestGameTs ? `Latest: ${fmtDate(latestGameTs)}` : undefined}
          ok={minutesAgo(latestGameTs) < 10}
        />
        <StatCard
          label="Evolution"
          value={evoState?.current_generation ? `Gen ${evoState.current_generation}` : 'Not started'}
          sub={evoState?.last_run_at ? `Last: ${fmtDate(evoState.last_run_at)}` : undefined}
          ok={!lastEvo || lastEvo.severity !== 'error'}
          onClick={() => setEvoDetailOpen(o => !o)}
        />
      </div>

      {/* ── Evolution Generation Breakdown ── */}
      {evoDetailOpen && (
        <div className="bg-surface rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-[#2a2a2e] flex items-center justify-between">
            <h2 className="font-semibold text-sm">Performance by Generation</h2>
            <span className="text-xs text-slate-500">{genRows.length} gens</span>
          </div>
          {genRows.length === 0 ? (
            <p className="px-4 py-6 text-slate-500 text-sm">No scored shadow plays yet.</p>
          ) : (
            <div className="overflow-x-auto max-h-72">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-surface z-10">
                  <tr className="text-slate-500 border-b border-[#2a2a2e]">
                    <th className="px-3 py-2 text-left">Gen</th>
                    <th className="px-3 py-2 text-left">W–L</th>
                    <th className="px-3 py-2 text-right">Win %</th>
                    <th className="px-3 py-2 text-right">P&amp;L</th>
                    <th className="px-3 py-2 text-right">P&amp;L/g</th>
                  </tr>
                </thead>
                <tbody>
                  {genRows.map(([gen, b]) => (
                    <tr key={gen} className="border-b border-[#1e1e24] hover:bg-[#1e1e24]">
                      <td className="px-3 py-2 font-mono text-slate-300">
                        {gen}{gen === evoState?.current_generation && <span className="ml-1 text-crimson text-[9px]">NOW</span>}
                      </td>
                      <td className="px-3 py-2">
                        <span className="text-green-400">{b.wins}W</span>
                        <span className="text-slate-500 mx-0.5">–</span>
                        <span className="text-red-400">{b.losses}L</span>
                      </td>
                      <td className="px-3 py-2 text-right">{b.total > 0 ? `${((b.wins / b.total) * 100).toFixed(1)}%` : '—'}</td>
                      <td className={`px-3 py-2 text-right font-mono ${b.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {b.pnl >= 0 ? '+' : ''}${b.pnl.toFixed(2)}
                      </td>
                      <td className={`px-3 py-2 text-right font-mono ${b.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        ${b.total > 0 ? (b.pnl / b.total).toFixed(3) : '0.000'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Biggest Win ── */}
      <StatCard
        label="Biggest Win"
        value={biggestWinResult ? `$${biggestWinResult.prize}` : '—'}
        sub={biggestWinResult ? `${biggestWinResult.spot_count}-spot · ${biggestWinResult.matches}/${biggestWinResult.spot_count} · ${new Date(biggestWinResult.scored_at).toLocaleDateString()}` : 'No wins yet'}
        onClick={() => setBiggestWinOpen(o => !o)}
      />

      {/* ── Biggest Win 14-Day History ── */}
      {biggestWinOpen && (
        <div className="bg-surface rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-[#2a2a2e] flex items-center justify-between">
            <h2 className="font-semibold text-sm">Biggest Win by Day (Last 14 Days)</h2>
            <span className="text-xs text-slate-500">{biggestWinByDay.length} days</span>
          </div>
          {biggestWinByDay.length === 0 ? (
            <p className="px-4 py-6 text-slate-500 text-sm">No wins recorded yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-slate-500 border-b border-[#2a2a2e]">
                    <th className="px-3 py-2 text-left">Date</th>
                    <th className="px-3 py-2 text-right">Prize</th>
                    <th className="px-3 py-2 text-center">Spot</th>
                    <th className="px-3 py-2 text-center hidden sm:table-cell">Matches</th>
                    <th className="px-3 py-2 text-right hidden sm:table-cell">Game #</th>
                  </tr>
                </thead>
                <tbody>
                  {biggestWinByDay.map(row => (
                    <tr key={row.date} className={`border-b border-[#1e1e24] hover:bg-[#1e1e24] ${row.date === todayKey ? 'bg-[#16161a]' : ''}`}>
                      <td className="px-3 py-2 font-mono text-slate-300 whitespace-nowrap">
                        {row.date}{row.date === todayKey && <span className="ml-1 text-crimson text-[9px]">TODAY</span>}
                      </td>
                      <td className={`px-3 py-2 text-right font-bold ${row.prize > 0 ? 'text-green-400' : 'text-slate-500'}`}>
                        {row.prize > 0 ? `$${row.prize}` : '—'}
                      </td>
                      <td className="px-3 py-2 text-center text-slate-400">{row.prize > 0 ? `${row.spotCount}-sp` : '—'}</td>
                      <td className="px-3 py-2 text-center text-slate-400 hidden sm:table-cell">{row.prize > 0 ? `${row.matches}/${row.spotCount}` : '—'}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-500 hidden sm:table-cell">#{row.gameNum}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Live Game Feed ── */}
      <div className="bg-surface rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-[#2a2a2e] flex items-center justify-between">
          <h2 className="font-semibold text-sm">Live Game & Prediction Feed</h2>
          {(() => {
            const gamesWithPredictions = new Set(liveResults.map(r => r.game_num));
            const covered = recentGames.filter(g => gamesWithPredictions.has(g.game_num)).length;
            const total = recentGames.length;
            const pct = total > 0 ? Math.round(covered / total * 100) : 0;
            return (
              <span className="text-xs text-slate-500">
                Arthur covered{' '}
                <span className={pct === 100 ? 'text-green-400' : pct >= 75 ? 'text-amber-400' : 'text-red-400'}>
                  {covered}/{total}
                </span>{' '}
                recent games
              </span>
            );
          })()}
        </div>
        <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
          {recentGames.length === 0 ? (
            <p className="px-4 py-6 text-slate-500 text-sm">No games yet.</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-surface z-10">
                <tr className="text-slate-500 border-b border-[#2a2a2e]">
                  <th className="px-3 py-2 text-left">Game</th>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Numbers Drawn</th>
                  <th className="px-3 py-2 text-center" colSpan={10}>Spot predictions (matches · P&L)</th>
                </tr>
                <tr className="text-slate-600 border-b border-[#2a2a2e]">
                  <th colSpan={3} />
                  {[1,2,3,4,5,6,7,8,9,10].map(s => (
                    <th key={s} className="px-1 py-1 text-center">{s}sp</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recentGames.slice(0, 10).map(game => {
                  const gameResults = resultsByGame.get(game.game_num) ?? [];
                  const bySpot = new Map(gameResults.map(r => [r.spot_count, r]));
                  return (
                    <tr key={game.game_num} className="border-b border-[#1e1e24] hover:bg-[#1e1e24]">
                      <td className="px-3 py-2 font-mono text-slate-400">#{game.game_num}</td>
                      <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{game.draw_date}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-0.5">
                          {[...game.hits].sort((a, b) => a - b).map(n => (
                            <span key={n}
                              className="w-5 h-5 rounded-full bg-[#2a2a2e] text-slate-300 flex items-center justify-center text-[10px] font-bold">
                              {n}
                            </span>
                          ))}
                        </div>
                        {(game.bonus || game.super_bonus) && (
                          <div className="flex gap-2 mt-1">
                            {game.bonus && (
                              <span className="text-[9px] text-amber-400 font-semibold">B:{game.bonus}</span>
                            )}
                            {game.super_bonus && (
                              <span className="text-[9px] text-purple-400 font-semibold">SB:{game.super_bonus}</span>
                            )}
                          </div>
                        )}
                      </td>
                      {[1,2,3,4,5,6,7,8,9,10].map(s => {
                        const r = bySpot.get(s);
                        if (!r) return <td key={s} className="px-1 py-2 text-center text-slate-700">—</td>;
                        const color = r.pnl > 0 ? 'text-green-400' : r.pnl === 0 ? 'text-slate-400' : 'text-red-400';
                        const bonusBadge = r.bonus_type === 'bonus'
                          ? <span className="text-[8px] text-amber-400 font-semibold">B×{r.bonus_multiplier}</span>
                          : r.bonus_type === 'super_bonus'
                          ? <span className="text-[8px] text-purple-400 font-semibold">SB×{r.bonus_multiplier}</span>
                          : null;
                        const cellKey = `${game.game_num}-${s}`;
                        const isExpanded = expandedPick === cellKey;
                        return (
                          <td
                            key={s}
                            className={`px-1 py-2 text-center cursor-pointer hover:bg-[#2a2a2e] transition-colors relative ${color}`}
                            onClick={() => setExpandedPick(isExpanded ? null : cellKey)}
                          >
                            {r.matches}/{s}<br />
                            <span className="text-[10px]">
                              {r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(0)}
                            </span>
                            {bonusBadge && <><br />{bonusBadge}</>}
                            {isExpanded && (
                              <div className="absolute z-20 left-1/2 -translate-x-1/2 top-full mt-1 bg-[#16161a] border border-[#333] rounded-lg p-2 shadow-xl min-w-[120px]">
                                <div className="text-[9px] text-slate-500 mb-1">Picks</div>
                                <div className="flex flex-wrap gap-0.5 justify-center">
                                  {[...r.picks].sort((a, b) => a - b).map(n => (
                                    <span
                                      key={n}
                                      className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold ${
                                        r.actual_hits.includes(n)
                                          ? 'bg-crimson text-white'
                                          : 'bg-[#2a2a2e] text-slate-400'
                                      }`}
                                    >
                                      {n}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ── Evolution Pulse ── */}
      <div className="bg-surface rounded-xl p-4">
        <h2 className="font-semibold text-sm mb-4">Evolution Pulse</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <div className="text-xs text-slate-500 mb-2">Current Champions</div>
            <div className="grid grid-cols-5 gap-2">
              {[1,2,3,4,5,6,7,8,9,10].map(s => {
                const champ = champions.find(c => c.spot_count === s);
                return (
                  <div key={s} className="bg-[#0e0e10] rounded-lg p-2 text-center">
                    <div className="text-xs text-slate-500">{s}-sp</div>
                    {champ ? (
                      <>
                        <div className="text-xs font-mono text-crimson">
                          #{champ.id}
                        </div>
                        <div className="text-[10px] text-slate-400">
                          G{champ.generation}
                        </div>
                        <div className="text-[10px] text-green-400">
                          {champ.fitness_score !== null ? champ.fitness_score.toFixed(3) : '—'}
                        </div>
                      </>
                    ) : (
                      <div className="text-xs text-slate-600 mt-1">—</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <div className="text-xs text-slate-500 mb-2">Best Fitness by Generation (last 48)</div>
            {fitnessByGen.length > 1 ? (
              <ResponsiveContainer width="100%" height={140}>
                <LineChart data={fitnessByGen} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                  <XAxis dataKey="generation" tick={{ fontSize: 9 }} />
                  <YAxis tick={{ fontSize: 9 }} />
                  <Tooltip
                    contentStyle={{ background: '#16161a', border: '1px solid #333', fontSize: 11 }}
                    formatter={(v: number) => v.toFixed(4)}
                  />
                  {[1,2,3,4,5,6,7,8,9,10].map((s, i) => (
                    <Line
                      key={s}
                      dataKey={`s${s}`}
                      dot={false}
                      strokeWidth={1.5}
                      stroke={SPOT_COLORS[i]}
                      name={`${s}-sp`}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-36 flex items-center justify-center text-slate-600 text-sm">
                Run evolution first to see fitness trends
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Rolling Performance (collapsed) ── */}
      <div className="bg-surface rounded-xl overflow-hidden">
        <button
          onClick={() => setRollingPerfOpen(o => !o)}
          className="w-full px-4 py-3 flex items-center justify-between hover:bg-[#1e1e24] transition-colors"
        >
          <div className="flex items-center gap-3">
            <h2 className="font-semibold text-sm">{filterLabel} Performance</h2>
            <span className="text-xs text-slate-500">
              {filteredBucket.total} plays · {filteredBucket.total > 0 ? ((filteredBucket.wins / filteredBucket.total) * 100).toFixed(1) : '0'}% wins ·{' '}
              <span className={filteredBucket.pnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                {filteredBucket.pnl >= 0 ? '+' : ''}${filteredBucket.pnl.toFixed(2)}
              </span>
            </span>
          </div>
          <span className="text-slate-600 text-xs">{rollingPerfOpen ? '▲' : '▼'}</span>
        </button>
        {rollingPerfOpen && (
          <div className="px-4 pb-4 border-t border-[#2a2a2e] pt-3">
            <PerfCol label={filterLabel} bucket={filteredBucket} bySpot={filteredBySpot} />
          </div>
        )}
      </div>

      {/* ── Cron Health (compact) ── */}
      {(() => {
        const pollOk = minutesAgo(lastPoll?.occurred_at) < 6;
        const syncOk = minutesAgo(lastSync?.occurred_at) < 65;
        const allOk = pollOk && syncOk;
        return (
          <div className="bg-surface rounded-xl overflow-hidden">
            <button
              onClick={() => setCronHealthOpen(o => !o)}
              className="w-full px-4 py-3 flex items-center justify-between hover:bg-[#1e1e24] transition-colors"
            >
              <div className="flex items-center gap-2">
                <span className={`inline-block w-2.5 h-2.5 rounded-full ${allOk ? 'bg-green-400' : 'bg-amber-400'}`} />
                <h2 className="font-semibold text-sm">System Health</h2>
                <span className="text-xs text-slate-500">{allOk ? 'All systems go' : 'Attention needed'}</span>
              </div>
              <span className="text-slate-600 text-xs">{cronHealthOpen ? '▲' : '▼'}</span>
            </button>
            {cronHealthOpen && (
              <div className="px-4 pb-4 border-t border-[#2a2a2e] pt-3 space-y-2">
                <div className="flex items-center gap-2 text-xs">
                  <Dot ok={pollOk} />
                  <span className="text-slate-400">Poll (every 4 min)</span>
                  <span className="ml-auto text-slate-500 font-mono">
                    {lastPoll ? `${minutesAgo(lastPoll.occurred_at).toFixed(0)}m ago` : 'never'}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <Dot ok={syncOk} />
                  <span className="text-slate-400">Sync (hourly)</span>
                  <span className="ml-auto text-slate-500 font-mono">
                    {lastSync ? `${minutesAgo(lastSync.occurred_at).toFixed(0)}m ago` : 'never'}
                  </span>
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Activity Log (collapsed) ── */}
      <div className="bg-surface rounded-xl overflow-hidden">
        <button
          onClick={() => setActivityLogOpen(o => !o)}
          className="w-full px-4 py-3 border-b border-[#2a2a2e] flex items-center justify-between hover:bg-[#1e1e24] transition-colors"
        >
          <h2 className="font-semibold text-sm">Activity Log</h2>
          <span className="text-xs text-slate-500">{events.length} events {activityLogOpen ? '▲' : '▼'}</span>
        </button>
        {activityLogOpen && (
          <div className="divide-y divide-[#1e1e24] max-h-96 overflow-y-auto">
            {events.slice(0, eventsPage * 50).map(evt => (
              <div key={evt.id}>
                <button
                  className="w-full text-left px-4 py-2 hover:bg-[#1e1e24] flex items-start gap-2"
                  onClick={() => setExpandedEvent(expandedEvent === evt.id ? null : evt.id)}
                >
                  <span className="shrink-0 mt-0.5">{EVENT_ICONS[evt.severity] ?? '⚪'}</span>
                  <span className="text-[10px] text-slate-500 shrink-0 mt-0.5 font-mono">
                    {fmt(evt.occurred_at)}
                  </span>
                  <span className="text-xs text-slate-300 text-left">{evt.message}</span>
                </button>
                {expandedEvent === evt.id && evt.metadata && (
                  <div className="px-10 pb-2">
                    <pre className="text-[10px] text-slate-500 bg-[#0e0e10] rounded p-2 overflow-x-auto">
                      {JSON.stringify(evt.metadata, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            ))}
            {eventsPage * 50 < events.length && (
              <button
                className="w-full py-2 text-xs text-slate-500 hover:text-white"
                onClick={() => setEventsPage(p => p + 1)}
              >
                Load more
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
