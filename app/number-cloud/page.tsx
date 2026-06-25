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

const SVG_W = 800;
const SVG_H = 520;
const MIN_R = 15;
const MAX_R = 50;

function getScore(s: NumberStats, mode: Mode): number {
  return mode === 'frequency' ? s.count : mode === 'recency' ? s.recencyScore : s.compositeScore;
}

function buildLayout(
  stats: NumberStats[],
  mode: Mode,
): { stat: NumberStats; r: number; x: number; y: number }[] {
  if (stats.length === 0) return [];

  const values = stats.map(s => getScore(s, mode));
  const maxVal = Math.max(...values, 1);
  const minVal = Math.min(...values, 0);

  // Largest circles at center, smallest at outer edge
  const sorted = [...stats].sort((a, b) => getScore(b, mode) - getScore(a, mode));

  const cx = SVG_W / 2;
  const cy = SVG_H / 2;
  // Golden angle: produces natural-looking, uniform spiral density
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));

  return sorted.map((stat, i) => {
    const t = maxVal > minVal ? (getScore(stat, mode) - minVal) / (maxVal - minVal) : 0.5;
    const r = MIN_R + t * (MAX_R - MIN_R);

    if (i === 0) return { stat, r, x: cx, y: cy };

    const angle = i * goldenAngle;
    const spiralR = Math.sqrt(i / sorted.length) * Math.min(SVG_W, SVG_H) * 0.45;
    const rawX = cx + Math.cos(angle) * spiralR;
    const rawY = cy + Math.sin(angle) * spiralR * 0.82; // slightly elliptical

    return {
      stat,
      r,
      x: Math.max(r + 4, Math.min(SVG_W - r - 4, rawX)),
      y: Math.max(r + 4, Math.min(SVG_H - r - 4, rawY)),
    };
  });
}

