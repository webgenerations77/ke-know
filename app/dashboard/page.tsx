'use client';

import { useEffect, useState } from 'react';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Cell, ReferenceLine,
} from 'recharts';
import { supabase, Game, SyncLog } from '@/lib/supabase';
import { computeNumberStats } from '@/lib/analysis';
import { computePrediction, computeMomentum, DOW_LABELS } from '@/lib/prediction-engine';

const CRIMSON = '#8B1A4A';

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="bg-surface rounded-xl p-4">
      <div className="text-xs text-slate-500 mb-1">{label}</div>
      <div className={`text-xl font-bold ${accent ?? 'text-white'}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

export default function DashboardPage() {
  const [games, setGames] = useState<Game[]>([]);
  const [syncLog, setSyncLog] = useState<SyncLog[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      supabase.from('games').select('*').order('game_num', { ascending: false }).limit(5000),
      supabase.from('sync_log').select('*').order('synced_at', { ascending: false }).limit(10),
    ]).then(([{ data: gData }, { data: sData }]) => {
      if (gData) setGames(gData as Game[]);
      if (sData) setSyncLog(sData as SyncLog[]);
      setLoading(false);
    });
  }, []);

  if (loading) return <div className="text-slate-500 pt-8">Loading…</div>;

  if (!games.length) {
    return (
      <div className="space-y-4 max-w-5xl">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <div className="bg-surface rounded-xl p-8 text-center text-slate-500">
          <p className="text-lg font-medium text-slate-300 mb-2">No data yet</p>
          <p className="text-sm">Go to <strong>Data Ingestion</strong> to run the backfill and populate the database.</p>
        </div>
      </div>
    );
  }

  // ── Core computations ───────────────────────────────────────────────────────
  const sortedAsc = [...games].sort((a, b) => a.game_num - b.game_num);
  const sortedDesc = [...games].sort((a, b) => b.game_num - a.game_num);
  const newestDate = sortedDesc[0]?.draw_date ?? '—';
  const oldestDate = sortedAsc[0]?.draw_date ?? '—';
  const dayRange = Math.max(1, (new Date(newestDate).getTime() - new Date(oldestDate).getTime()) / 86400000);
  const avgPerDay = +(games.length / dayRange).toFixed(1);

  const stats = computeNumberStats(games);
  const prediction = computePrediction(games, 8);
  const momentum = computeMomentum(games);

  // Sync health
  const lastSync = syncLog[0];
  const syncAgeMs = lastSync ? Date.now() - new Date(lastSync.synced_at).getTime() : null;
  const syncAgeMins = syncAgeMs ? Math.round(syncAgeMs / 60000) : null;
  const syncHealth =
    syncAgeMins === null ? 'Unknown'
    : syncAgeMins < 90 ? 'Current'
    : syncAgeMins < 180 ? 'Slightly stale'
    : 'Stale — sync needed';
  const syncColor =
    syncAgeMins === null ? 'text-slate-400'
    : syncAgeMins < 90 ? 'text-green-400'
    : syncAgeMins < 180 ? 'text-yellow-400'
    : 'text-red-400';

  // ── Prediction accuracy trend ───────────────────────────────────────────────
  // Check how many of the current top-20 appeared in each of the last 50 draws
  const top20Nums = new Set(stats.slice(0, 20).map(s => s.number));
  const recentAccuracy = sortedDesc.slice(0, 50).map((g, i) => ({
    game: sortedDesc.length - i,
    hits: g.hits.filter(h => top20Nums.has(h)).length,
    label: g.draw_date,
  })).reverse();
  const avgAccuracy = recentAccuracy.reduce((s, r) => s + r.hits, 0) / recentAccuracy.length;

  // ── Number momentum: top 5 rising and top 5 falling ────────────────────────
  const rising = momentum
    .filter(m => m.trend === 'rising')
    .sort((a, b) => b.momentumNorm - a.momentumNorm)
    .slice(0, 5);
  const falling = momentum
    .filter(m => m.trend === 'falling')
    .sort((a, b) => a.momentumNorm - b.momentumNorm)
    .slice(0, 5);

  const momentumChartData = [
    ...rising.map(m => ({ number: m.number, value: m.recentCount - m.priorCount, type: 'rising' })),
    ...falling.map(m => ({ number: m.number, value: m.recentCount - m.priorCount, type: 'falling' })),
  ].sort((a, b) => b.value - a.value);

  // ── Recent draws (last 8) ────────────────────────────────────────────────────
  const recentDraws = sortedDesc.slice(0, 8);

  // ── Today's top picks ───────────────────────────────────────────────────────
  const topPicks = prediction.picks.slice(0, 6);

  return (
    <div className="space-y-6 max-w-5xl">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      {/* Core summary metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Games in DB" value={games.length.toLocaleString()} sub={`${oldestDate} → ${newestDate}`} />
        <StatCard label="Avg Draws / Day" value={avgPerDay.toString()} sub="based on full date range" />
        <StatCard
          label="Sync Status"
          value={syncHealth}
          sub={syncAgeMins !== null ? `${syncAgeMins}m ago · ${lastSync?.games_added ?? 0} added` : 'Never synced'}
          accent={syncColor}
        />
        <StatCard
          label="Prediction Confidence"
          value={`${prediction.overallConfidence}/100`}
          sub={`Best day: ${prediction.whenToPlay}`}
          accent={prediction.overallConfidence > 65 ? 'text-green-400' : prediction.overallConfidence > 45 ? 'text-yellow-400' : 'text-slate-300'}
        />
      </div>

      {/* Today's Top Picks + Recommendation */}
      <div className="bg-surface rounded-xl p-5">
        <div className="flex justify-between items-center mb-4">
          <div>
            <h2 className="font-semibold">Today's Algorithm Picks</h2>
            <p className="text-xs text-slate-500 mt-0.5">Top 6 of {prediction.spotCount}-spot recommendation · click a number for signal breakdown</p>
          </div>
          <a href="/prediction-portal" className="text-xs text-crimson hover:underline">Full Portal →</a>
        </div>

        <div className="flex flex-wrap gap-2 mb-4">
          {topPicks.map(p => (
            <div key={p.number}
              className={`w-12 h-12 rounded-lg flex flex-col items-center justify-center cursor-default ${
                p.recommendation === 'Strong Play'
                  ? 'bg-crimson text-white shadow-lg shadow-crimson/20'
                  : 'bg-[#1a3a5e] text-blue-200'
              }`}
            >
              <span className="text-base font-bold">{p.number}</span>
              <span className="text-[9px] opacity-70">{p.confidence}</span>
            </div>
          ))}
          <div className="flex items-center ml-2">
            <a href="/prediction-portal" className="text-xs text-slate-500 hover:text-white">
              +{prediction.picks.length - 6} more →
            </a>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3 text-center">
          <div className="bg-[#0e0e10] rounded-lg p-2">
            <div className="text-xs text-slate-500">Best Day</div>
            <div className="text-sm font-semibold text-white">{prediction.whenToPlay}</div>
          </div>
          <div className="bg-[#0e0e10] rounded-lg p-2">
            <div className="text-xs text-slate-500">Games / Session</div>
            <div className="text-sm font-semibold text-white">{prediction.howManyGames}</div>
          </div>
          <div className="bg-[#0e0e10] rounded-lg p-2">
            <div className="text-xs text-slate-500">Expected Match Rate</div>
            <div className="text-sm font-semibold text-white">~{prediction.predictedMatchRate.toFixed(1)}/draw</div>
          </div>
        </div>
      </div>

      {/* Prediction accuracy trend + Momentum chart */}
      <div className="grid md:grid-cols-2 gap-6">
        <div className="bg-surface rounded-xl p-4">
          <h2 className="text-sm font-semibold mb-1 text-slate-300">Top-20 Pick Hit Rate (Last 50 Draws)</h2>
          <p className="text-xs text-slate-500 mb-3">
            How many of the current top-20 numbers appeared in each recent draw.
            Expected baseline: 5 per draw (20/80). Avg: <strong className="text-white">{avgAccuracy.toFixed(1)}</strong>
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
          <h2 className="text-sm font-semibold mb-1 text-slate-300">Number Momentum (Recent vs Prior)</h2>
          <p className="text-xs text-slate-500 mb-3">
            Change in frequency: last 250 draws vs prior 250. Positive = trending up.
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

      {/* Recent draws */}
      <div className="bg-surface rounded-xl p-4">
        <h2 className="text-sm font-semibold mb-3 text-slate-300">Recent Draws</h2>
        <div className="space-y-2">
          {recentDraws.map(g => {
            const topHits = g.hits.filter(h => top20Nums.has(h));
            return (
              <div key={g.game_num} className="flex items-start gap-3 py-2 border-b border-[#1e1e24] last:border-0">
                <div className="text-xs text-slate-500 w-20 shrink-0">
                  <div className="font-mono">#{g.game_num}</div>
                  <div>{g.draw_date}</div>
                </div>
                <div className="flex flex-wrap gap-1 flex-1">
                  {g.hits.sort((a, b) => a - b).map(h => (
                    <span key={h}
                      className={`w-6 h-6 rounded flex items-center justify-center text-xs font-bold ${
                        top20Nums.has(h)
                          ? 'bg-crimson/80 text-white'
                          : 'bg-[#1e1e24] text-slate-500'
                      }`}
                    >
                      {h}
                    </span>
                  ))}
                </div>
                <div className="text-xs text-slate-500 shrink-0 text-right">
                  <div className="text-crimson font-semibold">{topHits.length}/20 top picks</div>
                  {g.bonus && <div>B×{g.bonus}</div>}
                </div>
              </div>
            );
          })}
        </div>
        <p className="text-xs text-slate-600 mt-2">Crimson numbers are in the current top-20 picks.</p>
      </div>

      {/* Sync history */}
      <div className="bg-surface rounded-xl p-4">
        <h2 className="text-sm font-semibold mb-3 text-slate-300">Recent Sync Activity</h2>
        {syncLog.length === 0 ? (
          <p className="text-sm text-slate-500">No sync history yet.</p>
        ) : (
          <div className="space-y-1">
            {syncLog.slice(0, 8).map(s => (
              <div key={s.id} className="flex justify-between text-xs py-1 border-b border-[#1e1e24] last:border-0">
                <span className="text-slate-500">{new Date(s.synced_at).toLocaleString()}</span>
                <span className="text-slate-400 capitalize">{s.source}</span>
                <span className={s.games_added > 0 ? 'text-green-400' : 'text-slate-500'}>
                  {s.games_added > 0 ? `+${s.games_added} games` : 'up to date'}
                </span>
                <span className="text-slate-600 max-w-xs truncate">{s.notes}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
