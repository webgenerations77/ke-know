'use client';

import { useEffect, useState, useMemo } from 'react';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Cell, ReferenceLine,
} from 'recharts';
import { supabase, Game, SyncLog, Strategy, StrategyResult, EvolutionState } from '@/lib/supabase';
import { computeNumberStats } from '@/lib/analysis';
import { computeMomentum, DOW_LABELS } from '@/lib/prediction-engine';

const CRIMSON = '#8B1A4A';
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="bg-surface rounded-xl p-4">
      <div className="text-xs text-slate-500 mb-1">{label}</div>
      <div className={`text-xl font-bold ${accent ?? 'text-white'}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

const WINDOW_OPTIONS = [
  { label: '100', value: 100 },
  { label: '500', value: 500 },
  { label: '1,000', value: 1000 },
  { label: '2,500', value: 2500 },
  { label: '5,000', value: 5000 },
];

export default function DashboardPage() {
  const [games, setGames] = useState<Game[]>([]);
  const [totalDbCount, setTotalDbCount] = useState(0);
  const [syncLog, setSyncLog] = useState<SyncLog[]>([]);
  const [evoState, setEvoState] = useState<EvolutionState | null>(null);
  const [overallChamp, setOverallChamp] = useState<(Strategy & { fitness: number | null }) | null>(null);
  const [evoTrend, setEvoTrend] = useState<'improving' | 'plateauing' | 'regressing' | null>(null);
  const [loading, setLoading] = useState(true);

  // Filters
  const [windowSize, setWindowSize] = useState(5000);
  const [dowFilter, setDowFilter] = useState<number | null>(null);

  useEffect(() => {
    Promise.all([
      // Real count — separate from the data fetch so it's never capped
      supabase.from('games').select('*', { count: 'exact', head: true }),
      supabase.from('games').select('*').order('game_num', { ascending: false }).limit(5000),
      supabase.from('sync_log').select('*').order('synced_at', { ascending: false }).limit(10),
      supabase.from('evolution_state').select('*').eq('id', 1).maybeSingle(),
      supabase.from('strategies').select('*').eq('status', 'promoted').limit(50),
      supabase.from('strategy_results').select('generation,fitness_score').order('generation', { ascending: false }).limit(2000),
    ]).then(([{ count }, { data: gData }, { data: sData }, { data: evoData }, { data: promotedData }, { data: gfData }]) => {
      setTotalDbCount(count ?? 0);
      if (gData) setGames(gData as Game[]);
      if (sData) setSyncLog(sData as SyncLog[]);
      if (evoData) setEvoState(evoData as EvolutionState);

      // Resolve overall champion among promoted strategies via their latest strategy_results row
      (async () => {
        const promoted = (promotedData ?? []) as Strategy[];
        if (promoted.length === 0) { setOverallChamp(null); return; }
        const { data: results } = await supabase
          .from('strategy_results')
          .select('*')
          .in('strategy_id', promoted.map(p => p.id))
          .order('evaluated_at', { ascending: false })
          .limit(500);
        const latestByStrategy = new Map<number, StrategyResult>();
        for (const r of (results ?? []) as StrategyResult[]) {
          if (!latestByStrategy.has(r.strategy_id)) latestByStrategy.set(r.strategy_id, r);
        }
        let best: Strategy | null = null;
        let bestFitness = -Infinity;
        for (const p of promoted) {
          const f = latestByStrategy.get(p.id)?.fitness_score ?? -Infinity;
          if (f > bestFitness) { bestFitness = f; best = p; }
        }
        setOverallChamp(best ? { ...best, fitness: bestFitness === -Infinity ? null : bestFitness } : null);
      })();

      // Trend: best fitness of latest generation vs the one before it
      if (gfData) {
        const byGen = new Map<number, number>();
        for (const row of gfData as { generation: number; fitness_score: number | null }[]) {
          const cur = byGen.get(row.generation) ?? -Infinity;
          if ((row.fitness_score ?? -Infinity) > cur) byGen.set(row.generation, row.fitness_score ?? -Infinity);
        }
        const gens = [...byGen.keys()].sort((a, b) => b - a);
        if (gens.length >= 2) {
          const latest = byGen.get(gens[0])!;
          const prev = byGen.get(gens[1])!;
          const delta = latest - prev;
          setEvoTrend(delta > 0.005 ? 'improving' : delta < -0.005 ? 'regressing' : 'plateauing');
        }
      }

      setLoading(false);
    });
  }, []);

  // Apply window + DOW filter
  const filteredGames = useMemo(() => {
    // games is already sorted newest-first; slice gives the most recent N
    const windowed = games.slice(0, windowSize);
    return dowFilter !== null ? windowed.filter(g => g.draw_dow === dowFilter) : windowed;
  }, [games, windowSize, dowFilter]);

  const activeFilter = dowFilter !== null || windowSize !== 5000;

  if (loading) return <div className="text-slate-500 pt-8">Loading…</div>;

  if (!games.length) {
    return (
      <div className="space-y-4 max-w-5xl">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <div className="bg-surface rounded-xl p-8 text-center text-slate-500">
          <p className="text-lg font-medium text-slate-300 mb-2">No data yet</p>
          <p className="text-sm">Go to <strong>Data Ingestion</strong> to run the backfill.</p>
        </div>
      </div>
    );
  }

  // ── Computations on filtered data ────────────────────────────────────────────
  const sortedAsc = [...filteredGames].sort((a, b) => a.game_num - b.game_num);
  const sortedDesc = [...filteredGames].sort((a, b) => b.game_num - a.game_num);
  const newestDate = sortedDesc[0]?.draw_date ?? '—';
  const oldestDate = sortedAsc[0]?.draw_date ?? '—';
  const dayRange = Math.max(1, (new Date(newestDate).getTime() - new Date(oldestDate).getTime()) / 86400000);
  const avgPerDay = +(filteredGames.length / dayRange).toFixed(1);

  const stats = computeNumberStats(filteredGames);
  const momentum = filteredGames.length >= 50 ? computeMomentum(filteredGames) : [];

  // Sync health (always from full data, not filtered)
  const lastSync = syncLog[0];
  const syncAgeMs = lastSync ? Date.now() - new Date(lastSync.synced_at).getTime() : null;
  const syncAgeMins = syncAgeMs ? Math.round(syncAgeMs / 60000) : null;
  const syncHealth = syncAgeMins === null ? 'Unknown' : syncAgeMins < 90 ? 'Current' : syncAgeMins < 360 ? 'Slightly stale' : 'Stale';
  const syncColor = syncAgeMins === null ? 'text-slate-400' : syncAgeMins < 90 ? 'text-green-400' : syncAgeMins < 360 ? 'text-yellow-400' : 'text-red-400';

  // Top-20 hit rate over last 50 filtered draws
  const top20Nums = new Set(stats.slice(0, 20).map(s => s.number));
  const recentAccuracy = sortedDesc.slice(0, 50).map((g, i) => ({
    game: sortedDesc.length - i,
    hits: g.hits.filter(h => top20Nums.has(h)).length,
  })).reverse();
  const avgAccuracy = recentAccuracy.length
    ? recentAccuracy.reduce((s, r) => s + r.hits, 0) / recentAccuracy.length
    : 0;

  // Momentum chart data
  const rising = momentum.filter(m => m.trend === 'rising').sort((a, b) => b.momentumNorm - a.momentumNorm).slice(0, 5);
  const falling = momentum.filter(m => m.trend === 'falling').sort((a, b) => a.momentumNorm - b.momentumNorm).slice(0, 5);
  const momentumChartData = [
    ...rising.map(m => ({ number: m.number, value: m.recentCount - m.priorCount, type: 'rising' })),
    ...falling.map(m => ({ number: m.number, value: m.recentCount - m.priorCount, type: 'falling' })),
  ].sort((a, b) => b.value - a.value);

  // Recent draws for display
  const recentDraws = sortedDesc.slice(0, 8);

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        {activeFilter && (
          <button
            onClick={() => { setWindowSize(5000); setDowFilter(null); }}
            className="text-xs text-crimson hover:underline"
          >
            Clear filters ✕
          </button>
        )}
      </div>

      {/* ── Filter Bar ─────────────────────────────────────────────────────── */}
      <div className="bg-surface rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap gap-6">
          {/* Analysis window */}
          <div>
            <div className="text-xs text-slate-500 mb-2">Analysis Window (most recent games)</div>
            <div className="flex gap-1 flex-wrap">
              {WINDOW_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setWindowSize(opt.value)}
                  disabled={totalDbCount < opt.value}
                  className={`px-3 py-1 rounded text-xs font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                    windowSize === opt.value
                      ? 'bg-crimson text-white'
                      : 'bg-[#0e0e10] text-slate-400 border border-[#333] hover:text-white'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Day of week */}
          <div>
            <div className="text-xs text-slate-500 mb-2">Day of Week</div>
            <div className="flex gap-1 flex-wrap">
              <button
                onClick={() => setDowFilter(null)}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                  dowFilter === null
                    ? 'bg-crimson text-white'
                    : 'bg-[#0e0e10] text-slate-400 border border-[#333] hover:text-white'
                }`}
              >
                All Days
              </button>
              {DOW_SHORT.map((d, i) => (
                <button
                  key={i}
                  onClick={() => setDowFilter(dowFilter === i ? null : i)}
                  className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                    dowFilter === i
                      ? 'bg-crimson text-white'
                      : 'bg-[#0e0e10] text-slate-400 border border-[#333] hover:text-white'
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Active filter summary */}
        {activeFilter && (
          <div className="text-xs text-slate-400 pt-1 border-t border-[#1e1e24]">
            Analyzing <strong className="text-white">{filteredGames.length.toLocaleString()}</strong> games
            {dowFilter !== null ? ` on ${DOW_LABELS[dowFilter]}s` : ''}
            {` from last ${windowSize.toLocaleString()} draws`}
          </div>
        )}
      </div>

      {/* ── Summary metrics ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <StatCard
          label="Games in DB"
          value={totalDbCount.toLocaleString()}
          sub={`Analyzing ${filteredGames.length.toLocaleString()}${activeFilter ? ' (filtered)' : ''}`}
        />
        <StatCard
          label={dowFilter !== null ? `Avg Draws / Day (${DOW_LABELS[dowFilter]}s)` : 'Avg Draws / Day'}
          value={avgPerDay.toString()}
          sub={`${oldestDate} → ${newestDate}`}
        />
        <StatCard
          label="Sync Status"
          value={syncHealth}
          sub={syncAgeMins !== null ? `${syncAgeMins}m ago · +${lastSync?.games_added ?? 0} last sync` : 'Never synced'}
          accent={syncColor}
        />
      </div>

      {/* ── Evolution status ────────────────────────────────────────────────── */}
      {evoState && (
        <div className="bg-surface rounded-xl p-4">
          <div className="flex justify-between items-center mb-3">
            <h2 className="text-sm font-semibold text-slate-300">Evolution Engine</h2>
            <a href="/admin/strategy-lab" className="text-xs text-crimson hover:underline">Strategy Lab →</a>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <div className="text-xs text-slate-500">Generation</div>
              <div className="text-lg font-bold text-white">{evoState.current_generation}</div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Last Run</div>
              <div className="text-lg font-bold text-white">
                {evoState.last_run_at ? new Date(evoState.last_run_at).toLocaleString() : '—'}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Champion</div>
              <div className="text-lg font-bold text-white">
                {overallChamp ? `${overallChamp.spot_count}-spot` : '—'}
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                {overallChamp?.fitness != null ? `Fitness ${overallChamp.fitness.toFixed(4)}` : 'No promoted strategy yet'}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Trend</div>
              <div className={`text-lg font-bold ${
                evoTrend === 'improving' ? 'text-green-400'
                  : evoTrend === 'regressing' ? 'text-red-400'
                  : evoTrend === 'plateauing' ? 'text-yellow-400'
                  : 'text-slate-500'
              }`}>
                {evoTrend === 'improving' ? '↑ Improving'
                  : evoTrend === 'regressing' ? '↓ Regressing'
                  : evoTrend === 'plateauing' ? '→ Plateauing'
                  : '—'}
              </div>
            </div>
          </div>
        </div>
      )}

      {filteredGames.length < 50 && (
        <div className="bg-yellow-900/20 border border-yellow-800 rounded-xl p-4 text-sm text-yellow-300">
          Not enough data with the current filter ({filteredGames.length} games). Try widening the window or removing the day filter.
        </div>
      )}

      {/* ── Charts ─────────────────────────────────────────────────────────── */}
      {filteredGames.length >= 50 && (
        <div className="grid md:grid-cols-2 gap-6">
          <div className="bg-surface rounded-xl p-4">
            <h2 className="text-sm font-semibold mb-1 text-slate-300">Top-20 Hit Rate (Last 50 Draws)</h2>
            <p className="text-xs text-slate-500 mb-3">
              How many of the current top-20 scored numbers appeared in each recent draw.
              Baseline: 5/draw · Avg: <strong className="text-white">{avgAccuracy.toFixed(1)}</strong>
            </p>
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={recentAccuracy}>
                <XAxis dataKey="game" hide />
                <YAxis domain={[0, 12]} tick={{ fill: '#64748b', fontSize: 10 }} />
                <Tooltip
                  contentStyle={{ background: '#16161a', border: '1px solid #333', borderRadius: 8 }}
                  formatter={(v: number) => [v, 'Hits from top 20']}
                  labelFormatter={v => `Draw #${v}`}
                />
                <ReferenceLine y={5} stroke="#4a4a5a" strokeDasharray="4 2" />
                <Line type="monotone" dataKey="hits" stroke={CRIMSON} dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="bg-surface rounded-xl p-4">
            <h2 className="text-sm font-semibold mb-1 text-slate-300">Number Momentum</h2>
            <p className="text-xs text-slate-500 mb-3">
              Frequency change: recent half vs prior half of analysis window. Green = trending up.
            </p>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={momentumChartData} layout="vertical">
                <XAxis type="number" tick={{ fill: '#64748b', fontSize: 10 }} />
                <YAxis dataKey="number" type="category" width={28} tick={{ fill: '#94a3b8', fontSize: 11 }} />
                <Tooltip
                  contentStyle={{ background: '#16161a', border: '1px solid #333', borderRadius: 8 }}
                  formatter={(v: number) => [v > 0 ? `+${v}` : v, 'Δ frequency']}
                />
                <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                  {momentumChartData.map((d, i) => (
                    <Cell key={i} fill={d.type === 'rising' ? '#22c55e' : '#ef4444'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* ── Recent draws ────────────────────────────────────────────────────── */}
      <div className="bg-surface rounded-xl p-4">
        <h2 className="text-sm font-semibold mb-3 text-slate-300">
          Recent Draws {dowFilter !== null ? `(${DOW_LABELS[dowFilter]}s)` : ''}
        </h2>
        {recentDraws.length === 0 ? (
          <p className="text-sm text-slate-500">No draws match the current filter.</p>
        ) : (
          <>
            <div className="space-y-2">
              {recentDraws.map(g => {
                const topHits = g.hits.filter(h => top20Nums.has(h));
                return (
                  <div key={g.game_num} className="flex items-start gap-3 py-2 border-b border-[#1e1e24] last:border-0">
                    <div className="text-xs text-slate-500 w-20 shrink-0">
                      <div className="font-mono">#{g.game_num}</div>
                      <div>{g.draw_date}</div>
                      {g.draw_dow !== null && <div className="text-slate-600">{DOW_SHORT[g.draw_dow]}</div>}
                    </div>
                    <div className="flex flex-wrap gap-1 flex-1">
                      {g.hits.sort((a, b) => a - b).map(h => (
                        <span key={h}
                          className={`w-6 h-6 rounded flex items-center justify-center text-xs font-bold ${
                            top20Nums.has(h) ? 'bg-crimson/80 text-white' : 'bg-[#1e1e24] text-slate-500'
                          }`}
                        >
                          {h}
                        </span>
                      ))}
                    </div>
                    <div className="text-xs text-slate-500 shrink-0 text-right">
                      <div className="text-crimson font-semibold">{topHits.length}/20</div>
                      {g.bonus ? <div>B×{g.bonus}</div> : null}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-slate-600 mt-2">Crimson = in current top-20 picks.</p>
          </>
        )}
      </div>

      {/* ── Sync history ────────────────────────────────────────────────────── */}
      <div className="bg-surface rounded-xl p-4">
        <h2 className="text-sm font-semibold mb-3 text-slate-300">Recent Sync Activity</h2>
        {syncLog.length === 0 ? (
          <p className="text-sm text-slate-500">No sync history yet.</p>
        ) : (
          <div className="space-y-1">
            {syncLog.slice(0, 8).map(s => (
              <div key={s.id} className="flex justify-between text-xs py-1 border-b border-[#1e1e24] last:border-0 gap-4">
                <span className="text-slate-500 shrink-0">{new Date(s.synced_at).toLocaleString()}</span>
                <span className="text-slate-400 capitalize shrink-0">{s.source}</span>
                <span className={`shrink-0 ${s.games_added > 0 ? 'text-green-400' : 'text-slate-500'}`}>
                  {s.games_added > 0 ? `+${s.games_added} games` : 'up to date'}
                </span>
                <span className="text-slate-600 truncate">{s.notes}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
