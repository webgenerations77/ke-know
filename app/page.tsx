'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { supabase } from '@/lib/supabase';

type ArthurMood = 'awakening' | 'curious' | 'focused' | 'optimistic' | 'cautious' | 'frustrated';

const MOOD_META: Record<ArthurMood, {
  label: string; color: string; stroke: string; bg: string; desc: string; long: string;
}> = {
  awakening: {
    label: 'Awakening',  color: 'text-slate-400',  stroke: '#64748b', bg: 'rgba(100,116,139,0.10)',
    desc: 'Waiting to evolve',
    long: 'Arthur has no evolution cycles yet. Feed him historical data and run the first evolution to bring him online.',
  },
  curious: {
    label: 'Curious',    color: 'text-blue-400',   stroke: '#60a5fa', bg: 'rgba(96,165,250,0.10)',
    desc: 'Exploring patterns',
    long: "Arthur is active but hasn't accumulated enough today's shadow plays to form a clear view. He's watching and learning.",
  },
  focused: {
    label: 'Focused',    color: 'text-slate-200',  stroke: '#94a3b8', bg: 'rgba(148,163,184,0.08)',
    desc: 'Analyzing data',
    long: "Arthur is on baseline — steady win rate, roughly break-even P&L. He's locked in on the data without strong signals in either direction.",
  },
  optimistic: {
    label: 'Optimistic', color: 'text-green-400',  stroke: '#4ade80', bg: 'rgba(74,222,128,0.10)',
    desc: 'Performing well',
    long: "Today's session is profitable with a win rate above 35%. Arthur's current generation strategies are firing on all cylinders.",
  },
  cautious: {
    label: 'Cautious',   color: 'text-amber-400',  stroke: '#fbbf24', bg: 'rgba(251,191,36,0.10)',
    desc: 'Watching trends',
    long: "Today's P&L is slightly negative. Arthur is monitoring the session closely and expecting the next evolution cycle to recalibrate.",
  },
  frustrated: {
    label: 'Frustrated', color: 'text-red-400',    stroke: '#f87171', bg: 'rgba(248,113,113,0.10)',
    desc: 'Adapting strategy',
    long: "Significant losses or a very low win rate today. Arthur knows these runs happen — he'll use this data to drive harder selection pressure in the next generation.",
  },
};

const MOODS_ORDER: ArthurMood[] = ['awakening', 'curious', 'focused', 'optimistic', 'cautious', 'frustrated'];