export default function NumberCloudPage() {
  const [games, setGames] = useState<Game[]>([]);
  const [mode, setMode] = useState<Mode>('composite');
  const [hovered, setHovered] = useState<NumberStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase
      .from('games')
      .select('*')
      .order('game_num', { ascending: false })
      .limit(5000)
      .then(({ data }) => {
        if (data) setGames(data as Game[]);
        setLoading(false);
      });
  }, []);

  const stats = useMemo(() => computeNumberStats(games), [games]);
  const bubbles = useMemo(() => buildLayout(stats, mode), [stats, mode]);
  const top10 = useMemo(() => {
    const sorted = [...stats].sort((a, b) => getScore(b, mode) - getScore(a, mode));
    return new Set(sorted.slice(0, 10).map(s => s.number));
  }, [stats, mode]);

  if (loading) return <div className="text-slate-500 pt-8">Loading...</div>;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Number Cloud</h1>
          <p className="text-sm text-slate-500 mt-1">
            Bubble size = score · Color = status · Top 10 pulse with glow
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {(['composite', 'frequency', 'recency'] as Mode[]).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                mode === m
                  ? 'bg-crimson text-white'
                  : 'bg-surface text-slate-400 border border-[#333] hover:text-white'
              }`}
            >
              {m === 'composite' ? 'Composite' : m === 'frequency' ? 'Frequency' : 'Recency'}
            </button>
          ))}
        </div>
      </div>

      {/* Tooltip — always rendered to prevent layout shift, toggled by opacity */}
      <div
        className={`bg-surface rounded-xl px-4 py-3 text-sm flex flex-wrap gap-x-5 gap-y-1 items-center border transition-opacity duration-150 ${
          hovered ? 'border-[#2a2a2e] opacity-100' : 'border-transparent opacity-0 pointer-events-none'
        }`}
        style={{ minHeight: '3.25rem' }}
      >
        {hovered && (
          <>
            <span className="text-2xl font-bold text-white">{hovered.number}</span>
            <span className="text-slate-400">
              Drawn <span className="text-white font-medium">{hovered.count}x</span>{' '}
              · {hovered.pct.toFixed(1)}% of games
            </span>
            <span className="text-slate-400">
              Score <span className="text-crimson font-mono">{hovered.compositeScore.toFixed(3)}</span>
            </span>
            <span className="text-slate-400">
              Last seen{' '}
              {hovered.lastSeen === null
                ? 'never'
                : hovered.lastSeen === 0
                ? 'last game'
                : `${hovered.lastSeen}g ago`}
            </span>
            <span className="text-slate-400">
              Rank <span className="text-white">#{hovered.rank}</span>
            </span>
            <span
              className="px-2 py-0.5 rounded-full text-xs font-medium"
              style={{
                background: STATUS_COLORS[hovered.status] + '30',
                color: STATUS_COLORS[hovered.status],
              }}
            >
              {hovered.status}
            </span>
          </>
        )}
      </div>

      {/* Bubble cloud */}
      <div className="bg-surface rounded-xl overflow-hidden">
        <svg
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          width="100%"
          style={{ display: 'block' }}
        >
          <defs>
            <filter id="nc-glow" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter id="nc-glow-strong" x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur stdDeviation="9" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <style>{`
              @keyframes nc-pulse-a {
                0%   { opacity: 0.7; }
                100% { opacity: 0; }
              }
              @keyframes nc-pulse-b {
                0%   { opacity: 0.45; }
                100% { opacity: 0; }
              }
            `}</style>
          </defs>

          {bubbles.map(({ stat, r, x, y }) => {
            const color = STATUS_COLORS[stat.status] ?? STATUS_COLORS.Normal;
            const isTop = top10.has(stat.number);
            const isHov = hovered?.number === stat.number;
            const delay = `${(stat.number % 10) * 0.22}s`;

            return (
              <g
                key={stat.number}
                transform={`translate(${x},${y})`}
                onMouseEnter={() => setHovered(stat)}
                onMouseLeave={() => setHovered(null)}
                style={{ cursor: 'pointer' }}
              >
                {/* Dual expanding pulse rings — top-10 only */}
                {isTop && (
                  <>
                    <circle
                      r={r + 8}
                      fill="none"
                      stroke={color}
                      strokeWidth="1.5"
                      style={{
                        animation: 'nc-pulse-a 2.6s ease-out infinite',
                        animationDelay: delay,
                        opacity: 0,
                      }}
                    />
                    <circle
                      r={r + 18}
                      fill="none"
                      stroke={color}
                      strokeWidth="1"
                      style={{
                        animation: 'nc-pulse-b 2.6s ease-out infinite',
                        animationDelay: `calc(${delay} + 0.55s)`,
                        opacity: 0,
                      }}
                    />
                  </>
                )}

                {/* Main bubble */}
                <circle
                  r={isHov ? r * 1.14 : r}
                  fill={`${color}${isHov ? 'dd' : isTop ? 'aa' : '55'}`}
                  stroke={color}
                  strokeWidth={isHov ? 2.5 : isTop ? 1.5 : 0.7}
                  filter={isHov ? 'url(#nc-glow-strong)' : isTop ? 'url(#nc-glow)' : undefined}
                  style={{ transition: 'r 0.12s ease, fill 0.12s ease' }}
                />

                {/* Number label */}
                <text
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={Math.max(9, r * 0.62)}
                  fontWeight={isHov ? '800' : isTop ? '700' : '500'}
                  fill={isHov || isTop ? '#ffffff' : '#94a3b8'}
                  style={{ pointerEvents: 'none', userSelect: 'none' }}
                >
                  {stat.number}
                </text>
              </g>
            );
          })}
        </svg>
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
        <span className="text-slate-600">Larger = higher score · Top 10 pulse</span>
      </div>

      {games.length === 0 && (
        <p className="text-slate-500 text-sm">
          No data yet — run the backfill on the Data Ingestion page.
        </p>
      )}
    </div>
  );
}
