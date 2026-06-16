import { createServiceClient } from '@/lib/supabase-server';
import { fetchDrawings, parseDrawing } from '@/lib/lottery-api';
import { runEvolution } from '@/lib/evolution/evolve';

export interface SyncResult {
  gamesAdded: number;
  evolutionRan: boolean;
  notes?: string;
  [key: string]: unknown;
}

/**
 * Backfills new games and runs one evolution generation. Shared by /api/sync
 * (cron-job.org, Bearer-protected) and /api/sync-manual (browser "Sync Now"
 * button) so neither has to make a fragile self-referential HTTP call back
 * into the deployment.
 */
export async function performSync(db: ReturnType<typeof createServiceClient>): Promise<SyncResult> {
  try {
    // ---- 1. Sync latest games ----
    const { data: maxRow } = await db
      .from('games')
      .select('game_num')
      .order('game_num', { ascending: false })
      .limit(1)
      .maybeSingle();
    const maxInDb: number = maxRow?.game_num ?? 0;

    const latestBatch = await fetchDrawings(1);
    if (!latestBatch.length) {
      return { gamesAdded: 0, evolutionRan: false, notes: 'API returned no drawings' };
    }
    const latestNum = parseInt(latestBatch[0].drawNumber, 10);

    let totalAdded = 0;

    if (latestNum > maxInDb) {
      let cursor = latestNum;
      const MAX_BATCHES = 50;

      for (let i = 0; i < MAX_BATCHES; i++) {
        const drawings = await fetchDrawings(100, cursor);
        if (!drawings.length) break;

        const newDrawings = drawings.filter(
          d => parseInt(d.drawNumber, 10) > maxInDb
        );

        if (newDrawings.length > 0) {
          const rows = newDrawings.map(parseDrawing);
          const { error } = await db
            .from('games')
            .upsert(rows, { onConflict: 'game_num', ignoreDuplicates: true });
          if (error) throw error;
          totalAdded += rows.length;
        }

        if (newDrawings.length < drawings.length) break;

        const lowestInBatch = Math.min(...drawings.map(d => parseInt(d.drawNumber, 10)));
        if (lowestInBatch <= maxInDb) break;
        cursor = lowestInBatch - 1;
      }
    }

    await db.from('sync_log').insert({
      games_added: totalAdded,
      source: 'auto',
      latest_game_num: latestNum,
      notes: totalAdded > 0 ? `Added ${totalAdded} games up to #${latestNum}` : 'Already up to date',
    });

    await db.from('system_events').insert({
      event_type: 'sync_complete',
      severity: 'info',
      message: `Sync complete — ${totalAdded} new games (latest #${latestNum})`,
      metadata: { games_added: totalAdded, latest_game_num: latestNum },
    });

    // ---- 2. Run evolution ----
    let evolutionRan = false;
    let evolutionResult: object = {};

    try {
      const result = await runEvolution();
      evolutionRan = true;
      evolutionResult = result;
    } catch (evoErr) {
      const msg = evoErr instanceof Error ? evoErr.message : String(evoErr);
      console.error('[sync/evolution]', msg);
      try {
        await db.from('system_events').insert({
          event_type: 'evolution_complete',
          severity: 'error',
          message: `Evolution error: ${msg}`,
          metadata: { error: msg },
        });
      } catch { /* best-effort logging */ }
    }

    return { gamesAdded: totalAdded, evolutionRan, ...evolutionResult };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[sync]', msg);
    try {
      await db.from('system_events').insert({
        event_type: 'sync_error',
        severity: 'error',
        message: `Sync error: ${msg}`,
        metadata: { error: msg },
      });
    } catch { /* best-effort logging */ }
    throw err;
  }
}
