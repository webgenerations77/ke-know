'use client';

import { useEffect, useState } from 'react';
import { supabase, Game } from '@/lib/supabase';
import {
  computeNumberStats, pickNumbers, Strategy, NumberStats,
} from '@/lib/analysis';
import { useToast } from '@/components/Toast';
import { describeGenome, type StrategyGenome } from '@/lib/evolution/genome';
import { generatePicks } from '@/lib/evolution/fitness';

const STRATEGY_LABELS: Record<Strategy, string> = {
  hot: 'Hot — raw frequency',
  balanced: 'Balanced — composite score',
  cold: 'Cold — most overdue',
  streak: 'Streak — consecutive recent hits',
};

const STATUS_COLORS: Record<string, string> = {
  Hot: 'bg-red-500/20 text-red-300',
  Cold: 'bg-blue-500/20 text-blue-300',
  Overdue: 'bg-amber-500/20 text-amber-300',
  'On Streak': 'bg-green-500/20 text-green-300',
  Normal: 'bg-slate-500/20 text-slate-400',
};

interface SaveModal {
  open: boolean;
  label: string;
  wager: number;
  wagerType: 'classic' | 'pktg';
  bonusType: 'none' | 'bonus' | 'super_bonus';
  notes: string;
}

interface Champion {
  id: number;
  generation: number;
  spot_count: number;
  genome: StrategyGenome;
  fitness_score: number | null;
  test_pnl_per_game: number | null;
  live_ppg: number | null;
}

