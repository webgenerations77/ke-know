'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase, Game } from '@/lib/supabase';
import { computeNumberStats, NumberStats } from '@/lib/analysis';

type SortKey = 'rank' | 'number' | 'count' | 'pct' | 'deviation' | 'lastSeen' | 'streak';

const STATUS_COLORS: Record<string, string> = {
  Hot: 'text-red-400',
  Cold: 'text-blue-400',
  Overdue: 'text-amber-400',
  'On Streak': 'text-green-400',
  Normal: 'text-slate-500',
};

export default function FrequencyPage() {
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>('rank');
  const [sortAsc, setSortAsc] = useState(true);

  useEffect(() => {
    supabase.from('games').select('*').order('game_num', { ascending: false }).limit(5000)
      .then(({ data }) => { if (data) setGames(data as Game[]); setLoading(false); });
  }, []);

  const stats = computeNumberStats(games);

  const sorted = useMemo(() => {
    const arr = [...stats];
    arr.sort((a, b) => {
      let av: number, bv: number;
      switch (sortKey) {
        case 'rank': av = a.rank; bv = b.rank; break;
        case 'number': av = a.number; bv = b.number; break;
        case 'count': av = a.count; bv = b.count; break;
        case 'pct': av = a.pct; bv = b.pct; break;
        case 'deviation': av = a.deviation; bv = b.deviation; break;
        case 'lastSeen': av = a.lastSeen ?? 999999; bv = b.lastSeen ?? 999999; break;
        case 'streak': av = a.streak; bv = b.streak; break;
        default: return 0;
      }
      return sortAsc ? av - bv : bv - av;
    });
    return arr;
  }, [stats, sortKey, sortAsc]);

  function handleSort(key: SortKey) {
    if (key === sortKey) setSortAsc(a => !a);
    else { setSortKey(key); setSortAsc(true); }
  }

  function ColHeader({ k, label }: { k: SortKey; label: string }) {
    const active = sortKey === k;
    return (
      <th
        className={`px-4 py-3 text-left cursor-pointer select-none whitespace-nowrap ${
          active ? 'text-crimson' : 'text-slate-500'
        } hover:text-white transition-colors`}
        onClick={() => handleSort(k)}
      >
        {label} {active ? (sortAsc ? '↑' : '↓') : ''}
      </th>
    );
  }

  if (loading) return <div className="text-slate-500 pt-8">Loading…</div>;

  return (
    <div className="space-y-4 max-w-5xl">
      <h1 className="text-2xl font-bold">Frequency Table</h1>
      <p className="text-sm text-slate-400">
        All 80 numbers · {games.length.toLocaleString()} draws · expected {(games.length * 20 / 80).toFixed(0)} draws per number
      </p>

      <div className="bg-surface rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#2a2a2e] text-xs">
                <ColHeader k="rank" label="Rank" />
                <ColHeader k="number" label="Number" />
                <ColHeader k="count" label="Times Drawn" />
                <ColHeader k="pct" label="% of Games" />
                <ColHeader k="deviation" label="Deviation" />
                <ColHeader k="lastSeen" label="Last Seen" />
                <ColHeader k="streak" label="Streak" />
                <th className="px-4 py-3 text-left text-slate-500">Status</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(s => (
                <tr key={s.number} className="border-b border-[#1e1e24] hover:bg-[#1e1e24] transition-colors">
                  <td className="px-4 py-2.5 text-slate-500">#{s.rank}</td>
                  <td className="px-4 py-2.5 font-bold text-white">{s.number}</td>
                  <td className="px-4 py-2.5">{s.count.toLocaleString()}</td>
                  <td className="px-4 py-2.5">{s.pct.toFixed(2)}%</td>
                  <td className={`px-4 py-2.5 font-mono ${s.deviation >= 0 ? 'text-red-400' : 'text-blue-400'}`}>
                    {s.deviation >= 0 ? '+' : ''}{s.deviation.toFixed(1)}%
                  </td>
                  <td className="px-4 py-2.5 text-slate-400">
                    {s.lastSeen === null ? 'Never' : s.lastSeen === 0 ? 'Last game' : `${s.lastSeen}g ago`}
                  </td>
                  <td className="px-4 py-2.5 text-slate-400">{s.streak}</td>
                  <td className={`px-4 py-2.5 text-xs font-medium ${STATUS_COLORS[s.status]}`}>{s.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {games.length === 0 && (
        <p className="text-slate-500 text-sm">No data yet — run the backfill on the Data Ingestion page.</p>
      )}
    </div>
  );
}
