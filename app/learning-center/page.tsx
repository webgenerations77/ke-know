'use client';

import { useEffect, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import { supabase } from '@/lib/supabase';

const SPOT_COLORS = ['#ef4444','#f97316','#eab308','#22c55e','#14b8a6','#3b82f6','#8b5cf6','#ec4899','#94a3b8','#f1f5f9'];

function fmt(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface GenRow {
  generation: number;
  games: number;
  wins: number;
  pnl: number;
  bestWin: number;
  champCount: number;
}

interface SpotPerf {
  spot: number;
  games: number;
  wins: number;
  pnl: number;
  ppg: number;
  bestWin: number;
}

interface FitnessPoint {
  generation: number;
  [key: string]: number;
}

export default function SimulatorPage() {
  const [loading, setLoading] = useState(true);
  const [genRows, setGenRows] = useState<GenRow[]>([]);
  const [spotPerf, setSpotPerf] = useState<SpotPerf[]>([]);
  const [fitnessData, setFitnessData] = useState<FitnessPoint[]>([]);
  const [totalResults, setTotalResults] = useState(0);
  const [totalGames, setTotalGames] = useState(0);
  const [currentGen, setCurrentGen] = useState(0);
  const [champCount, setChampCount] = useState(0);
  const [lastReplay, setLastReplay] = useState('');
  const [lastTrained, setLastTrained] = useState('');
  const [replaying, setReplaying] = useState(false);
  const [genDetailOpen, setGenDetailOpen] = useState(false);

  useEffect(() => {
    async function load() {
      const [
        { data: liveResults },
        { data: strategies },
        { data: evoState },
        { count: gamesCount },
        { data: fitnessRows },
        { data: replayEvt },
      ] = await Promise.all([
        supabase.from('live_results').select('strategy_id, spot_count, prize, pnl, matches').limit(50000),
        supabase.from('strategies').select('id, generation, spot_count, status'),
        supabase.from('evolution_state').select('current_generation, last_run_at').eq('id', 1).single(),
        supabase.from('games').select('game_num', { count: 'exact', head: true }),
        supabase.from('strategy_results').select('generation, spot_count, fitness_score').order('generation', { ascending: true }).limit(2000),
        supabase.from('system_events').select('occurred_at').eq('event_type', 'simulator_replay').order('occurred_at', { ascending: false }).limit(1),
      ]);

      const results = (liveResults ?? []) as { strategy_id: number; spot_count: number; prize: number; pnl: number; matches: number }[];
      const strats = (strategies ?? []) as { id: number; generation: number; spot_count: number; status: string }[];

      const stratGenMap = new Map<number, number>();
      for (const s of strats) stratGenMap.set(s.id, s.generation);

      // Per-generation breakdown
      const genMap = new Map<number, { games: number; wins: number; pnl: number; bestWin: number }>();
      for (const r of results) {
        const gen = stratGenMap.get(r.strategy_id) ?? 0;
        if (gen === 0) continue;
        const entry = genMap.get(gen) ?? { games: 0, wins: 0, pnl: 0, bestWin: 0 };
        entry.games++;
        entry.pnl += r.pnl;
        if (r.prize > 0) entry.wins++;
        if (r.prize > entry.bestWin) entry.bestWin = r.prize;
        genMap.set(gen, entry);
      }

      const champsByGen = new Map<number, number>();
      for (const s of strats) {
        if (s.status === 'promoted') {
          champsByGen.set(s.generation, (champsByGen.get(s.generation) ?? 0) + 1);
        }
      }

      const rows: GenRow[] = [...genMap.entries()]
        .map(([gen, d]) => ({ generation: gen, ...d, champCount: champsByGen.get(gen) ?? 0 }))
        .sort((a, b) => b.generation - a.generation);
      setGenRows(rows);

      // Per-spot breakdown
      const spotMap = new Map<number, { games: number; wins: number; pnl: number; bestWin: number }>();
      for (const r of results) {
        const entry = spotMap.get(r.spot_count) ?? { games: 0, wins: 0, pnl: 0, bestWin: 0 };
        entry.games++;
        entry.pnl += r.pnl;
        if (r.prize > 0) entry.wins++;
        if (r.prize > entry.bestWin) entry.bestWin = r.prize;
        spotMap.set(r.spot_count, entry);
      }
      setSpotPerf([...spotMap.entries()]
        .map(([spot, d]) => ({ spot, ...d, ppg: d.games > 0 ? d.pnl / d.games : 0 }))
        .sort((a, b) => a.spot - b.spot));

      // Fitness history chart
      if (fitnessRows) {
        const byGen = new Map<number, Map<number, number>>();
        for (const row of fitnessRows as { generation: number; spot_count: number; fitness_score: number | null }[]) {
          if (!byGen.has(row.generation)) byGen.set(row.generation, new Map());
          const gm = byGen.get(row.generation)!;
          const cur = gm.get(row.spot_count) ?? -999;
          if ((row.fitness_score ?? -999) > cur) gm.set(row.spot_count, row.fitness_score ?? 0);
        }
        const last48 = [...byGen.entries()].sort((a, b) => a[0] - b[0]).slice(-48);
        setFitnessData(last48.map(([gen, spotMap]) => {
          const entry: FitnessPoint = { generation: gen };
          for (const [spot, fit] of spotMap) entry[`s${spot}`] = fit;
          return entry;
        }));
      }

      setTotalResults(results.length);
      setTotalGames(gamesCount ?? 0);
      setCurrentGen(evoState?.current_generation ?? 0);
      setLastTrained((evoState as { current_generation?: number; last_run_at?: string } | null)?.last_run_at ?? '');
      setChampCount(strats.filter(s => s.status === 'promoted').length);
      setLastReplay((replayEvt?.[0] as { occurred_at?: string } | undefined)?.occurred_at ?? '');
      setLoading(false);
    }
    load();
  }, []);

  if (loading) return <div className="text-slate-500 pt-8">Loading...</div>;

  const totalPnl = genRows.reduce((s, r) => s + r.pnl, 0);
  const totalWins = genRows.reduce((s, r) => s + r.wins, 0);
  const totalPlays = genRows.reduce((s, r) => s + r.games, 0);
  const overallWR = totalPlays > 0 ? ((totalWins / totalPlays) * 100).toFixed(1) : '0.0';
  const bestSpot = spotPerf.length > 0 ? spotPerf.reduce((best, s) => s.ppg > best.ppg ? s : best, spotPerf[0]) : null;

  return (
    <div className="space-y-5 max-w-4xl">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold">Arthur's Training</h1>
        <p className="text-sm text-slate-400 mt-1">
          How Arthur performs when practicing against the game archive. These results feed directly into his evolution fitness scores.
        </p>
        {lastTrained && (
          <p className="text-xs text-slate-600 mt-1">
            Last trained: {new Date(lastTrained).toLocaleString()}
          </p>
        )}
      </div>

      {/* ── Summary Cards ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-surface rounded-xl p-4">
          <div className="text-xs text-slate-500 mb-1">Games Practiced</div>
          <div className="text-xl font-bold">{totalPlays.toLocaleString()}</div>
          <div className="text-[10px] text-slate-600">of {totalGames.toLocaleString()} in archive</div>
        </div>
        <div className="bg-surface rounded-xl p-4">
          <div className="text-xs text-slate-500 mb-1">Win Rate</div>
          <div className="text-xl font-bold">{overallWR}%</div>
          <div className="text-[10px] text-slate-600">{totalWins.toLocaleString()} wins</div>
        </div>
        <div className="bg-surface rounded-xl p-4">
          <div className="text-xs text-slate-500 mb-1">Net P&L</div>
          <div className={`text-xl font-bold ${totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {totalPnl >= 0 ? '+' : ''}{fmt(totalPnl)}
          </div>
          <div className="text-[10px] text-slate-600">{totalPlays > 0 ? `${(totalPnl / totalPlays).toFixed(3)}/game` : ''}</div>
        </div>
        <div className="bg-surface rounded-xl p-4">
          <div className="text-xs text-slate-500 mb-1">Generation</div>
          <div className="text-xl font-bold">Gen {currentGen}</div>
          <div className="text-[10px] text-slate-600">{champCount} active champions</div>
        </div>
      </div>

      {/* ── What Arthur Learned ── */}
      <div className="bg-surface rounded-xl p-4 space-y-3 border border-[#2a2a2e]">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-crimson/10 border border-crimson/20 flex items-center justify-center shrink-0">
            <span className="text-crimson text-xs font-bold">A</span>
          </div>
          <div>
            <p className="text-sm font-medium text-slate-300">What Arthur Has Learned</p>
            <p className="text-xs text-slate-500">Insights from {totalPlays.toLocaleString()} practice games across {genRows.length} generations</p>
          </div>
        </div>
        <div className="space-y-2 text-xs text-slate-400 leading-relaxed">
          {bestSpot && bestSpot.ppg > 0 && (
            <p>Best performing spot count: <strong className="text-slate-200">{bestSpot.spot}-spot</strong> at +${bestSpot.ppg.toFixed(3)}/game across {bestSpot.games} games.</p>
          )}
          {bestSpot && bestSpot.ppg <= 0 && spotPerf.length > 0 && (
            <p>No spot count is consistently profitable yet. Closest: <strong className="text-slate-200">{bestSpot.spot}-spot</strong> at ${bestSpot.ppg.toFixed(3)}/game. More evolution cycles will sharpen the edge.</p>
          )}
          {genRows.length >= 2 && (() => {
            const latest = genRows[0];
            const prev = genRows[1];
            if (latest && prev && latest.games >= 10 && prev.games >= 10) {
              const latestPpg = latest.pnl / latest.games;
              const prevPpg = prev.pnl / prev.games;
              const improving = latestPpg > prevPpg;
              return <p>Gen {latest.generation} is {improving ? 'outperforming' : 'trailing'} Gen {prev.generation}: ${latestPpg.toFixed(3)}/game vs ${prevPpg.toFixed(3)}/game. {improving ? 'The strategies are getting sharper.' : 'Variance or a harder stretch of draws.'}</p>;
            }
            return null;
          })()}
          {totalPlays > 100 && (
            <p>Across all training, Arthur wins {overallWR}% of games. In Keno, the edge comes from the size of wins, not frequency — rare bigger catches offset many small losses.</p>
          )}
        </div>
      </div>

      {/* ── Spot Performance ── */}
      {spotPerf.length > 0 && (
        <div className="bg-surface rounded-xl p-4">
          <h2 className="font-semibold text-sm mb-3">Performance by Spot Count</h2>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {spotPerf.map(s => (
              <div key={s.spot} className={`rounded-lg p-3 text-center ${s.ppg > 0 ? 'bg-green-900/15 border border-green-900/30' : 'bg-[#0e0e10] border border-[#1e1e24]'}`}>
                <div className="text-xs text-slate-500">{s.spot}-spot</div>
                <div className={`text-sm font-bold ${s.ppg >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {s.ppg >= 0 ? '+' : ''}${s.ppg.toFixed(3)}
                </div>
                <div className="text-[10px] text-slate-600">{s.games} games · {s.games > 0 ? ((s.wins / s.games) * 100).toFixed(0) : 0}% wins</div>
                {s.bestWin > 0 && <div className="text-[10px] text-slate-500 mt-0.5">Best: ${s.bestWin}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Fitness History Chart ── */}
      {fitnessData.length > 1 && (
        <div className="bg-surface rounded-xl p-4">
          <h2 className="font-semibold text-sm mb-3">Fitness Over Generations</h2>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={fitnessData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
              <XAxis dataKey="generation" tick={{ fontSize: 9 }} />
              <YAxis tick={{ fontSize: 9 }} />
              <Tooltip
                contentStyle={{ background: '#16161a', border: '1px solid #333', fontSize: 11 }}
                formatter={(v: number) => v.toFixed(4)}
              />
              {[1,2,3,4,5,6,7,8,9,10].map((s, i) => (
                <Line key={s} dataKey={`s${s}`} dot={false} strokeWidth={1.5} stroke={SPOT_COLORS[i]} name={`${s}-sp`} />
              ))}
            </LineChart>
          </ResponsiveContainer>
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 justify-center">
            {[1,2,3,4,5,6,7,8,9,10].map((s, i) => (
              <span key={s} className="text-[9px] flex items-center gap-1">
                <span className="w-2 h-2 rounded-full inline-block" style={{ background: SPOT_COLORS[i] }} />
                {s}-sp
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ── Generation Breakdown ── */}
      {genRows.length > 0 && (
        <div className="bg-surface rounded-xl overflow-hidden">
          <button
            onClick={() => setGenDetailOpen(o => !o)}
            className="w-full px-4 py-3 flex items-center justify-between hover:bg-[#1e1e24] transition-colors"
          >
            <h2 className="font-semibold text-sm">Performance by Generation</h2>
            <span className="text-xs text-slate-500">{genRows.length} gens {genDetailOpen ? '▲' : '▼'}</span>
          </button>
          {genDetailOpen && (
            <div className="overflow-x-auto max-h-[400px] overflow-y-auto border-t border-[#2a2a2e]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-surface z-10">
                  <tr className="text-slate-500 border-b border-[#2a2a2e]">
                    <th className="px-3 py-2 text-left">Gen</th>
                    <th className="px-3 py-2 text-left">Games</th>
                    <th className="px-3 py-2 text-left">W–L</th>
                    <th className="px-3 py-2 text-right">Win %</th>
                    <th className="px-3 py-2 text-right">P&L</th>
                    <th className="px-3 py-2 text-right">P&L/g</th>
                    <th className="px-3 py-2 text-right">Best</th>
                  </tr>
                </thead>
                <tbody>
                  {genRows.map(r => (
                    <tr key={r.generation} className="border-b border-[#1e1e24] hover:bg-[#1e1e24]">
                      <td className="px-3 py-2 font-mono text-slate-300">
                        {r.generation}
                        {r.generation === currentGen && <span className="ml-1 text-crimson text-[9px]">NOW</span>}
                        {r.champCount > 0 && <span className="ml-1 text-amber-400 text-[9px]">{r.champCount} champs</span>}
                      </td>
                      <td className="px-3 py-2 text-slate-400">{r.games}</td>
                      <td className="px-3 py-2">
                        <span className="text-green-400">{r.wins}W</span>
                        <span className="text-slate-500 mx-0.5">–</span>
                        <span className="text-red-400">{r.games - r.wins}L</span>
                      </td>
                      <td className="px-3 py-2 text-right">{r.games > 0 ? ((r.wins / r.games) * 100).toFixed(1) : '—'}%</td>
                      <td className={`px-3 py-2 text-right font-mono ${r.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {r.pnl >= 0 ? '+' : ''}{fmt(r.pnl)}
                      </td>
                      <td className={`px-3 py-2 text-right font-mono ${r.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        ${r.games > 0 ? (r.pnl / r.games).toFixed(3) : '0.000'}
                      </td>
                      <td className="px-3 py-2 text-right">{r.bestWin > 0 ? `$${r.bestWin}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Replay Controls ── */}
      <div className="bg-surface rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-slate-300">Background Training</p>
          <p className="text-xs text-slate-500">
            Arthur automatically replays against archived games during each sync.
            {lastReplay && ` Last run: ${new Date(lastReplay).toLocaleDateString()}.`}
            {' '}{totalResults.toLocaleString()} total training results.
          </p>
        </div>
        <button
          onClick={async () => {
            setReplaying(true);
            try {
              const res = await fetch('/api/simulate', { method: 'POST', headers: { 'x-internal': '1' } });
              const data = await res.json();
              if (data.ok && data.totalNew > 0) {
                setTotalResults(prev => prev + data.totalNew);
                setLastReplay(new Date().toISOString());
              }
            } catch { /* best-effort */ }
            setReplaying(false);
          }}
          disabled={replaying || champCount === 0}
          className="px-4 py-2 rounded-lg bg-crimson hover:bg-[#a01f57] disabled:opacity-50 text-white text-sm font-medium transition-colors"
        >
          {replaying ? 'Training…' : 'Train Now'}
        </button>
      </div>
    </div>
  );
}
