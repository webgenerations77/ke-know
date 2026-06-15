'use client';

import { useEffect, useState } from 'react';
import { supabase, Game } from '@/lib/supabase';
import { computeNumberStats, NumberStats } from '@/lib/analysis';

type Mode = 'frequency' | 'recency' | 'composite';

function interpolateColor(t: number) {
  // dark blue -> crimson gradient based on 0..1
  const r = Math.round(14 + t * (139 - 14));
  const g = Math.round(14 + t * (26 - 14));
  const b = Math.round(16 + t * (74 - 16));
  return `rgb(${r},${g},${b})`;
}

export default function HeatmapPage() {
  const [games, setGames] = useState<Game[]>([]);
  const [mode, setMode] = useState<Mode>('composite');
  const [hovered, setHovered] = useState<NumberStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.from('games').select('*').order('game_num', { ascending: false }).limit(5000)
      .then(({ data }) => { if (data) setGames(data as Game[]); setLoading(false); });
  }, []);

  const stats = computeNumberStats(games);
  const top20 = new Set(stats.slice(0, 20).map(s => s.number));

  const scoreFor = (s: NumberStats) => {
    if (mode === 'frequency') return s.count;
    if (mode === 'recency') return s.recencyScore;
    return s.compositeScore;
  };

  const values = stats.map(scoreFor);
  const maxVal = Math.max(...values, 1);
  const minVal = Math.min(...values, 0);

  const statsMap = new Map(stats.map(s => [s.number, s]));

  if (loading) return <div className="text-slate-500 pt-8">Loading…</div>;

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-2xl font-bold">Heatmap</h1>

      <div className="flex gap-2 flex-wrap">
        {(['composite', 'frequency', 'recency'] as Mode[]).map(m => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              mode === m ? 'bg-crimson text-white' : 'bg-surface text-slate-400 border border-[#333] hover:text-white'
            }`}
          >
            {m === 'composite' ? 'Composite Score' : m === 'frequency' ? 'Raw Frequency' : 'Recency-Weighted'}
          </button>
        ))}
      </div>

      {hovered && (
        <div className="bg-surface rounded-xl px-4 py-3 text-sm flex flex-wrap gap-4">
          <span className="font-bold text-white text-lg">{hovered.number}</span>
          <span className="text-slate-400">Drawn {hovered.count}× · {hovered.pct.toFixed(1)}% of games</span>
          <span className="text-slate-400">Composite: {hovered.compositeScore.toFixed(3)}</span>
          <span className="text-slate-400">Last seen: {hovered.lastSeen === null ? 'Never' : hovered.lastSeen === 0 ? 'Last game' : `${hovered.lastSeen}g ago`}</span>
          <span className="text-slate-400">Rank: #{hovered.rank}</span>
        </div>
      )}

      <div className="bg-surface rounded-xl p-4">
        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(10, minmax(0, 1fr))' }}>
          {Array.from({ length: 80 }, (_, i) => i + 1).map(num => {
            const s = statsMap.get(num);
            const val = s ? scoreFor(s) : 0;
            const t = maxVal > minVal ? (val - minVal) / (maxVal - minVal) : 0;
            const bg = interpolateColor(t);
            const isTop = top20.has(num);
            return (
              <div
                key={num}
                onMouseEnter={() => setHovered(s ?? null)}
                onMouseLeave={() => setHovered(null)}
                className="relative aspect-square rounded-lg flex items-center justify-center cursor-pointer transition-transform hover:scale-110"
                style={{ background: bg }}
              >
                <span className="text-xs font-bold text-white/90 select-none">{num}</span>
                {isTop && (
                  <span className="absolute top-0 right-0 w-2 h-2 rounded-full bg-yellow-400" />
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-4 flex items-center gap-3 text-xs text-slate-500">
          <div className="w-4 h-4 rounded-full bg-yellow-400" />
          <span>Top 20 picks</span>
          <div className="flex-1 h-1.5 rounded-full" style={{ background: 'linear-gradient(to right, rgb(14,14,16), rgb(139,26,74))' }} />
          <span>Low → High</span>
        </div>
      </div>

      {games.length === 0 && (
        <p className="text-slate-500 text-sm">No data yet — run the backfill on the Data Ingestion page.</p>
      )}
    </div>
  );
}
