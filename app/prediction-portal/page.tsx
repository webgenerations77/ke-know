'use client';

import { useEffect, useState, useCallback } from 'react';
import { supabase, Game, MyPlay } from '@/lib/supabase';
import {
  computePrediction,
  computeMomentum,
  evaluatePlay,
  DOW_LABELS,
  NumberPrediction,
  PlayPerformance,
} from '@/lib/prediction-engine';

const CRIMSON = '#8B1A4A';

// ── Small reusable components ─────────────────────────────────────────────────

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${color}`}>
      {label}
    </span>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const color = value > 65 ? 'bg-green-500' : value > 45 ? 'bg-yellow-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-[#1e1e24] rounded-full h-1.5">
        <div className={`${color} h-1.5 rounded-full transition-all`} style={{ width: `${value}%` }} />
      </div>
      <span className="text-xs font-mono text-slate-400 w-8">{value}</span>
    </div>
  );
}

const DOW_TODAY = new Date().getDay();

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PredictionPortalPage() {
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState(true);
  const [spotCount, setSpotCount] = useState(8);
  const [targetDow, setTargetDow] = useState(DOW_TODAY);
  const [myPlays, setMyPlays] = useState<MyPlay[]>([]);
  const [performances, setPerformances] = useState<Map<number, PlayPerformance>>(new Map());
  const [showAddForm, setShowAddForm] = useState(false);
  const [newPlay, setNewPlay] = useState({ name: '', numbersStr: '', wager: 1 });
  const [addError, setAddError] = useState('');
  const [activeTab, setActiveTab] = useState<'prediction' | 'myplays'>('prediction');
  const [expandedPick, setExpandedPick] = useState<number | null>(null);

  // Load games + my plays
  useEffect(() => {
    Promise.all([
      supabase.from('games').select('*').order('game_num', { ascending: false }).limit(5000),
      supabase.from('my_plays').select('*').order('created_at', { ascending: false }),
    ]).then(([{ data: gData }, { data: pData }]) => {
      if (gData) setGames(gData as Game[]);
      if (pData) setMyPlays(pData as MyPlay[]);
      setLoading(false);
    });
  }, []);

  // Evaluate my plays whenever games/plays change
  useEffect(() => {
    if (!games.length || !myPlays.length) return;
    const m = new Map<number, PlayPerformance>();
    for (const play of myPlays) {
      m.set(play.id, evaluatePlay(play.numbers, games));
    }
    setPerformances(m);
  }, [games, myPlays]);

  const prediction = games.length >= 50
    ? computePrediction(games, spotCount, targetDow)
    : null;

  const momentum = games.length >= 50 ? computeMomentum(games) : [];
  const rising = momentum.filter(m => m.trend === 'rising').sort((a, b) => b.momentumNorm - a.momentumNorm).slice(0, 8);
  const falling = momentum.filter(m => m.trend === 'falling').sort((a, b) => a.momentumNorm - b.momentumNorm).slice(0, 8);

  // Add a new play
  const addPlay = useCallback(async () => {
    setAddError('');
    const nums = newPlay.numbersStr
      .split(/[,\s]+/)
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n) && n >= 1 && n <= 80);
    const unique = [...new Set(nums)];
    if (!newPlay.name.trim()) { setAddError('Name is required.'); return; }
    if (unique.length < 1) { setAddError('Enter at least 1 number (1–80).'); return; }
    if (unique.length > 10) { setAddError('Max 10 numbers.'); return; }

    const { data, error } = await supabase.from('my_plays').insert({
      name: newPlay.name.trim(),
      numbers: unique,
      spot_count: unique.length,
      wager: newPlay.wager,
      wager_type: 'classic',
      bonus_type: 'none',
      active: true,
    }).select().single();

    if (error) { setAddError(error.message); return; }
    setMyPlays(prev => [data as MyPlay, ...prev]);
    setNewPlay({ name: '', numbersStr: '', wager: 1 });
    setShowAddForm(false);
  }, [newPlay]);

  const deletePlay = useCallback(async (id: number) => {
    await supabase.from('my_plays').delete().eq('id', id);
    setMyPlays(prev => prev.filter(p => p.id !== id));
    setPerformances(prev => { const m = new Map(prev); m.delete(id); return m; });
  }, []);

  if (loading) return <div className="text-slate-500 pt-8">Loading…</div>;

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold">Prediction Portal</h1>
        <p className="text-sm text-slate-400 mt-1">
          5-signal AI-assisted pick engine — composite history, momentum, day alignment, gap urgency, and streak analysis.
        </p>
      </div>

      {games.length < 100 && (
        <div className="bg-yellow-900/30 border border-yellow-700 rounded-xl p-4 text-sm text-yellow-300">
          Only {games.length} games loaded. Run the backfill on the Data Ingestion page for accurate predictions.
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 bg-[#0e0e10] rounded-lg p-1 w-fit">
        {(['prediction', 'myplays'] as const).map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            className={`px-4 py-1.5 rounded text-sm font-medium transition-colors ${
              activeTab === tab ? 'bg-crimson text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            {tab === 'prediction' ? 'Today\'s Prediction' : `My Plays (${myPlays.length})`}
          </button>
        ))}
      </div>

      {activeTab === 'prediction' && (
        <>
          {/* Controls */}
          <div className="bg-surface rounded-xl p-4 flex flex-wrap gap-5 items-end">
            <div>
              <label className="text-xs text-slate-400 block mb-1">Spots to Pick</label>
              <select value={spotCount} onChange={e => setSpotCount(+e.target.value)}
                className="px-3 py-1.5 rounded bg-[#0e0e10] border border-[#333] text-sm text-white focus:outline-none focus:border-crimson"
              >
                {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
                  <option key={n} value={n}>{n} Spots</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Simulate Playing On</label>
              <div className="flex gap-1 flex-wrap">
                {DOW_LABELS.map((d, i) => (
                  <button key={i} onClick={() => setTargetDow(i)}
                    className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                      targetDow === i
                        ? 'bg-crimson text-white'
                        : i === DOW_TODAY
                        ? 'bg-[#1e2a1e] text-green-400 border border-green-800'
                        : 'bg-[#0e0e10] text-slate-400 border border-[#333] hover:text-white'
                    }`}
                  >
                    {d}{i === DOW_TODAY ? ' ★' : ''}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {prediction && (
            <>
              {/* Recommendation Card */}
              <div className="bg-surface rounded-xl p-5 border border-crimson/30">
                <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
                  <div>
                    <h2 className="font-bold text-lg">Play Recommendation</h2>
                    <p className="text-xs text-slate-500 mt-0.5">Based on {games.length.toLocaleString()} historical draws · 5 weighted signals</p>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-slate-400 mb-1">Overall Confidence</div>
                    <div className={`text-3xl font-bold ${
                      prediction.overallConfidence > 65 ? 'text-green-400'
                      : prediction.overallConfidence > 45 ? 'text-yellow-400'
                      : 'text-red-400'
                    }`}>{prediction.overallConfidence}<span className="text-sm text-slate-500">/100</span></div>
                  </div>
                </div>

                {/* Picks Grid */}
                <div className="mb-4">
                  <div className="text-xs text-slate-500 mb-2">Top {spotCount} Picks</div>
                  <div className="flex flex-wrap gap-2">
                    {prediction.picks.map(p => (
                      <button key={p.number}
                        onClick={() => setExpandedPick(expandedPick === p.number ? null : p.number)}
                        className={`w-11 h-11 rounded-lg flex items-center justify-center font-bold text-sm transition-all hover:scale-110 ${
                          p.recommendation === 'Strong Play'
                            ? 'bg-crimson text-white shadow-lg shadow-crimson/30'
                            : p.recommendation === 'Play'
                            ? 'bg-[#1a3a5e] text-blue-200'
                            : 'bg-[#2a2a2e] text-slate-400'
                        }`}
                      >
                        {p.number}
                      </button>
                    ))}
                  </div>
                  <div className="mt-2 text-xs text-slate-500">
                    <span className="inline-block w-3 h-3 rounded bg-crimson mr-1 align-middle" />Strong Play
                    <span className="inline-block w-3 h-3 rounded bg-[#1a3a5e] mx-1 ml-3 align-middle" />Play
                  </div>
                </div>

                {/* Expanded signal breakdown */}
                {expandedPick !== null && (() => {
                  const p = prediction.picks.find(x => x.number === expandedPick);
                  if (!p) return null;
                  return (
                    <div className="mb-4 bg-[#0e0e10] rounded-xl p-4 border border-[#333]">
                      <div className="flex justify-between items-center mb-3">
                        <span className="font-bold text-white text-lg">Number {p.number}</span>
                        <Badge label={p.recommendation}
                          color={p.recommendation === 'Strong Play' ? 'bg-crimson text-white' : 'bg-blue-900 text-blue-200'} />
                      </div>
                      <div className="space-y-2">
                        {p.signals.map(s => (
                          <div key={s.name}>
                            <div className="flex justify-between text-xs text-slate-400 mb-0.5">
                              <span>{s.name} <span className="text-slate-600">({(s.weight * 100).toFixed(0)}% weight)</span></span>
                              <span>{(s.score * 100).toFixed(0)}/100</span>
                            </div>
                            <ConfidenceBar value={Math.round(s.score * 100)} />
                            <div className="text-xs text-slate-600 mt-0.5">{s.description}</div>
                          </div>
                        ))}
                      </div>
                      <button onClick={() => setExpandedPick(null)} className="mt-3 text-xs text-slate-500 hover:text-white">Close ✕</button>
                    </div>
                  );
                })()}

                {/* When / How / How much */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                  {[
                    { label: 'Best Day to Play', value: prediction.whenToPlay, icon: '📅' },
                    { label: 'Games to Play', value: `${prediction.howManyGames} games`, icon: '🎯' },
                    { label: 'Suggested Wager', value: `$${prediction.howMuchToWager}/game`, icon: '💰' },
                    { label: 'Expected Matches', value: `~${prediction.predictedMatchRate.toFixed(1)}/draw`, icon: '⚡' },
                  ].map(({ label, value, icon }) => (
                    <div key={label} className="bg-[#0e0e10] rounded-lg p-3">
                      <div className="text-lg mb-1">{icon}</div>
                      <div className="text-xs text-slate-500">{label}</div>
                      <div className="text-sm font-semibold text-white mt-0.5">{value}</div>
                    </div>
                  ))}
                </div>

                {/* AI Reasoning */}
                <div>
                  <div className="text-xs text-slate-500 mb-2 font-semibold uppercase tracking-wide">Signal Analysis</div>
                  <ul className="space-y-1">
                    {prediction.reasoning.map((r, i) => (
                      <li key={i} className="text-xs text-slate-400 flex gap-2">
                        <span className="text-crimson/60 mt-0.5">›</span>
                        <span>{r}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* Momentum Snapshot */}
              <div className="grid md:grid-cols-2 gap-4">
                <div className="bg-surface rounded-xl p-4">
                  <h2 className="text-sm font-semibold mb-3 text-green-400">Rising Momentum</h2>
                  <div className="space-y-2">
                    {rising.map(m => (
                      <div key={m.number} className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded bg-green-900/30 flex items-center justify-center text-xs font-bold text-green-400">
                          {m.number}
                        </div>
                        <div className="flex-1">
                          <div className="flex justify-between text-xs text-slate-400 mb-0.5">
                            <span>Recent {m.recentCount} vs Prior {m.priorCount}</span>
                            <span className="text-green-400">↑ {((m.momentumNorm - 0.5) * 200).toFixed(0)}%</span>
                          </div>
                          <div className="w-full bg-[#1e1e24] rounded-full h-1">
                            <div className="bg-green-500 h-1 rounded-full" style={{ width: `${m.momentumNorm * 100}%` }} />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="bg-surface rounded-xl p-4">
                  <h2 className="text-sm font-semibold mb-3 text-red-400">Falling Momentum</h2>
                  <div className="space-y-2">
                    {falling.map(m => (
                      <div key={m.number} className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded bg-red-900/20 flex items-center justify-center text-xs font-bold text-red-400">
                          {m.number}
                        </div>
                        <div className="flex-1">
                          <div className="flex justify-between text-xs text-slate-400 mb-0.5">
                            <span>Recent {m.recentCount} vs Prior {m.priorCount}</span>
                            <span className="text-red-400">↓ {((0.5 - m.momentumNorm) * 200).toFixed(0)}%</span>
                          </div>
                          <div className="w-full bg-[#1e1e24] rounded-full h-1">
                            <div className="bg-red-500 h-1 rounded-full" style={{ width: `${m.momentumNorm * 100}%` }} />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {activeTab === 'myplays' && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <p className="text-sm text-slate-400">
              Add the numbers you regularly play. The portal tracks their performance and tells you when conditions are optimal.
            </p>
            <button onClick={() => setShowAddForm(!showAddForm)}
              className="px-4 py-2 rounded-lg bg-crimson hover:bg-[#a01f57] text-white text-sm font-semibold transition-colors shrink-0">
              + Add Play
            </button>
          </div>

          {/* Add Form */}
          {showAddForm && (
            <div className="bg-surface rounded-xl p-5 border border-crimson/30 space-y-4">
              <h2 className="font-semibold">New Regular Play</h2>
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Play Name</label>
                  <input value={newPlay.name} onChange={e => setNewPlay(p => ({ ...p, name: e.target.value }))}
                    placeholder="e.g. My Lucky 8"
                    className="w-full px-3 py-1.5 rounded bg-[#0e0e10] border border-[#333] text-sm text-white focus:outline-none focus:border-crimson"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Wager per Game ($)</label>
                  <input type="number" min={1} max={20} value={newPlay.wager}
                    onChange={e => setNewPlay(p => ({ ...p, wager: +e.target.value }))}
                    className="w-full px-3 py-1.5 rounded bg-[#0e0e10] border border-[#333] text-sm text-white focus:outline-none focus:border-crimson"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Your Numbers (comma or space separated, 1–80)</label>
                <input value={newPlay.numbersStr} onChange={e => setNewPlay(p => ({ ...p, numbersStr: e.target.value }))}
                  placeholder="e.g. 7, 14, 23, 31, 42, 55, 66, 78"
                  className="w-full px-3 py-1.5 rounded bg-[#0e0e10] border border-[#333] text-sm text-white focus:outline-none focus:border-crimson"
                />
              </div>
              {addError && <p className="text-sm text-red-400">{addError}</p>}
              <div className="flex gap-3">
                <button onClick={addPlay}
                  className="px-4 py-2 rounded-lg bg-crimson hover:bg-[#a01f57] text-white text-sm font-semibold transition-colors">
                  Save Play
                </button>
                <button onClick={() => { setShowAddForm(false); setAddError(''); }}
                  className="px-4 py-2 rounded-lg bg-[#2a2a2e] text-white text-sm transition-colors">
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* My Plays List */}
          {myPlays.length === 0 ? (
            <div className="bg-surface rounded-xl p-8 text-center text-slate-500">
              <p className="font-medium text-slate-300 mb-1">No plays saved yet</p>
              <p className="text-sm">Add the numbers you regularly play to track their performance and get notified when conditions are optimal.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {myPlays.map(play => {
                const perf = performances.get(play.id);
                return (
                  <div key={play.id} className={`bg-surface rounded-xl p-5 border ${perf?.isHot ? 'border-green-700' : 'border-[#2a2a2e]'}`}>
                    <div className="flex justify-between items-start mb-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="font-semibold">{play.name}</h3>
                          {perf?.isHot && <Badge label="PLAY NOW" color="bg-green-700 text-white" />}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">{play.spot_count} spots · ${play.wager}/game</div>
                      </div>
                      <button onClick={() => deletePlay(play.id)}
                        className="text-xs text-slate-600 hover:text-red-400 transition-colors">Remove</button>
                    </div>

                    {/* Numbers */}
                    <div className="flex flex-wrap gap-1.5 mb-4">
                      {play.numbers.sort((a, b) => a - b).map(n => (
                        <span key={n}
                          className="w-8 h-8 rounded flex items-center justify-center text-xs font-bold bg-[#1e1e24] text-slate-300">
                          {n}
                        </span>
                      ))}
                    </div>

                    {perf ? (
                      <>
                        {/* Status label */}
                        <div className={`text-sm font-semibold mb-3 ${
                          perf.statusLabel.startsWith('Optimal') ? 'text-green-400'
                          : perf.statusLabel.startsWith('Good') ? 'text-blue-400'
                          : perf.statusLabel.startsWith('Cold') ? 'text-red-400'
                          : 'text-slate-300'
                        }`}>
                          {perf.statusLabel}
                        </div>

                        {/* Stats */}
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                          {[
                            { label: 'Current Score', value: `${perf.currentScore}/100` },
                            { label: 'Avg Matches', value: `${perf.avgMatches.toFixed(2)}/draw` },
                            { label: 'Hit Rate', value: `${perf.hitRate.toFixed(1)}%` },
                            { label: 'Best Match', value: `${perf.bestMatch}/${play.spot_count} caught` },
                          ].map(({ label, value }) => (
                            <div key={label} className="bg-[#0e0e10] rounded-lg p-2.5">
                              <div className="text-xs text-slate-500">{label}</div>
                              <div className="text-sm font-semibold text-white mt-0.5">{value}</div>
                            </div>
                          ))}
                        </div>

                        <div className="mt-3">
                          <div className="flex justify-between text-xs text-slate-500 mb-1">
                            <span>Algorithm Score</span>
                            <span>{perf.currentScore}/100</span>
                          </div>
                          <ConfidenceBar value={perf.currentScore} />
                        </div>

                        <p className="text-xs text-slate-500 mt-2">
                          Based on last {perf.totalGames} draws (of {games.length.toLocaleString()} in DB)
                        </p>
                      </>
                    ) : (
                      <div className="text-xs text-slate-500">Calculating performance…</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {myPlays.length > 0 && (
            <div className="bg-surface rounded-xl p-4 text-xs text-slate-500 space-y-1">
              <p className="font-semibold text-slate-400">How Your Play Tracker Works</p>
              <p>Each play is evaluated against the last 200 draws from the DB. The "score" is the average composite prediction score (frequency + recency + gap urgency) for your chosen numbers. "Optimal — Play Now" means multiple signals are aligned and your numbers are performing above expected baseline.</p>
              <p>Sync regularly to keep results current. The algorithm re-evaluates each time you load this page.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
