'use client';

import { useEffect, useState, useCallback } from 'react';
import { supabase, Game } from '@/lib/supabase';
import { useToast } from '@/components/Toast';
import { generatePicks } from '@/lib/evolution/fitness';
import type { StrategyGenome } from '@/lib/evolution/genome';

interface Favorite {
  id: number;
  created_at: string;
  name: string;
  spot_count: number;
  numbers: number[];
  bonus_type: 'none' | 'bonus' | 'super_bonus';
  draws: number;
  wager_amount: number;
}

interface ArthurSignal {
  overlap: number;
  overlapPct: number;
  arthurPicks: number[];
  bestHour: number | null;
  signal: 'hot' | 'warm' | 'cold';
}

interface EditState {
  open: boolean;
  id: number | null;
  name: string;
  spotCount: number;
  numbers: number[];
  bonusType: 'none' | 'bonus' | 'super_bonus';
  draws: number;
  wagerAmount: number;
}

const BONUS_LABELS: Record<string, string> = {
  none: 'No Bonus',
  bonus: 'Bonus (2x)',
  super_bonus: 'Super Bonus (3x)',
};

const BONUS_STYLE: Record<string, string> = {
  none: 'text-slate-400 bg-[#1e1e24] border-[#333]',
  bonus: 'text-amber-300 bg-amber-900/30 border-amber-500/40',
  super_bonus: 'text-purple-300 bg-purple-900/30 border-purple-500/40',
};

const SIGNAL_META = {
  hot: { label: 'Strong Match', color: 'text-green-400', bg: 'bg-green-900/20 border-green-500/30', desc: "Arthur's picks overlap heavily with yours" },
  warm: { label: 'Partial Match', color: 'text-amber-400', bg: 'bg-amber-900/20 border-amber-500/30', desc: 'Some overlap with Arthur\'s current picks' },
  cold: { label: 'Low Match', color: 'text-slate-500', bg: 'bg-[#1e1e24] border-[#333]', desc: "Arthur's picks differ from yours right now" },
};

