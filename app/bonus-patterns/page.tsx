'use client';

import { useEffect, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, Legend,
} from 'recharts';
import { supabase, Game } from '@/lib/supabase';
import { computeBonusDist, computeNumberStats, expectedMultiplierFromDist } from '@/lib/analysis';
import { computeEV } from '@/lib/keno-odds';

const CRIMSON = '#8B1A4A';
const PURPLE = '#7c3aed';
const GOLD = '#d97706';

export default function BonusPatternsPage() {
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.from('games').select('*').order('game_num', { ascending: false }).limit(5000)
      .then(({ data }) => { if (data) setGames(data as Game[]); setLoading(false); });
  }, []);

  const bonusDist = computeBonusDist(games, 'bonus');
  const superDist = computeBonusDist(games, 'super_bonus');
  const bonusMult = bonusDist.length ? expectedMultiplierFromDist(bonusDist) : 2.0;
  const superMult = superDist.length ? expectedMultiplierFromDist(superDist) : 3.3;

  // Top 10 numbers per bonus level
  function topNumsAtBonus(field: 'bonus' | 'super_bonus', mult: number) {
    const subGames = games.filter(g => g[field] === mult);
    if (subGames.length < 5) return [];
    const freq = new Map<number, number>();
    for (const g of subGames) for (const h of g.hits) freq.set(h, (freq.get(h) ?? 0) + 1);
    return Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([number, count]) => ({ number, count, pct: (count / subGames.length) * 100 }));
  }

  // EV comparison for 6 spots (best EV spot)
  const bestSpots = 6;
  const baseEv = computeEV(bestSpots);
  const evData = [
    { name: 'Base ($1)', ev: baseEv, fill: '#475569' },
    { name: 'Bonus ($2)', ev: (baseEv * bonusMult) / 2, fill: CRIMSON },
    { name: 'Super Bonus ($3)', ev: (baseEv * superMult) / 3, fill: PURPLE },
  ];

  const bonusLevels = [...new Set(bonusDist.map(d => d.multiplier))];
  const superLevels = [...new Set(superDist.map(d => d.multiplier))];

  if (loading) return <div className="text-slate-500 pt-8">Loading…</div>;

  return (
    <div className="space-y-6 max-w-4xl">
      <h1 className="text-2xl font-bold">Bonus Patterns</h1>

      {games.length === 0 && (
        <p className="text-slate-500 text-sm">No data yet — run the backfill on the Data Ingestion page.</p>
      )}

      {/* Distributions */}
      <div className="grid md:grid-cols-2 gap-6">
        <div className="bg-surface rounded-xl p-4">
          <h2 className="text-sm font-semibold mb-1 text-slate-300">Bonus Multiplier Distribution</h2>
          <p className="text-xs text-slate-500 mb-3">
            {bonusDist.length ? `Based on ${games.filter(g => g.bonus).length} draws with bonus data` : 'No data'}
            {bonusDist.length ? ` · E[mult] = ${bonusMult.toFixed(2)}×` : ''}
          </p>
          {bonusDist.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={bonusDist}>
                <XAxis dataKey="multiplier" tick={{ fill: '#94a3b8', fontSize: 11 }} tickFormatter={v => `${v}×`} />
                <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} />
                <Tooltip
                  contentStyle={{ background: '#16161a', border: '1px solid #333', borderRadius: 8 }}
                  formatter={(v: number, n: string) => [n === 'count' ? v : `${(v * 100).toFixed(1)}%`, n === 'count' ? 'Count' : 'Probability']}
                  labelFormatter={v => `${v}× multiplier`}
                />
                <Bar dataKey="count" fill={CRIMSON} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <div className="h-48 flex items-center justify-center text-slate-600 text-sm">No bonus data</div>}
        </div>

        <div className="bg-surface rounded-xl p-4">
          <h2 className="text-sm font-semibold mb-1 text-slate-300">Super Bonus Multiplier Distribution</h2>
          <p className="text-xs text-slate-500 mb-3">
            {superDist.length ? `E[mult] = ${superMult.toFixed(2)}×` : 'No data'}
          </p>
          {superDist.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={superDist}>
                <XAxis dataKey="multiplier" tick={{ fill: '#94a3b8', fontSize: 11 }} tickFormatter={v => `${v}×`} />
                <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} />
                <Tooltip
                  contentStyle={{ background: '#16161a', border: '1px solid #333', borderRadius: 8 }}
                  formatter={(v: number) => [v, 'Count']}
                  labelFormatter={v => `${v}× multiplier`}
                />
                <Bar dataKey="count" fill={PURPLE} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <div className="h-48 flex items-center justify-center text-slate-600 text-sm">No super bonus data</div>}
        </div>
      </div>

      {/* EV comparison */}
      <div className="bg-surface rounded-xl p-4">
        <h2 className="text-sm font-semibold mb-1 text-slate-300">Historical EV Comparison ({bestSpots}-spot, per $1 spent)</h2>
        <p className="text-xs text-slate-500 mb-3">
          Expected return per dollar wagered, using actual DB multiplier frequencies.
        </p>
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={evData} layout="vertical">
            <XAxis type="number" tick={{ fill: '#94a3b8', fontSize: 11 }} tickFormatter={v => `${(v * 100).toFixed(1)}¢`} />
            <YAxis dataKey="name" type="category" width={120} tick={{ fill: '#94a3b8', fontSize: 11 }} />
            <Tooltip
              contentStyle={{ background: '#16161a', border: '1px solid #333', borderRadius: 8 }}
              formatter={(v: number) => [`${(v * 100).toFixed(2)}¢`, 'Expected return per $1']}
            />
            <Bar dataKey="ev" radius={[0, 4, 4, 0]}>
              {evData.map((d, i) => <Cell key={i} fill={d.fill} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Top 10 numbers per bonus level */}
      {bonusLevels.slice(0, 3).map(mult => {
        const top = topNumsAtBonus('bonus', mult);
        if (!top.length) return null;
        return (
          <div key={mult} className="bg-surface rounded-xl p-4">
            <h2 className="text-sm font-semibold mb-3 text-slate-300">
              Top 10 numbers at Bonus {mult}×
            </h2>
            <div className="flex flex-wrap gap-2">
              {top.map(({ number, count, pct }) => (
                <div key={number} className="bg-[#0e0e10] rounded-lg px-3 py-2 text-center">
                  <div className="text-lg font-bold text-white">{number}</div>
                  <div className="text-xs text-slate-500">{count}× · {pct.toFixed(1)}%</div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
