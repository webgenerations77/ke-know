'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ADMIN_NAV = [
  { href: '/admin/strategy-lab', label: 'Strategy Lab', icon: '⚙' },
  { href: '/admin/dashboard', label: 'Dashboard', icon: '◉' },
  { href: '/admin/data-ingestion', label: 'Data Ingestion', icon: '⬡' },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const path = usePathname();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 flex-wrap">
        <Link
          href="/monitor"
          className="text-xs text-slate-500 hover:text-white transition-colors flex items-center gap-1"
        >
          ← Back to app
        </Link>
        <div className="flex gap-1">
          {ADMIN_NAV.map(({ href, label, icon }) => {
            const active = path === href;
            return (
              <Link
                key={href}
                href={href}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  active
                    ? 'bg-crimson text-white'
                    : 'text-slate-400 hover:text-white hover:bg-[#1e1e24]'
                }`}
              >
                <span className="mr-1.5">{icon}</span>
                {label}
              </Link>
            );
          })}
        </div>
        <span className="ml-auto text-[10px] text-slate-600 uppercase tracking-widest font-semibold">Admin</span>
      </div>
      {children}
    </div>
  );
}
