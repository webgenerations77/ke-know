# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Dev Commands

```bash
npm run dev      # Next.js dev server
npm run build    # Production build
npm run lint     # ESLint
```

No test framework is configured.

## Architecture

**Stack**: Next.js 14 App Router, Supabase (Postgres + Realtime), Tailwind CSS, Recharts. Deployed on Vercel. Single-user personal research tool — no auth, no RLS.

**Two Supabase clients**:
- `lib/supabase.ts` — browser client (anon key, used by all pages)
- `lib/supabase-server.ts` — server client (service role key, used by API routes)

All pages are `'use client'` and fetch data via Supabase client in `useEffect`, not Server Components.

### Data Flow

```
Maryland Lottery API → /api/poll (every 4min) → games table
                                               → score pending_predictions → live_results
                                               → commit new predictions

/api/sync (daily 9:30AM UTC) → backfill games → run evolution → promote champions

/api/daily-pick (daily 10AM UTC) → pick best champion → generate daily pick
```

### Evolution Engine (`lib/evolution/`)

A genetic algorithm that breeds Keno number-picking strategies:

- **Genome** (`genome.ts`): 15 active genes controlling lookback window, weighting method, decay rates, gap detection, hot/cold balance, pair co-occurrence, pick noise, lookback step, bonus type, wager ($1-$5 base), and commitment (3-20 games with same picks before regenerating). Heuristic seeding produces momentum, contrarian, balanced, and bonus-hunter archetypes. `getWagerCost(genome)` computes total per-game cost (base wager × bonus multiplier). Commitment state tracked on `strategies.current_picks` + `commitment_remaining`
- **Fitness** (`fitness.ts`): 3-fold temporal cross-validation (not single train/test split). Fitness = 35% OOS PPG + 35% trust-scaled live PPG + 15% overfit penalty + 10% risk-adjusted return + 5% diversity bonus. Live PPG only counts genuine pre-committed predictions (source='prediction'), not replays. Trust scaling: sqrt(n/100) clamped to [0,1]
- **Evolution** (`evolve.ts`): 20 strategies per spot count (1-10), 10 survive. SUS parent selection, 40% crossover / 60% mutation, 2 random immigrants per generation. Mutation rate: 50%->35%->20%->12% (never below 12%). Champions promoted per spot count if they beat the incumbent

Key constraint: promotion requires positive OOS P&L/game OR 10%+ higher fitness with better OOS PPG than current champion. The `live_results.source` column distinguishes pre-committed predictions from retroactive replays.

### Cron System

- `/api/poll` — POST with Bearer auth, called every ~4 min by external cron (cron-job.org). Catches up on missed games, scores predictions, notifies on big wins, commits new ones. Always returns 200.
- `/api/sync` — GET (Vercel cron) or POST (external cron). Daily backfill + score predictions + replay champions against missed games + one evolution generation. Notifies on new champion promotions.
- `/api/daily-pick` — GET (Vercel cron). Selects highest-fitness champion, generates picks, finds best hour from live data. Sends push notification with today's pick.
- `/api/simulate` — POST with Bearer auth or x-internal header. Triggers `replayChampions()` to replay promoted strategies against historical games they haven't been scored on. Runs automatically during sync but can be triggered manually from Simulator UI.
- `/api/notify-window` — POST with Bearer auth. Checks if the current ET hour matches today's best play window and sends a push notification. Set up a cron to call this every hour.
- `/api/sync-manual` — POST, no auth. Browser-triggered sync.
- `/api/evolve` — POST. On-demand evolution trigger.

### Arthur (AI Mascot)

Arthur is a stateless AI personality on the Live Monitor page. His thought engine (`computeArthurFull` in `app/monitor/page.tsx`) builds layered commentary from:
- **Reactive**: current streak detection, last-result reactions, spot-level hot/cold today
- **Trend-based**: weekly spot performance opinions, day-over-day comparisons, profitable day ratios, all-time best win memory, generation depth, champion diversity
- **Mood system**: fire/good/steady/down/waiting — drives UI color (pulse dot, gradient background)
- **Template pools**: each trigger has 3-5 phrase variants, randomly selected via `pick()` helper. Observations are weight-shuffled to surface different insights each render
- Outputs a main thought + up to 3 secondary observations
- Uses day-of-week names and time-of-day for contextual variety

### Prize Tables & Math

`lib/keno-odds.ts` contains actual Maryland Keno payouts (1-10 spot), bonus/super bonus multiplier distributions, and hypergeometric probability calculations for EV. `lib/keno/prizes.ts` re-exports the lookup function.

## Environment Variables

| Variable | Scope | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Client + Server | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Client + Server | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only | Bypasses RLS, used in all API routes |
| `CRON_SECRET` | Server only | Bearer token for poll/sync endpoints |
| `NTFY_TOPIC` | Server only | ntfy.sh topic name for push notifications (e.g. `keknow-alerts`) |
| `NTFY_URL` | Server only | Optional ntfy server URL (defaults to `https://ntfy.sh`) |

