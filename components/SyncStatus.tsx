'use client';

import { useEffect, useState } from 'react';
import { supabase, SyncLog } from '@/lib/supabase';
import { useToast } from './Toast';

export function SyncStatus() {
  const [lastSync, setLastSync] = useState<SyncLog | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [countdown, setCountdown] = useState('');
  const { toast } = useToast();

  async function loadLastSync() {
    const { data } = await supabase
      .from('sync_log')
      .select('*')
      .order('synced_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) setLastSync(data as SyncLog);
  }

  useEffect(() => {
    loadLastSync();
  }, []);

  // Countdown to next hourly sync
  useEffect(() => {
    const tick = () => {
      if (!lastSync) { setCountdown('—'); return; }
      const last = new Date(lastSync.synced_at);
      const next = new Date(last.getTime() + 60 * 60 * 1000);
      const diff = next.getTime() - Date.now();
      if (diff <= 0) { setCountdown('soon'); return; }
      const m = Math.floor(diff / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setCountdown(`${m}m ${s}s`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [lastSync]);

  async function handleManualSync() {
    setSyncing(true);
    try {
      const res = await fetch('/api/sync-manual', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Sync failed');
      toast(`Sync complete — ${data.gamesAdded} game(s) added`, 'success');
      await loadLastSync();
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setSyncing(false);
    }
  }

  const syncedAt = lastSync
    ? new Date(lastSync.synced_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'Never';

  return (
    <div className="mt-auto pt-4 border-t border-[#2a2a2e] space-y-2 text-xs text-slate-400">
      <div className="flex items-center gap-2">
        <span
          className={`w-2 h-2 rounded-full ${syncing ? 'bg-amber-400 animate-pulse' : 'bg-green-500'}`}
        />
        <span className="truncate">Last sync: {syncedAt}</span>
      </div>
      {lastSync && (
        <div className="text-slate-500">+{lastSync.games_added} games · next in {countdown}</div>
      )}
      <button
        onClick={handleManualSync}
        disabled={syncing}
        className="w-full mt-1 py-1.5 px-3 rounded text-xs bg-[#8B1A4A] hover:bg-[#a81f5a] disabled:opacity-50 text-white transition-colors"
      >
        {syncing ? 'Syncing…' : 'Sync Now'}
      </button>
    </div>
  );
}