// SVG face avatars — each mood has a distinct expression drawn in a 32×32 viewBox.
function MoodFace({ mood, size = 40 }: { mood: ArthurMood; size?: number }) {
  const { stroke, bg } = MOOD_META[mood];

  const expression: Record<ArthurMood, React.ReactNode> = {
    // Sleeping — closed eyes, gentle smile, zz
    awakening: (
      <>
        <line x1="9" y1="13" x2="13" y2="13" stroke={stroke} strokeWidth="1.8" strokeLinecap="round"/>
        <line x1="19" y1="13" x2="23" y2="13" stroke={stroke} strokeWidth="1.8" strokeLinecap="round"/>
        <path d="M12,20 Q16,22 20,20" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" fill="none"/>
        <text x="20.5" y="10" fontSize="5.5" fill={stroke} fontWeight="700" opacity="0.85">z</text>
        <text x="24" y="7.5" fontSize="3.8" fill={stroke} fontWeight="700" opacity="0.5">z</text>
      </>
    ),
    // One raised brow, inquisitive eyes, lopsided smile
    curious: (
      <>
        <path d="M9,11 Q11,8 13,9" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" fill="none"/>
        <path d="M19,10 Q21,9 23,10" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" fill="none"/>
        <circle cx="11" cy="14" r="2.1" fill={stroke}/>
        <circle cx="21" cy="14" r="1.8" fill={stroke}/>
        <path d="M12,21 Q16,23 20,20" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" fill="none"/>
      </>
    ),
    // Furrowed brows, squinting eyes, flat mouth — intense focus
    focused: (
      <>
        <path d="M9,10 Q11,11 13,10" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" fill="none"/>
        <path d="M19,10 Q21,11 23,10" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" fill="none"/>
        <line x1="9" y1="14" x2="14" y2="14" stroke={stroke} strokeWidth="2.2" strokeLinecap="round"/>
        <line x1="18" y1="14" x2="23" y2="14" stroke={stroke} strokeWidth="2.2" strokeLinecap="round"/>
        <line x1="12" y1="20" x2="20" y2="20" stroke={stroke} strokeWidth="1.8" strokeLinecap="round"/>
      </>
    ),
    // Raised happy brows, wide bright eyes, big smile
    optimistic: (
      <>
        <path d="M9,10 Q11,7.5 13,9" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" fill="none"/>
        <path d="M19,9 Q21,7.5 23,10" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" fill="none"/>
        <circle cx="11" cy="14" r="2.3" fill={stroke}/>
        <circle cx="21" cy="14" r="2.3" fill={stroke}/>
        <path d="M10,19 Q16,26 22,19" stroke={stroke} strokeWidth="2.2" strokeLinecap="round" fill="none"/>
      </>
    ),
    // Worried inner brows (inner corners rise), normal eyes, slight downward mouth
    cautious: (
      <>
        <path d="M9,11.5 Q11,9 13,10" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" fill="none"/>
        <path d="M19,10 Q21,9 23,11.5" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" fill="none"/>
        <circle cx="11" cy="15" r="1.8" fill={stroke}/>
        <circle cx="21" cy="15" r="1.8" fill={stroke}/>
        <path d="M12,21 Q16,19 20,21" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" fill="none"/>
      </>
    ),
    // Inner brow corners pull DOWN (angry tilt), eyes, clear frown
    frustrated: (
      <>
        <path d="M9,9 Q11,10.5 13,12" stroke={stroke} strokeWidth="2.1" strokeLinecap="round" fill="none"/>
        <path d="M19,12 Q21,10.5 23,9" stroke={stroke} strokeWidth="2.1" strokeLinecap="round" fill="none"/>
        <circle cx="11" cy="15" r="1.8" fill={stroke}/>
        <circle cx="21" cy="15" r="1.8" fill={stroke}/>
        <path d="M11,22 Q16,18 21,22" stroke={stroke} strokeWidth="2.1" strokeLinecap="round" fill="none"/>
      </>
    ),
  };

  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: bg, border: `1.5px solid ${stroke}45`,
      flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <svg width={size} height={size} viewBox="0 0 32 32">
        {expression[mood]}
      </svg>
    </div>
  );
}

interface ArthurStatus {
  generation: number | null;
  totalGames: number | null;
  lastRunAt: string | null;
  mood: ArthurMood;
}