## Conventions

- Path alias `@/*` maps to project root
- Dark theme: `bg: #0e0e10`, `surface: #16161a`, `crimson: #8B1A4A` — defined in both `tailwind.config.js` and CSS vars in `globals.css`
- All tables grant full CRUD to `anon` role (no RLS)
- Migrations in `supabase/migrations/` are applied manually via Supabase SQL editor
- Realtime enabled on: `games`, `system_events`, `live_results`, `strategies`, `strategy_results`
- Data source: Maryland Lottery Keno API proxied through `/api/lottery` (no CORS on source)
- `lib/prediction-engine.ts` is an older non-evolutionary prediction system used only by the Prediction Portal page; the evolution engine is the primary system

### Page Structure

**Player pages** (main sidebar nav):
- `/monitor` — Live Monitor with Arthur, time filter (today/week/month/all), win/loss, live feed
- `/daily-pick` — Arthur's daily recommended play
- `/spot-advisor` — Spot count recommendations
- `/learning-center` — Simulator: live sessions + historical backtests using champion strategies. Results feed into `live_results` for fitness scoring. Auto-replay runs during sync.
- `/number-cloud`, `/frequency`, `/pair-patterns`, `/draw-history` — Data exploration

### Simulator & Replay System (`lib/replay.ts`)

The replay engine (`replayChampions()`) retroactively scores promoted champion strategies against historical games they haven't been scored on. Results are tagged `source='replay'` in `live_results` — the fitness function only trusts `source='prediction'` for live PPG. Key constraint: picks for game N only use games 1..N-1 as context (no look-ahead). Capped at 500 new results per sync run. Unique index on `live_results(strategy_id, game_num)` prevents duplicates.

### Push Notifications (`lib/notify.ts`)

Uses ntfy.sh for push notifications. Set `NTFY_TOPIC` env var and install the ntfy app on your phone. Notifications fire for:
- Daily pick generated (with numbers + best play window)
- Play window opening (via `/api/notify-window` hourly cron)
- Big wins ($10+) detected during poll scoring
- New champion promotions after evolution

**Admin pages** (`/admin/*` route with dedicated layout):
- `/admin/strategy-lab` — Evolution engine dashboard, genome explorer
- `/admin/dashboard` — Analytics overview
- `/admin/data-ingestion` — DB sync controls, evolution triggers, backfill

## Arthur Roadmap — Next Steps

### Near-Term (Next Few Sessions)

- **Selective spot play**: Arthur currently plays all 10 spot counts every game. He should learn which spot counts are worth playing and drop underperformers — add a `spot_active` gene or fitness threshold that retires unprofitable spot counts from live play
- **Confidence-based wager scaling**: Instead of a flat evolved wager, Arthur could scale his bet up/down based on how strongly his analysis favors a pick set — high-confidence picks get the full wager, uncertain ones get the minimum
- **Session bankroll tracking**: Track cumulative P&L per session (commitment run) and let Arthur set stop-loss/take-profit thresholds as evolvable genes — cut a losing run short or lock in profits
- **Time-of-day awareness**: Arthur already finds the best play window for daily picks, but his champion strategies don't factor time into number selection. Add hour-of-day context to the scoring function so picks can shift based on when draws happen

### Medium-Term (Architecture Improvements)

- **Multi-generation evolution per sync**: Currently sync runs one generation per day. Allow configurable N generations per sync cycle (e.g., 3-5) to accelerate learning, especially in early generations
- **Population sizing by performance**: Increase population for spot counts that are close to profitability (more exploration needed) and reduce for those that are clearly dominated
- **Cross-spot-count learning**: Champions from similar spot counts (e.g., 4-spot and 5-spot) could share genome traits through cross-spot crossover — a strategy that works for 5-spot might partially transfer to 6-spot
- **Fitness function tuning**: Add an evolvable meta-gene that adjusts the fitness weight split (OOS/live/overfit/risk/diversity) per spot count — different spot counts may need different evaluation emphasis

### Longer-Term (New Capabilities)

- **Pattern memory**: Give Arthur a persistent memory of which number patterns preceded big wins, building a pattern library that supplements the statistical scoring
- **Ensemble picks**: Instead of one champion per spot count, run top-3 strategies and combine their picks (majority vote, weighted by fitness) for more robust number selection
- **Real-play tracking**: Add manual result entry so Arthur can track actual plays made at the lottery terminal and compare his shadow play performance against real outcomes
- **Arthur personality depth**: Give Arthur memory of his own history — "last time I ran this exact set of numbers for 15 games, I hit $25 on game 12" — making his commentary more personal and data-driven rather than template-based
