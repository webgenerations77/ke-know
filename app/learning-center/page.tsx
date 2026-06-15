'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { supabase, Game } from '@/lib/supabase';
import { computeNumberStats, pickNumbers, Strategy } from '@/lib/analysis';
import { simulateSession, SimRound } from '@/lib/prediction-engine';
import { fetchDrawings, parseDrawing } from '@/lib/lottery-api';
import { PRIZE_TABLE } from '@/lib/keno-odds';

const CRIMSON = '#8B1A4A';
const POLL_INTERVAL_MS = 90_000; // check every 90 seconds (Keno draws ~every 4 min)

function fmt(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface LiveSession {
  picks: number[];
  spotCount: number;
  wager: number;
  bonusType: 'none' | 'bonus' | 'super';
  budget: number;
  gamesTarget: number;
  startedAt: string;
  startGameNum: number;
}

interface LiveRound {
  gameNum: number;
  drawDate: string;
  hits: number[];
  matches: number;
  wagered: number;
  won: number;
  bankroll: number;
  checkedAt: string;
}

interface Config {
  spotCount: number;
  strategy: Strategy;
  wager: number;
  bonusType: 'none' | 'bonus' | 'super';
  budget: number;
  gamesTarget: number;
}

const DEFAULT_CONFIG: Config = {
  spotCount: 8,
  strategy: 'balanced',
  wager: 2,
  bonusType: 'none',
  budget: 100,
  gamesTarget: 50,
};

export default function LearningCenterPage() {
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'live' | 'historical'>('live');
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);

  // ── Live session state ─────────────────────────────────────────────────────
  const [session, setSession] = useState<LiveSession | null>(null);
  const [liveRounds, setLiveRounds] = useState<LiveRound[]>([]);
  const [bankroll, setBankroll] = useState(0);
  const [pollStatus, setPollStatus] = useState<'idle' | 'checking' | 'waiting' | 'new-draw' | 'complete'>('idle');
  const [countdown, setCountdown] = useState(0);
  const [lastCheckedNum, setLastCheckedNum] = useState(0);
  const [sessionEnded, setSessionEnded] = useState(false);
  const lastCheckedRef = useRef(0);
  const bankrollRef = useRef(0);
  const roundsRef = useRef<LiveRound[]>([]);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  // ── Historical simulation state ────────────────────────────────────────────
  const [histRounds, setHistRounds] = useState<SimRound[]>([]);
  const [histRunning, setHistRunning] = useState(false);
  const [histAnimIdx, setHistAnimIdx] = useState(0);
  const histIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const histLogRef = useRef<HTMLDivElement>(null);
  const [histConfig, setHistConfig] = useState<Config>(DEFAULT_CONFIG);

  useEffect(() => {
    supabase.from('games').select('*').order('game_num', { ascending: false }).limit(5000)
      .then(({ data }) => { if (data) setGames(data as Game[]); setLoading(false); });
  }, []);

  // ── Poll logic ─────────────────────────────────────────────────────────────
  const checkForNewDraw = useCallback(async (sess: LiveSession) => {
    if (!sess) return;
    setPollStatus('checking');

    try {
      const latest = await fetchDrawings(1);
      if (!latest.length) { setPollStatus('waiting'); return; }

      const latestNum = parseInt(latest[0].drawNumber, 10);

      if (latestNum <= lastCheckedRef.current) {
        setPollStatus('waiting');
        return;
      }

      // New draw found — fetch it (may already be in `latest[0]`)
      const drawing = latest[0];
      const hits: number[] = drawing.results?.hits ?? [];
      const bonusVal: number = drawing.results?.bonus ?? 1;
      const superBonusVal: number = drawing.results?.superBonus ?? 1;

      const prizeTable = PRIZE_TABLE[sess.spotCount] ?? [];
      const matches = hits.filter(h => sess.picks.includes(h)).length;
      const entry = prizeTable.find(p => p.catches === matches);
      let prize = entry ? entry.prize * sess.wager : 0;

      if (sess.bonusType === 'bonus' && bonusVal > 1) prize *= bonusVal;
      if (sess.bonusType === 'super' && superBonusVal > 1) prize *= superBonusVal;

      const costPerGame = sess.wager * (sess.bonusType === 'super' ? 3 : sess.bonusType === 'bonus' ? 2 : 1);
      const prevBankroll = bankrollRef.current;
      const newBankroll = Math.max(0, prevBankroll - costPerGame + prize);

      const round: LiveRound = {
        gameNum: latestNum,
        drawDate: drawing.drawDate,
        hits,
        matches,
        wagered: costPerGame,
        won: prize,
        bankroll: newBankroll,
        checkedAt: new Date().toLocaleTimeString(),
      };

      bankrollRef.current = newBankroll;
      roundsRef.current = [round, ...roundsRef.current];
      lastCheckedRef.current = latestNum;

      setLastCheckedNum(latestNum);
      setBankroll(newBankroll);
      setLiveRounds(prev => [round, ...prev]);
      setPollStatus('new-draw');

      // Also push this game to DB so the rest of the app sees it
      const parsedRow = parseDrawing(drawing);
      await supabase.from('games').upsert([parsedRow], { onConflict: 'game_num', ignoreDuplicates: true });

      // Check stop conditions
      const gamesPlayed = roundsRef.current.length;
      if (newBankroll <= 0 || gamesPlayed >= sess.gamesTarget) {
        stopSession();
        return;
      }

      setTimeout(() => setPollStatus('waiting'), 2000);
    } catch (err) {
      console.error('[live poll]', err);
      setPollStatus('waiting');
    }
  }, []);

  const stopSession = useCallback(() => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);
    pollTimerRef.current = null;
    countdownRef.current = null;
    setPollStatus('complete');
    setSessionEnded(true);
    setCountdown(0);
  }, []);

  const startLiveSession = useCallback(async () => {
    if (!games.length) return;

    // Generate picks from current stats
    const stats = computeNumberStats(games);
    const picks = pickNumbers(stats, config.spotCount, config.strategy).map(s => s.number);

    // Get current latest game
    const latest = await fetchDrawings(1);
    const startGameNum = latest.length ? parseInt(latest[0].drawNumber, 10) : 0;

    const sess: LiveSession = {
      picks,
      spotCount: config.spotCount,
      wager: config.wager,
      bonusType: config.bonusType,
      budget: config.budget,
      gamesTarget: config.gamesTarget,
      startedAt: new Date().toISOString(),
      startGameNum,
    };

    lastCheckedRef.current = startGameNum;
    bankrollRef.current = config.budget;
    roundsRef.current = [];

    setSession(sess);
    setLiveRounds([]);
    setBankroll(config.budget);
    setLastCheckedNum(startGameNum);
    setSessionEnded(false);
    setPollStatus('waiting');
    setCountdown(POLL_INTERVAL_MS / 1000);

    // Start countdown ticker
    countdownRef.current = setInterval(() => {
      setCountdown(prev => Math.max(0, prev - 1));
    }, 1000);

    // Poll immediately after 5 seconds (in case a draw just happened), then every 90s
    const firstCheck = setTimeout(() => {
      checkForNewDraw(sess);
      // Now start the recurring poll
      pollTimerRef.current = setInterval(() => {
        setCountdown(POLL_INTERVAL_MS / 1000);
        checkForNewDraw(sess);
      }, POLL_INTERVAL_MS);
    }, 5000);

    return () => clearTimeout(firstCheck);
  }, [games, config, checkForNewDraw]);

  const resetLive = useCallback(() => {
    stopSession();
    setSession(null);
    setLiveRounds([]);
    setBankroll(0);
    setLastCheckedNum(0);
    setSessionEnded(false);
    setPollStatus('idle');
    roundsRef.current = [];
    bankrollRef.current = 0;
    lastCheckedRef.current = 0;
  }, [stopSession]);

  const checkNow = useCallback(() => {
    if (!session) return;
    setCountdown(POLL_INTERVAL_MS / 1000);
    checkForNewDraw(session);
  }, [session, checkForNewDraw]);

  useEffect(() => () => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = 0;
  }, [liveRounds.length]);

  // ── Live derived stats ─────────────────────────────────────────────────────
  const gamesPlayed = liveRounds.length;
  const totalWagered = liveRounds.reduce((s, r) => s + r.wagered, 0);
  const totalWon = liveRounds.reduce((s, r) => s + r.won, 0);
  const wins = liveRounds.filter(r => r.won > 0).length;
  const roi = totalWagered > 0 ? ((totalWon - totalWagered) / totalWagered) * 100 : 0;
  const winRate = gamesPlayed > 0 ? (wins / gamesPlayed) * 100 : 0;

  // ── Historical sim ─────────────────────────────────────────────────────────
  const runHistSim = useCallback(() => {
    if (!games.length) return;
    setHistRounds([]);
    setHistAnimIdx(0);
    const stats = computeNumberStats(games);
    const picks = pickNumbers(stats, histConfig.spotCount, histConfig.strategy).map(s => s.number);
    const all = simulateSession(picks, games, histConfig.wager, histConfig.bonusType, histConfig.budget, histConfig.gamesTarget);
    setHistRunning(true);
    let idx = 0;
    histIntervalRef.current = setInterval(() => {
      idx += 5;
      if (idx >= all.length) { idx = all.length; clearInterval(histIntervalRef.current!); setHistRunning(false); }
      setHistAnimIdx(idx);
      setHistRounds(all.slice(0, idx));
      setTimeout(() => histLogRef.current?.scrollTo(0, histLogRef.current.scrollHeight), 30);
    }, 80);
  }, [games, histConfig]);

  useEffect(() => () => { if (histIntervalRef.current) clearInterval(histIntervalRef.current); }, []);

  if (loading) return <div className="text-slate-500 pt-8">Loading…</div>;

  const prizeTable = PRIZE_TABLE[config.spotCount] ?? [];
  const livePrizeTable = PRIZE_TABLE[session?.spotCount ?? config.spotCount] ?? [];

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold">Learning Center</h1>
        <p className="text-sm text-slate-400 mt-1">
          Live mode monitors each Keno draw as it happens and tracks your picks in real time.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-[#0e0e10] rounded-lg p-1 w-fit">
        {(['live', 'historical'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded text-sm font-medium transition-colors ${
              tab === t ? 'bg-crimson text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            {t === 'live' ? '⚡ Live Session' : '📊 Historical Test'}
          </button>
        ))}
      </div>

      {/* ── LIVE TAB ─────────────────────────────────────────────────────────── */}
      {tab === 'live' && (
        <>
          {!session ? (
            /* Config Panel */
            <div className="bg-surface rounded-xl p-5 space-y-5">
              <div>
                <h2 className="font-semibold">Live Session Setup</h2>
                <p className="text-xs text-slate-500 mt-1">
                  The app will check for each new Keno draw (every ~4 minutes) and play your picks automatically.
                  Draws are checked every 90 seconds. Session runs until budget is exhausted or game count is reached.
                </p>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Spots to Pick (1–10)</label>
                  <input type="number" min={1} max={10} value={config.spotCount}
                    onChange={e => setConfig(c => ({ ...c, spotCount: Math.min(10, Math.max(1, +e.target.value || 1)) }))}
                    className="w-full px-3 py-1.5 rounded bg-[#0e0e10] border border-[#333] text-sm text-white focus:outline-none focus:border-crimson"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Pick Strategy</label>
                  <select value={config.strategy}
                    onChange={e => setConfig(c => ({ ...c, strategy: e.target.value as Strategy }))}
                    className="w-full px-3 py-1.5 rounded bg-[#0e0e10] border border-[#333] text-sm text-white focus:outline-none"
                  >
                    <option value="balanced">Balanced (Composite Score)</option>
                    <option value="hot">Hot Numbers</option>
                    <option value="cold">Cold Numbers</option>
                    <option value="streak">On Streak</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Wager per Game ($1–$20)</label>
                  <input type="number" min={1} max={20} value={config.wager}
                    onChange={e => setConfig(c => ({ ...c, wager: Math.min(20, Math.max(1, +e.target.value || 1)) }))}
                    className="w-full px-3 py-1.5 rounded bg-[#0e0e10] border border-[#333] text-sm text-white focus:outline-none focus:border-crimson"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Bonus Type</label>
                  <select value={config.bonusType}
                    onChange={e => setConfig(c => ({ ...c, bonusType: e.target.value as Config['bonusType'] }))}
                    className="w-full px-3 py-1.5 rounded bg-[#0e0e10] border border-[#333] text-sm text-white focus:outline-none"
                  >
                    <option value="none">None (1× cost)</option>
                    <option value="bonus">Bonus (2× cost)</option>
                    <option value="super">Super Bonus (3× cost)</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Starting Budget ($)</label>
                  <input type="number" min={10} step={10} value={config.budget}
                    onChange={e => setConfig(c => ({ ...c, budget: Math.max(10, +e.target.value || 100) }))}
                    className="w-full px-3 py-1.5 rounded bg-[#0e0e10] border border-[#333] text-sm text-white focus:outline-none focus:border-crimson"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Max Games to Play</label>
                  <input type="number" min={1} max={500} value={config.gamesTarget}
                    onChange={e => setConfig(c => ({ ...c, gamesTarget: Math.min(500, Math.max(1, +e.target.value || 50)) }))}
                    className="w-full px-3 py-1.5 rounded bg-[#0e0e10] border border-[#333] text-sm text-white focus:outline-none focus:border-crimson"
                  />
                </div>
              </div>

              <button onClick={startLiveSession} disabled={!games.length}
                className="px-6 py-2.5 rounded-lg bg-crimson hover:bg-[#a01f57] disabled:opacity-50 text-white font-semibold transition-colors">
                Start Live Session
              </button>
            </div>
          ) : (
            /* Active Session */
            <>
              {/* Status bar */}
              <div className={`rounded-xl p-4 border flex flex-wrap items-center justify-between gap-4 ${
                pollStatus === 'new-draw' ? 'bg-green-900/20 border-green-700' :
                pollStatus === 'checking' ? 'bg-blue-900/20 border-blue-700' :
                pollStatus === 'complete' ? 'bg-[#1e1e24] border-[#333]' :
                'bg-surface border-[#2a2a2e]'
              }`}>
                <div className="flex items-center gap-3">
                  {pollStatus === 'checking' && (
                    <span className="animate-spin text-blue-400 text-lg">↻</span>
                  )}
                  {pollStatus === 'new-draw' && (
                    <span className="text-green-400 text-lg">✓</span>
                  )}
                  {pollStatus === 'waiting' && (
                    <span className="text-crimson text-lg">⏱</span>
                  )}
                  {pollStatus === 'complete' && (
                    <span className="text-slate-400 text-lg">■</span>
                  )}
                  <div>
                    <div className="text-sm font-semibold">
                      {pollStatus === 'checking' && 'Checking for new draw…'}
                      {pollStatus === 'new-draw' && `New draw #${lastCheckedNum} found!`}
                      {pollStatus === 'waiting' && `Waiting for next draw — next check in ${countdown}s`}
                      {pollStatus === 'complete' && 'Session complete'}
                    </div>
                    <div className="text-xs text-slate-500">
                      Last checked draw: #{lastCheckedNum || session.startGameNum} · Started: {new Date(session.startedAt).toLocaleTimeString()}
                    </div>
                  </div>
                </div>
                <div className="flex gap-2">
                  {!sessionEnded && (
                    <>
                      <button onClick={checkNow}
                        className="px-3 py-1.5 text-xs rounded bg-[#1e1e24] hover:bg-[#2a2a2e] text-slate-300 border border-[#333] transition-colors">
                        Check Now
                      </button>
                      <button onClick={stopSession}
                        className="px-3 py-1.5 text-xs rounded bg-red-900/40 hover:bg-red-900/60 text-red-300 border border-red-900 transition-colors">
                        Stop Session
                      </button>
                    </>
                  )}
                  {sessionEnded && (
                    <button onClick={resetLive}
                      className="px-3 py-1.5 text-xs rounded bg-crimson text-white transition-colors">
                      New Session
                    </button>
                  )}
                </div>
              </div>

              {/* Current Picks */}
              <div className="bg-surface rounded-xl p-4">
                <h2 className="text-sm font-semibold mb-3 text-slate-300">
                  Active Picks — {session.spotCount} spots · ${session.wager}/game{session.bonusType !== 'none' ? ` + ${session.bonusType}` : ''}
                </h2>
                <div className="flex flex-wrap gap-2">
                  {session.picks.sort((a, b) => a - b).map(n => {
                    const lastRound = liveRounds[0];
                    const wasHit = lastRound?.hits.includes(n);
                    const wasPicked = lastRound?.hits && session.picks.includes(n) && wasHit;
                    return (
                      <div key={n}
                        className={`w-10 h-10 rounded-lg flex items-center justify-center text-sm font-bold transition-all ${
                          lastRound && lastRound.hits.includes(n) && session.picks.includes(n)
                            ? 'bg-green-600 text-white scale-110'
                            : lastRound
                            ? 'bg-[#1e1e24] text-slate-500'
                            : 'bg-crimson text-white'
                        }`}
                      >
                        {n}
                      </div>
                    );
                  })}
                </div>
                {liveRounds[0] && (
                  <p className="text-xs text-slate-500 mt-2">
                    Last draw #{liveRounds[0].gameNum}: {liveRounds[0].matches}/{session.spotCount} matched
                    {liveRounds[0].won > 0 ? ` — won ${fmt(liveRounds[0].won)}` : ' — no prize'}
                    {' '}· Green = matched in last draw
                  </p>
                )}
              </div>

              {/* Live Stats */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { label: 'Bankroll', value: fmt(bankroll), accent: bankroll >= session.budget ? 'text-green-400' : 'text-red-400' },
                  { label: 'ROI', value: `${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`, accent: roi >= 0 ? 'text-green-400' : 'text-red-400' },
                  { label: 'Win Rate', value: `${winRate.toFixed(1)}%`, accent: 'text-white' },
                  { label: 'Games', value: `${gamesPlayed} / ${session.gamesTarget}`, accent: 'text-white' },
                ].map(({ label, value, accent }) => (
                  <div key={label} className="bg-surface rounded-xl p-4">
                    <div className="text-xs text-slate-500 mb-1">{label}</div>
                    <div className={`text-xl font-bold ${accent}`}>{value}</div>
                  </div>
                ))}
                {[
                  { label: 'Total Wagered', value: fmt(totalWagered) },
                  { label: 'Total Won', value: fmt(totalWon) },
                  { label: 'Net P&L', value: fmt(totalWon - totalWagered) },
                  { label: 'Best Win', value: liveRounds.length ? fmt(Math.max(...liveRounds.map(r => r.won))) : '—' },
                ].map(({ label, value }) => (
                  <div key={label} className="bg-surface rounded-xl p-4">
                    <div className="text-xs text-slate-500 mb-1">{label}</div>
                    <div className="text-lg font-semibold">{value}</div>
                  </div>
                ))}
              </div>

              {/* Bankroll chart */}
              {liveRounds.length > 1 && (
                <div className="bg-surface rounded-xl p-4">
                  <h2 className="text-sm font-semibold mb-3 text-slate-300">Bankroll Over Time</h2>
                  <ResponsiveContainer width="100%" height={180}>
                    <LineChart data={[...liveRounds].reverse().map((r, i) => ({ game: i + 1, bankroll: r.bankroll }))}>
                      <XAxis dataKey="game" tick={{ fill: '#64748b', fontSize: 10 }} />
                      <YAxis tick={{ fill: '#64748b', fontSize: 10 }} tickFormatter={v => `$${v}`} />
                      <Tooltip contentStyle={{ background: '#16161a', border: '1px solid #333', borderRadius: 8 }}
                        formatter={(v: number) => [fmt(v), 'Bankroll']} labelFormatter={v => `Game ${v}`} />
                      <ReferenceLine y={session.budget} stroke="#4a4a5a" strokeDasharray="4 2" />
                      <Line type="monotone" dataKey="bankroll" stroke={CRIMSON} dot={false} strokeWidth={2} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* Round log */}
              <div className="bg-surface rounded-xl p-4">
                <h2 className="text-sm font-semibold mb-3 text-slate-300">Draw Results</h2>
                {liveRounds.length === 0 ? (
                  <div className="text-center py-8 text-slate-500 text-sm">
                    Waiting for the next Keno draw… (checked every 90 seconds)
                    <br />
                    <span className="text-xs">Maryland Keno draws approximately every 4 minutes.</span>
                  </div>
                ) : (
                  <div ref={logRef} className="space-y-1 max-h-64 overflow-y-auto">
                    {liveRounds.map((r, i) => (
                      <div key={i}
                        className={`flex flex-wrap gap-3 items-center py-1.5 px-3 rounded text-xs ${r.won > 0 ? 'bg-green-900/15' : 'bg-[#0e0e10]'}`}
                      >
                        <span className="text-slate-500 font-mono w-16">#{r.gameNum}</span>
                        <span className="text-slate-400">{r.drawDate}</span>
                        <span className="text-slate-300">{r.matches}/{session.spotCount} matched</span>
                        {r.won > 0
                          ? <span className="text-green-400 font-semibold">+{fmt(r.won)}</span>
                          : <span className="text-slate-600">no prize</span>
                        }
                        <span className={`ml-auto font-mono ${r.bankroll >= session.budget ? 'text-green-400' : 'text-slate-400'}`}>
                          {fmt(r.bankroll)}
                        </span>
                        <span className="text-slate-600">{r.checkedAt}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Session ended summary */}
              {sessionEnded && liveRounds.length > 0 && (
                <div className={`rounded-xl p-5 border ${roi >= 0 ? 'bg-green-900/10 border-green-800' : 'bg-red-900/10 border-red-900'}`}>
                  <h2 className={`font-semibold ${roi >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    Live Session Complete — {roi >= 0 ? 'Profitable' : 'Net Loss'}
                  </h2>
                  <p className="text-sm text-slate-300 mt-2">
                    Played <strong>{gamesPlayed} live draws</strong> with real Keno results.
                    Wagered <strong>{fmt(totalWagered)}</strong>, won back <strong>{fmt(totalWon)}</strong>.
                    Net: <strong className={roi >= 0 ? 'text-green-400' : 'text-red-400'}>
                      {roi >= 0 ? '+' : ''}{fmt(totalWon - totalWagered)}
                    </strong> ({roi >= 0 ? '+' : ''}{roi.toFixed(1)}% ROI).
                  </p>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ── HISTORICAL TAB ──────────────────────────────────────────────────── */}
      {tab === 'historical' && (
        <>
          <div className="bg-surface rounded-xl p-4 text-xs text-blue-400 border border-blue-900/40 rounded-xl">
            Historical mode simulates picks against draws already in your database — useful for backtesting strategies quickly without waiting for real draws.
          </div>

          <div className="bg-surface rounded-xl p-5 space-y-4">
            <h2 className="font-semibold">Backtest Configuration</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              {[
                { label: 'Spots', key: 'spotCount', min: 1, max: 10 },
                { label: 'Wager ($)', key: 'wager', min: 1, max: 20 },
                { label: 'Budget ($)', key: 'budget', min: 10, max: 10000, step: 10 },
                { label: 'Games', key: 'gamesTarget', min: 10, max: 1000, step: 10 },
              ].map(({ label, key, min, max, step }) => (
                <div key={key}>
                  <label className="text-xs text-slate-400 block mb-1">{label}</label>
                  <input type="number" min={min} max={max} step={step ?? 1}
                    value={histConfig[key as keyof Config] as number}
                    onChange={e => setHistConfig(c => ({ ...c, [key]: +e.target.value }))}
                    className="w-full px-3 py-1.5 rounded bg-[#0e0e10] border border-[#333] text-sm text-white focus:outline-none focus:border-crimson"
                    disabled={histRunning}
                  />
                </div>
              ))}
              <div>
                <label className="text-xs text-slate-400 block mb-1">Strategy</label>
                <select value={histConfig.strategy}
                  onChange={e => setHistConfig(c => ({ ...c, strategy: e.target.value as Strategy }))}
                  className="w-full px-3 py-1.5 rounded bg-[#0e0e10] border border-[#333] text-sm text-white focus:outline-none"
                  disabled={histRunning}
                >
                  <option value="balanced">Balanced</option>
                  <option value="hot">Hot</option>
                  <option value="cold">Cold</option>
                  <option value="streak">Streak</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Bonus</label>
                <select value={histConfig.bonusType}
                  onChange={e => setHistConfig(c => ({ ...c, bonusType: e.target.value as Config['bonusType'] }))}
                  className="w-full px-3 py-1.5 rounded bg-[#0e0e10] border border-[#333] text-sm text-white focus:outline-none"
                  disabled={histRunning}
                >
                  <option value="none">None</option>
                  <option value="bonus">Bonus</option>
                  <option value="super">Super Bonus</option>
                </select>
              </div>
            </div>
            <div className="flex gap-3">
              <button onClick={runHistSim} disabled={histRunning || !games.length}
                className="px-5 py-2 rounded-lg bg-crimson hover:bg-[#a01f57] disabled:opacity-50 text-white text-sm font-semibold">
                {histRunning ? `Running… (${histAnimIdx})` : 'Run Backtest'}
              </button>
              {histRounds.length > 0 && !histRunning && (
                <button onClick={() => { setHistRounds([]); setHistAnimIdx(0); }}
                  className="px-4 py-2 rounded-lg bg-[#2a2a2e] text-white text-sm">Reset</button>
              )}
            </div>
          </div>

          {histRounds.length > 0 && (() => {
            const hw = histRounds.reduce((s, r) => s + r.won, 0);
            const hc = histRounds.reduce((s, r) => s + r.wagered, 0);
            const hroi = hc > 0 ? ((hw - hc) / hc) * 100 : 0;
            const hbk = histRounds[histRounds.length - 1]?.bankroll ?? histConfig.budget;
            return (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {[
                    { label: 'Final Bankroll', value: fmt(hbk), accent: hbk >= histConfig.budget ? 'text-green-400' : 'text-red-400' },
                    { label: 'ROI', value: `${hroi >= 0 ? '+' : ''}${hroi.toFixed(1)}%`, accent: hroi >= 0 ? 'text-green-400' : 'text-red-400' },
                    { label: 'Win Rate', value: `${(histRounds.filter(r => r.won > 0).length / histRounds.length * 100).toFixed(1)}%`, accent: 'text-white' },
                    { label: 'Games Played', value: histRounds.length.toString(), accent: 'text-white' },
                  ].map(({ label, value, accent }) => (
                    <div key={label} className="bg-surface rounded-xl p-4">
                      <div className="text-xs text-slate-500 mb-1">{label}</div>
                      <div className={`text-xl font-bold ${accent}`}>{value}</div>
                    </div>
                  ))}
                </div>
                <div className="bg-surface rounded-xl p-4">
                  <h2 className="text-sm font-semibold mb-3 text-slate-300">Bankroll Curve</h2>
                  <ResponsiveContainer width="100%" height={180}>
                    <LineChart data={histRounds.filter((_, i) => i % Math.max(1, Math.ceil(histRounds.length / 200)) === 0).map((r, i) => ({ game: i + 1, bankroll: r.bankroll }))}>
                      <XAxis dataKey="game" tick={{ fill: '#64748b', fontSize: 10 }} />
                      <YAxis tick={{ fill: '#64748b', fontSize: 10 }} tickFormatter={v => `$${v}`} />
                      <Tooltip contentStyle={{ background: '#16161a', border: '1px solid #333', borderRadius: 8 }}
                        formatter={(v: number) => [fmt(v), 'Bankroll']} />
                      <ReferenceLine y={histConfig.budget} stroke="#4a4a5a" strokeDasharray="4 2" />
                      <Line type="monotone" dataKey="bankroll" stroke={CRIMSON} dot={false} strokeWidth={2} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div className="bg-surface rounded-xl p-4">
                  <h2 className="text-sm font-semibold mb-3 text-slate-300">Last 50 Rounds</h2>
                  <div ref={histLogRef} className="space-y-0.5 max-h-48 overflow-y-auto text-xs">
                    {[...histRounds].reverse().slice(0, 50).map((r, i) => (
                      <div key={i} className={`flex justify-between py-0.5 px-2 rounded ${r.won > 0 ? 'bg-green-900/15' : ''}`}>
                        <span className="text-slate-500 font-mono">#{r.gameNum}</span>
                        <span className="text-slate-400">{r.matches}/{histConfig.spotCount} hit</span>
                        {r.won > 0 ? <span className="text-green-400">+{fmt(r.won)}</span> : <span className="text-slate-600">—</span>}
                        <span className="font-mono text-slate-400">{fmt(r.bankroll)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            );
          })()}
        </>
      )}
    </div>
  );
}