function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const mins = (Date.now() - new Date(iso).getTime()) / 60000;
  if (mins < 60) return `${Math.round(mins)}m ago`;
  const hrs = mins / 60;
  if (hrs < 24) return `${Math.round(hrs)}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function computeMood(
  generation: number | null,
  lastRunAt: string | null,
  todayTotal: number,
  todayWins: number,
  todayPnl: number,
): ArthurMood {
  if (!generation) return 'awakening';
  if (todayTotal < 5) {
    const mins = lastRunAt ? (Date.now() - new Date(lastRunAt).getTime()) / 60000 : 9999;
    return mins < 60 ? 'focused' : 'curious';
  }
  const winRate = todayWins / todayTotal;
  if (todayPnl > 5 && winRate > 0.35) return 'optimistic';
  if (todayPnl >= 0) return 'focused';
  if (todayPnl < -10 || winRate < 0.15) return 'frustrated';
  return 'cautious';
}

export default function SplashPage() {
  const router = useRouter();
  const [phase, setPhase] = useState(0);
  const [arthur, setArthur] = useState<ArthurStatus>({
    generation: null, totalGames: null, lastRunAt: null, mood: 'awakening',
  });
  const [moodPanelOpen, setMoodPanelOpen] = useState(false);

  useEffect(() => {
    const t1 = setTimeout(() => setPhase(1), 120);
    const t2 = setTimeout(() => setPhase(2), 520);
    const t3 = setTimeout(() => setPhase(3), 820);   // Enter button
    const t4 = setTimeout(() => setPhase(4), 1100);  // Meet Arthur
    const t5 = setTimeout(() => setPhase(5), 1350);  // Footer
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); clearTimeout(t4); clearTimeout(t5); };
  }, []);

  useEffect(() => {
    async function load() {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const [{ data: evo }, { count: gamesCount }, { data: todayResults }] = await Promise.all([
        supabase.from('evolution_state').select('current_generation,last_run_at').eq('id', 1).single(),
        supabase.from('games').select('game_num', { count: 'exact', head: true }),
        supabase.from('live_results').select('prize,pnl').gte('scored_at', todayStart.toISOString()),
      ]);
      const todayTotal = todayResults?.length ?? 0;
      const todayWins = todayResults?.filter(r => (r.prize ?? 0) > 0).length ?? 0;
      const todayPnl = todayResults?.reduce((sum, r) => sum + (r.pnl ?? 0), 0) ?? 0;
      const generation = evo?.current_generation ?? null;
      const lastRunAt = evo?.last_run_at ?? null;
      setArthur({
        generation, totalGames: gamesCount, lastRunAt,
        mood: computeMood(generation, lastRunAt, todayTotal, todayWins, todayPnl),
      });
    }
    load();
  }, []);

  const fade = (n: number) =>
    `transition-all duration-700 ${phase >= n ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3'}`;

  const mood = MOOD_META[arthur.mood];

  return (
    <div className="fixed inset-0 z-[9999] bg-bg flex flex-col items-center justify-center select-none">
      {/* Radial glow */}
      <div className="pointer-events-none absolute inset-0" style={{
        background: 'radial-gradient(ellipse 70% 50% at 50% 48%, rgba(139,26,74,0.10) 0%, transparent 70%)',
      }} />

      {/* Backdrop to close mood panel */}
      {moodPanelOpen && (
        <div className="fixed inset-0 z-20" onClick={() => setMoodPanelOpen(false)} />
      )}

      <div className="relative flex flex-col items-center z-10 -mt-16">

        {/* Logo */}
        <div className={fade(1)}>
          <Image
            src="/Logo-Keno.png"
            alt="KE-KNOW"
            width={640}
            height={320}
            style={{ height: '300px', width: 'auto', objectFit: 'contain' }}
            priority
          />
        </div>

        {/* Tagline */}
        <div className={`-mt-7 ${fade(2)}`}>
          <p className="text-xs tracking-[0.35em] text-slate-500 uppercase text-center">
            Maryland Keno Intelligence
          </p>
        </div>

        {/* ── Enter button — between tagline and Arthur ── */}
        <div className={`mt-10 ${fade(3)}`}>
          <button
            onClick={() => router.push('/monitor')}
            className="group relative px-12 py-3.5 rounded-lg bg-crimson hover:bg-crimson-hover text-white text-sm tracking-widest font-medium transition-all duration-200 hover:shadow-[0_0_32px_rgba(139,26,74,0.45)]"
          >
            Watch Arthur Live
            <span className="ml-3 opacity-50 group-hover:opacity-100 group-hover:ml-4 transition-all duration-200">→</span>
          </button>
        </div>

        {/* Divider */}
        <div className={`mt-3 mb-3 w-px h-6 bg-gradient-to-b from-transparent via-[#2a2a2e] to-transparent ${fade(4)}`} />

        {/* ── Arthur block ── */}
        <div className={`flex flex-col items-center gap-4 ${fade(4)}`}>

          {/* "Meet Arthur" — prominent section heading */}
          <div className="flex items-center gap-3">
            <div className="h-px w-8 bg-gradient-to-r from-transparent to-[#3a3a40]" />
            <p className="text-sm tracking-[0.5em] text-slate-300 uppercase font-semibold">
              Meet Arthur
            </p>
            <div className="h-px w-8 bg-gradient-to-l from-transparent to-[#3a3a40]" />
          </div>

          {/* Live status */}
          <div className="flex items-center gap-2.5">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-40" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500/70" />
            </span>
            <span className="text-sm text-slate-300 tracking-wide">Arthur is learning.</span>
          </div>

          {/* Stats row */}
          {(arthur.generation !== null || arthur.totalGames !== null) && (
            <div className="flex items-center gap-3 text-xs text-slate-500 tracking-wide">
              {arthur.generation !== null && (
                <span>Gen <span className="text-slate-200">{arthur.generation}</span></span>
              )}
              {arthur.totalGames !== null && (
                <>
                  <span className="text-[#2a2a2e]">·</span>
                  <span><span className="text-slate-200">{arthur.totalGames.toLocaleString()}</span> draws studied</span>
                </>
              )}
              {arthur.lastRunAt && (
                <>
                  <span className="text-[#2a2a2e]">·</span>
                  <span>last run <span className="text-slate-200">{timeAgo(arthur.lastRunAt)}</span></span>
                </>
              )}
            </div>
          )}

          {/* Mood row — face avatar as the clickable trigger */}
          <div className="relative flex flex-col items-center gap-2">
            <div className="flex items-center gap-3">
              <span className={`inline-flex w-2 h-2 rounded-full flex-shrink-0`}
                style={{ background: mood.stroke }} />
              <span className={`text-sm font-medium tracking-wide ${mood.color}`}>{mood.label}</span>
              <span className="text-xs text-slate-600">· {mood.desc}</span>
              <button
                onClick={e => { e.stopPropagation(); setMoodPanelOpen(o => !o); }}
                className="hover:scale-110 transition-transform cursor-pointer"
                title="What does Arthur's mood mean?"
              >
                <MoodFace mood={arthur.mood} size={34} />
              </button>
            </div>

            {/* Mood explanation panel */}
            {moodPanelOpen && (
              <div
                className="absolute top-full mt-3 z-30 w-[22rem] bg-[#111114] border border-[#2a2a2e] rounded-xl shadow-2xl overflow-hidden"
                onClick={e => e.stopPropagation()}
              >
                <div className="px-4 py-3 border-b border-[#2a2a2e]">
                  <p className="text-xs font-semibold text-slate-300 tracking-wide">Arthur's Emotional States</p>
                  <p className="text-[10px] text-slate-600 mt-0.5">His mood reflects today's live performance</p>
                </div>
                <div className="divide-y divide-[#1e1e24]">
                  {MOODS_ORDER.map(m => {
                    const meta = MOOD_META[m];
                    const isActive = m === arthur.mood;
                    return (
                      <div key={m} className={`flex gap-3 px-4 py-3 ${isActive ? 'bg-[#1a1a1e]' : ''}`}>
                        <div className="pt-0.5 flex-shrink-0">
                          <MoodFace mood={m} size={30} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`text-xs font-semibold ${meta.color}`}>{meta.label}</span>
                            <span className="text-[10px] text-slate-600">· {meta.desc}</span>
                            {isActive && (
                              <span className="ml-auto text-[9px] text-crimson/70 font-semibold uppercase tracking-widest">now</span>
                            )}
                          </div>
                          <p className="text-[10px] text-slate-500 leading-relaxed">{meta.long}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

        </div>
      </div>

      {/* Powered By footer */}
      <div className={`absolute bottom-6 flex flex-row items-center gap-2 ${fade(5)}`}>
        <p className="text-[9px] text-slate-700 tracking-[0.3em] uppercase">Powered By</p>
        <Image
          src="/Logo.png"
          alt="Powered By"
          width={100}
          height={32}
          style={{ height: '22px', width: 'auto', objectFit: 'contain', opacity: 0.35 }}
        />
      </div>
    </div>
  );
}
