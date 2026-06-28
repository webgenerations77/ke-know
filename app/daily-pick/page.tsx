'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useToast } from '@/components/Toast';
import { supabase } from '@/lib/supabase';

interface DailyPick {
  id: number;
  generated_at: string;
  pick_date: string;
  strategy_id: number | null;
  spot_count: number;
  picks: number[];
  bonus_type: 'none' | 'bonus' | 'super_bonus';
  wager_per_game: number;
  recommended_games: number;
  best_hour: number | null;
  expected_pnl_per_game: number | null;
  expected_total_pnl: number | null;
  fitness_score: number | null;
  games_played: number;
  status: 'pending' | 'playing' | 'complete';
  reasoning: {
    shadow_plays?: number;
    win_rate?: number;
    max_losing_streak?: number;
    champion_id?: number;
  } | null;
}

interface PickPerformance {
  pick_date: string;
  spot_count: number;
  picks: number[];
  bonus_type: string;
  wager_per_game: number;
  games_played: number;
  recommended_games: number;
  games_scored: number;
  wins: number;
  total_pnl: number;
  total_wagered: number;
  best_win: number;
}

function fmtHour(h: number): string {
  const suffix = h >= 12 ? 'PM' : 'AM';
  const display = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${display}:00 ${suffix}`;
}

function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec.toString().padStart(2, '0')}s`;
  return `${sec}s`;
}

function windowStatus(bestHour: number | null, now: Date) {
  if (bestHour === null) return { state: 'unknown' as const, label: '' };
  const start = new Date(now);
  start.setHours(bestHour, 0, 0, 0);
  const end = new Date(now);
  end.setHours(bestHour + 1, 0, 0, 0);

  if (now < start) {
    return { state: 'before' as const, label: `Opens in ${fmtCountdown(start.getTime() - now.getTime())}` };
  }
  if (now < end) {
    return { state: 'active' as const, label: `Play now · Closes in ${fmtCountdown(end.getTime() - now.getTime())}` };
  }
  return { state: 'past' as const, label: "Today's window has passed" };
}