export default function MyFavoritesPage() {
  const { toast } = useToast();
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [signals, setSignals] = useState<Map<number, ArthurSignal>>(new Map());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [edit, setEdit] = useState<EditState>({
    open: false, id: null, name: '', spotCount: 6, numbers: [],
    bonusType: 'none', draws: 1, wagerAmount: 1,
  });

  const [tableError, setTableError] = useState(false);

  const loadFavorites = useCallback(async () => {
    const { data, error } = await supabase
      .from('favorites')
      .select('*')
      .order('created_at', { ascending: true })
      .limit(4);
    if (error) {
      console.error('favorites table error:', error.message);
      setTableError(true);
      return;
    }
    setFavorites((data ?? []) as Favorite[]);
  }, []);

  const computeSignals = useCallback(async (favs: Favorite[]) => {
    if (!favs.length) return;

    const spotCounts = [...new Set(favs.map(f => f.spot_count))];
    const [{ data: champions }, { data: gamesData }, { data: dailyPick }] = await Promise.all([
      supabase.from('strategies').select('id, spot_count, genome').eq('status', 'promoted').in('spot_count', spotCounts),
      supabase.from('games').select('game_num,draw_date,draw_iso,draw_dow,bonus,super_bonus,hits').order('game_num', { ascending: true }).limit(5000),
      supabase.from('daily_picks').select('best_hour').eq('pick_date', new Date().toLocaleDateString('en-CA')).maybeSingle(),
    ]);

    const games = (gamesData ?? []) as Game[];
    const champMap = new Map<number, { genome: StrategyGenome; id: number }>();
    for (const c of champions ?? []) {
      champMap.set(c.spot_count as number, { genome: c.genome as StrategyGenome, id: c.id as number });
    }

    const newSignals = new Map<number, ArthurSignal>();
    for (const fav of favs) {
      const champ = champMap.get(fav.spot_count);
      if (!champ || !games.length) {
        newSignals.set(fav.id, { overlap: 0, overlapPct: 0, arthurPicks: [], bestHour: null, signal: 'cold' });
        continue;
      }
      const arthurPicks = generatePicks(champ.genome, fav.spot_count, games);
      const overlap = fav.numbers.filter(n => arthurPicks.includes(n)).length;
      const overlapPct = fav.numbers.length > 0 ? overlap / fav.numbers.length : 0;
      const signal: ArthurSignal['signal'] = overlapPct >= 0.5 ? 'hot' : overlapPct >= 0.25 ? 'warm' : 'cold';
      newSignals.set(fav.id, {
        overlap,
        overlapPct,
        arthurPicks,
        bestHour: dailyPick?.best_hour ?? null,
        signal,
      });
    }
    setSignals(newSignals);
  }, []);

  useEffect(() => {
    loadFavorites().then(() => setLoading(false));
  }, [loadFavorites]);

  useEffect(() => {
    if (favorites.length > 0) computeSignals(favorites);
  }, [favorites, computeSignals]);

  function openAdd() {
    setEdit({
      open: true, id: null, name: '', spotCount: 6, numbers: [],
      bonusType: 'none', draws: 1, wagerAmount: 1,
    });
  }

  function openEdit(fav: Favorite) {
    setEdit({
      open: true, id: fav.id, name: fav.name, spotCount: fav.spot_count,
      numbers: [...fav.numbers], bonusType: fav.bonus_type,
      draws: fav.draws, wagerAmount: fav.wager_amount,
    });
  }

  function toggleNumber(n: number) {
    setEdit(e => {
      if (e.numbers.includes(n)) return { ...e, numbers: e.numbers.filter(x => x !== n) };
      if (e.numbers.length >= e.spotCount) return e;
      return { ...e, numbers: [...e.numbers, n] };
    });
  }

  async function saveFavorite() {
    if (!edit.name.trim()) { toast('Name is required', 'error'); return; }
    if (edit.numbers.length !== edit.spotCount) {
      toast(`Select exactly ${edit.spotCount} numbers`, 'error'); return;
    }
    setSaving(true);

    const row = {
      name: edit.name.trim(),
      spot_count: edit.spotCount,
      numbers: [...edit.numbers].sort((a, b) => a - b),
      bonus_type: edit.bonusType,
      draws: edit.draws,
      wager_amount: edit.wagerAmount,
    };

    let error;
    if (edit.id) {
      ({ error } = await supabase.from('favorites').update(row).eq('id', edit.id));
    } else {
      ({ error } = await supabase.from('favorites').insert(row));
    }

    setSaving(false);
    if (error) { toast(error.message, 'error'); return; }
    toast(edit.id ? 'Favorite updated!' : 'Favorite saved!', 'success');
    setEdit(e => ({ ...e, open: false }));
    await loadFavorites();
  }

  async function deleteFavorite(id: number) {
    setDeleting(id);
    const { error } = await supabase.from('favorites').delete().eq('id', id);
    setDeleting(null);
    if (error) { toast(error.message, 'error'); return; }
    toast('Favorite removed', 'info');
    await loadFavorites();
  }

  function fmtHour(h: number): string {
    const suffix = h >= 12 ? 'PM' : 'AM';
    const display = h > 12 ? h - 12 : h === 0 ? 12 : h;
    return `${display}:00 ${suffix}`;
  }

  if (loading) return <div className="text-slate-500 pt-8">Loading...</div>;

  if (tableError) {
    return (
      <div className="space-y-6 max-w-4xl">
        <h1 className="text-2xl font-bold">My Favorites</h1>
        <div className="bg-surface rounded-xl p-8 text-center border border-red-500/30">
          <p className="text-red-400 font-semibold mb-2">Favorites table not found</p>
          <p className="text-sm text-slate-500 mb-4">
            The favorites table needs to be created in your Supabase database.
            Run the migration in <span className="font-mono text-slate-400">supabase/migrations/004_favorites.sql</span> to set it up.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-6 max-w-4xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">My Favorites</h1>
            <p className="text-sm text-slate-500 mt-1">
              Save up to 4 games you frequently play. Arthur watches them for you.
            </p>
          </div>
          {favorites.length < 4 && (
            <button
              onClick={openAdd}
              className="px-5 py-2.5 rounded-lg bg-crimson hover:bg-crimson-hover text-white text-sm font-medium transition-colors flex-shrink-0"
            >
              + Add Favorite
            </button>
          )}
        </div>

        {/* Favorite cards */}
        {favorites.length === 0 ? (
          <div className="bg-surface rounded-xl p-10 text-center border border-dashed border-[#333]">
            <p className="text-slate-400 mb-3">No favorites yet</p>
            <p className="text-sm text-slate-600 mb-5">Add your go-to Keno games and Arthur will watch them for payout opportunities.</p>
            <button
              onClick={openAdd}
              className="px-6 py-2.5 rounded-lg bg-crimson hover:bg-crimson-hover text-white text-sm font-medium transition-colors"
            >
              + Add Your First Game
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {favorites.map(fav => {
              const sig = signals.get(fav.id);
              const sigMeta = sig ? SIGNAL_META[sig.signal] : null;
              const bonusMultiplier = fav.bonus_type === 'super_bonus' ? 3 : fav.bonus_type === 'bonus' ? 2 : 1;
              const totalCost = Number(fav.wager_amount) * bonusMultiplier * fav.draws;

              return (
                <div key={fav.id} className="bg-surface rounded-xl p-5 space-y-4 border border-[#2a2a2e]">
                  {/* Header */}
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="font-semibold text-white">{fav.name}</h3>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {fav.spot_count}-Spot · {fav.draws} draw{fav.draws > 1 ? 's' : ''} · ${totalCost.toFixed(2)} total
                      </p>
                    </div>
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => openEdit(fav)}
                        className="px-2.5 py-1 rounded text-xs bg-[#1e1e24] border border-[#333] text-slate-400 hover:text-white hover:border-crimson/40 transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => deleteFavorite(fav.id)}
                        disabled={deleting === fav.id}
                        className="px-2.5 py-1 rounded text-xs bg-[#1e1e24] border border-[#333] text-red-400/60 hover:text-red-400 hover:border-red-500/40 transition-colors disabled:opacity-50"
                      >
                        {deleting === fav.id ? '...' : 'x'}
                      </button>
                    </div>
                  </div>

                  {/* Numbers */}
                  <div className="flex flex-wrap gap-1.5">
                    {[...fav.numbers].sort((a, b) => a - b).map(n => {
                      const isArthurPick = sig?.arthurPicks.includes(n);
                      return (
                        <div
                          key={n}
                          className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold border ${
                            isArthurPick
                              ? 'bg-crimson/20 border-crimson/60 text-crimson'
                              : 'bg-[#0e0e10] border-[#333] text-slate-300'
                          }`}
                        >
                          {n}
                        </div>
                      );
                    })}
                    <span className={`self-center ml-1.5 px-2.5 py-1 rounded-lg text-[10px] font-semibold border ${BONUS_STYLE[fav.bonus_type]}`}>
                      {BONUS_LABELS[fav.bonus_type]}
                    </span>
                  </div>

                  {/* Arthur's signal */}
                  {sigMeta && sig && (
                    <div className={`rounded-lg px-3 py-2.5 border ${sigMeta.bg} flex items-center gap-3`}>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className={`text-xs font-semibold ${sigMeta.color}`}>{sigMeta.label}</span>
                          <span className="text-[10px] text-slate-600">
                            {sig.overlap}/{fav.numbers.length} numbers match Arthur
                          </span>
                        </div>
                        <p className="text-[10px] text-slate-600">{sigMeta.desc}</p>
                      </div>
                      {sig.bestHour !== null && sig.signal === 'hot' && (
                        <div className="text-right flex-shrink-0">
                          <p className="text-[10px] text-slate-500">Best window</p>
                          <p className={`text-xs font-semibold ${sigMeta.color}`}>
                            {fmtHour(sig.bestHour)} – {fmtHour(sig.bestHour + 1)}
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Wager details */}
                  <div className="flex gap-4 text-[10px] text-slate-600 pt-1 border-t border-[#1e1e24]">
                    <span>${Number(fav.wager_amount).toFixed(2)} / game</span>
                    <span>{fav.draws} draw{fav.draws > 1 ? 's' : ''}</span>
                    <span>${totalCost.toFixed(2)} session</span>
                  </div>
                </div>
              );
            })}

            {/* Add card placeholder */}
            {favorites.length < 4 && (
              <button
                onClick={openAdd}
                className="bg-surface rounded-xl p-8 border border-dashed border-[#333] flex flex-col items-center justify-center gap-2 text-slate-600 hover:text-slate-400 hover:border-crimson/30 transition-colors min-h-[200px]"
              >
                <span className="text-3xl">+</span>
                <span className="text-sm">Add Favorite</span>
              </button>
            )}
          </div>
        )}

        {/* Info */}
        <div className="rounded-lg px-4 py-3 bg-[#0a0a0d] border border-[#1a1a1e]">
          <p className="text-[10px] text-slate-700 leading-relaxed">
            Arthur compares your favorite numbers against his current champion picks for each spot count.
            Numbers highlighted in crimson match Arthur's recommendations.
            A "Strong Match" means Arthur's analysis agrees with your game — consider playing during the suggested window.
          </p>
        </div>
      </div>

      {/* Add / Edit modal */}
      {edit.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-surface rounded-2xl p-6 w-full max-w-lg space-y-5 mx-4 max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-bold">{edit.id ? 'Edit Favorite' : 'Add Favorite'}</h2>

            {/* Name */}
            <div>
              <label className="text-xs text-slate-400 block mb-1">Game Name *</label>
              <input
                value={edit.name}
                onChange={e => setEdit(s => ({ ...s, name: e.target.value }))}
                className="w-full bg-[#0e0e10] border border-[#333] rounded px-3 py-2 text-sm focus:outline-none focus:border-crimson"
                placeholder="e.g. My Lucky 6"
              />
            </div>

            {/* Spot count */}
            <div>
              <label className="text-xs text-slate-400 block mb-1">Spot Count</label>
              <div className="flex gap-1">
                {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
                  <button
                    key={n}
                    onClick={() => setEdit(s => ({ ...s, spotCount: n, numbers: s.numbers.slice(0, n) }))}
                    className={`w-8 h-8 rounded text-sm font-medium transition-colors ${
                      edit.spotCount === n
                        ? 'bg-crimson text-white'
                        : 'bg-[#0e0e10] text-slate-400 hover:text-white border border-[#333]'
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            {/* Number grid */}
            <div>
              <label className="text-xs text-slate-400 block mb-2">
                Pick {edit.spotCount} Numbers
                <span className="text-slate-600 ml-2">({edit.numbers.length}/{edit.spotCount} selected)</span>
              </label>
              <div className="grid gap-1" style={{ gridTemplateColumns: 'repeat(10, minmax(0, 1fr))' }}>
                {Array.from({ length: 80 }, (_, i) => i + 1).map(n => {
                  const selected = edit.numbers.includes(n);
                  const full = edit.numbers.length >= edit.spotCount;
                  return (
                    <button
                      key={n}
                      onClick={() => toggleNumber(n)}
                      disabled={!selected && full}
                      className={`aspect-square rounded text-xs font-bold transition-colors ${
                        selected
                          ? 'bg-crimson text-white'
                          : 'bg-[#0e0e10] text-slate-500 hover:text-white hover:bg-[#1e1e24] border border-[#222]'
                      } disabled:opacity-25 disabled:cursor-not-allowed`}
                    >
                      {n}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Bonus, draws, wager */}
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Bonus Type</label>
                <select
                  value={edit.bonusType}
                  onChange={e => setEdit(s => ({ ...s, bonusType: e.target.value as EditState['bonusType'] }))}
                  className="w-full bg-[#0e0e10] border border-[#333] rounded px-3 py-2 text-sm focus:outline-none focus:border-crimson"
                >
                  <option value="none">None</option>
                  <option value="bonus">Bonus (2x)</option>
                  <option value="super_bonus">Super Bonus (3x)</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Draws</label>
                <input
                  type="number" min={1} max={200}
                  value={edit.draws}
                  onChange={e => setEdit(s => ({ ...s, draws: Math.max(1, parseInt(e.target.value) || 1) }))}
                  className="w-full bg-[#0e0e10] border border-[#333] rounded px-3 py-2 text-sm focus:outline-none focus:border-crimson"
                />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Wager ($)</label>
                <input
                  type="number" min={1} max={20} step={1}
                  value={edit.wagerAmount}
                  onChange={e => setEdit(s => ({ ...s, wagerAmount: Math.max(1, parseFloat(e.target.value) || 1) }))}
                  className="w-full bg-[#0e0e10] border border-[#333] rounded px-3 py-2 text-sm focus:outline-none focus:border-crimson"
                />
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-2 justify-end pt-2">
              <button
                onClick={() => setEdit(s => ({ ...s, open: false }))}
                className="px-4 py-2 rounded-lg bg-[#2a2a2e] text-slate-300 text-sm hover:bg-[#333]"
              >
                Cancel
              </button>
              <button
                onClick={saveFavorite}
                disabled={saving}
                className="px-5 py-2 rounded-lg bg-crimson hover:bg-crimson-hover text-white text-sm font-medium disabled:opacity-50"
              >
                {saving ? 'Saving...' : edit.id ? 'Update' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
