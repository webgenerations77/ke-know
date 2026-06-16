'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Strategy, StrategyResult, LiveResult } from '@/lib/supabase';
import { describeGenome, type StrategyGenome } from '@/lib/evolution/genome';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';

interface StrategyWithResult extends Strategy {
  latestResult: StrategyResult | null;
  livePlays: number;
  livePnlPerGame: number;
}

function Ball({ n, active }: { n: number; active?: boolean }) {
  return (
    <span className={`inline-flex w-8 h-8 rounded-full items-center justify-center text-xs font-bold shrink-0
      ${active ? 'bg-crimson text-white' : 'bg-[#2a2a2e] text-slate-300'}`}>
      {n}
    </span>
  );
}

function PnlBadge({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <span className="text-slate-600">—</span>;
  return (
    <span className={value >= 0 ? 'text-green-400' : 'text-red-400'}>
      {value >= 0 ? '+' : ''}${value.toFixed(3)}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    promoted: 'bg-crimson/20 text-crimson',
    active: 'bg-blue-500/20 text-blue-300',
    retired: 'bg-slate-700/50 text-slate-500',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${colors[status] ?? ''}`}>
      {status}
    </span>
  );
}

interface GenomeExplorer {
  open: boolean;
  strategy: StrategyWithResult | null;
  history: StrategyResult[];
}

export default function StrategyLabPage() {
  const [strategies, setStrategies] = useState<StrategyWithResult[]>([]);
  const [liveResults, setLiveResults] = useState<LiveResult[]>([]);
  const [genFitness, setGenFitness] = useState<{ generation: number; [k: string]: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterSpot, setFilterSpot] = useState(0);
  const [sortKey, setSortKey] = useState<'fitness_score' | 'test_pnl_per_game' | 'live_ppg' | 'win_rate'>('fitness_score');
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [explorer, setExplorer] = useState<GenomeExplorer>({ open: false, strategy: null, history: [] });

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: strats }, { data: results }, { data: live }, { data: gf }] = await Promise.all([
      supabase.from('strategies')
        .select('*')
        .in('status', ['active', 'promoted', 'retired'])
        .order('spot_count').order('id').limit(500),
      supabase.from('strategy_results')
        .select('*')
        .order('evaluated_at', { ascending: false })
        .limit(2000),
      supabase.from('live_results')
        .select('strategy_id,pnl,prize,scored_at')
        .order('scored_at', { ascending: false })
        .limit(1000),
      supabase.from('strategy_results')
        .select('generation,spot_count,fitness_score')
        .order('generation', { ascending: true })
        .limit(2000),
    ]);

    const liveData = (live ?? []) as { strategy_id: number; pnl: number; prize: number }[];
    setLiveResults(live as LiveResult[] ?? []);

    // Build live stats map
    const liveStats = new Map<number, { count: number; total: number }>();
    for (const r of liveData) {
      const s = liveStats.get(r.strategy_id) ?? { count: 0, total: 0 };
      s.count++;
      s.total += r.pnl;
      liveStats.set(r.strategy_id, s);
    }

    // Build latest result map (one per strategy)
    const latestResult = new Map<number, StrategyResult>();
    for (const r of (results ?? []) as StrategyResult[]) {
      if (!latestResult.has(r.strategy_id)) {
        latestResult.set(r.strategy_id, r);
      }
    }

    const enriched: StrategyWithResult[] = ((strats ?? []) as Strategy[]).map(s => {
      const ls = liveStats.get(s.id) ?? { count: 0, total: 0 };
      return {
        ...s,
        latestResult: latestResult.get(s.id) ?? null,
        livePlays: ls.count,
        livePnlPerGame: ls.count > 0 ? ls.total / ls.count : 0,
      };
    });
    setStrategies(enriched);

    // Fitness history by generation
    if (gf) {
      const byGen = new Map<number, Map<number, number>>();
      for (const row of gf as { generation: number; spot_count: number; fitness_score: number | null }[]) {
        if (!byGen.has(row.generation)) byGen.set(row.generation, new Map());
        const gm = byGen.get(row.generation)!;
        const cur = gm.get(row.spot_count) ?? -999;
        if ((row.fitness_score ?? -999) > cur) gm.set(row.spot_count, row.fitness_score ?? 0);
      }
      const sorted = [...byGen.entries()].sort((a, b) => a[0] - b[0]);
      setGenFitness(sorted.map(([gen, sm]) => {
        const e: { generation: number; [k: string]: number } = { generation: gen };
        for (const [s, f] of sm) e[`s${s}`] = f;
        return e;
      }));
    }

    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Realtime: live results stream
  useEffect(() => {
    const ch = supabase
      .channel('lab_live_results')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'live_results' },
        payload => {
          setLiveResults(prev => [payload.new as LiveResult, ...prev].slice(0, 1000));
        })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  async function openExplorer(strategy: StrategyWithResult) {
    const { data } = await supabase
      .from('strategy_results')
      .select('*')
      .eq('strategy_id', strategy.id)
      .order('evaluated_at', { ascending: false })
      .limit(50);
    setExplorer({ open: true, strategy, history: (data ?? []) as StrategyResult[] });
  }

  // Derived data
  const promoted = strategies.filter(s => s.status === 'promoted');
  const overallChamp = promoted.length > 0
    ? promoted.reduce((best, s) =>
        (s.latestResult?.fitness_score ?? -999) > (best.latestResult?.fitness_score ?? -999) ? s : best
      )
    : null;

  const filtered = strategies
    .filter(s => filterSpot === 0 || s.spot_count === filterSpot)
    .filter(s => s.status !== 'retired')
    .sort((a, b) => {
      let av = 0, bv = 0;
      if (sortKey === 'fitness_score') {
        av = a.latestResult?.fitness_score ?? -999;
        bv = b.latestResult?.fitness_score ?? -999;
      } else if (sortKey === 'test_pnl_per_game') {
        av = a.latestResult?.test_pnl_per_game ?? -999;
        bv = b.latestResult?.test_pnl_per_game ?? -999;
      } else if (sortKey === 'live_ppg') {
        av = a.livePnlPerGame;
        bv = b.livePnlPerGame;
      } else {
        av = a.latestResult?.win_rate ?? 0;
        bv = b.latestResult?.win_rate ?? 0;
      }
      return sortDir * (bv - av);
    });

  const recentLive = [...liveResults]
    .sort((a, b) => new Date(b.scored_at).getTime() - new Date(a.scored_at).getTime())
    .slice(0, 50);
  const liveTodayPnl = liveResults
    .filter(r => Date.now() - new Date(r.scored_at).getTime() < 86400000)
    .reduce((s, r) => s + r.pnl, 0);

  const SPOT_COLORS = ['#ef4444','#f97316','#eab308','#22c55e','#14b8a6','#3b82f6','#8b5cf6','#ec4899','#94a3b8','#f1f5f9'];

  function colHeader(key: typeof sortKey, label: string) {
    const active = sortKey === key;
    return (
      <th
        className="px-3 py-2 text-left cursor-pointer hover:text-white select-none"
        onClick={() => { if (active) setSortDir(d => d === 1 ? -1 : 1); else { setSortKey(key); setSortDir(-1); } }}
      >
        {label} {active ? (sortDir === -1 ? '↓' : '↑') : ''}
      </th>
    );
  }

  if (loading) return <div className="text-slate-500 pt-8">Loading strategy lab…</div>;

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">Strategy Lab</h1>

      {/* ── Section 1: Overall Champion ── */}
      {overallChamp ? (
        <div className="bg-surface rounded-xl p-5 border border-crimson/30">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-crimson text-lg">★</span>
            <h2 className="font-semibold">Overall Champion</h2>
            <span className="text-xs text-slate-500">#{overallChamp.id} · Gen {overallChamp.generation} · {overallChamp.spot_count}-spot</span>
            <StatusBadge status={overallChamp.status} />
          </div>
          <p className="text-xs text-slate-400 mb-4 italic">{describeGenome(overallChamp.genome as unknown as StrategyGenome)}</p>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4 text-sm">
            {[
              { label: 'Fitness', value: overallChamp.latestResult?.fitness_score?.toFixed(4) ?? '—' },
              { label: 'Test P&L/game', value: overallChamp.latestResult?.test_pnl_per_game != null ? `$${overallChamp.latestResult.test_pnl_per_game.toFixed(3)}` : '—' },
              { label: 'Live P&L/game', value: overallChamp.livePlays > 0 ? `$${overallChamp.livePnlPerGame.toFixed(3)}` : '—' },
              { label: 'Win Rate', value: overallChamp.latestResult?.win_rate != null ? `${(overallChamp.latestResult.win_rate * 100).toFixed(1)}%` : '—' },
              { label: 'Max Streak', value: `${overallChamp.latestResult?.max_losing_streak ?? '—'} L` },
            ].map(({ label, value }) => (
              <div key={label} className="bg-[#0e0e10] rounded-lg p-3">
                <div className="text-xs text-slate-500">{label}</div>
                <div className="font-bold mt-0.5">{value}</div>
              </div>
            ))}
          </div>

          {overallChamp.latestResult?.picks_snapshot && (
            <div className="flex flex-wrap gap-2 mb-4">
              {overallChamp.latestResult.picks_snapshot.map(n => <Ball key={n} n={n} active />)}
            </div>
          )}

          <button
            onClick={() => openExplorer(overallChamp)}
            className="text-xs px-3 py-1.5 rounded border border-[#333] text-slate-300 hover:bg-[#2a2a2e]"
          >
            Explore Genome
          </button>
        </div>
      ) : (
        <div className="bg-surface rounded-xl p-5 text-slate-500 text-sm">
          No champion yet. Run the hourly sync to start evolution.
        </div>
      )}

      {/* ── Section 2: Champion per Spot Count ── */}
      <div>
        <h2 className="font-semibold text-sm text-slate-400 mb-3">Champion per Spot Count</h2>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {[1,2,3,4,5,6,7,8,9,10].map(s => {
            const champ = promoted.find(p => p.spot_count === s);
            return (
              <div
                key={s}
                className="bg-surface rounded-xl p-3 cursor-pointer hover:border-crimson/40 border border-transparent"
                onClick={() => champ && openExplorer(champ)}
              >
                <div className="text-xs text-slate-500 mb-1">{s}-spot</div>
                {champ ? (
                  <>
                    <div className="text-xs font-mono text-crimson">#{champ.id}</div>
                    <div className="text-[10px] text-slate-500">Gen {champ.generation}</div>
                    <div className="mt-2 space-y-0.5 text-[10px]">
                      <div className="flex justify-between">
                        <span className="text-slate-600">Fitness</span>
                        <span>{champ.latestResult?.fitness_score?.toFixed(3) ?? '—'}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-600">Test PPG</span>
                        <span className={champ.latestResult?.test_pnl_per_game != null && champ.latestResult.test_pnl_per_game >= 0 ? 'text-green-400' : 'text-red-400'}>
                          {champ.latestResult?.test_pnl_per_game != null ? `$${champ.latestResult.test_pnl_per_game.toFixed(3)}` : '—'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-600">Live PPG</span>
                        <span className={champ.livePnlPerGame >= 0 ? 'text-green-400' : 'text-red-400'}>
                          {champ.livePlays > 0 ? `$${champ.livePnlPerGame.toFixed(3)}` : '—'}
                        </span>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="text-xs text-slate-600 mt-2">No champion</div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Section 3: Full Leaderboard ── */}
      <div className="bg-surface rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-[#2a2a2e] flex flex-wrap items-center gap-3">
          <h2 className="font-semibold text-sm">Leaderboard</h2>
          <span className="text-xs text-slate-500">{filtered.length} strategies</span>
          <select
            value={filterSpot}
            onChange={e => setFilterSpot(parseInt(e.target.value))}
            className="ml-auto bg-[#0e0e10] border border-[#333] text-xs rounded px-2 py-1 text-white"
          >
            <option value={0}>All spots</option>
            {[1,2,3,4,5,6,7,8,9,10].map(s => <option key={s} value={s}>{s} spots</option>)}
          </select>
        </div>
        <div className="overflow-x-auto max-h-96">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface z-10">
              <tr className="text-slate-500 border-b border-[#2a2a2e]">
                <th className="px-3 py-2 text-left">#</th>
                <th className="px-3 py-2 text-left">ID</th>
                <th className="px-3 py-2 text-left">Spots</th>
                <th className="px-3 py-2 text-left">Gen</th>
                {colHeader('fitness_score', 'Fitness')}
                {colHeader('test_pnl_per_game', 'Test PPG')}
                {colHeader('live_ppg', 'Live PPG')}
                {colHeader('win_rate', 'Win%')}
                <th className="px-3 py-2 text-left">MaxL</th>
                <th className="px-3 py-2 text-left">Live</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 200).map((s, i) => (
                <tr key={s.id} className="border-b border-[#1e1e24] hover:bg-[#1e1e24]">
                  <td className="px-3 py-2 text-slate-600">{i + 1}</td>
                  <td className="px-3 py-2 font-mono text-slate-400">#{s.id}</td>
                  <td className="px-3 py-2">{s.spot_count}</td>
                  <td className="px-3 py-2 text-slate-500">{s.generation}</td>
                  <td className="px-3 py-2 font-mono">
                    {s.latestResult?.fitness_score?.toFixed(4) ?? '—'}
                  </td>
                  <td className="px-3 py-2">
                    <PnlBadge value={s.latestResult?.test_pnl_per_game} />
                  </td>
                  <td className="px-3 py-2">
                    {s.livePlays > 0 ? <PnlBadge value={s.livePnlPerGame} /> : <span className="text-slate-600">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    {s.latestResult?.win_rate != null
                      ? `${(s.latestResult.win_rate * 100).toFixed(1)}%`
                      : '—'}
                  </td>
                  <td className="px-3 py-2">{s.latestResult?.max_losing_streak ?? '—'}</td>
                  <td className="px-3 py-2 text-slate-500">{s.livePlays}</td>
                  <td className="px-3 py-2"><StatusBadge status={s.status} /></td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => openExplorer(s)}
                      className="text-slate-600 hover:text-white text-xs"
                    >
                      Explore
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Section 4: Evolution History Chart ── */}
      <div className="bg-surface rounded-xl p-4">
        <h2 className="font-semibold text-sm mb-4">Evolution Fitness History</h2>
        {genFitness.length > 1 ? (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={genFitness} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
              <XAxis dataKey="generation" tick={{ fontSize: 10 }} label={{ value: 'Generation', position: 'insideBottom', offset: -2, style: { fontSize: 10 } }} />
              <YAxis tick={{ fontSize: 10 }} />
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
                  name={`${s}-spot`}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-48 flex items-center justify-center text-slate-600 text-sm">
            Evolution fitness history will appear here after the first run.
          </div>
        )}
      </div>

      {/* ── Section 5: Live Prediction Feed ── */}
      <div className="bg-surface rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-[#2a2a2e] flex items-center justify-between">
          <h2 className="font-semibold text-sm">Live Prediction Feed</h2>
          <span className={`text-xs font-semibold ${liveTodayPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            24h P&L: {liveTodayPnl >= 0 ? '+' : ''}${liveTodayPnl.toFixed(2)}
          </span>
        </div>
        <div className="overflow-x-auto max-h-80">
          {recentLive.length === 0 ? (
            <p className="px-4 py-6 text-slate-500 text-sm">No shadow plays yet. Shadow plays appear after the poll starts scoring predictions.</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-500 border-b border-[#2a2a2e]">
                  <th className="px-3 py-2 text-left">Game</th>
                  <th className="px-3 py-2 text-left">Strategy</th>
                  <th className="px-3 py-2 text-left">Spots</th>
                  <th className="px-3 py-2 text-left">Picks</th>
                  <th className="px-3 py-2 text-left">Matches</th>
                  <th className="px-3 py-2 text-right">Prize</th>
                  <th className="px-3 py-2 text-right">P&L</th>
                </tr>
              </thead>
              <tbody>
                {recentLive.map(r => (
                  <tr key={r.id} className="border-b border-[#1e1e24] hover:bg-[#1e1e24]">
                    <td className="px-3 py-2 font-mono text-slate-400">#{r.game_num}</td>
                    <td className="px-3 py-2 text-slate-500">#{r.strategy_id}</td>
                    <td className="px-3 py-2">{r.spot_count}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-0.5">
                        {r.picks.map(n => (
                          <span key={n} className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold
                            ${r.actual_hits.includes(n) ? 'bg-crimson text-white' : 'bg-[#2a2a2e] text-slate-500'}`}>
                            {n}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2">{r.matches}/{r.spot_count}</td>
                    <td className="px-3 py-2 text-right">${r.prize}</td>
                    <td className={`px-3 py-2 text-right font-mono ${r.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ── Section 6: Genome Explorer Slide-over ── */}
      {explorer.open && explorer.strategy && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/60"
            onClick={() => setExplorer(e => ({ ...e, open: false }))}
          />
          <aside className="fixed inset-y-0 right-0 z-50 w-full max-w-lg bg-surface overflow-y-auto">
            <div className="sticky top-0 bg-surface px-5 py-4 border-b border-[#2a2a2e] flex items-center justify-between">
              <div>
                <h2 className="font-bold">Strategy #{explorer.strategy.id}</h2>
                <p className="text-xs text-slate-500">
                  {explorer.strategy.spot_count}-spot · Gen {explorer.strategy.generation} ·{' '}
                  <StatusBadge status={explorer.strategy.status} />
                </p>
              </div>
              <button
                onClick={() => setExplorer(e => ({ ...e, open: false }))}
                className="text-slate-500 hover:text-white text-xl"
              >✕</button>
            </div>

            <div className="p-5 space-y-6">
              {/* Plain-English description */}
              <div>
                <h3 className="text-xs font-semibold text-slate-400 mb-2">Strategy Description</h3>
                <p className="text-sm text-slate-300">
                  {describeGenome(explorer.strategy.genome as unknown as StrategyGenome)}
                </p>
              </div>

              {/* Current picks */}
              {explorer.strategy.latestResult?.picks_snapshot && (
                <div>
                  <h3 className="text-xs font-semibold text-slate-400 mb-2">Current Picks</h3>
                  <div className="flex flex-wrap gap-2">
                    {explorer.strategy.latestResult.picks_snapshot.map(n => <Ball key={n} n={n} active />)}
                  </div>
                </div>
              )}

              {/* Performance */}
              {explorer.strategy.latestResult && (
                <div>
                  <h3 className="text-xs font-semibold text-slate-400 mb-2">Performance</h3>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    {[
                      ['Fitness Score', explorer.strategy.latestResult.fitness_score?.toFixed(4)],
                      ['Training P&L/game', `$${explorer.strategy.latestResult.training_pnl_per_game?.toFixed(3) ?? '—'}`],
                      ['Test P&L/game', `$${explorer.strategy.latestResult.test_pnl_per_game?.toFixed(3) ?? '—'}`],
                      ['Live P&L/game', explorer.strategy.livePlays > 0 ? `$${explorer.strategy.livePnlPerGame.toFixed(3)}` : '—'],
                      ['Win Rate', `${((explorer.strategy.latestResult.win_rate ?? 0) * 100).toFixed(1)}%`],
                      ['Avg Matches', explorer.strategy.latestResult.avg_matches?.toFixed(2)],
                      ['Best Win', `$${explorer.strategy.latestResult.best_single_win ?? 0}`],
                      ['Max Losing Streak', explorer.strategy.latestResult.max_losing_streak],
                      ['Training Games', explorer.strategy.latestResult.games_in_training],
                      ['Test Games', explorer.strategy.latestResult.games_in_test],
                      ['Live Plays', explorer.strategy.livePlays],
                      ['Real World Plays', explorer.strategy.real_world_plays],
                    ].map(([label, value]) => (
                      <div key={String(label)} className="bg-[#0e0e10] rounded p-2">
                        <div className="text-slate-600">{label}</div>
                        <div className="font-bold mt-0.5">{value ?? '—'}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Ancestry */}
              {explorer.strategy.parent_ids && explorer.strategy.parent_ids.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-slate-400 mb-2">Ancestry</h3>
                  <p className="text-xs text-slate-500">
                    Parent strategies: {explorer.strategy.parent_ids.map(id => `#${id}`).join(', ')}
                  </p>
                  {explorer.strategy.mutation_log && (
                    <div className="mt-2 bg-[#0e0e10] rounded p-2">
                      <div className="text-xs text-slate-600 mb-1">
                        {explorer.strategy.mutation_log.action === 'crossover' ? '🔀 Crossover' : '🧬 Mutation'}
                      </div>
                      <ul className="text-[10px] text-slate-500 space-y-0.5">
                        {(explorer.strategy.mutation_log.details ?? []).slice(0, 8).map((d, i) => (
                          <li key={i}>{d}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {/* Raw genome */}
              <div>
                <h3 className="text-xs font-semibold text-slate-400 mb-2">Genome Parameters</h3>
                <div className="bg-[#0e0e10] rounded p-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  {Object.entries(explorer.strategy.genome as object).map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-2">
                      <span className="text-slate-600 truncate">{k}</span>
                      <span className="font-mono text-slate-300">
                        {typeof v === 'number' ? v.toFixed(4) : String(v)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Evaluation history chart */}
              {explorer.history.length > 1 && (
                <div>
                  <h3 className="text-xs font-semibold text-slate-400 mb-2">Fitness History</h3>
                  <ResponsiveContainer width="100%" height={120}>
                    <LineChart
                      data={[...explorer.history].reverse().map((r, i) => ({
                        eval: i + 1,
                        fitness: r.fitness_score ?? 0,
                        test_ppg: r.test_pnl_per_game ?? 0,
                      }))}
                      margin={{ top: 4, right: 4, bottom: 0, left: -20 }}
                    >
                      <XAxis dataKey="eval" tick={{ fontSize: 9 }} />
                      <YAxis tick={{ fontSize: 9 }} />
                      <Tooltip contentStyle={{ background: '#16161a', border: '1px solid #333', fontSize: 10 }} formatter={(v: number) => v.toFixed(4)} />
                      <Line dataKey="fitness" stroke="#8B1A4A" dot={false} strokeWidth={2} name="Fitness" />
                      <Line dataKey="test_ppg" stroke="#22c55e" dot={false} strokeWidth={1} name="Test PPG" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