export default function MyPicksPage() {
  const { toast } = useToast();
  const [games, setGames] = useState<Game[]>([]);
  const [spotCount, setSpotCount] = useState(6);
  const [strategy, setStrategy] = useState<Strategy>('balanced');
  const [mode, setMode] = useState<'manual' | 'evolved'>('manual');
  const [loading, setLoading] = useState(true);
  const [champions, setChampions] = useState<Champion[]>([]);
  const [modal, setModal] = useState<SaveModal>({
    open: false, label: '', wager: 1, wagerType: 'classic', bonusType: 'none', notes: '',
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      supabase.from('games').select('*').order('game_num', { ascending: false }).limit(5000),
      supabase.from('strategies').select('id,generation,spot_count,genome').eq('status', 'promoted').order('spot_count'),
    ]).then(async ([{ data: gamesData }, { data: champsData }]) => {
      if (gamesData) setGames(gamesData as Game[]);

      if (champsData) {
        const enriched: Champion[] = await Promise.all(
          (champsData as { id: number; generation: number; spot_count: number; genome: StrategyGenome }[]).map(async c => {
            const [{ data: result }, { data: live }] = await Promise.all([
              supabase.from('strategy_results').select('fitness_score,test_pnl_per_game')
                .eq('strategy_id', c.id).order('evaluated_at', { ascending: false }).limit(1).maybeSingle(),
              supabase.from('live_results').select('pnl').eq('strategy_id', c.id),
            ]);
            const livePnl = (live ?? []).reduce((s: number, r: { pnl: number }) => s + r.pnl, 0);
            const liveCount = live?.length ?? 0;
            return {
              ...c,
              fitness_score: result?.fitness_score ?? null,
              test_pnl_per_game: result?.test_pnl_per_game ?? null,
              live_ppg: liveCount >= 5 ? livePnl / liveCount : null,
            };
          })
        );
        setChampions(enriched);
      }

      setLoading(false);
    });
  }, []);

  // Compute picks
  const allStats = computeNumberStats(games);
  const currentChamp = champions.find(c => c.spot_count === spotCount);

  let picks: NumberStats[] = [];
  let evolvedPickNumbers: number[] = [];

  if (mode === 'evolved' && currentChamp) {
    evolvedPickNumbers = generatePicks(currentChamp.genome, spotCount, games);
    picks = allStats
      .filter(s => evolvedPickNumbers.includes(s.number))
      .sort((a, b) => evolvedPickNumbers.indexOf(a.number) - evolvedPickNumbers.indexOf(b.number));
  } else {
    picks = pickNumbers(allStats, spotCount, strategy);
  }

  const sortedPicks = [...picks].sort((a, b) => a.number - b.number);

  function openSave() {
    const strategyLabel = mode === 'evolved'
      ? `evolved-${spotCount}-spot`
      : strategy;
    setModal(m => ({
      ...m,
      open: true,
      label: `${spotCount}-spot ${strategyLabel} — ${new Date().toLocaleDateString()}`,
    }));
  }

  async function savePicks() {
    if (!modal.label.trim()) { toast('Label is required', 'error'); return; }
    setSaving(true);
    const scoreSnapshot: Record<number, number> = {};
    picks.forEach(p => { scoreSnapshot[p.number] = p.compositeScore; });

    const { error } = await supabase.from('saved_picks').insert({
      label: modal.label.trim(),
      spot_count: spotCount,
      strategy: mode === 'evolved' ? 'evolved' : strategy,
      numbers: sortedPicks.map(p => p.number),
      wager: modal.wager,
      wager_type: modal.wagerType,
      bonus_type: modal.bonusType,
      notes: modal.notes || null,
      score_snapshot: scoreSnapshot,
      strategy_id: mode === 'evolved' && currentChamp ? currentChamp.id : null,
    });
    setSaving(false);
    if (error) { toast(error.message, 'error'); return; }
    toast('Picks saved!', 'success');
    setModal(m => ({ ...m, open: false }));
  }

  function copyToClipboard() {
    const nums = sortedPicks.map(p => p.number).join(', ');
    const label = mode === 'evolved' ? `Evolved (Strategy #${currentChamp?.id ?? '?'})` : STRATEGY_LABELS[strategy];
    const text = `Maryland Keno ${spotCount}-Spot Picks (${label})\nNumbers: ${nums}\nDate: ${new Date().toLocaleDateString()}`;
    navigator.clipboard.writeText(text);
    toast('Copied to clipboard', 'info');
  }

  if (loading) return <div className="text-slate-500 pt-8">Loading…</div>;

  return (
    <>
      <div className="hidden print:block p-8">
        <h1 className="text-2xl font-bold mb-2">Maryland Keno Picks</h1>
        <p className="text-sm mb-4">{spotCount} spots · {new Date().toLocaleDateString()}</p>
        <div className="flex gap-3 flex-wrap mb-6">
          {sortedPicks.map(p => (
            <div key={p.number} className="w-12 h-12 rounded-full border-2 border-black flex items-center justify-center text-xl font-bold">
              {p.number}
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-6 max-w-4xl no-print">
        <h1 className="text-2xl font-bold">My Picks</h1>

        {/* Mode toggle */}
        <div className="flex gap-2">
          <button
            onClick={() => setMode('manual')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              mode === 'manual' ? 'bg-crimson text-white' : 'bg-[#2a2a2e] text-slate-400 hover:text-white'
            }`}
          >
            Manual
          </button>
          <button
            onClick={() => setMode('evolved')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              mode === 'evolved' ? 'bg-crimson text-white' : 'bg-[#2a2a2e] text-slate-400 hover:text-white'
            }`}
          >
            ⚙ Evolved
          </button>
        </div>

        {/* Controls */}
        <div className="bg-surface rounded-xl p-4 flex flex-wrap gap-5 items-end">
          <div>
            <label className="text-xs text-slate-400 block mb-1">Spot Count</label>
            <div className="flex gap-1">
              {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
                <button
                  key={n}
                  onClick={() => setSpotCount(n)}
                  className={`w-8 h-8 rounded text-sm font-medium transition-colors ${
                    spotCount === n ? 'bg-crimson text-white' : 'bg-[#0e0e10] text-slate-400 hover:text-white border border-[#333]'
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          {mode === 'manual' && (
            <div>
              <label className="text-xs text-slate-400 block mb-1">Strategy</label>
              <select
                value={strategy}
                onChange={e => setStrategy(e.target.value as Strategy)}
                className="bg-[#0e0e10] border border-[#333] text-sm rounded px-3 py-1.5 text-white focus:outline-none focus:border-crimson"
              >
                {(Object.entries(STRATEGY_LABELS) as [Strategy, string][]).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
          )}

          <div className="flex gap-2">
            <button onClick={openSave} className="px-3 py-1.5 rounded-lg bg-crimson hover:bg-crimson-hover text-white text-sm">
              Save Picks
            </button>
            <button onClick={copyToClipboard} className="px-3 py-1.5 rounded-lg bg-[#2a2a2e] hover:bg-[#333] text-slate-300 text-sm">
              Copy
            </button>
            <button onClick={() => window.print()} className="px-3 py-1.5 rounded-lg bg-[#2a2a2e] hover:bg-[#333] text-slate-300 text-sm">
              Print
            </button>
          </div>
        </div>

        {/* Evolved champion info */}
        {mode === 'evolved' && (
          <div className={`bg-surface rounded-xl p-4 border ${currentChamp ? 'border-crimson/30' : 'border-[#333]'}`}>
            {currentChamp ? (
              <div className="flex flex-wrap gap-4 items-start">
                <div>
                  <div className="text-xs text-slate-500 mb-0.5">Champion Strategy</div>
                  <div className="font-bold text-crimson">#{currentChamp.id}</div>
                  <div className="text-xs text-slate-500">Gen {currentChamp.generation}</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 mb-0.5">Fitness</div>
                  <div className="font-mono text-sm">{currentChamp.fitness_score?.toFixed(4) ?? '—'}</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 mb-0.5">Test P&L/game</div>
                  <div className={`font-mono text-sm ${(currentChamp.test_pnl_per_game ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {currentChamp.test_pnl_per_game != null ? `$${currentChamp.test_pnl_per_game.toFixed(3)}` : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 mb-0.5">Live P&L/game</div>
                  <div className={`font-mono text-sm ${(currentChamp.live_ppg ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {currentChamp.live_ppg != null ? `$${currentChamp.live_ppg.toFixed(3)}` : '< 5 plays'}
                  </div>
                </div>
                <div className="flex-1 min-w-40">
                  <div className="text-xs text-slate-500 mb-0.5">Strategy</div>
                  <p className="text-xs text-slate-400 italic">{describeGenome(currentChamp.genome)}</p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-slate-500">
                No evolved champion yet for {spotCount}-spot. Run the hourly sync to start evolution, or choose a different spot count.
              </p>
            )}
          </div>
        )}

        {/* Number balls */}
        {(mode === 'manual' || (mode === 'evolved' && currentChamp)) && (
          <>
            <div className="bg-surface rounded-xl p-5">
              <h2 className="text-sm font-semibold text-slate-400 mb-4">
                {mode === 'evolved'
                  ? `Evolved picks for ${spotCount}-spot (champion strategy #${currentChamp?.id})`
                  : `Top ${spotCount} numbers by ${strategy} strategy`}
              </h2>
              <div className="flex flex-wrap gap-3">
                {picks.sort((a, b) => b.compositeScore - a.compositeScore).map((p, i) => (
                  <div key={p.number} className="relative">
                    <div className={`w-14 h-14 rounded-full flex items-center justify-center text-xl font-bold ${
                      i < 3 ? 'bg-crimson text-white' : 'bg-[#2a2a2e] text-slate-200'
                    }`}>
                      {p.number}
                    </div>
                    <div className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-[#0e0e10] border border-[#333] flex items-center justify-center text-xs text-slate-400 font-bold">
                      {p.rank}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Breakdown table */}
            <div className="bg-surface rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-slate-500 border-b border-[#2a2a2e]">
                      <th className="px-4 py-3 text-left">Rank</th>
                      <th className="px-4 py-3 text-left">Number</th>
                      <th className="px-4 py-3 text-right">Score</th>
                      <th className="px-4 py-3 text-right">Count</th>
                      <th className="px-4 py-3 text-right">% of Games</th>
                      <th className="px-4 py-3 text-right">Deviation</th>
                      <th className="px-4 py-3 text-right">Last Seen</th>
                      <th className="px-4 py-3 text-right">Streak</th>
                      <th className="px-4 py-3 text-center">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {picks.sort((a, b) => b.compositeScore - a.compositeScore).map(p => (
                      <tr key={p.number} className="border-b border-[#1e1e24] hover:bg-[#1e1e24]">
                        <td className="px-4 py-3 text-slate-500">#{p.rank}</td>
                        <td className="px-4 py-3 font-bold text-white">{p.number}</td>
                        <td className="px-4 py-3 text-right font-mono text-crimson">{p.compositeScore.toFixed(3)}</td>
                        <td className="px-4 py-3 text-right">{p.count}</td>
                        <td className="px-4 py-3 text-right">{p.pct.toFixed(1)}%</td>
                        <td className={`px-4 py-3 text-right ${p.deviation >= 0 ? 'text-red-400' : 'text-blue-400'}`}>
                          {p.deviation >= 0 ? '+' : ''}{p.deviation.toFixed(1)}%
                        </td>
                        <td className="px-4 py-3 text-right text-slate-400">
                          {p.lastSeen === null ? 'Never' : p.lastSeen === 0 ? 'Last game' : `${p.lastSeen}g ago`}
                        </td>
                        <td className="px-4 py-3 text-right text-slate-400">{p.streak}</td>
                        <td className="px-4 py-3 text-center">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[p.status]}`}>
                            {p.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <p className="text-xs text-slate-500">
              {mode === 'evolved'
                ? `Evolved picks use the champion strategy's genome to score and rank all 80 numbers.`
                : `Composite score = frequency 30% + recency-weighted 40% + gap 20% + overdue bonus 10%.`}
              {games.length > 0 ? ` Based on ${games.length.toLocaleString()} draws.` : ' No draws loaded yet.'}
            </p>
          </>
        )}
      </div>

      {/* Save modal */}
      {modal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 no-print">
          <div className="bg-surface rounded-2xl p-6 w-full max-w-md space-y-4 mx-4">
            <h2 className="text-lg font-bold">Save Picks</h2>

            {mode === 'evolved' && currentChamp && (
              <div className="text-xs text-slate-500 bg-[#0e0e10] rounded p-2">
                ⚙ Evolved picks from Strategy #{currentChamp.id} (Gen {currentChamp.generation}) will be linked.
              </div>
            )}

            <div>
              <label className="text-xs text-slate-400 block mb-1">Label *</label>
              <input
                value={modal.label}
                onChange={e => setModal(m => ({ ...m, label: e.target.value }))}
                className="w-full bg-[#0e0e10] border border-[#333] rounded px-3 py-2 text-sm focus:outline-none focus:border-crimson"
                placeholder="e.g. Tuesday night session"
              />
            </div>

            <div className="flex gap-4">
              <div className="flex-1">
                <label className="text-xs text-slate-400 block mb-1">Wager ($)</label>
                <input
                  type="number" min={1} max={20}
                  value={modal.wager}
                  onChange={e => setModal(m => ({ ...m, wager: parseInt(e.target.value) || 1 }))}
                  className="w-full bg-[#0e0e10] border border-[#333] rounded px-3 py-2 text-sm focus:outline-none focus:border-crimson"
                />
              </div>
              <div className="flex-1">
                <label className="text-xs text-slate-400 block mb-1">Wager Type</label>
                <select
                  value={modal.wagerType}
                  onChange={e => setModal(m => ({ ...m, wagerType: e.target.value as 'classic' | 'pktg' }))}
                  className="w-full bg-[#0e0e10] border border-[#333] rounded px-3 py-2 text-sm focus:outline-none focus:border-crimson"
                >
                  <option value="classic">Classic</option>
                  <option value="pktg">PKTG</option>
                </select>
              </div>
            </div>

            <div>
              <label className="text-xs text-slate-400 block mb-1">Bonus Type</label>
              <select
                value={modal.bonusType}
                onChange={e => setModal(m => ({ ...m, bonusType: e.target.value as SaveModal['bonusType'] }))}
                className="w-full bg-[#0e0e10] border border-[#333] rounded px-3 py-2 text-sm focus:outline-none focus:border-crimson"
              >
                <option value="none">None</option>
                <option value="bonus">Bonus (2× cost)</option>
                <option value="super_bonus">Super Bonus (3× cost)</option>
              </select>
            </div>

            <div>
              <label className="text-xs text-slate-400 block mb-1">Notes (optional)</label>
              <textarea
                value={modal.notes}
                onChange={e => setModal(m => ({ ...m, notes: e.target.value }))}
                rows={2}
                className="w-full bg-[#0e0e10] border border-[#333] rounded px-3 py-2 text-sm focus:outline-none focus:border-crimson resize-none"
              />
            </div>

            <div className="flex gap-2 justify-end pt-2">
              <button
                onClick={() => setModal(m => ({ ...m, open: false }))}
                className="px-4 py-2 rounded-lg bg-[#2a2a2e] text-slate-300 text-sm hover:bg-[#333]"
              >
                Cancel
              </button>
              <button
                onClick={savePicks}
                disabled={saving}
                className="px-4 py-2 rounded-lg bg-crimson hover:bg-crimson-hover text-white text-sm disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
