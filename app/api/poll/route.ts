import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-server';
import { fetchDrawings, parseDrawing } from '@/lib/lottery-api';
import { generatePicks } from '@/lib/evolution/fitness';
import { scorePendingPredictions } from '@/lib/score-predictions';
import type { StrategyGenome } from '@/lib/evolution/genome';
import type { Game } from '@/lib/supabase';
import { notifyBigWin } from '@/lib/notify';

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const auth = req.headers.get('Authorization') ?? '';
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = createServiceClient();

  try {
    // 1. Find current max game already stored
    const { data: maxRow } = await db
      .from('games')
      .select('game_num')
      .order('game_num', { ascending: false })
      .limit(1)
      .maybeSingle();
    const maxInDb: number = maxRow?.game_num ?? 0;

    // 2. Check the latest drawing from the API
    const latest = await fetchDrawings(1);
    if (!latest.length) {
      await logEvent(db, 'poll_error', 'error', 'API returned no drawings');
      return NextResponse.json({ ok: true, action: 'no_data' });
    }
    const latestNum = parseInt(latest[0].drawNumber, 10);

    // 3. Catch up on every game missed since the last poll/sync — not just
    // the single most recent draw. If poll runs every 4 min but a draw lands
    // every 4 min too, drift or a missed cron-job.org invocation can mean
    // more than one new game is waiting; inserting only the latest would
    // silently skip the rest (they'd never get scored or shown).
    let insertedCount = 0;
    if (latestNum > maxInDb) {
      let cursor = latestNum;
      const MAX_BATCHES = 20;
      const allNew: ReturnType<typeof parseDrawing>[] = [];

      for (let i = 0; i < MAX_BATCHES; i++) {
        const drawings = await fetchDrawings(100, cursor);
        if (!drawings.length) break;

        const newDrawings = drawings.filter(d => parseInt(d.drawNumber, 10) > maxInDb);
        allNew.push(...newDrawings.map(parseDrawing));

        if (newDrawings.length < drawings.length) break;

        const lowestInBatch = Math.min(...drawings.map(d => parseInt(d.drawNumber, 10)));
        if (lowestInBatch <= maxInDb) break;
        cursor = lowestInBatch - 1;
      }

      if (allNew.length > 0) {
        const { error: insertErr } = await db
          .from('games')
          .upsert(allNew, { onConflict: 'game_num', ignoreDuplicates: true });
        if (insertErr) throw new Error(`Failed to insert games: ${insertErr.message}`);
        insertedCount = allNew.length;

        await logEvent(db, 'poll_success', 'success',
          `Poll ingested ${insertedCount} new game(s) up to #${latestNum}`,
          { count: insertedCount, latest_game_num: latestNum });
      }
    }

    if (insertedCount === 0) {
      await logEvent(db, 'poll_no_new_game', 'info',
        `Poll: already up to date at game #${maxInDb}`, { game_num: maxInDb });
    }

    // 4. Score every outstanding pending prediction whose target game now
    // exists — covers games inserted just now by this poll *and* any
    // inserted earlier by sync's backfill that never got scored.
    const scoredCount = await scorePendingPredictions(db);

    // 4b. Notify on big wins (prize >= $10) from just-scored predictions
    if (scoredCount > 0) {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const { data: bigWins } = await db
        .from('live_results')
        .select('prize, spot_count, matches')
        .gte('prize', 10)
        .gte('scored_at', fiveMinAgo)
        .order('prize', { ascending: false })
        .limit(1);
      if (bigWins?.[0]) {
        const bw = bigWins[0];
        await notifyBigWin(bw.prize as number, bw.spot_count as number, bw.matches as number).catch(() => {});
      }
    }

    // 5. Commit predictions for the next 3 games to buffer against missed
    //    poll cycles. Each draw is ~4 min apart, so 3 games covers ~12 min.
    //    ignoreDuplicates ensures earlier predictions aren't overwritten.
    const LOOKAHEAD = 3;

    const { data: maxAfterRow } = await db
      .from('games')
      .select('game_num')
      .order('game_num', { ascending: false })
      .limit(1)
      .maybeSingle();
    const baseNextGame = (maxAfterRow?.game_num ?? maxInDb) + 1;

    const { data: promoted } = await db
      .from('strategies')
      .select('id,spot_count,genome,current_picks,commitment_remaining')
      .eq('status', 'promoted');

    // Load today's daily pick to check if we should use its exact numbers
    const today = new Date().toLocaleDateString('en-CA');
    const { data: dailyPick } = await db
      .from('daily_picks')
      .select('strategy_id,picks,bonus_type,best_hour,recommended_games,games_played,status,spot_count')
      .eq('pick_date', today)
      .maybeSingle();

    const nowET = (new Date().getUTCHours() - 4 + 24) % 24;
    const inDailyWindow = dailyPick
      && dailyPick.best_hour != null
      && nowET >= (dailyPick.best_hour as number)
      && nowET < (dailyPick.best_hour as number) + 1
      && ((dailyPick.games_played as number) ?? 0) < (dailyPick.recommended_games as number)
      && dailyPick.status !== 'complete';

    if (promoted && promoted.length > 0) {
      const { data: recentGames } = await db
        .from('games')
        .select('game_num,draw_date,draw_iso,draw_dow,bonus,super_bonus,hits')
        .order('game_num', { ascending: true })
        .limit(5000);

      const games = (recentGames ?? []) as Game[];

      // Generate or reuse picks based on commitment state
      const picksPerStrategy = new Map<number, { picks: number[]; bonusType: string; spotCount: number }>();
      const commitmentUpdates: { id: number; picks: number[]; remaining: number }[] = [];

      for (const s of promoted) {
        const sid = s.id as number;
        const genome = s.genome as StrategyGenome;
        const commitmentLen = genome.commitment_games ?? 5;

        if (inDailyWindow && dailyPick && sid === dailyPick.strategy_id) {
          picksPerStrategy.set(sid, {
            picks: dailyPick.picks as number[],
            bonusType: dailyPick.bonus_type as string,
            spotCount: dailyPick.spot_count as number,
          });
        } else {
          const remaining = (s.commitment_remaining as number) ?? 0;
          const currentPicks = s.current_picks as number[] | null;

          if (remaining > 0 && currentPicks && currentPicks.length > 0) {
            picksPerStrategy.set(sid, {
              picks: currentPicks,
              bonusType: genome.bonus_type ?? 'none',
              spotCount: s.spot_count as number,
            });
            commitmentUpdates.push({ id: sid, picks: currentPicks, remaining: remaining - 1 });
          } else {
            const newPicks = generatePicks(genome, s.spot_count as number, games);
            picksPerStrategy.set(sid, {
              picks: newPicks,
              bonusType: genome.bonus_type ?? 'none',
              spotCount: s.spot_count as number,
            });
            commitmentUpdates.push({ id: sid, picks: newPicks, remaining: commitmentLen - 1 });
          }
        }
      }

      // Update commitment state on strategies
      for (const upd of commitmentUpdates) {
        await db.from('strategies').update({
          current_picks: upd.picks,
          commitment_remaining: upd.remaining,
        }).eq('id', upd.id);
      }

      const allPredictions: { strategy_id: number; spot_count: number; predicted_for_game_num: number; picks: number[]; bonus_type: string }[] = [];
      for (let offset = 0; offset < LOOKAHEAD; offset++) {
        const gameNum = baseNextGame + offset;
        for (const s of promoted) {
          const p = picksPerStrategy.get(s.id as number)!;
          allPredictions.push({
            strategy_id: s.id as number,
            spot_count: p.spotCount,
            predicted_for_game_num: gameNum,
            picks: p.picks,
            bonus_type: p.bonusType,
          });
        }
      }

      await db.from('pending_predictions').upsert(allPredictions, {
        onConflict: 'strategy_id,predicted_for_game_num',
        ignoreDuplicates: true,
      });

      await logEvent(db, 'prediction_committed', 'info',
        `Committed predictions for games #${baseNextGame}–#${baseNextGame + LOOKAHEAD - 1} (${promoted.length} strategies × ${LOOKAHEAD} games)`,
        { game_num_start: baseNextGame, game_num_end: baseNextGame + LOOKAHEAD - 1, count: allPredictions.length });

      // Track daily pick games played
      if (inDailyWindow && dailyPick) {
        const newPlayed = ((dailyPick.games_played as number) ?? 0) + 1;
        const newStatus = newPlayed >= (dailyPick.recommended_games as number) ? 'complete' : 'playing';
        await db.from('daily_picks')
          .update({ games_played: newPlayed, status: newStatus })
          .eq('pick_date', today);
      }
    }

    return NextResponse.json({
      ok: true,
      action: insertedCount > 0 ? 'new_games' : 'no_new_game',
      games_added: insertedCount,
      latest_game_num: latestNum,
      predictions_scored: scoredCount,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logEvent(db, 'poll_error', 'error', `Poll error: ${msg}`, { error: msg }).catch(() => {});
    return NextResponse.json({ ok: true, error: msg }, { status: 200 }); // always 200
  }
}

async function logEvent(
  db: ReturnType<typeof createServiceClient>,
  event_type: string,
  severity: string,
  message: string,
  metadata?: object
) {
  await db.from('system_events').insert({ event_type, severity, message, metadata: metadata ?? null });
}
