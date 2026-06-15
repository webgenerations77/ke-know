'use client';

import { useEffect, useState } from 'react';
import { supabase, Game } from '@/lib/supabase';
import {
  PRIZE_TABLE, OVERALL_ODDS, computeEV, hypergeoPMF,
  BONUS_DIST, SUPER_BONUS_DIST,
} from '@/lib/keno-odds';
import {
  computeNumberStats, computeBonusDist, expectedMultiplierFromDist,
} from '@/lib/analysis';

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

export default function SpotAdvisorPage() {
  const [games, setGames] = useState<Game[]>([]);
  const [wager, setWager] = useState(1);
  const [wagerType, setWagerType] = useState<'classic' | 'pktg'>('classic');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.from('games').select('*').order('game_num', { ascending: false }).limit(5000)
      .then(({ data }) => {
        if (data) setGames(data as Game[]);
        setLoading(false);
      });
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

  const baseEv = computeEV(bestSpots);
  const bonusEv = baseEv * bonusMultFromDb; // return on $1 of prizes, wager cost is 2×
  const superEv = baseEv * superMultFromDb; // return on $1 of prizes, wager cost is 3×

  const baseRatio = baseEv; // per $1
  const bonusRatio = bonusEv / 2; // per $1 (cost 2×)
  const superRatio = superEv / 3; // per $1 (cost 3×)

  const bestBonus = superRatio > bonusRatio && superRatio > baseRatio
    ? 'Super Bonus'
    : bonusRatio > baseRatio
    ? 'Bonus'
    : 'None';

  if (loading) return <div className="text-slate-500 pt-8">Loading…</div>;

  return (
    <div className="space-y-6 max-w-4xl">
      <h1 className="text-2xl font-bold">Spot Advisor</h1>

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

      {/* Recommendation callout */}
      <div className="bg-crimson/10 border border-crimson/30 rounded-xl p-5 space-y-2">
        <h2 className="font-semibold text-crimson-light">Recommendation</h2>
        <p className="text-sm text-slate-300 leading-relaxed">
          <strong className="text-white">Play {bestSpots} spots</strong> — it has the highest expected return of{' '}
          <strong className="text-green-400">{fmtEv(rows[bestIdx].evPerDollar * prizeScale, wager)}</strong> per ${wager} wager
          (return ratio: {(rows[bestIdx].evPerDollar * 100).toFixed(1)}¢ per dollar wagered).
          {rows[bestIdx].historicalHitRate !== null && (
            <> Historical hit rate using top-scored numbers: <strong>{rows[bestIdx].historicalHitRate.toFixed(1)}%</strong>.</>
          )}
        </p>
        <p className="text-xs text-slate-500">
          EV is calculated from official Maryland Lottery prize tables using the hypergeometric probability distribution
          (N=80, k=20 drawn). A higher EV per dollar means a better expected return — though all spot counts are
          negative-EV in the long run (that's how lotteries work). This tool helps you choose the least-bad option.
        </p>
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