export default function DailyPickPage() {
  const { toast } = useToast();
  const [pick, setPick] = useState<DailyPick | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [history, setHistory] = useState<PickPerformance[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  async function loadPick() {
    setLoading(true);
    try {
      const res = await fetch('/api/daily-pick');
      const data = await res.json();
      setPick(data.ok && data.pick ? data.pick : null);
    } catch {
      setPick(null);
    } finally {
      setLoading(false);
    }
  }

  async function loadHistory() {
    const { data: pastPicks } = await supabase
      .from('daily_picks')
      .select('pick_date, spot_count, picks, bonus_type, strategy_id, wager_per_game, games_played, recommended_games')
      .order('pick_date', { ascending: false })
      .limit(30);

    if (!pastPicks || pastPicks.length === 0) return;

    // W-L/P&L come exclusively from the daily pick's own scored window plays —
    // keyed by pick_date, never the champion's continuous live_results stream.
    const dates = pastPicks.map(p => p.pick_date);
    const { data: playData } = await supabase
      .from('daily_pick_plays')
      .select('pick_date, prize, pnl')
      .in('pick_date', dates as string[])
      .eq('scored', true)
      .limit(10000);

    const perf: PickPerformance[] = pastPicks.map(dp => {
      const dayResults = (playData ?? []).filter(r => r.pick_date === dp.pick_date);

      const wagerPerGame = (dp.wager_per_game as number) ?? 1;
      const gamesScored = dayResults.length;

      return {
        pick_date: dp.pick_date,
        spot_count: dp.spot_count,
        picks: dp.picks as number[],
        bonus_type: dp.bonus_type as string,
        wager_per_game: wagerPerGame,
        games_played: (dp.games_played as number) ?? 0,
        recommended_games: (dp.recommended_games as number) ?? 20,
        games_scored: gamesScored,
        wins: dayResults.filter(r => (r.prize as number) > 0).length,
        total_pnl: dayResults.reduce((s, r) => s + (r.pnl as number), 0),
        total_wagered: gamesScored * wagerPerGame,
        best_win: gamesScored > 0 ? Math.max(...dayResults.map(r => r.prize as number)) : 0,
      };
    });

    setHistory(perf);
  }

  useEffect(() => { loadPick(); loadHistory(); }, []);

  async function handleGenerate() {
    setGenerating(true);
    try {
      const res = await fetch('/api/daily-pick', { method: 'POST' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? 'Generation failed');
      toast("Today's pick generated!", 'success');
      await loadPick();
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setGenerating(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-2xl space-y-5">
        <div className="h-8 bg-surface rounded-lg w-56 animate-pulse" />
        <div className="bg-surface rounded-xl h-56 animate-pulse" />
        <div className="bg-surface rounded-xl h-28 animate-pulse" />
        <div className="bg-surface rounded-xl h-20 animate-pulse" />
      </div>
    );
  }

  if (!pick) {
    return (
      <div className="max-w-2xl space-y-6">
        <h1 className="text-2xl font-bold">Arthur's Daily Pick</h1>
        <div className="bg-surface rounded-xl p-10 flex flex-col items-center gap-5 text-center border border-crimson/20">
          <div className="w-16 h-16 rounded-full bg-crimson/10 border border-crimson/30 flex items-center justify-center">
            <span className="text-2xl font-bold text-crimson">A</span>
          </div>
          <div>
            <p className="font-semibold text-slate-200 mb-1.5">No pick generated yet for today</p>
            <p className="text-sm text-slate-500 max-w-sm">
              Arthur analyzes all champion strategies and composes the single strongest play for the day.
              Updated automatically at 6:00 AM.
            </p>
          </div>
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="px-8 py-3 rounded-lg bg-crimson hover:bg-crimson-hover disabled:opacity-50 text-white text-sm font-medium tracking-wide transition-colors"
          >
            {generating ? 'Generating…' : "Generate Today's Pick"}
          </button>
        </div>
      </div>
    );
  }

  const bonusLabel = pick.bonus_type === 'super_bonus' ? 'Super Bonus' : pick.bonus_type === 'bonus' ? 'Bonus' : 'Base Play';
  const bonusStyle =
    pick.bonus_type === 'super_bonus'
      ? 'text-purple-300 bg-purple-900/30 border-purple-500/40'
      : pick.bonus_type === 'bonus'
      ? 'text-amber-300 bg-amber-900/30 border-amber-500/40'
      : 'text-slate-400 bg-[#1e1e24] border-[#333]';

  const bonusMultiplier = pick.bonus_type === 'super_bonus' ? 3 : pick.bonus_type === 'bonus' ? 2 : 1;
  const baseWager = bonusMultiplier > 1 ? Math.round(pick.wager_per_game / bonusMultiplier) : pick.wager_per_game;
  const totalWager = pick.wager_per_game * pick.recommended_games;
  const gamesPlayed = pick.games_played ?? 0;
  const playProgress = Math.min(100, (gamesPlayed / pick.recommended_games) * 100);
  const playStatus = pick.status ?? 'pending';
  const win = windowStatus(pick.best_hour, now);
  const ppg = pick.expected_pnl_per_game ?? 0;
  const total = pick.expected_total_pnl ?? 0;

  const windowStyle =
    win.state === 'active'
      ? 'border-green-500/30 bg-green-900/10'
      : win.state === 'before'
      ? 'border-amber-500/30 bg-amber-900/10'
      : 'border-[#2a2a2e] bg-surface';

  const windowLabelStyle =
    win.state === 'active' ? 'text-green-400' : win.state === 'before' ? 'text-amber-400' : 'text-slate-500';

  const pickDate = new Date(pick.pick_date + 'T12:00:00');

  return (
    <div className="max-w-2xl space-y-5">

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Arthur's Daily Pick</h1>
          <p className="text-sm text-slate-500 mt-1">
            {pickDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
            {' · '}Generated {new Date(pick.generated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </p>
        </div>
        <button
          onClick={handleGenerate}
          disabled={generating}
          className="flex-shrink-0 px-4 py-2 rounded-lg bg-[#1e1e24] border border-[#333] hover:border-crimson/50 text-sm text-slate-300 disabled:opacity-50 transition-colors"
        >
          {generating ? 'Refreshing…' : '↻ Refresh'}
        </button>
      </div>

      {/* Main pick card */}
      <div className="bg-surface rounded-xl p-6 space-y-5 border border-crimson/25">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] text-slate-600 uppercase tracking-[0.3em] mb-1">Today's Play</p>
            <p className="text-4xl font-bold">{pick.spot_count}-Spot</p>
          </div>
          <span className={`px-3 py-1.5 rounded-lg text-xs font-semibold border ${bonusStyle}`}>
            {bonusLabel}
          </span>
        </div>

        <div>
          <p className="text-[10px] text-slate-600 uppercase tracking-[0.3em] mb-3">Pick These Numbers</p>
          <div className="flex flex-wrap gap-2.5">
            {[...pick.picks].sort((a, b) => a - b).map(n => (
              <div
                key={n}
                className="w-11 h-11 rounded-full bg-crimson border border-crimson/80 flex items-center justify-center text-sm font-bold text-white"
              >
                {n}
              </div>
            ))}
          </div>
        </div>

        {pick.fitness_score !== null && (
          <p className="text-[10px] text-slate-700">
            Arthur's best champion · Fitness {pick.fitness_score.toFixed(4)}
          </p>
        )}
      </div>

      {/* Session plan */}
      <div className="bg-surface rounded-xl p-4 sm:p-5 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
          <div className="flex sm:block items-center justify-between">
            <p className="text-xs text-slate-500 sm:mb-1">Base Wager</p>
            <p className="text-xl sm:text-2xl font-bold">${baseWager.toFixed(2)}</p>
          </div>
          <div className="flex sm:block items-center justify-between">
            <p className="text-xs text-slate-500 sm:mb-1">
              {pick.bonus_type === 'none' ? 'Wager / Game' : `With ${bonusLabel}`}
            </p>
            <p className="text-xl sm:text-2xl font-bold">
              ${Number(pick.wager_per_game).toFixed(2)}
              {pick.bonus_type !== 'none' && (
                <span className="text-sm text-slate-500 font-normal ml-1">
                  ({pick.bonus_type === 'super_bonus' ? '3' : '2'}× base)
                </span>
              )}
            </p>
          </div>
          <div className="flex sm:block items-center justify-between">
            <p className="text-xs text-slate-500 sm:mb-1">Games to Play</p>
            <p className="text-xl sm:text-2xl font-bold">{pick.recommended_games}</p>
          </div>
          <div className="flex sm:block items-center justify-between">
            <p className="text-xs text-slate-500 sm:mb-1">Total Investment</p>
            <p className="text-xl sm:text-2xl font-bold">${totalWager.toFixed(2)}</p>
          </div>
        </div>

        {/* Arthur's play progress */}
        <div className="border-t border-[#1e1e24] pt-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-slate-500">Arthur's Shadow Play</p>
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
              playStatus === 'complete' ? 'bg-green-900/30 text-green-400 border border-green-500/30' :
              playStatus === 'playing' ? 'bg-amber-900/30 text-amber-400 border border-amber-500/30' :
              win.state === 'past' ? 'bg-[#1e1e24] text-slate-600 border border-[#333]' :
              'bg-[#1e1e24] text-slate-500 border border-[#333]'
            }`}>
              {playStatus === 'complete' ? 'Complete' :
               playStatus === 'playing' ? 'Playing Now' :
               win.state === 'past' ? 'Window Passed — Not Played' :
               'Waiting for Window'}
            </span>
          </div>
          {win.state === 'before' && playStatus === 'pending' ? (
            <div className="rounded-lg bg-[#0e0e10] border border-[#1e1e24] px-4 py-3">
              <p className="text-sm text-slate-400">
                Arthur will start playing at <span className="text-white font-semibold">{pick.best_hour != null ? fmtHour(pick.best_hour) : '—'}</span> ET
              </p>
              <p className="text-[10px] text-slate-600 mt-1">
                No games have been played yet. Arthur only plays these numbers during his suggested window.
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <div className="flex-1 bg-[#1e1e24] rounded-full h-2.5 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      playStatus === 'complete' ? 'bg-green-500' : 'bg-crimson'
                    }`}
                    style={{ width: `${playProgress}%` }}
                  />
                </div>
                <span className="text-sm font-mono text-slate-300 shrink-0">
                  {gamesPlayed}/{pick.recommended_games}
                </span>
              </div>
              <p className="text-[10px] text-slate-600 mt-1.5">
                {playStatus === 'complete'
                  ? `Arthur played ${gamesPlayed} games during the ${pick.best_hour != null ? `${fmtHour(pick.best_hour)}–${fmtHour(pick.best_hour + 1)}` : ''} window.`
                  : `Arthur plays these picks only during the ${pick.best_hour != null ? `${fmtHour(pick.best_hour)}–${fmtHour(pick.best_hour + 1)}` : 'recommended'} window.`
                }
              </p>
            </>
          )}
        </div>
      </div>

      {/* Best play window */}
      {pick.best_hour !== null && (
        <div className={`rounded-xl p-4 sm:p-5 flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-5 border ${windowStyle}`}>
          <div className="flex-1 w-full sm:w-auto">
            <p className="text-[10px] text-slate-500 uppercase tracking-[0.2em] mb-1">Best Play Window</p>
            <p className="text-2xl sm:text-xl font-bold">
              {fmtHour(pick.best_hour)} – {fmtHour(pick.best_hour + 1)}
            </p>
            <p className="text-xs text-slate-600 mt-1">Eastern Time</p>
          </div>
          <div className="sm:text-right w-full sm:w-auto">
            {win.state === 'active' && (
              <div className="flex items-center gap-2 sm:justify-end mb-1">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-40" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
                </span>
                <span className="text-sm sm:text-xs text-green-400 font-semibold uppercase tracking-wide">Live Window</span>
              </div>
            )}
            <p className={`text-base sm:text-sm font-semibold ${windowLabelStyle}`}>{win.label}</p>
          </div>
        </div>
      )}

      {/* Performance History (moved above Expected Outcome) */}
      {history.length > 0 && (() => {
        const scored = history.filter(h => h.games_scored > 0);
        const totalGames = scored.reduce((s, h) => s + h.games_scored, 0);
        const totalWins = scored.reduce((s, h) => s + h.wins, 0);
        const totalPnl = scored.reduce((s, h) => s + h.total_pnl, 0);
        const totalWageredAll = scored.reduce((s, h) => s + h.total_wagered, 0);
        const winningDays = scored.filter(h => h.total_pnl > 0).length;
        const winRate = totalGames > 0 ? ((totalWins / totalGames) * 100).toFixed(1) : '0.0';
        const ppg = totalGames > 0 ? (totalPnl / totalGames) : 0;
        return (
          <div className="bg-surface rounded-xl overflow-hidden border border-[#2a2a2e]">
            <button
              type="button"
              onClick={() => setHistoryOpen(o => !o)}
              className="w-full px-5 py-4 flex items-center justify-between text-left hover:bg-[#1e1e24] transition-colors"
            >
              <div>
                <p className="text-[10px] text-slate-500 uppercase tracking-[0.2em] mb-1">Daily Pick Play Record</p>
                <div className="flex items-center gap-4">
                  <span className="text-lg font-bold">
                    <span className="text-green-400">{totalWins}W</span>
                    <span className="text-slate-500 mx-1">–</span>
                    <span className="text-red-400">{totalGames - totalWins}L</span>
                  </span>
                  <span className={`text-sm font-bold ${totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
                  </span>
                  <span className="text-xs text-slate-500">
                    {scored.length} days · {winningDays} profitable
                  </span>
                </div>
                <div className="flex gap-4 mt-1.5 text-[10px] text-slate-600">
                  <span>{winRate}% win rate</span>
                  <span>{ppg >= 0 ? '+' : ''}${ppg.toFixed(3)}/game avg</span>
                  <span>${totalWageredAll.toFixed(2)} total wagered</span>
                  <span>{totalGames} games played</span>
                </div>
              </div>
              <span className="text-slate-600">{historyOpen ? '▲' : '▼'}</span>
            </button>

            {historyOpen && (
              <div className="border-t border-[#2a2a2e]">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-slate-500 border-b border-[#2a2a2e]">
                      <th className="px-3 py-2 text-left">Date</th>
                      <th className="px-3 py-2 text-left">Play</th>
                      <th className="px-3 py-2 text-left hidden sm:table-cell">Numbers</th>
                      <th className="px-3 py-2 text-center hidden sm:table-cell">Wager</th>
                      <th className="px-3 py-2 text-center">Games</th>
                      <th className="px-3 py-2 text-left">W–L</th>
                      <th className="px-3 py-2 text-right">P&L</th>
                      <th className="px-3 py-2 text-right hidden sm:table-cell">Best</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map(h => {
                      const baseW = 1;
                      const bonusLbl = h.bonus_type === 'super_bonus' ? 'SB' : h.bonus_type === 'bonus' ? 'B' : '';
                      return (
                        <tr key={h.pick_date} className="border-b border-[#1e1e24] hover:bg-[#1e1e24]">
                          <td className="px-3 py-2 font-mono text-slate-300 whitespace-nowrap">{h.pick_date}</td>
                          <td className="px-3 py-2 text-slate-400">
                            {h.spot_count}-sp
                            {bonusLbl && <span className={`ml-1 text-[9px] font-semibold ${h.bonus_type === 'super_bonus' ? 'text-purple-400' : 'text-amber-400'}`}>{bonusLbl}</span>}
                          </td>
                          <td className="px-3 py-2 hidden sm:table-cell">
                            <div className="flex flex-wrap gap-0.5">
                              {h.picks.slice(0, h.spot_count).sort((a, b) => a - b).map(n => (
                                <span key={n} className="w-5 h-5 rounded-full bg-crimson/50 border border-crimson/70 text-white text-[9px] font-bold flex items-center justify-center">
                                  {n}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-center hidden sm:table-cell text-slate-400">
                            <span className="text-slate-500">${baseW}</span>
                            {h.wager_per_game > baseW && <span className="text-slate-300">→${h.wager_per_game}</span>}
                          </td>
                          <td className="px-3 py-2 text-center text-slate-400">
                            {h.games_played}/{h.recommended_games}
                          </td>
                          <td className="px-3 py-2">
                            {h.games_scored > 0 ? (
                              <>
                                <span className="text-green-400">{h.wins}W</span>
                                <span className="text-slate-500 mx-0.5">–</span>
                                <span className="text-red-400">{h.games_scored - h.wins}L</span>
                              </>
                            ) : (
                              <span className="text-slate-600">—</span>
                            )}
                          </td>
                          <td className={`px-3 py-2 text-right font-mono ${h.total_pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {h.games_scored > 0 ? `${h.total_pnl >= 0 ? '+' : ''}$${h.total_pnl.toFixed(2)}` : '—'}
                          </td>
                          <td className="px-3 py-2 text-right hidden sm:table-cell">
                            {h.best_win > 0 ? `$${h.best_win}` : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })()}

      {/* Expected outcome */}
      <div className="bg-surface rounded-xl p-5 space-y-4">
        <p className="text-[10px] text-slate-500 uppercase tracking-[0.2em]">Backtested Long-Run Average</p>

        {pick.reasoning?.win_rate != null && (
          <div className="rounded-lg bg-[#0e0e10] px-4 py-3 border border-[#1e1e24]">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-slate-400">Win Rate</span>
              <span className="text-lg font-bold text-white">{((pick.reasoning.win_rate) * 100).toFixed(1)}%</span>
            </div>
            <div className="w-full bg-[#1e1e24] rounded-full h-2 overflow-hidden">
              <div
                className="bg-crimson h-full rounded-full"
                style={{ width: `${Math.min(100, pick.reasoning.win_rate * 100)}%` }}
              />
            </div>
            <p className="text-[10px] text-slate-600 mt-1.5">
              Roughly {Math.round(1 / pick.reasoning.win_rate)} games between wins on average.
              {pick.reasoning.max_losing_streak != null && ` Worst cold streak in testing: ${pick.reasoning.max_losing_streak} games.`}
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
          <div className="flex sm:block items-center justify-between">
            <p className="text-xs text-slate-600 sm:mb-1">Long-Run Avg Per Game</p>
            <p className={`text-xl sm:text-2xl font-bold ${ppg >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {ppg >= 0 ? '+' : ''}${ppg.toFixed(3)}
            </p>
          </div>
          <div className="flex sm:block items-center justify-between">
            <p className="text-xs text-slate-600 sm:mb-1">Projected Session ({pick.recommended_games}g)</p>
            <p className={`text-xl sm:text-2xl font-bold ${total >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {total >= 0 ? '+' : ''}${total.toFixed(2)}
            </p>
          </div>
        </div>
        {pick.reasoning && (
          <div className="space-y-2 pt-2 border-t border-[#1e1e24]">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-600">
              {pick.reasoning.shadow_plays !== undefined && (
                <span>{pick.reasoning.shadow_plays} shadow plays analyzed</span>
              )}
            </div>
            <p className="text-[10px] text-slate-700 leading-relaxed">
              These numbers are long-run averages from backtesting against thousands of real draws.
              A small positive average means the strategy expects to come out slightly ahead over many sessions,
              but most individual games will be losses. The rare bigger wins are what pull the average up.
              Think of it like a batting average — the stat only tells the story over hundreds of at-bats.
            </p>
          </div>
        )}
      </div>

      {/* Navigation links */}
      <div className="flex gap-3">
        <Link
          href="/monitor"
          className="flex-1 py-3 rounded-lg bg-[#1e1e24] border border-[#333] hover:border-crimson/40 text-sm text-center text-slate-300 hover:text-white transition-colors"
        >
          Watch Arthur Live →
        </Link>
      </div>

      {/* Disclaimer */}
      <div className="rounded-lg px-4 py-3 bg-[#0a0a0d] border border-[#1a1a1e]">
        <p className="text-[10px] text-slate-700 leading-relaxed">
          Arthur's picks are generated by an evolutionary AI trained on historical Maryland Keno data.
          Expected outcomes reflect simulated backtest performance — actual Keno draws are random and past
          performance does not guarantee future results. Play within your means. 18+ only.
        </p>
      </div>

    </div>
  );
}
