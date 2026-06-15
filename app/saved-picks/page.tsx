'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase, SavedPick } from '@/lib/supabase';
import { PRIZE_TABLE } from '@/lib/keno-odds';
import { useToast } from '@/components/Toast';

const BONUS_LABELS: Record<string, string> = {
  none: 'No Bonus',
  bonus: 'Bonus (2×)',
  super_bonus: 'Super Bonus (3×)',
};

const STRATEGY_LABELS: Record<string, string> = {
  hot: 'Hot',
  balanced: 'Balanced',
  cold: 'Cold',
  streak: 'Streak',
};

interface ResultModal {
  open: boolean;
  pickId: number;
  gameNum: string;
  matches: string;
}

export default function SavedPicksPage() {
  const { toast } = useToast();
  const [picks, setPicks] = useState<SavedPick[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterSpot, setFilterSpot] = useState(0);
  const [filterStrategy, setFilterStrategy] = useState('');
  const [deleting, setDeleting] = useState<number | null>(null);
  const [resultModal, setResultModal] = useState<ResultModal>({
    open: false, pickId: 0, gameNum: '', matches: '',
  });

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('saved_picks')
      .select('*')
      .order('saved_at', { ascending: false });
    if (data) setPicks(data as SavedPick[]);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function deletePick(id: number) {
    setDeleting(id);
    await supabase.from('saved_picks').delete().eq('id', id);
    setPicks(p => p.filter(x => x.id !== id));
    setDeleting(null);
    toast('Pick deleted', 'info');
  }

  async function logResult() {
    const { pickId, gameNum, matches } = resultModal;
    if (!gameNum || !matches) { toast('Fill in both fields', 'error'); return; }
    const { error } = await supabase
      .from('saved_picks')
      .update({ result_game_num: parseInt(gameNum), result_matches: parseInt(matches) })
      .eq('id', pickId);
    if (error) { toast(error.message, 'error'); return; }
    toast('Result logged', 'success');
    setResultModal(m => ({ ...m, open: false }));
    await load();
  }

  const filtered = picks.filter(p => {
    if (filterSpot > 0 && p.spot_count !== filterSpot) return false;
    if (filterStrategy && p.strategy !== filterStrategy) return false;
    return true;
  });

  // Performance summary from picks with results
  const withResults = picks.filter(p => p.result_matches !== null);
  const totalPlayed = withResults.length;
  const totalMatches = withResults.reduce((s, p) => s + (p.result_matches ?? 0), 0);
  const avgMatches = totalPlayed > 0 ? totalMatches / totalPlayed : 0;
  const bestResult = withResults.length > 0
    ? Math.max(...withResults.map(p => p.result_matches ?? 0))
    : 0;

  // Win rate: % of played picks that hit at least minimum winning catch for their spot count
  const wins = withResults.filter(p => {
    const prizes = PRIZE_TABLE[p.spot_count] ?? [];
    const minCatch = prizes.length > 0 ? Math.min(...prizes.map(x => x.catches)) : p.spot_count;
    return (p.result_matches ?? 0) >= minCatch;
  });

  if (loading) return <div className="text-slate-500 pt-8">Loading…</div>;

  return (
    <div className="space-y-6 max-w-4xl">
      <h1 className="text-2xl font-bold">Saved Picks</h1>

      {/* Performance summary */}
      {totalPlayed > 0 && (
        <div className="bg-surface rounded-xl p-5">
          <h2 className="text-sm font-semibold text-slate-400 mb-3">Performance Summary</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'Games Played', value: totalPlayed },
              { label: 'Avg Matches', value: avgMatches.toFixed(2) },
              { label: 'Best Result', value: `${bestResult} matches` },
              { label: 'Win Rate', value: `${((wins.length / totalPlayed) * 100).toFixed(1)}%` },
            ].map(({ label, value }) => (
              <div key={label}>
                <div className="text-xs text-slate-500">{label}</div>
                <div className="text-lg font-bold">{value}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3 flex-wrap items-center">
        <span className="text-xs text-slate-500">{picks.length} total · {filtered.length} shown</span>
        <select
          value={filterSpot}
          onChange={e => setFilterSpot(parseInt(e.target.value))}
          className="bg-surface border border-[#333] text-sm rounded px-3 py-1.5 text-white focus:outline-none"
        >
          <option value={0}>All spots</option>
          {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
            <option key={n} value={n}>{n} spots</option>
          ))}
        </select>
        <select
          value={filterStrategy}
          onChange={e => setFilterStrategy(e.target.value)}
          className="bg-surface border border-[#333] text-sm rounded px-3 py-1.5 text-white focus:outline-none"
        >
          <option value="">All strategies</option>
          {Object.entries(STRATEGY_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </div>

      {filtered.length === 0 && (
        <p className="text-slate-500 text-sm">No saved picks yet. Go to My Picks to create and save picks.</p>
      )}

      <div className="space-y-4">
        {filtered.map(pick => (
          <div key={pick.id} className="bg-surface rounded-xl p-5 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold text-white">{pick.label || 'Unnamed'}</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {new Date(pick.saved_at).toLocaleString()} ·{' '}
                  {pick.spot_count} spots · {STRATEGY_LABELS[pick.strategy] ?? pick.strategy} ·{' '}
                  {BONUS_LABELS[pick.bonus_type] ?? pick.bonus_type}
                  {pick.wager && ` · $${pick.wager} ${pick.wager_type}`}
                </p>
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={() => setResultModal({ open: true, pickId: pick.id, gameNum: pick.result_game_num?.toString() ?? '', matches: pick.result_matches?.toString() ?? '' })}
                  className="text-xs px-2.5 py-1 rounded bg-[#2a2a2e] hover:bg-[#333] text-slate-300"
                >
                  Log Result
                </button>
                {deleting === pick.id ? (
                  <button onClick={() => deletePick(pick.id)} className="text-xs px-2.5 py-1 rounded bg-red-800 text-red-200">
                    Confirm
                  </button>
                ) : (
                  <button onClick={() => setDeleting(pick.id)} className="text-xs px-2.5 py-1 rounded bg-[#2a2a2e] hover:bg-red-900/50 text-slate-400">
                    Delete
                  </button>
                )}
              </div>
            </div>

            {/* Mini number balls */}
            <div className="flex flex-wrap gap-1.5">
              {[...pick.numbers].sort((a, b) => a - b).map(n => (
                <span
                  key={n}
                  className="w-8 h-8 rounded-full bg-crimson/80 text-white text-xs font-bold flex items-center justify-center"
                >
                  {n}
                </span>
              ))}
            </div>

            {pick.notes && (
              <p className="text-xs text-slate-500 italic">{pick.notes}</p>
            )}

            {pick.result_matches !== null && (
              <div className="text-xs text-green-400">
                Result: {pick.result_matches} matches
                {pick.result_game_num && ` on game #${pick.result_game_num}`}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Log result modal */}
      {resultModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-surface rounded-2xl p-6 w-full max-w-sm space-y-4 mx-4">
            <h2 className="text-lg font-bold">Log Result</h2>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Game Number</label>
              <input
                type="number"
                value={resultModal.gameNum}
                onChange={e => setResultModal(m => ({ ...m, gameNum: e.target.value }))}
                className="w-full bg-[#0e0e10] border border-[#333] rounded px-3 py-2 text-sm focus:outline-none focus:border-crimson"
                placeholder="e.g. 02671082"
              />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Numbers Matched</label>
              <input
                type="number"
                min={0}
                value={resultModal.matches}
                onChange={e => setResultModal(m => ({ ...m, matches: e.target.value }))}
                className="w-full bg-[#0e0e10] border border-[#333] rounded px-3 py-2 text-sm focus:outline-none focus:border-crimson"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setResultModal(m => ({ ...m, open: false }))}
                className="px-4 py-2 rounded-lg bg-[#2a2a2e] text-slate-300 text-sm"
              >
                Cancel
              </button>
              <button
                onClick={logResult}
                className="px-4 py-2 rounded-lg bg-crimson text-white text-sm"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
