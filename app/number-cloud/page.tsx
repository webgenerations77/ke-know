'use client';

import { useEffect, useState, useMemo } from 'react';
import { supabase, Game } from '@/lib/supabase';
import { computeNumberStats, NumberStats } from '@/lib/analysis';

type Mode = 'composite' | 'frequency' | 'recency';

const STATUS_COLORS: Record<string, string> = {
  Hot: '#dc2626',
  Cold: '#3b82f6',
  Overdue: '#f59e0b',
  'On Streak': '#22c55e',
  Normal: '#94a3b8',
};

const MIN_FONT = 13;
const MAX_FONT = 54;

function seededShuffle<T>(arr: T[], seed: number): T[] {
  const out = [...arr];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export default function NumberCloudPage() {
  const [games, setGames] = useState<Game[]>([]);
  const [mode, setMode] = useState<Mode>('composite');
  const [hovered, setHovered] = useState<NumberStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.from('games').select('*').order('game_num', { ascending: false }).limit(5000)
      .then(({ data }) => { if (data) setGames(data as Game[]); setLoading(false); });
  }, []);

  const stats = useMemo(() => computeNumberStats(games), [games]);

  const scoreFor = (s: NumberStats) =>
    mode === 'frequency' ? s.count : mode === 'recency' ? s.recencyScore : s.compositeScore;

  const values = stats.map(scoreFor);
  const maxVal = Math.max(...values, 1);
  const minVal = Math.min(...values, 0);

  const shuffled = useMemo(
    () => seededShuffle(stats, 42 + mode.length),
    [stats, mode]
  );

  const top10 = useMemo(() => {
    const sorted = [...stats].sort((a, b) => scoreFor(b) - scoreFor(a));
    return new Set(sorted.slice(0, 10).map(s => s.number));
  }, [stats, mode]);

  if (loading) return <div className="text-slate-500 pt-8">Loading...</div>;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Number Cloud</h1>
          <p className="text-sm text-slate-500 mt-1">Numbers sized by significance — bigger means higher score</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {(['composite', 'frequency', 'recency'] as Mode[]).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                mode === m ? 'bg-crimson text-white' : 'bg-surface text-slate-400 border border-[#333] hover:text-white'
              }`}
            >
              {m === 'composite' ? 'Composite' : m === 'frequency' ? 'Frequency' : 'Recency'}
            </button>
          ))}
        </div>
      </div>

      {/* Tooltip */}
      {hovered && (
        <div className="bg-surface rounded-xl px-4 py-3 text-sm flex flex-wrap gap-x-5 gap-y-1 items-center">
          <span className="text-2xl font-bold text-white">{hovered.number}</span>
          <span className="text-slate-400">Drawn <span className="text-white font-medium">{hovered.count}x</span> · {hovered.pct.toFixed(1)}% of games</span>
          <span className="text-slate-400">Score <span className="text-crimson font-mono">{hovered.compositeScore.toFixed(3)}</span></span>
          <span className="text-slate-400">Last seen {hovered.lastSeen === null ? 'never' : hovered.lastSeen === 0 ? 'last game' : `${hovered.lastSeen}g ago`}</span>
          <span className="text-slate-400">Rank <span className="text-white">#{hovered.rank}</span></span>
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium`}
            style={{ background: STATUS_COLORS[hovered.status] + '30', color: STATUS_COLORS[hovered.status] }}>
            {hovered.status}
          </span>
        </div>
      )}

      {/* Cloud */}
      <div className="bg-surface rounded-xl p-6 min-h-[420px]">
        <div className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0">
          {shuffled.map(s => {
            const val = scoreFor(s);
            const t = maxVal > minVal ? (val - minVal) / (maxVal - minVal) : 0.5;
            const fontSize = MIN_FONT + t * (MAX_FONT - MIN_FONT);
            const color = STATUS_COLORS[s.status] ?? STATUS_COLORS.Normal;
            const isTop = top10.has(s.number);
            const isHovered = hovered?.number === s.number;

            return (
              <span
                key={s.number}
                onMouseEnter={() => setHovered(s)}
                onMouseLeave={() => setHovered(null)}
                className="inline-block cursor-pointer transition-all duration-200 select-none"
                style={{
                  fontSize: `${fontSize}px`,
                  fontWeight: t > 0.5 ? 800 : t > 0.25 ? 600 : 400,
                  color,
                  opacity: isHovered ? 1 : 0.45 + t * 0.55,
                  lineHeight: 1.3,
                  padding: '0 2px',
                  transform: isHovered ? 'scale(1.2)' : 'none',
                  textShadow: isTop ? `0 0 12px ${color}60` : 'none',
                }}
              >
                {s.number}
              </span>
            );
          })}
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-500 px-1">
        {Object.entries(STATUS_COLORS).map(([label, color]) => (
          <div key={label} className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-full" style={{ background: color }} />
            <span>{label}</span>
          </div>
        ))}
        <span className="text-slate-700 ml-2">|</span>
        <span className="text-slate-600">Larger = higher score · Top 10 have glow effect</span>
      </div>

      {games.length === 0 && (
        <p className="text-slate-500 text-sm">No data yet — run the backfill on the Data Ingestion page.</p>
      )}
    </div>
  );
}
