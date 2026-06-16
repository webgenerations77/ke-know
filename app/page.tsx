'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { supabase } from '@/lib/supabase';

type ArthurMood = 'awakening' | 'curious' | 'focused' | 'optimistic' | 'cautious' | 'frustrated';

const MOOD_META: Record<ArthurMood, {
  label: string; color: string; dot: string; desc: string; emoji: string; long: string;
}> = {
  awakening:  {
    label: 'Awakening',  color: 'text-slate-400',  dot: 'bg-slate-500',  emoji: '🌱',
    desc: 'Waiting to evolve',
    long: 'Arthur has no evolution cycles yet. Feed him historical data and run the first evolution to bring him online.',
  },
  curious:    {
    label: 'Curious',    color: 'text-blue-400',   dot: 'bg-blue-400',   emoji: '🔍',
    desc: 'Exploring patterns',
    long: 'Arthur is active but hasn\'t accumulated enough today\'s shadow plays to form a clear view. He\'s watching and learning.',
  },
  focused:    {
    label: 'Focused',    color: 'text-slate-200',  dot: 'bg-slate-400',  emoji: '🎯',
    desc: 'Analyzing data',
    long: 'Arthur is on baseline — steady win rate, roughly break-even P&L. He\'s locked in on the data without strong signals in either direction.',
  },
  optimistic: {
    label: 'Optimistic', color: 'text-green-400',  dot: 'bg-green-400',  emoji: '🚀',
    desc: 'Performing well',
    long: 'Today\'s session is profitable with a win rate above 35%. Arthur\'s current generation strategies are firing on all cylinders.',
  },
  cautious:   {
    label: 'Cautious',   color: 'text-amber-400',  dot: 'bg-amber-400',  emoji: '⚠️',
    desc: 'Watching trends',
    long: 'Today\'s P&L is slightly negative. Arthur is monitoring the session closely and expecting the next evolution cycle to recalibrate.',
  },
  frustrated: {
    label: 'Frustrated', color: 'text-red-400',    dot: 'bg-red-500',    emoji: '🔥',
    desc: 'Adapting strategy',
    long: 'Significant losses or a very low win rate today. Arthur knows these runs happen — he\'ll use this data to drive harder selection pressure in the next generation.',
  },
};

const MOODS_ORDER: ArthurMood[] = ['awakening', 'curious', 'focused', 'optimistic', 'cautious', 'frustrated'];

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
    const t3 = setTimeout(() => setPhase(3), 860);
    const t4 = setTimeout(() => setPhase(4), 1100);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); clearTimeout(t4); };
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
        generation,
        totalGames: gamesCount,
        lastRunAt,
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

      {/* Mood panel overlay — closes on outside click */}
      {moodPanelOpen && (
        <div
          className="fixed inset-0 z-20"
          onClick={() => setMoodPanelOpen(false)}
        />
      )}

      <div className="relative flex flex-col items-center gap-0 z-10">

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
        <div className={`mt-5 ${fade(2)}`}>
          <p className="text-xs tracking-[0.35em] text-slate-500 uppercase text-center">
            Maryland Keno Intelligence
          </p>
        </div>

        {/* Divider */}
        <div className={`mt-10 mb-10 w-px h-12 bg-gradient-to-b from-transparent via-[#2a2a2e] to-transparent ${fade(3)}`} />

        {/* Arthur block */}
        <div className={`flex flex-col items-center gap-4 ${fade(3)}`}>

          {/* Section label */}
          <p className="text-[10px] tracking-[0.45em] text-slate-600 uppercase">
            Meet Arthur
          </p>

          {/* Status indicator */}
          <div className="flex items-center gap-2.5">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-40" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500/70" />
            </span>
            <span className="text-sm text-slate-300 tracking-wide">
              Arthur is learning.
            </span>
          </div>

          {/* Live stats */}
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

          {/* Mood row + clickable emoji */}
          <div className="relative flex flex-col items-center gap-2">
            <div className="flex items-center gap-2">
              <span className={`inline-flex w-2 h-2 rounded-full flex-shrink-0 ${mood.dot}`} />
              <span className={`text-sm font-medium tracking-wide ${mood.color}`}>{mood.label}</span>
              <span className="text-xs text-slate-600">· {mood.desc}</span>
              <button
                onClick={(e) => { e.stopPropagation(); setMoodPanelOpen(o => !o); }}
                className="text-lg leading-none hover:scale-110 transition-transform cursor-pointer ml-1"
                title="What does Arthur's mood mean?"
              >
                {mood.emoji}
              </button>
            </div>

            {/* Mood explanation panel */}
            {moodPanelOpen && (
              <div
                className="absolute top-full mt-3 z-30 w-80 bg-[#111114] border border-[#2a2a2e] rounded-xl shadow-2xl overflow-hidden"
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
                      <div
                        key={m}
                        className={`px-4 py-3 ${isActive ? 'bg-[#1a1a1e]' : ''}`}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-base">{meta.emoji}</span>
                          <span className={`text-xs font-semibold ${meta.color}`}>{meta.label}</span>
                          {isActive && (
                            <span className="ml-auto text-[9px] text-crimson/70 font-semibold uppercase tracking-widest">now</span>
                          )}
                        </div>
                        <p className="text-[10px] text-slate-500 leading-relaxed pl-7">{meta.long}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

        </div>

        {/* Enter button */}
        <div className={`mt-14 ${fade(4)}`}>
          <button
            onClick={() => router.push('/monitor')}
            className="group relative px-12 py-3.5 rounded-lg bg-crimson hover:bg-crimson-hover text-white text-sm tracking-widest font-medium transition-all duration-200 hover:shadow-[0_0_32px_rgba(139,26,74,0.45)]"
          >
            Enter
            <span className="ml-3 opacity-50 group-hover:opacity-100 group-hover:ml-4 transition-all duration-200">→</span>
          </button>
        </div>

      </div>

      {/* Powered By footer */}
      <div className={`absolute bottom-6 flex flex-col items-center gap-2 ${fade(4)}`}>
        <p className="text-[9px] text-slate-700 tracking-[0.3em] uppercase">Powered By</p>
        <Image
          src="/Logo.png"
          alt="Powered By"
          width={100}
          height={32}
          style={{ height: '28px', width: 'auto', objectFit: 'contain', opacity: 0.35 }}
        />
      </div>
    </div>
  );
}
