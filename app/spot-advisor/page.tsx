'use client';

import { useEffect, useState } from 'react';
import { supabase, Game, Strategy, StrategyResult } from '@/lib/supabase';
import {
  PRIZE_TABLE, OVERALL_ODDS, computeEV, hypergeoPMF,
  BONUS_DIST, SUPER_BONUS_DIST,
} from '@/lib/keno-odds';
import {
  computeNumberStats, computeBonusDist, expectedMultiplierFromDist,
} from '@/lib/analysis';
import type { StrategyGenome } from '@/lib/evolution/genome';

interface EvoChampion {
  strategy: Strategy;
  result: StrategyResult | null;
}

interface BonusPick {
  label: 'Base' | 'Bonus' | 'Super Bonus';
  baseRatio: number;
  bonusRatio: number;
  superRatio: number;
}

interface Recommendation {
  spots: number;
  source: 'evolution' | 'ev';
  evoChampion?: EvoChampion;
  evPerDollar: number;
  recommendedGames: number;
  bonus: BonusPick;
}

// How many games in a row to commit to so the strategy has room to recover
// from its own worst historical losing streak (with a buffer), rounded to a
// friendly number. Strategies without backtest history default to a
// conservative 20-game session.
function recommendedSessionLength(maxLosingStreak: number | null | undefined): number {
  const streak = maxLosingStreak ?? 5;
  return Math.max(20, Math.ceil((streak * 2) / 10) * 10);
}

interface SpotRow {
  spots: number;
  oddsDisplay: string;
  topPrize: number;
  evPerDollar: number;
  historicalHitRate: number | null;
  isBest: boolean;
}

