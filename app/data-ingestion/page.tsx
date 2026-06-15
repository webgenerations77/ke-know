'use client';

import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { fetchDrawings, parseDrawing } from '@/lib/lottery-api';
import { useToast } from '@/components/Toast';

const BATCH = 100;
const TARGET = 5000;
const DELAY_MS = 150;

export default function DataIngestionPage() {
  const { toast } = useToast();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [dbStats, setDbStats] = useState<{
    total: number; newest: string; oldest: string; lastSync: string | null;
  } | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const abortRef = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);

  function addLog(msg: string) {
    setLog(prev => [...prev.slice(-200), `${new Date().toLocaleTimeString()} — ${msg}`]);
    setTimeout(() => logRef.current?.scrollTo(0, logRef.current.scrollHeight), 50);
  }

  async function loadStats() {
    const [countRes, newestRes, oldestRes, syncRes] = await Promise.all([
      supabase.from('games').select('game_num', { count: 'exact', head: true }),
      supabase.from('games').select('draw_date').order('game_num', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('games').select('draw_date').order('game_num', { ascending: true }).limit(1).maybeSingle(),
      supabase.from('sync_log').select('synced_at').order('synced_at', { ascending: false }).limit(1).maybeSingle(),
    ]);
    setDbStats({
      total: countRes.count ?? 0,
      newest: newestRes.data?.draw_date ?? '—',
      oldest: oldestRes.data?.draw_date ?? '—',
      lastSync: syncRes.data?.synced_at ?? null,
    });
  }

  useEffect(() => { loadStats(); }, []);

  async function startBackfill() {
    setRunning(true);
    abortRef.current = false;
    setLog([]);
    setProgress(0);

    try {
      // Get current count & max game num
      const { count } = await supabase.from('games').select('game_num', { count: 'exact', head: true });
      const alreadyHave = count ?? 0;
      if (alreadyHave >= TARGET) {
        addLog(`Already have ${alreadyHave} games — target reached.`);
        setProgress(100);
        return;
      }

      const { data: maxRow } = await supabase
        .from('games').select('game_num').order('game_num', { ascending: false }).limit(1).maybeSingle();
      const minRow = await supabase
        .from('games').select('game_num').order('game_num', { ascending: true }).limit(1).maybeSingle();

      // Get latest game num from API
      const latestDrawings = await fetchDrawings(1);
      if (!latestDrawings.length) throw new Error('API returned no drawings');
      const latestNum = parseInt(latestDrawings[0].drawNumber, 10);
      const oldestInDb: number = minRow.data?.game_num ?? latestNum;

      addLog(`Latest API game: ${latestNum}. DB has ${alreadyHave} games. Target: ${TARGET}.`);

      let cursor = oldestInDb - 1; // start fetching before oldest we have
      let totalAdded = 0;

      // If DB is empty, start from latest
      if (alreadyHave === 0) cursor = latestNum;

      while (!abortRef.current) {
        const { count: currentCount } = await supabase
          .from('games').select('game_num', { count: 'exact', head: true });
        const have = currentCount ?? 0;
        if (have >= TARGET) {
          addLog(`Reached target of ${TARGET} games.`);
          break;
        }

        if (cursor <= 0) {
          addLog('Reached beginning of available data.');
          break;
        }

        addLog(`Fetching batch starting at game ${cursor}…`);
        const drawings = await fetchDrawings(BATCH, cursor);
        if (!drawings.length) {
          addLog('No more drawings returned — done.');
          break;
        }

        const rows = drawings.map(parseDrawing);
        const { error, count: upserted } = await supabase
          .from('games')
          .upsert(rows, { onConflict: 'game_num', ignoreDuplicates: true });

        if (error) throw error;

        totalAdded += rows.length;
        const lowestInBatch = Math.min(...rows.map(r => r.game_num));
        cursor = lowestInBatch - 1;

        const newTotal = have + rows.length;
        const pct = Math.min(100, Math.round((newTotal / TARGET) * 100));
        setProgress(pct);
        addLog(`Inserted ${rows.length} rows. Total: ~${newTotal}. Oldest in batch: ${lowestInBatch}.`);

        // Log to sync_log
        await supabase.from('sync_log').insert({
          games_added: rows.length,
          source: 'backfill',
          latest_game_num: Math.max(...rows.map(r => r.game_num)),
          notes: `Backfill batch, cursor ${cursor + rows.length + 1}`,
        });

        await new Promise(r => setTimeout(r, DELAY_MS));
      }

      addLog(`Backfill complete. Added ${totalAdded} games this run.`);
      toast(`Backfill done — ${totalAdded} games added`, 'success');
      await loadStats();
    } catch (err) {
      addLog(`ERROR: ${err}`);
      toast(String(err), 'error');
    } finally {
      setRunning(false);
    }
  }

  async function clearDb() {
    setShowClearConfirm(false);
    try {
      await supabase.from('games').delete().neq('game_num', 0);
      await supabase.from('sync_log').delete().neq('id', 0);
      toast('Database cleared', 'info');
      await loadStats();
    } catch (e) {
      toast(String(e), 'error');
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-2xl font-bold">Data Ingestion</h1>

      {/* DB Stats */}
      <div className="bg-surface rounded-xl p-5 grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Games in DB', value: dbStats?.total.toLocaleString() ?? '…' },
          { label: 'Newest Draw', value: dbStats?.newest ?? '…' },
          { label: 'Oldest Draw', value: dbStats?.oldest ?? '…' },
          { label: 'Last Sync', value: dbStats?.lastSync ? new Date(dbStats.lastSync).toLocaleString() : 'Never' },
        ].map(({ label, value }) => (
          <div key={label}>
            <div className="text-xs text-slate-500">{label}</div>
            <div className="text-sm font-semibold mt-0.5">{value}</div>
          </div>
        ))}
      </div>

      {/* Backfill */}
      <div className="bg-surface rounded-xl p-5 space-y-4">
        <h2 className="font-semibold">One-Time Backfill</h2>
        <p className="text-sm text-slate-400">
          Fetches draws in 100-game batches going backward from the latest game until 5,000 games are stored.
          Runs entirely in your browser. Safe to restart — duplicate rows are skipped automatically.
        </p>

        <div className="flex gap-3 flex-wrap">
          <button
            onClick={startBackfill}
            disabled={running}
            className="px-4 py-2 rounded-lg bg-crimson hover:bg-crimson-hover disabled:opacity-50 text-white text-sm font-medium transition-colors"
          >
            {running ? 'Running…' : 'Start Backfill'}
          </button>
          {running && (
            <button
              onClick={() => { abortRef.current = true; }}
              className="px-4 py-2 rounded-lg bg-[#333] hover:bg-[#444] text-white text-sm"
            >
              Stop
            </button>
          )}
        </div>

        {/* Progress bar */}
        {(running || progress > 0) && (
          <div>
            <div className="flex justify-between text-xs text-slate-400 mb-1">
              <span>Progress</span>
              <span>{progress}%</span>
            </div>
            <div className="w-full bg-[#2a2a2e] rounded-full h-2.5">
              <div
                className="bg-crimson h-2.5 rounded-full transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}

        {/* Activity log */}
        {log.length > 0 && (
          <div
            ref={logRef}
            className="bg-[#0e0e10] rounded-lg p-3 h-48 overflow-y-auto font-mono text-xs text-slate-400 space-y-0.5"
          >
            {log.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        )}
      </div>

      {/* How sync works */}
      <div className="bg-surface rounded-xl p-5 space-y-3 text-sm text-slate-400">
        <h2 className="font-semibold text-slate-200">How Sync Works</h2>
        <ul className="space-y-2 list-disc list-inside">
          <li><strong className="text-slate-300">Backfill</strong> — runs once in your browser to populate the DB with up to 5,000 historical draws.</li>
          <li><strong className="text-slate-300">Auto-sync</strong> — a Vercel Cron Job runs <em>every hour</em> to pull new draws automatically, even when the app is closed. It hits <code className="bg-[#0e0e10] px-1 rounded">/api/sync</code> with the shared <code>CRON_SECRET</code>.</li>
          <li><strong className="text-slate-300">Manual sync</strong> — the "Sync Now" button in the sidebar calls <code className="bg-[#0e0e10] px-1 rounded">/api/sync-manual</code>, which proxies to the sync route server-side so the secret is never exposed to the browser.</li>
        </ul>
      </div>

      {/* Clear DB */}
      <div className="bg-surface rounded-xl p-5 space-y-3">
        <h2 className="font-semibold text-red-400">Danger Zone</h2>
        {!showClearConfirm ? (
          <button
            onClick={() => setShowClearConfirm(true)}
            className="px-4 py-2 rounded-lg bg-red-900 hover:bg-red-800 text-red-200 text-sm"
          >
            Clear All Data
          </button>
        ) : (
          <div className="flex gap-3 items-center">
            <span className="text-sm text-red-300">Delete all games and sync logs?</span>
            <button onClick={clearDb} className="px-3 py-1.5 rounded bg-red-700 text-white text-sm">Confirm</button>
            <button onClick={() => setShowClearConfirm(false)} className="px-3 py-1.5 rounded bg-[#333] text-white text-sm">Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}
