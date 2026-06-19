'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase, Game } from '@/lib/supabase';
import { computeNumberStats } from '@/lib/analysis';

const PAGE_SIZE = 50;

export default function DrawHistoryPage() {
  const [games, setGames] = useState<Game[]>([]);
  const [allGames, setAllGames] = useState<Game[]>([]);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filterNumber, setFilterNumber] = useState('');
  const [filterBonus, setFilterBonus] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');
  const [totalCount, setTotalCount] = useState(0);
  const [top20, setTop20] = useState<Set<number>>(new Set());

  useEffect(() => {
    async function load() {
      const { data, count } = await supabase
        .from('games')
        .select('*', { count: 'exact' })
        .order('game_num', { ascending: false })
        .limit(5000);
      if (data) {
        const g = data as Game[];
        setAllGames(g);
        setTotalCount(count ?? g.length);
        const stats = computeNumberStats(g);
        setTop20(new Set(stats.slice(0, 20).map(s => s.number)));
      }
      setLoading(false);
    }
    load();
  }, []);

  const filtered = useMemo(() => {
    let arr = [...allGames];
    if (filterNumber) {
      const n = parseInt(filterNumber);
      if (!isNaN(n)) arr = arr.filter(g => g.hits.includes(n));
    }
    if (filterBonus) {
      const b = parseInt(filterBonus);
      if (!isNaN(b)) arr = arr.filter(g => g.bonus === b || g.super_bonus === b);
    }
    if (filterFrom) arr = arr.filter(g => g.draw_date >= filterFrom);
    if (filterTo) arr = arr.filter(g => g.draw_date <= filterTo);
    return arr;
  }, [allGames, filterNumber, filterBonus, filterFrom, filterTo]);

  const pageData = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

  useEffect(() => { setPage(0); }, [filterNumber, filterBonus, filterFrom, filterTo]);

  if (loading) return <div className="text-slate-500 pt-8">Loading…</div>;

  return (
    <div className="space-y-4 max-w-6xl">
      <h1 className="text-2xl font-bold">Draw History</h1>

      {/* Filters */}
      <div className="bg-surface rounded-xl p-4 flex flex-wrap gap-3 items-end">
        <div>
          <label className="text-xs text-slate-400 block mb-1">Number Appeared</label>
          <input
            type="number" min={1} max={80}
            value={filterNumber}
            onChange={e => setFilterNumber(e.target.value)}
            placeholder="1–80"
            className="w-24 bg-[#0e0e10] border border-[#333] rounded px-2 py-1.5 text-sm focus:outline-none focus:border-crimson text-white"
          />
        </div>
        <div>
          <label className="text-xs text-slate-400 block mb-1">Bonus Value</label>
          <input
            type="number"
            value={filterBonus}
            onChange={e => setFilterBonus(e.target.value)}
            placeholder="e.g. 3"
            className="w-24 bg-[#0e0e10] border border-[#333] rounded px-2 py-1.5 text-sm focus:outline-none focus:border-crimson text-white"
          />
        </div>
        <div>
          <label className="text-xs text-slate-400 block mb-1">From Date</label>
          <input
            type="date"
            value={filterFrom}
            onChange={e => setFilterFrom(e.target.value)}
            className="bg-[#0e0e10] border border-[#333] rounded px-2 py-1.5 text-sm focus:outline-none focus:border-crimson text-white"
          />
        </div>
        <div>
          <label className="text-xs text-slate-400 block mb-1">To Date</label>
          <input
            type="date"
            value={filterTo}
            onChange={e => setFilterTo(e.target.value)}
            className="bg-[#0e0e10] border border-[#333] rounded px-2 py-1.5 text-sm focus:outline-none focus:border-crimson text-white"
          />
        </div>
        {(filterNumber || filterBonus || filterFrom || filterTo) && (
          <button
            onClick={() => { setFilterNumber(''); setFilterBonus(''); setFilterFrom(''); setFilterTo(''); }}
            className="px-3 py-1.5 rounded bg-[#333] text-slate-300 text-sm hover:bg-[#444]"
          >
            Clear Filters
          </button>
        )}
      </div>

      <div className="text-xs text-slate-500">
        Showing {Math.min(filtered.length, PAGE_SIZE)} of {filtered.length.toLocaleString()} draws
        {(filterNumber || filterBonus || filterFrom || filterTo) ? ' (filtered)' : ` · ${totalCount.toLocaleString()} total in DB`}
        {' · '}
        <span className="text-yellow-400">Gold</span> = top 20 pick
      </div>

      <div className="bg-surface rounded-xl overflow-hidden">
        <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface z-10">
              <tr className="text-slate-500 border-b border-[#2a2a2e]">
                <th className="px-3 py-3 text-left">Game #</th>
                <th className="px-3 py-3 text-left">Date</th>
                <th className="px-3 py-3 text-left">Time</th>
                <th className="px-3 py-3 text-left">Day</th>
                <th className="px-3 py-3 text-center">B</th>
                <th className="px-3 py-3 text-center">SB</th>
                <th className="px-3 py-3 text-left">Numbers Drawn (sorted)</th>
              </tr>
            </thead>
            <tbody>
              {pageData.map(g => (
                <tr key={g.game_num} className="border-b border-[#1a1a1e] hover:bg-[#1e1e24]">
                  <td className="px-3 py-2.5 font-mono text-slate-400">{g.game_num}</td>
                  <td className="px-3 py-2.5 text-slate-400">{g.draw_date}</td>
                  <td className="px-3 py-2.5 font-mono text-slate-500 whitespace-nowrap">
                    {g.draw_iso ? new Date(g.draw_iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true }) : '—'}
                  </td>
                  <td className="px-3 py-2.5 text-slate-500">{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][g.draw_dow ?? 0] ?? '—'}</td>
                  <td className="px-3 py-2.5 text-center text-amber-400 font-bold">{g.bonus ?? '—'}</td>
                  <td className="px-3 py-2.5 text-center text-purple-400 font-bold">{g.super_bonus ?? '—'}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {[...g.hits].sort((a, b) => a - b).map(n => (
                        <span
                          key={n}
                          className={`w-6 h-6 rounded-full flex items-center justify-center font-bold ${
                            top20.has(n)
                              ? 'bg-yellow-500/20 text-yellow-300 ring-1 ring-yellow-500/40'
                              : 'bg-[#2a2a2e] text-slate-400'
                          }`}
                        >
                          {n}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex gap-2 items-center justify-center">
          <button
            onClick={() => setPage(0)}
            disabled={page === 0}
            className="px-3 py-1 rounded bg-surface text-slate-400 disabled:opacity-30 text-sm hover:text-white"
          >
            «
          </button>
          <button
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={page === 0}
            className="px-3 py-1 rounded bg-surface text-slate-400 disabled:opacity-30 text-sm hover:text-white"
          >
            ‹
          </button>
          <span className="text-sm text-slate-400 px-2">
            Page {page + 1} of {totalPages}
          </span>
          <button
            onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="px-3 py-1 rounded bg-surface text-slate-400 disabled:opacity-30 text-sm hover:text-white"
          >
            ›
          </button>
          <button
            onClick={() => setPage(totalPages - 1)}
            disabled={page >= totalPages - 1}
            className="px-3 py-1 rounded bg-surface text-slate-400 disabled:opacity-30 text-sm hover:text-white"
          >
            »
          </button>
        </div>
      )}

      {allGames.length === 0 && (
        <p className="text-slate-500 text-sm">No draws in DB — run the backfill on Data Ingestion first.</p>
      )}
    </div>
  );
}
