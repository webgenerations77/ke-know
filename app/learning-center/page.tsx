'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { supabase, Game } from '@/lib/supabase';
import { computeNumberStats } from '@/lib/analysis';
import { pickNumbers, Strategy } from '@/lib/analysis';
import { simulateSession, SimRound } from '@/lib/prediction-engine';
import { PRIZE_TABLE } from '@/lib/keno-odds';

const CRIMSON = '#8B1A4A';

interface Config {
  spotCount: number;
  strategy: Strategy;
  wager: number;
  bonusType: 'none' | 'bonus' | 'super';
  budget: number;
  gamesTarget: number;
}

const DEFAULT_CONFIG: Config = {
  spotCount: 8,
  strategy: 'balanced',
  wager: 2,
  bonusType: 'none',
  budget: 100,
  gamesTarget: 100,
};

function fmt(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

export default function LearningCenterPage() {
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
  const [rounds, setRounds] = useState<SimRound[]>([]);
  const [running, setRunning] = useState(false);
  const [animIdx, setAnimIdx] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    supabase.from('games').select('*').order('game_num', { ascending: false }).limit(5000)
      .then(({ data }) => { if (data) setGames(data as Game[]); setLoading(false); });
  }, []);

  const runSimulation = useCallback(() => {
    if (!games.length) return;
    setRounds([]);
    setAnimIdx(0);

    const stats = computeNumberStats(games);
    const picks = pickNumbers(stats, config.spotCount, config.strategy).map(s => s.number);

    const allRounds = simulateSession(
      picks,
      games,
      config.wager,
      config.bonusType,
      config.budget,
      config.gamesTarget
    );

    setRunning(true);

    // Animate rounds in batches for a live feel
    let idx = 0;
    intervalRef.current = setInterval(() => {
      idx += 5;
      if (idx >= allRounds.length) {
        idx = allRounds.length;
        clearInterval(intervalRef.current!);
        setRunning(false);
      }
      setAnimIdx(idx);
      setRounds(allRounds.slice(0, idx));
      setTimeout(() => logRef.current?.scrollTo(0, logRef.current.scrollHeight), 30);
    }, 80);
  }, [games, config]);

  useEffect(() => () => { if (intervalRef.current) clearInterval(intervalRef.current); }, []);

  const reset = () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setRunning(false);
    setRounds([]);
    setAnimIdx(0);
  };

  // ── Derived stats ────────────────────────────────────────────────────────────
  const totalWagered = rounds.reduce((s, r) => s + r.wagered, 0);
  const totalWon = rounds.reduce((s, r) => s + r.won, 0);
  const wins = rounds.filter(r => r.won > 0).length;
  const losses = rounds.filter(r => r.won === 0).length;
  const bankroll = rounds.length > 0 ? rounds[rounds.length - 1].bankroll : config.budget;
  const roi = totalWagered > 0 ? ((totalWon - totalWagered) / totalWagered) * 100 : 0;
  const bestWin = rounds.length > 0 ? Math.max(...rounds.map(r => r.won)) : 0;
  const winRate = rounds.length > 0 ? (wins / rounds.length) * 100 : 0;
  const currentPicks = rounds.length > 0 ? rounds[0].picks : [];

  // Chart data: bankroll over time (downsample to 200 pts for performance)
  const chartData = rounds.length > 200
    ? rounds.filter((_, i) => i % Math.ceil(rounds.length / 200) === 0)
    : rounds;

  const prizeTable = PRIZE_TABLE[config.spotCount] ?? [];

  if (loading) return <div className="text-slate-500 pt-8">Loading…</div>;

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold">Learning Center</h1>
        <p className="text-sm text-slate-400 mt-1">
          Let the app play itself — simulate picks against real historical draws to test prediction accuracy.
        </p>
      </div>

      {games.length < 100 && (
        <div className="bg-yellow-900/30 border border-yellow-700 rounded-xl p-4 text-sm text-yellow-300">
          Only {games.length} games in DB. Run the backfill on the Data Ingestion page for meaningful simulations (5,000 games recommended).
        </div>
      )}

      {/* Config Panel */}
      <div className="bg-surface rounded-xl p-5">
        <h2 className="font-semibold mb-4">Simulation Setup</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {/* Spot Count */}
          <div>
            <label className="text-xs text-slate-400 block mb-1">Spots to Pick (1–10)</label>
            <input type="number" min={1} max={10} value={config.spotCount}
              onChange={e => setConfig(c => ({ ...c, spotCount: Math.min(10, Math.max(1, +e.target.value || 1)) }))}
              className="w-full px-3 py-1.5 rounded bg-[#0e0e10] border border-[#333] text-sm text-white focus:outline-none focus:border-crimson"
              disabled={running}
            />
          </div>

          {/* Strategy */}
          <div>
            <label className="text-xs text-slate-400 block mb-1">Pick Strategy</label>
            <select value={config.strategy}
              onChange={e => setConfig(c => ({ ...c, strategy: e.target.value as Strategy }))}
              className="w-full px-3 py-1.5 rounded bg-[#0e0e10] border border-[#333] text-sm text-white focus:outline-none focus:border-crimson"
              disabled={running}
            >
              <option value="balanced">Balanced (Composite Score)</option>
              <option value="hot">Hot Numbers</option>
              <option value="cold">Cold Numbers</option>
              <option value="streak">On Streak</option>
            </select>
          </div>

          {/* Wager */}
          <div>
            <label className="text-xs text-slate-400 block mb-1">Wager per Game ($1–$20)</label>
            <input type="number" min={1} max={20} value={config.wager}
              onChange={e => setConfig(c => ({ ...c, wager: Math.min(20, Math.max(1, +e.target.value || 1)) }))}
              className="w-full px-3 py-1.5 rounded bg-[#0e0e10] border border-[#333] text-sm text-white focus:outline-none focus:border-crimson"
              disabled={running}
            />
          </div>

          {/* Bonus Type */}
          <div>
            <label className="text-xs text-slate-400 block mb-1">Bonus Type</label>
            <select value={config.bonusType}
              onChange={e => setConfig(c => ({ ...c, bonusType: e.target.value as Config['bonusType'] }))}
              className="w-full px-3 py-1.5 rounded bg-[#0e0e10] border border-[#333] text-sm text-white focus:outline-none focus:border-crimson"
              disabled={running}
            >
              <option value="none">None (1× cost)</option>
              <option value="bonus">Bonus (2× cost)</option>
              <option value="super">Super Bonus (3× cost)</option>
            </select>
          </div>

          {/* Budget */}
          <div>
            <label className="text-xs text-slate-400 block mb-1">Starting Budget ($)</label>
            <input type="number" min={10} max={10000} step={10} value={config.budget}
              onChange={e => setConfig(c => ({ ...c, budget: Math.max(10, +e.target.value || 100) }))}
              className="w-full px-3 py-1.5 rounded bg-[#0e0e10] border border-[#333] text-sm text-white focus:outline-none focus:border-crimson"
              disabled={running}
            />
          </div>

          {/* Games Target */}
          <div>
            <label className="text-xs text-slate-400 block mb-1">Games to Simulate (up to 1000)</label>
            <input type="number" min={10} max={1000} step={10} value={config.gamesTarget}
              onChange={e => setConfig(c => ({ ...c, gamesTarget: Math.min(1000, Math.max(10, +e.target.value || 100)) }))}
              className="w-full px-3 py-1.5 rounded bg-[#0e0e10] border border-[#333] text-sm text-white focus:outline-none focus:border-crimson"
              disabled={running}
            />
          </div>
        </div>

        <div className="flex gap-3 mt-5">
          <button
            onClick={runSimulation}
            disabled={running || !games.length}
            className="px-5 py-2 rounded-lg bg-crimson hover:bg-[#a01f57] disabled:opacity-50 text-white text-sm font-semibold transition-colors"
          >
            {running ? `Simulating… (${animIdx}/${config.gamesTarget})` : 'Run Simulation'}
          </button>
          {(running || rounds.length > 0) && (
            <button onClick={reset}
              className="px-4 py-2 rounded-lg bg-[#2a2a2e] hover:bg-[#333] text-white text-sm transition-colors">
              Reset
            </button>
          )}
        </div>

        {currentPicks.length > 0 && (
          <div className="mt-3 text-xs text-slate-500">
            Simulated picks:{' '}
            <span className="text-slate-300 font-mono">{currentPicks.sort((a,b)=>a-b).join(', ')}</span>
          </div>
        )}
      </div>

      {/* Live Stats */}
      {rounds.length > 0 && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'Bankroll', value: fmt(bankroll), color: bankroll >= config.budget ? 'text-green-400' : 'text-red-400' },
              { label: 'ROI', value: `${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`, color: roi >= 0 ? 'text-green-400' : 'text-red-400' },
              { label: 'Win Rate', value: `${winRate.toFixed(1)}%`, color: 'text-white' },
              { label: 'Games Played', value: `${rounds.length} / ${config.gamesTarget}`, color: 'text-white' },
            ].map(({ label, value, color }) => (
              <div key={label} className="bg-surface rounded-xl p-4">
                <div className="text-xs text-slate-500 mb-1">{label}</div>
                <div className={`text-xl font-bold ${color}`}>{value}</div>
              </div>
            ))}
            {[
              { label: 'Total Wagered', value: fmt(totalWagered) },
              { label: 'Total Won', value: fmt(totalWon) },
              { label: 'Wins / Losses', value: `${wins} / ${losses}` },
              { label: 'Best Single Win', value: fmt(bestWin) },
            ].map(({ label, value }) => (
              <div key={label} className="bg-surface rounded-xl p-4">
                <div className="text-xs text-slate-500 mb-1">{label}</div>
                <div className="text-lg font-semibold">{value}</div>
              </div>
            ))}
          </div>

          {/* Bankroll Chart */}
          <div className="bg-surface rounded-xl p-4">
            <h2 className="text-sm font-semibold mb-3 text-slate-300">Bankroll Over Time</h2>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={chartData.map((r, i) => ({ game: i + 1, bankroll: r.bankroll }))}>
                <XAxis dataKey="game" tick={{ fill: '#94a3b8', fontSize: 10 }} />
                <YAxis tick={{ fill: '#94a3b8', fontSize: 10 }} tickFormatter={v => `$${v}`} />
                <Tooltip
                  contentStyle={{ background: '#16161a', border: '1px solid #333', borderRadius: 8 }}
                  formatter={(v: number) => [fmt(v), 'Bankroll']}
                  labelFormatter={v => `Game ${v}`}
                />
                <ReferenceLine y={config.budget} stroke="#4a4a5a" strokeDasharray="4 2" label={{ value: 'Start', fill: '#64748b', fontSize: 10 }} />
                <Line type="monotone" dataKey="bankroll" stroke={CRIMSON} dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Prize Table Reference */}
          <div className="grid md:grid-cols-2 gap-6">
            <div className="bg-surface rounded-xl p-4">
              <h2 className="text-sm font-semibold mb-3 text-slate-300">Prize Table ({config.spotCount} Spots)</h2>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-slate-500 border-b border-[#2a2a2e]">
                    <th className="pb-2 text-left">Catch</th>
                    <th className="pb-2 text-right">Prize / $1</th>
                    <th className="pb-2 text-right">Hits in Sim</th>
                  </tr>
                </thead>
                <tbody>
                  {prizeTable.map(({ catches, prize }) => {
                    const hitCount = rounds.filter(r => r.matches === catches).length;
                    return (
                      <tr key={catches} className="border-b border-[#1e1e24]">
                        <td className="py-1.5 text-slate-300">{catches} of {config.spotCount}</td>
                        <td className="py-1.5 text-right text-green-400">${prize}</td>
                        <td className="py-1.5 text-right text-slate-400">{hitCount}×</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Recent Rounds Log */}
            <div className="bg-surface rounded-xl p-4">
              <h2 className="text-sm font-semibold mb-3 text-slate-300">Recent Rounds</h2>
              <div ref={logRef} className="space-y-1 h-48 overflow-y-auto text-xs">
                {[...rounds].reverse().slice(0, 80).map((r, i) => (
                  <div key={i}
                    className={`flex justify-between items-center py-0.5 px-2 rounded ${r.won > 0 ? 'bg-green-900/20' : ''}`}
                  >
                    <span className="text-slate-500 font-mono w-16">#{r.gameNum}</span>
                    <span className="text-slate-400">{r.matches}/{config.spotCount} hit</span>
                    {r.won > 0
                      ? <span className="text-green-400 font-semibold">+{fmt(r.won)}</span>
                      : <span className="text-slate-600">—</span>
                    }
                    <span className={`font-mono ${r.bankroll >= config.budget ? 'text-green-400' : 'text-slate-400'}`}>
                      {fmt(r.bankroll)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Summary callout */}
          {!running && (
            <div className={`rounded-xl p-5 border ${roi >= 0 ? 'bg-green-900/10 border-green-800' : 'bg-red-900/10 border-red-900'}`}>
              <h2 className={`font-semibold ${roi >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                Simulation Complete — {roi >= 0 ? 'Profitable Run' : 'Net Loss'}
              </h2>
              <p className="text-sm text-slate-300 mt-2">
                After <strong>{rounds.length} games</strong> simulated against real historical draws:{' '}
                wagered <strong>{fmt(totalWagered)}</strong>, returned <strong>{fmt(totalWon)}</strong>,{' '}
                net <strong className={roi >= 0 ? 'text-green-400' : 'text-red-400'}>
                  {roi >= 0 ? '+' : ''}{fmt(totalWon - totalWagered)}
                </strong> ({roi >= 0 ? '+' : ''}{roi.toFixed(1)}% ROI).{' '}
                Win rate: <strong>{winRate.toFixed(1)}%</strong> of games had at least one matching number.
              </p>
              <p className="text-xs text-slate-500 mt-2">
                This simulation uses real historical draw data. Past results do not predict future draws —
                Keno numbers are randomly selected each game. Use this to understand how different strategies
                perform over time, not as a guarantee of future outcomes.
              </p>
            </div>
          )}
        </>
      )}

      {!rounds.length && !running && (
        <div className="bg-surface rounded-xl p-8 text-center text-slate-500">
          <div className="text-4xl mb-3">▶</div>
          <p className="font-medium text-slate-300 mb-1">Ready to simulate</p>
          <p className="text-sm">Configure your parameters above and click Run Simulation to test the algorithm against {games.length.toLocaleString()} historical draws.</p>
        </div>
      )}
    </div>
  );
}
