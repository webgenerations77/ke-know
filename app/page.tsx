'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { supabase } from '@/lib/supabase';

interface ArthurStatus {
  generation: number | null;
  totalGames: number | null;
  lastRunAt: string | null;
}

function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const mins = (Date.now() - new Date(iso).getTime()) / 60000;
  if (mins < 60) return `${Math.round(mins)}m ago`;
  const hrs = mins / 60;
  if (hrs < 24) return `${Math.round(hrs)}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export default function SplashPage() {
  const router = useRouter();
  const [phase, setPhase] = useState(0);
  const [arthur, setArthur] = useState<ArthurStatus>({ generation: null, totalGames: null, lastRunAt: null });

  // Stagger entrance animation
  useEffect(() => {
    const t1 = setTimeout(() => setPhase(1), 120);
    const t2 = setTimeout(() => setPhase(2), 520);
    const t3 = setTimeout(() => setPhase(3), 860);
    const t4 = setTimeout(() => setPhase(4), 1100);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); clearTimeout(t4); };
  }, []);

  // Fetch Arthur's live status
  useEffect(() => {
    async function load() {
      const [{ data: evo }, { count }] = await Promise.all([
        supabase.from('evolution_state').select('current_generation,last_run_at').eq('id', 1).single(),
        supabase.from('games').select('game_num', { count: 'exact', head: true }),
      ]);
      setArthur({
        generation: evo?.current_generation ?? null,
        totalGames: count,
        lastRunAt: evo?.last_run_at ?? null,
      });
    }
    load();
  }, []);

  const fade = (n: number) =>
    `transition-all duration-700 ${phase >= n ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3'}`;

  return (
    <div className="fixed inset-0 z-[9999] bg-bg flex flex-col items-center justify-center select-none">
      {/* Subtle radial glow */}
      <div className="pointer-events-none absolute inset-0" style={{
        background: 'radial-gradient(ellipse 70% 50% at 50% 48%, rgba(139,26,74,0.10) 0%, transparent 70%)',
      }} />

      <div className="relative flex flex-col items-center gap-0 z-10">

        {/* Logo */}
        <div className={fade(1)}>
          <Image
            src="/Logo-Keno.png"
            alt="KE-KNOW"
            width={500}
            height={250}
            style={{ height: '220px', width: 'auto', objectFit: 'contain' }}
            priority
          />
        </div>

        {/* Tagline */}
        <div className={`mt-4 ${fade(2)}`}>
          <p className="text-[10px] tracking-[0.35em] text-slate-500 uppercase text-center">
            Maryland Keno Intelligence
          </p>
        </div>

        {/* Divider */}
        <div className={`mt-10 mb-10 w-px h-12 bg-gradient-to-b from-transparent via-[#2a2a2e] to-transparent ${fade(3)}`} />

        {/* Arthur status block */}
        <div className={`flex flex-col items-center gap-3 ${fade(3)}`}>

          {/* Status indicator */}
          <div className="flex items-center gap-2.5">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-40" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500/70" />
            </span>
            <span className="text-[11px] text-slate-500 tracking-wider">
              Arthur is learning.
            </span>
          </div>

          {/* Live stats — fade in once data arrives */}
          {(arthur.generation !== null || arthur.totalGames !== null) && (
            <div className="flex items-center gap-4 text-[10px] text-slate-700 tracking-wide">
              {arthur.generation !== null && (
                <span>
                  Gen <span className="text-slate-500">{arthur.generation}</span>
                </span>
              )}
              {arthur.generation !== null && arthur.totalGames !== null && (
                <span className="text-[#2a2a2e]">·</span>
              )}
              {arthur.totalGames !== null && (
                <span>
                  <span className="text-slate-500">{arthur.totalGames.toLocaleString()}</span> draws studied
                </span>
              )}
              {arthur.lastRunAt && (
                <>
                  <span className="text-[#2a2a2e]">·</span>
                  <span>
                    last run <span className="text-slate-500">{timeAgo(arthur.lastRunAt)}</span>
                  </span>
                </>
              )}
            </div>
          )}
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

      {/* Bottom note */}
      <div className={`absolute bottom-8 ${fade(4)}`}>
        <p className="text-[10px] text-slate-700 tracking-widest uppercase">
          ke-know · 2026
        </p>
      </div>
    </div>
  );
}
