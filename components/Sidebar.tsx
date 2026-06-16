'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { SyncStatus } from './SyncStatus';

const NAV = [
  { href: '/monitor', label: 'Live Monitor', icon: '⬤' },
  { href: '/spot-advisor', label: 'Spot Advisor', icon: '◈' },
  { href: '/strategy-lab', label: 'Strategy Lab', icon: '⚙' },
  { href: '/dashboard', label: 'Dashboard', icon: '◉' },
  { href: '/my-picks', label: 'My Picks', icon: '✦' },
  { href: '/saved-picks', label: 'Saved Picks', icon: '⊡' },
  { href: '/heatmap', label: 'Heatmap', icon: '▦' },
  { href: '/frequency', label: 'Frequency', icon: '≡' },
  { href: '/bonus-patterns', label: 'Bonus Patterns', icon: '✕' },
  { href: '/time-patterns', label: 'Time Patterns', icon: '◷' },
  { href: '/draw-history', label: 'Draw History', icon: '⊞' },
  { href: '/data-ingestion', label: 'Data Ingestion', icon: '⬆' },
];

export function Sidebar() {
  const path = usePathname();
  const [open, setOpen] = useState(false);

  const nav = (
    <nav className="flex flex-col h-full">
      <div className="px-4 py-4 border-b border-[#2a2a2e]">
        <Image
          src="/Logo-Keno.png"
          alt="KE-KNOW"
          width={300}
          height={100}
          style={{ height: '80px', width: 'auto', objectFit: 'contain' }}
        />
        <p className="text-xs text-slate-500 mt-1.5">MD Keno Predictor</p>
      </div>
      <ul className="flex-1 py-4 overflow-y-auto">
        {NAV.map(({ href, label, icon }) => {
          const active = path === href || (href !== '/' && path.startsWith(href));
          return (
            <li key={href}>
              <Link
                href={href}
                onClick={() => setOpen(false)}
                className={`flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                  active
                    ? 'bg-crimson text-white font-medium'
                    : 'text-slate-400 hover:text-white hover:bg-[#1e1e24]'
                }`}
              >
                <span className="text-base w-5 text-center">{icon}</span>
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="px-4 pb-4">
        <SyncStatus />
      </div>
    </nav>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-56 flex-shrink-0 flex-col bg-surface h-screen sticky top-0 no-print">
        {nav}
      </aside>

      {/* Mobile hamburger */}
      <div className="md:hidden no-print">
        <button
          onClick={() => setOpen(!open)}
          className="fixed top-3 left-3 z-50 p-2 rounded bg-surface border border-[#333] text-slate-300"
        >
          <span className="text-xl">{open ? '✕' : '☰'}</span>
        </button>
        {open && (
          <>
            <div
              className="fixed inset-0 z-40 bg-black/60"
              onClick={() => setOpen(false)}
            />
            <aside className="fixed inset-y-0 left-0 z-50 w-64 bg-surface flex flex-col">
              {nav}
            </aside>
          </>
        )}
      </div>
    </>
  );
}
