'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import { supabase, Game } from '@/lib/supabase';
import {
  computeCooccurrence, pairsForNumber, PairEntry,
  computeDowFreq, hotNumbersByDow,
} from '@/lib/analysis';

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

type SortMode = 'count' | 'lift';

export default function PairPatternsPage() {
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<number | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>('count');
  const [selectedDow, setSelectedDow] = useState<number | null>(null);

  useEffect(() => {
    supabase
      .from('games')
      .select('game_num, hits, draw_dow')
      .order('game_num', { ascending: false })
      .limit(5000)
      .then(({ data }) => {
        if (data) setGames(data as Game[]);
        setLoading(false);
      });
  }, []);

  // Co-occurrence computation — runs once, ~50–200ms for 5k games
  const allPairs = useMemo(() => computeCooccurrence(games), [games]);

  const top50 = useMemo(() => {
    const arr = [...allPairs];
    arr.sort((a, b) => sortMode === 'lift' ? b.lift - a.lift : b.count - a.count);
    return arr.slice(0, 50);
  }, [allPairs, sortMode]);

  const partnerPairs = useMemo(
    () => (selected !== null ? pairsForNumber(allPairs, selected).slice(0, 20) : []),
    [allPairs, selected]
  );

  const dowFreq = useMemo(() => computeDowFreq(games), [games]);

  const hotByDow = useMemo(
    () => (selectedDow !== null ? hotNumbersByDow(games, selectedDow) : []),
    [games, selectedDow]
  );

  const maxPartnerCount = partnerPairs[0]?.count ?? 1;
  const expectedStr = games.length > 0
    ? ((games.length * 20 / 80) * (19 / 79)).toFixed(0)
    : '—';

  if (loading) return <div className="text-slate-500 pt-8">Loading…</div>;

  if (games.length === 0) {
    return (
      <div className="space-y-4 max-w-3xl">
        <h1 className="text-2xl font-bold">Pair Patterns</h1>
        <p className="text-slate-500 text-sm">No data yet — run the backfill on Data Ingestion first.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <h1 className="text-2xl font-bold">Pair Patterns</h1>
      <p className="text-sm text-slate-400 leading-relaxed">
        Which numbers show up together more often than expected? With 20 of 80 numbers drawn each game,
        any two numbers have about a 6% chance of appearing together.
        The <strong className="text-slate-300">Together Score</strong> shows how often they actually pair up
        compared to that baseline — a score of 1.20 means they appear together 20% more often than random.
      </p>

      {/* ── Number Selector ──────────────────────────────────────────── */}
      <div className="bg-surface rounded-xl p-4">
        <h2 className="text-sm font-semibold mb-3 text-slate-300">
          Select a number to explore its partners
          {selected !== null && (
            <button
              onClick={() => setSelected(null)}
              className="ml-3 text-xs text-slate-500 hover:text-white"
            >
              (clear)
            </button>
          )}
        </h2>
        <div
          className="grid gap-1"
          style={{ gridTemplateColumns: 'repeat(16, minmax(0, 1fr))' }}
        >
          {Array.from({ length: 80 }, (_, i) => i + 1).map(n => (
            <button
              key={n}
              onClick={() => setSelected(selected === n ? null : n)}
              className={`aspect-square rounded text-xs font-bold transition-colors ${
                selected === n
                  ? 'bg-crimson text-white'
                  : 'bg-[#0e0e10] text-slate-400 hover:text-white hover:bg-[#2a2a2e]'
              }`}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      {/* ── Partner Breakdown ─────────────────────────────────────────── */}
      {selected !== null && (
        <div className="bg-surface rounded-xl p-5 space-y-4">
          <h2 className="text-sm font-semibold text-slate-300">
            Top partners for{' '}
            <span className="text-crimson font-bold text-xl">{selected}</span>
            <span className="text-slate-500 text-xs ml-2">
              (expected ~{expectedStr} co-occurrences per partner)
            </span>
          </h2>

          {/* Ball grid — click a ball to switch selected number */}
          <div className="flex flex-wrap gap-2">
            {partnerPairs.slice(0, 15).map(({ partner, count }) => {
              const intensity = count / maxPartnerCount;
              return (
                <div key={partner} className="text-center">
                  <button
                    onClick={() => setSelected(partner)}
                    className="w-11 h-11 rounded-full flex items-center justify-center font-bold text-sm transition-transform hover:scale-110"
                    style={{
                      background: `rgba(139,26,74,${0.2 + intensity * 0.8})`,
                      color: intensity > 0.35 ? '#fff' : '#94a3b8',
                    }}
                    title={`Switch to ${partner}`}
                  >
                    {partner}
                  </button>
                  <div className="text-xs text-slate-500 mt-0.5">{count}×</div>
                </div>
              );
            })}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-500 border-b border-[#2a2a2e]">
                  <th className="pb-2 text-left">Partner</th>
                  <th className="pb-2 text-right">Together</th>
                  <th className="pb-2 text-right">% of Games</th>
                  <th className="pb-2 text-right">Expected</th>
                  <th className="pb-2 text-right">Score</th>
                </tr>
              </thead>
              <tbody>
                {partnerPairs.map(({ partner, count, lift, pct, expected }) => (
                  <tr
                    key={partner}
                    className="border-b border-[#1e1e24] hover:bg-[#1e1e24] cursor-pointer"
                    onClick={() => setSelected(partner)}
                  >
                    <td className="py-2 font-bold text-white">{partner}</td>
                    <td className="py-2 text-right">{count}</td>
                    <td className="py-2 text-right">{pct.toFixed(1)}%</td>
                    <td className="py-2 text-right text-slate-500">{expected.toFixed(0)}</td>
                    <td className={`py-2 text-right font-mono font-bold ${
                      lift > 1.1 ? 'text-red-400' : lift < 0.9 ? 'text-blue-400' : 'text-slate-400'
                    }`}>
                      {lift.toFixed(2)}×
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-500">Click any partner to explore their pairs.</p>
        </div>
      )}

      {/* ── Strongest Pairs Overall ───────────────────────────────────── */}
      <div className="bg-surface rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-300">Strongest Pairs — Top 50</h2>
          <div className="flex gap-2">
            {(['count', 'lift'] as SortMode[]).map(m => (
              <button
                key={m}
                onClick={() => setSortMode(m)}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                  sortMode === m
                    ? 'bg-crimson text-white'
                    : 'bg-[#0e0e10] border border-[#333] text-slate-400 hover:text-white'
                }`}
              >
                By {m === 'count' ? 'Frequency' : 'Score'}
              </button>
            ))}
          </div>
        </div>
        <p className="text-xs text-slate-500">
          Any pair is expected together ~{expectedStr} times in {games.length.toLocaleString()} draws.
          Score above 1.0 means they appear together more than chance. Click a number to explore it.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-500 border-b border-[#2a2a2e]">
                <th className="px-3 py-2 text-left">#</th>
                <th className="px-3 py-2 text-left">Pair</th>
                <th className="px-3 py-2 text-right">Together</th>
                <th className="px-3 py-2 text-right">% of Games</th>
                <th className="px-3 py-2 text-right">Expected</th>
                <th className="px-3 py-2 text-right">Score</th>
              </tr>
            </thead>
            <tbody>
              {top50.map(({ a, b, count, lift, pct, expected }, i) => (
                <tr key={`${a}-${b}`} className="border-b border-[#1e1e24] hover:bg-[#1e1e24]">
                  <td className="px-3 py-2 text-slate-500 text-xs">{i + 1}</td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1.5 items-center">
                      <button
                        onClick={() => setSelected(a)}
                        className="w-7 h-7 rounded-full bg-crimson/80 hover:bg-crimson text-white text-xs font-bold transition-colors"
                      >
                        {a}
                      </button>
                      <span className="text-slate-600 text-xs">+</span>
                      <button
                        onClick={() => setSelected(b)}
                        className="w-7 h-7 rounded-full bg-crimson/80 hover:bg-crimson text-white text-xs font-bold transition-colors"
                      >
                        {b}
                      </button>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right font-bold">{count}</td>
                  <td className="px-3 py-2 text-right">{pct.toFixed(1)}%</td>
                  <td className="px-3 py-2 text-right text-slate-500">{expected.toFixed(0)}</td>
                  <td className={`px-3 py-2 text-right font-mono font-bold ${
                    lift > 1.1 ? 'text-red-400' : lift < 0.9 ? 'text-blue-400' : 'text-slate-400'
                  }`}>
                    {lift.toFixed(2)}×
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Day-of-Week Patterns (reliable, from draw_date) ──────────── */}
      <div className="bg-surface rounded-xl p-5 space-y-4">
        <h2 className="text-sm font-semibold text-slate-300">
          Draws by Day of Week
          <span className="ml-2 text-xs text-slate-500 font-normal">— from actual draw date</span>
        </h2>
        <div className="grid md:grid-cols-2 gap-6 items-start">
          <div>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={dowFreq}>
                <XAxis dataKey="label" tick={{ fill: '#94a3b8', fontSize: 12 }} />
                <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} />
                <Tooltip
                  contentStyle={{ background: '#16161a', border: '1px solid #333', borderRadius: 8 }}
                  formatter={(v: number) => [v, 'Draws']}
                />
                <Bar
                  dataKey="count"
                  fill="#8B1A4A"
                  radius={[4, 4, 0, 0]}
                  cursor="pointer"
                  onClick={(d: { dow: number }) => setSelectedDow(selectedDow === d.dow ? null : d.dow)}
                />
              </BarChart>
            </ResponsiveContainer>
            <p className="text-xs text-slate-500 mt-2">Click a bar to see hottest numbers that day.</p>
          </div>

          {selectedDow !== null && hotByDow.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-slate-400 mb-2">
                Top numbers on {DOW_LABELS[selectedDow]}s
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {hotByDow.map(({ number, count, pct }) => (
                  <div
                    key={number}
                    className="bg-[#0e0e10] rounded-lg px-2.5 py-2 text-center cursor-pointer hover:bg-[#2a2a2e]"
                    onClick={() => setSelected(number)}
                    title="Click to explore pairs"
                  >
                    <div className="text-base font-bold text-white">{number}</div>
                    <div className="text-xs text-slate-500">{pct.toFixed(1)}%</div>
                  </div>
                ))}
              </div>
              <p className="text-xs text-slate-500 mt-2">Click a number to explore its pairs.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