function fmt(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function fmtEv(ev: number, wager: number) {
  return (ev * wager).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function summarizeChampion(rec: Recommendation): string {
  const wr = rec.evoChampion?.result?.win_rate;
  const ppg = rec.evoChampion?.result?.test_pnl_per_game;
  const streak = rec.evoChampion?.result?.max_losing_streak;
  const genome = rec.evoChampion?.strategy.genome as unknown as StrategyGenome | undefined;

  if (wr == null && ppg == null) return "Arthur's top pick for this spot count — still gathering data.";

  const wrPct = wr != null ? (wr * 100) : 0;

  let summary = '';
  if (wrPct >= 30) {
    summary = `This one hits pretty often — about ${wrPct.toFixed(0)}% of games pay out.`;
  } else if (wrPct >= 15) {
    summary = `Wins roughly 1 in ${Math.round(100 / wrPct)} games, which is solid for ${rec.spots}-spot.`;
  } else if (wrPct > 0) {
    summary = `It's a long-shot play — wins are rare but the payouts make up for it.`;
  }

  if (ppg != null && ppg > 0) {
    summary += ` Historically comes out ahead over a full session.`;
  } else if (ppg != null) {
    summary += ` Still refining — the math is close to breaking even.`;
  }

  if (streak != null && streak > 10) {
    summary += ` Can go cold for ${streak}+ games, so give it room to run.`;
  }

  if (genome?.bonus_type === 'bonus') {
    summary += ` Plays with Bonus for extra upside on wins.`;
  } else if (genome?.bonus_type === 'super_bonus') {
    summary += ` Uses Super Bonus to chase bigger multipliers.`;
  }

  return summary.trim();
}

function Ball({ n }: { n: number }) {
  return (
    <span className="inline-flex w-7 h-7 rounded-full items-center justify-center text-xs font-bold shrink-0 bg-crimson text-white">
      {n}
    </span>
  );
}

export default function SpotAdvisorPage() {
  const [games, setGames] = useState<Game[]>([]);
  const [wager, setWager] = useState(1);
  const [wagerType, setWagerType] = useState<'classic' | 'pktg'>('classic');
  const [loading, setLoading] = useState(true);
  const [evoChampions, setEvoChampions] = useState<EvoChampion[]>([]);
  const [evoLoading, setEvoLoading] = useState(true);

  useEffect(() => {
    supabase.from('games').select('*').order('game_num', { ascending: false }).limit(5000)
      .then(({ data }) => {
        if (data) setGames(data as Game[]);
        setLoading(false);
      });
  }, []);

  // Pull every promoted strategy (one per spot count) from the evolution
  // engine, sorted by fitness score, to drive the top recommendations.
  useEffect(() => {
    async function loadEvoChampions() {
      const { data: strats } = await supabase
        .from('strategies')
        .select('*')
        .eq('status', 'promoted');

      if (!strats || strats.length === 0) {
        setEvoLoading(false);
        return;
      }

      const ids = (strats as Strategy[]).map(s => s.id);
      const { data: results } = await supabase
        .from('strategy_results')
        .select('*')
        .in('strategy_id', ids)
        .order('evaluated_at', { ascending: false });

      const latestByStrategy = new Map<number, StrategyResult>();
      for (const r of (results ?? []) as StrategyResult[]) {
        if (!latestByStrategy.has(r.strategy_id)) latestByStrategy.set(r.strategy_id, r);
      }

      const champs: EvoChampion[] = (strats as Strategy[]).map(s => ({
        strategy: s,
        result: latestByStrategy.get(s.id) ?? null,
      }));
      champs.sort((a, b) => (b.result?.fitness_score ?? -999) - (a.result?.fitness_score ?? -999));

      setEvoChampions(champs);
      setEvoLoading(false);
    }
    loadEvoChampions();
  }, []);

  const effectiveWager = wagerType === 'pktg' ? wager * 0.25 : wager;
  const prizeScale = wagerType === 'pktg' ? 0.25 : 1;

  // Historical hit rate: % of last 5000 games where the top-N scored numbers
  // hit the minimum winning catch threshold
  function historicalHitRate(spots: number): number | null {
    if (games.length < 100) return null;
    const stats = computeNumberStats(games);
    const topN = stats.slice(0, spots).map(s => s.number);
    const prizes = PRIZE_TABLE[spots] ?? [];
    const minCatch = prizes.length > 0 ? Math.min(...prizes.map(p => p.catches)) : spots;
    let hits = 0;
    for (const g of games) {
      const matches = g.hits.filter(h => topN.includes(h)).length;
      if (matches >= minCatch) hits++;
    }
    return (hits / games.length) * 100;
  }

  const rows: SpotRow[] = Array.from({ length: 10 }, (_, i) => {
    const spots = i + 1;
    const ev = computeEV(spots);
    const topPrize = Math.max(...(PRIZE_TABLE[spots]?.map(p => p.prize) ?? [0]));
    return {
      spots,
      oddsDisplay: `1 in ${OVERALL_ODDS[spots]}`,
      topPrize: topPrize * prizeScale,
      evPerDollar: ev,
      historicalHitRate: historicalHitRate(spots),
      isBest: false,
    };
  });
  // Best = highest EV per dollar
  const bestIdx = rows.reduce((bi, r, i) => (r.evPerDollar > rows[bi].evPerDollar ? i : bi), 0);
  rows[bestIdx].isBest = true;
  const bestSpots = rows[bestIdx].spots;

  // Bonus EV advisor
  const dbBonusDist = computeBonusDist(games, 'bonus');
  const dbSuperDist = computeBonusDist(games, 'super_bonus');
  const bonusMultFromDb = dbBonusDist.length >= 2
    ? expectedMultiplierFromDist(dbBonusDist)
    : BONUS_DIST.reduce((s, x) => s + x.multiplier * x.prob, 0);
  const superMultFromDb = dbSuperDist.length >= 2
    ? expectedMultiplierFromDist(dbSuperDist)
    : SUPER_BONUS_DIST.reduce((s, x) => s + x.multiplier * x.prob, 0);

  // Best base/bonus/super-bonus tier for a given spot count, by EV per $1 wagered.
  function bonusFor(spots: number): BonusPick {
    const ev = computeEV(spots);
    const baseRatio = ev; // per $1
    const bonusRatio = (ev * bonusMultFromDb) / 2; // per $1 (cost 2×)
    const superRatio = (ev * superMultFromDb) / 3; // per $1 (cost 3×)
    const label: BonusPick['label'] = superRatio > bonusRatio && superRatio > baseRatio
      ? 'Super Bonus'
      : bonusRatio > baseRatio
      ? 'Bonus'
      : 'Base';
    return { label, baseRatio, bonusRatio, superRatio };
  }

  const baseEv = computeEV(bestSpots);
  const { label: bestBonus, baseRatio, bonusRatio, superRatio } = bonusFor(bestSpots);

  // Top 3 recommendations: evolution-promoted champions first (highest fitness,
  // one per spot count), filled out with the next-best static EV spot counts
  // until evolution has promoted enough champions.
  const top3: Recommendation[] = (() => {
    const list: Recommendation[] = [];
    const usedSpots = new Set<number>();

    for (const champ of evoChampions) {
      if (list.length >= 3) break;
      const spots = champ.strategy.spot_count;
      if (usedSpots.has(spots)) continue;
      usedSpots.add(spots);
      list.push({
        spots,
        source: 'evolution',
        evoChampion: champ,
        evPerDollar: computeEV(spots),
        recommendedGames: recommendedSessionLength(champ.result?.max_losing_streak),
        bonus: bonusFor(spots),
      });
    }

    const evSorted = [...rows].sort((a, b) => b.evPerDollar - a.evPerDollar);
    for (const r of evSorted) {
      if (list.length >= 3) break;
      if (usedSpots.has(r.spots)) continue;
      usedSpots.add(r.spots);
      list.push({
        spots: r.spots,
        source: 'ev',
        evPerDollar: r.evPerDollar,
        recommendedGames: recommendedSessionLength(null),
        bonus: bonusFor(r.spots),
      });
    }

    return list;
  })();

  if (loading) return <div className="text-slate-500 pt-8">Loading…</div>;

  return (
    <div className="space-y-6 max-w-4xl">
      <h1 className="text-2xl font-bold">Spot Advisor</h1>

      {/* Top 3 Recommendations — evolution-promoted champions (highest fitness
          score, one per spot count) first, filled out with the next-best
          static EV spot counts until the engine has promoted enough champions. */}
      <div className="bg-crimson/10 border border-crimson/30 rounded-xl p-5 space-y-4">
        <h2 className="font-semibold text-crimson-light">Top 3 Recommendations</h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {top3.map((rec, i) => (
            <div key={`${rec.spots}-${i}`} className="bg-[#0e0e10] rounded-xl p-4 border border-[#2a2a2e] space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-crimson">#{i + 1}</span>
                {rec.source === 'evolution' ? (
                  <span className="px-2 py-0.5 rounded-full bg-crimson/20 text-crimson-light text-[10px] font-semibold uppercase tracking-wide">
                    Evolution-Learned
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded-full bg-slate-700/40 text-slate-400 text-[10px] font-semibold uppercase tracking-wide">
                    EV-Based
                  </span>
                )}
              </div>

              <div className="text-lg font-bold text-white">Play {rec.spots} spots</div>

              {rec.evoChampion && (
                <p className="text-xs text-slate-400 italic">
                  {summarizeChampion(rec)}
                </p>
              )}

              <div className="space-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-slate-500">Games to play</span>
                  <span className="font-mono text-white">{rec.recommendedGames}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Wager per game</span>
                  <span className="font-mono text-white">${wager}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Bonus to play</span>
                  <span className="font-mono text-white">{rec.bonus.label}</span>
                </div>
                {rec.evoChampion?.result?.test_pnl_per_game != null ? (
                  <div className="flex justify-between">
                    <span className="text-slate-500">Backtested P&L/game</span>
                    <span className={`font-mono ${rec.evoChampion.result.test_pnl_per_game >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      ${rec.evoChampion.result.test_pnl_per_game.toFixed(3)}
                    </span>
                  </div>
                ) : (
                  <div className="flex justify-between">
                    <span className="text-slate-500">EV / $1 wagered</span>
                    <span className="font-mono text-green-400">{(rec.evPerDollar * 100).toFixed(1)}¢</span>
                  </div>
                )}
                {rec.evoChampion?.result?.win_rate != null && (
                  <div className="flex justify-between">
                    <span className="text-slate-500">Win rate</span>
                    <span className="font-mono text-white">{(rec.evoChampion.result.win_rate * 100).toFixed(1)}%</span>
                  </div>
                )}
              </div>

              {rec.evoChampion?.result?.picks_snapshot && rec.evoChampion.result.picks_snapshot.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-1">
                  {rec.evoChampion.result.picks_snapshot.map(n => <Ball key={n} n={n} />)}
                </div>
              )}
            </div>
          ))}
        </div>

        <p className="text-xs text-slate-500">
          Arthur ranks these by testing strategies against thousands of real draws. &quot;Games to play&quot; gives the strategy
          enough room to recover from cold streaks.
          {!evoLoading && evoChampions.length === 0 && ' No champions promoted yet — run evolution to unlock Arthur\'s picks.'}
        </p>
      </div>

      {/* Controls */}
      <div className="bg-surface rounded-xl p-4 flex flex-wrap gap-5 items-center">
        <div>
          <label className="text-xs text-slate-400 block mb-1">Wager per game ($1–$20)</label>
          <input
            type="number"
            min={1}
            max={20}
            value={wager}
            onChange={e => setWager(Math.min(20, Math.max(1, parseInt(e.target.value) || 1)))}
            className="w-20 px-3 py-1.5 rounded bg-[#0e0e10] border border-[#333] text-sm text-white focus:outline-none focus:border-crimson"
          />
        </div>
        <div>
          <label className="text-xs text-slate-400 block mb-1">Wager Type</label>
          <div className="flex gap-2">
            {(['classic', 'pktg'] as const).map(t => (
              <button
                key={t}
                onClick={() => setWagerType(t)}
                className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                  wagerType === t ? 'bg-crimson text-white' : 'bg-[#0e0e10] text-slate-400 hover:text-white border border-[#333]'
                }`}
              >
                {t === 'classic' ? 'Classic' : 'PKTG (¼ prizes)'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Spot comparison table */}
      <div className="bg-surface rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-500 border-b border-[#2a2a2e]">
                <th className="px-4 py-3 text-left">Spots</th>
                <th className="px-4 py-3 text-left">Overall Odds</th>
                <th className="px-4 py-3 text-right">Top Prize</th>
                <th className="px-4 py-3 text-right">EV / ${wager}</th>
                <th className="px-4 py-3 text-right">Historical Hit%</th>
                <th className="px-4 py-3 text-center">Best</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr
                  key={row.spots}
                  className={`border-b border-[#1e1e24] hover:bg-[#1e1e24] transition-colors ${
                    row.isBest ? 'bg-crimson/10' : ''
                  }`}
                >
                  <td className="px-4 py-3 font-semibold">{row.spots}</td>
                  <td className="px-4 py-3 text-slate-400">{row.oddsDisplay}</td>
                  <td className="px-4 py-3 text-right">
                    {fmt(row.topPrize * wager)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-green-400">
                    {fmtEv(row.evPerDollar * prizeScale, wager)}
                  </td>
                  <td className="px-4 py-3 text-right text-slate-400">
                    {row.historicalHitRate !== null ? `${row.historicalHitRate.toFixed(1)}%` : '—'}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {row.isBest && (
                      <span className="px-2 py-0.5 rounded-full bg-crimson text-white text-xs font-semibold">
                        Best EV
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Bonus advisor */}
      <div className="bg-surface rounded-xl p-5 space-y-4">
        <h2 className="font-semibold">Bonus / Super Bonus Advisor</h2>
        <p className="text-xs text-slate-500 mb-2">
          Using {dbBonusDist.length >= 2 ? 'actual DB multiplier frequencies' : 'theoretical multiplier distribution'}.
          Based on {bestSpots}-spot picks at ${wager} wager.
        </p>

        <div className="grid grid-cols-3 gap-4">
          {[
            {
              label: 'Base',
              cost: `$${wager}`,
              ev: baseRatio * wager,
              evRatio: baseRatio,
              desc: `E[return] = ${(baseEv * 100).toFixed(1)}¢ per $1`,
            },
            {
              label: 'Bonus',
              cost: `$${wager * 2}`,
              ev: bonusRatio * wager,
              evRatio: bonusRatio,
              desc: `E[mult] = ${bonusMultFromDb.toFixed(2)}×, E[return] per $1 = ${(bonusRatio * 100).toFixed(1)}¢`,
            },
            {
              label: 'Super Bonus',
              cost: `$${wager * 3}`,
              ev: superRatio * wager,
              evRatio: superRatio,
              desc: `E[mult] = ${superMultFromDb.toFixed(2)}×, E[return] per $1 = ${(superRatio * 100).toFixed(1)}¢`,
            },
          ].map(({ label, cost, ev, evRatio, desc }) => (
            <div
              key={label}
              className={`rounded-xl p-4 border ${
                label === bestBonus
                  ? 'border-crimson bg-crimson/10'
                  : 'border-[#2a2a2e] bg-[#0e0e10]'
              }`}
            >
              <div className="text-xs text-slate-400">{label}</div>
              <div className="text-lg font-bold text-white mt-1">{cost} cost</div>
              <div className="text-green-400 font-mono text-sm mt-1">
                {ev.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })} expected
              </div>
              <div className="text-xs text-slate-500 mt-2">{desc}</div>
              {label === bestBonus && (
                <span className="mt-2 inline-block px-2 py-0.5 rounded-full bg-crimson text-white text-xs">
                  Best EV/$
                </span>
              )}
            </div>
          ))}
        </div>

        <p className="text-xs text-slate-500 mt-2">
          Bonus costs 2× your wager; Super Bonus costs 3×. Both multiply your prize winnings by a drawn multiplier.
          Super Bonus guarantees at least 2× and has a higher expected multiplier. Return ratios above assume you win
          and apply the average multiplier — the actual multiplier for any single game is random.
        </p>
      </div>
    </div>
  );
}
