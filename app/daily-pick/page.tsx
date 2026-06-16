'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useToast } from '@/components/Toast';

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
  reasoning: {
    shadow_plays?: number;
    win_rate?: number;
    max_losing_streak?: number;
    champion_id?: number;
  } | null;
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
  const router = useRouter();
  const { toast } = useToast();
  const [pick, setPick] = useState<DailyPick | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [now, setNow] = useState(() => new Date());

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

  useEffect(() => { loadPick(); }, []);

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

  const totalWager = pick.wager_per_game * pick.recommended_games;
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
                className="w-11 h-11 rounded-full bg-crimson/15 border border-crimson/50 flex items-center justify-center text-sm font-bold text-crimson"
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
      <div className="bg-surface rounded-xl p-5 grid grid-cols-3 gap-4">
        <div>
          <p className="text-xs text-slate-500 mb-1">Wager / Game</p>
          <p className="text-2xl font-bold">${Number(pick.wager_per_game).toFixed(2)}</p>
          <p className="text-[10px] text-slate-600 mt-0.5">
            {pick.bonus_type !== 'none' ? `includes ${bonusLabel.toLowerCase()}` : 'base wager'}
          </p>
        </div>
        <div>
          <p className="text-xs text-slate-500 mb-1">Games to Play</p>
          <p className="text-2xl font-bold">{pick.recommended_games}</p>
          <p className="text-[10px] text-slate-600 mt-0.5">recommended session</p>
        </div>
        <div>
          <p className="text-xs text-slate-500 mb-1">Total Investment</p>
          <p className="text-2xl font-bold">${totalWager.toFixed(2)}</p>
          <p className="text-[10px] text-slate-600 mt-0.5">before winnings</p>
        </div>
      </div>

      {/* Best play window */}
      {pick.best_hour !== null && (
        <div className={`rounded-xl p-5 flex items-center gap-5 border ${windowStyle}`}>
          <div className="flex-1">
            <p className="text-[10px] text-slate-500 uppercase tracking-[0.2em] mb-1">Best Play Window</p>
            <p className="text-xl font-bold">
              {fmtHour(pick.best_hour)} – {fmtHour(pick.best_hour + 1)}
            </p>
            <p className="text-xs text-slate-600 mt-1">Eastern Time</p>
          </div>
          <div className="text-right">
            {win.state === 'active' && (
              <div className="flex items-center gap-2 justify-end mb-1">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-40" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                </span>
                <span className="text-xs text-green-400 font-semibold uppercase tracking-wide">Live Window</span>
              </div>
            )}
            <p className={`text-sm font-semibold ${windowLabelStyle}`}>{win.label}</p>
            {win.state === 'before' && (
              <p className="text-[10px] text-slate-600 mt-0.5">Based on Arthur's win patterns</p>
            )}
            {win.state === 'past' && (
              <p className="text-[10px] text-slate-600 mt-0.5">Come back at 6 AM tomorrow</p>
            )}
          </div>
        </div>
      )}

      {/* Expected outcome */}
      <div className="bg-surface rounded-xl p-5 space-y-4">
        <p className="text-[10px] text-slate-500 uppercase tracking-[0.2em]">Expected Outcome</p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-slate-600 mb-1">Per Game (avg)</p>
            <p className={`text-3xl font-bold ${ppg >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {ppg >= 0 ? '+' : ''}{ppg.toFixed(2)}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-600 mb-1">Full Session ({pick.recommended_games} games)</p>
            <p className={`text-3xl font-bold ${total >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {total >= 0 ? '+' : ''}{total.toFixed(2)}
            </p>
          </div>
        </div>
        {pick.reasoning && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-600 pt-1 border-t border-[#1e1e24]">
            {pick.reasoning.shadow_plays !== undefined && (
              <span>{pick.reasoning.shadow_plays} shadow plays</span>
            )}
            {pick.reasoning.win_rate !== undefined && (
              <span>{((pick.reasoning.win_rate) * 100).toFixed(0)}% historical win rate</span>
            )}
            {pick.reasoning.max_losing_streak !== undefined && (
              <span>Max losing streak: {pick.reasoning.max_losing_streak}</span>
            )}
          </div>
        )}
      </div>

      {/* Save picks link */}
      <div className="flex gap-3">
        <Link
          href="/my-picks"
          className="flex-1 py-3 rounded-lg bg-[#1e1e24] border border-[#333] hover:border-crimson/40 text-sm text-center text-slate-300 hover:text-white transition-colors"
        >
          Save Picks Manually →
        </Link>
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
