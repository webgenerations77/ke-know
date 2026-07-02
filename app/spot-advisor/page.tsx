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
  tier: PlayTier;
  evolvedWager: number;
}

type PlayTier = 'short' | 'medium' | 'long';

interface TierDef {
  label: string;
  subtitle: string;
  minGames: number;
  maxGames: number;
  badgeColor: string;
}

const TIERS: Record<PlayTier, TierDef> = {
  short:  { label: 'Quick Play',    subtitle: 'Up to 40 games — fast action, frequent wins', minGames: 10, maxGames: 40, badgeColor: 'bg-green-900/30 text-green-400 border-green-500/30' },
  medium: { label: 'Standard Session', subtitle: '40–80 games — balanced risk and reward',    minGames: 40, maxGames: 80, badgeColor: 'bg-amber-900/30 text-amber-400 border-amber-500/30' },
  long:   { label: 'Marathon',      subtitle: '80+ games — patient play, maximum edge',       minGames: 80, maxGames: 150, badgeColor: 'bg-purple-900/30 text-purple-400 border-purple-500/30' },
};

function clampGames(games: number, tier: PlayTier): number {
  const t = TIERS[tier];
  return Math.min(t.maxGames, Math.max(t.minGames, Math.ceil(games / 10) * 10));
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

function fmtAdviceDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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

  // Three session tiers: short (≤20 games), medium (40-80), long (80+).
  // For each tier, pick the best champion suited to that session length.
  // Short = highest win rate (frequent wins in few games).
  // Medium = highest fitness (best overall performer).
  // Long = best OOS PPG (strongest long-run edge, patience required).
  const top3: Recommendation[] = (() => {
    const list: Recommendation[] = [];
    const usedSpots = new Set<number>();

    function pickChamp(
      tier: PlayTier,
      sortFn: (a: EvoChampion, b: EvoChampion) => number
    ): Recommendation | null {
      const sorted = [...evoChampions].sort(sortFn);
      for (const champ of sorted) {
        const spots = champ.strategy.spot_count;
        if (usedSpots.has(spots)) continue;
        usedSpots.add(spots);
        const streak = champ.result?.max_losing_streak ?? 5;
        const genome = champ.strategy.genome as unknown as StrategyGenome;
        return {
          spots,
          source: 'evolution',
          evoChampion: champ,
          evPerDollar: computeEV(spots),
          recommendedGames: clampGames(streak * 2, tier),
          bonus: bonusFor(spots),
          tier,
          evolvedWager: genome.wager ?? 1,
        };
      }
      return null;
    }

    // Short: highest win rate — more likely to see wins in a quick session
    const shortPick = pickChamp('short', (a, b) =>
      (b.result?.win_rate ?? 0) - (a.result?.win_rate ?? 0));

    // Medium: highest fitness — best overall balanced performer
    const medPick = pickChamp('medium', (a, b) =>
      (b.result?.fitness_score ?? -999) - (a.result?.fitness_score ?? -999));

    // Long: best OOS PPG — strongest long-run edge
    const longPick = pickChamp('long', (a, b) =>
      (b.result?.test_pnl_per_game ?? -999) - (a.result?.test_pnl_per_game ?? -999));

    if (shortPick) list.push(shortPick);
    if (medPick) list.push(medPick);
    if (longPick) list.push(longPick);

    // Fill remaining slots with EV-based picks
    const evSorted = [...rows].sort((a, b) => b.evPerDollar - a.evPerDollar);
    const tierOrder: PlayTier[] = ['short', 'medium', 'long'];
    for (const r of evSorted) {
      if (list.length >= 3) break;
      if (usedSpots.has(r.spots)) continue;
      usedSpots.add(r.spots);
      const tier = tierOrder[list.length] ?? 'medium';
      list.push({
        spots: r.spots,
        source: 'ev',
        evPerDollar: r.evPerDollar,
        recommendedGames: clampGames(20, tier),
        bonus: bonusFor(r.spots),
        tier,
        evolvedWager: wager,
      });
    }

    return list;
  })();

  if (loading) return <div className="text-slate-500 pt-8">Loading…</div>;

  return (
    <div className="space-y-6 max-w-4xl">
      <h1 className="text-2xl font-bold">Spot Advisor</h1>

      <div className="bg-crimson/10 border border-crimson/30 rounded-xl p-5 space-y-4">
        <h2 className="font-semibold text-crimson-light">Arthur's Picks by Session Length</h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {top3.map((rec) => {
            const tier = TIERS[rec.tier];
            return (
              <div key={`${rec.spots}-${rec.tier}`} className="bg-[#0e0e10] rounded-xl p-4 border border-[#2a2a2e] space-y-3">
                <div className="flex items-center justify-between">
                  <span className={`px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wide border ${tier.badgeColor}`}>
                    {tier.label}
                  </span>
                  {rec.source === 'evolution' ? (
                    <span className="px-2 py-0.5 rounded-full bg-crimson/20 text-crimson-light text-[10px] font-semibold uppercase tracking-wide">
                      Evolved
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded-full bg-slate-700/40 text-slate-400 text-[10px] font-semibold uppercase tracking-wide">
                      EV-Based
                    </span>
                  )}
                </div>

                <div>
                  <div className="text-lg font-bold text-white">Play {rec.spots} spots</div>
                  <p className="text-[10px] text-slate-600 mt-0.5">{tier.subtitle}</p>
                </div>

                {rec.evoChampion && (
                  <p className="text-xs text-slate-400 italic">
                    {summarizeChampion(rec)}
                  </p>
                )}

                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-slate-500">Games to play</span>
                    <span className="font-mono text-white font-bold">{rec.recommendedGames}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Base wager</span>
                    <span className="font-mono text-white">${rec.evolvedWager}</span>
                  </div>
                  {rec.bonus.label !== 'Base' && (
                    <div className="flex justify-between">
                      <span className="text-slate-500">With {rec.bonus.label}</span>
                      <span className="font-mono text-white">
                        ${rec.bonus.label === 'Super Bonus' ? rec.evolvedWager * 3 : rec.evolvedWager * 2}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-slate-500">Bonus to play</span>
                    <span className="font-mono text-white">{rec.bonus.label}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Session cost</span>
                    <span className="font-mono text-slate-300">
                      ${(rec.recommendedGames * (rec.bonus.label === 'Super Bonus' ? rec.evolvedWager * 3 : rec.bonus.label === 'Bonus' ? rec.evolvedWager * 2 : rec.evolvedWager)).toFixed(2)}
                    </span>
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

                {/* When this advice was generated — the champion's last evaluation
                    (evolution picks) or "live" for EV-derived fallbacks. */}
                {(() => {
                  const adviceDate = rec.source === 'evolution'
                    ? fmtAdviceDate(rec.evoChampion?.result?.evaluated_at ?? rec.evoChampion?.strategy.promoted_at)
                    : null;
                  return (
                    <p className="text-[10px] text-slate-600 pt-1 border-t border-[#1e1e24] mt-1">
                      {adviceDate ? `Advice as of ${adviceDate}` : 'Updated live from current data'}
                    </p>
                  );
                })()}
              </div>
            );
          })}
        </div>

        <p className="text-xs text-slate-500">
          Each tier suits a different play style. Quick Play picks strategies with the highest win rate for fast action.
          Marathon picks strategies with the strongest long-run edge — rare wins but bigger payouts.
          {!evoLoading && evoChampions.length === 0 && ' No champions promoted yet — run evolution to unlock Arthur\'s picks.'}
        </p>
      </div>

    </div>
  );
}
