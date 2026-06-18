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

- **Genome** (`genome.ts`): 18 genes controlling lookback window, weighting method, decay rates, gap detection, bonus type, and signal mixing weights
- **Fitness** (`fitness.ts`): Simulates each strategy against all historical games (train/test split). Uses TypedArrays for performance. Fitness = 50% test PPG + 30% live PPG + 10% win rate + 5% consistency + 5% real-world bonus
- **Evolution** (`evolve.ts`): 20 strategies per spot count (1-10), 10 survive. Breed via 40% crossover / 60% mutation. Mutation rate decays over generations. Champions promoted per spot count if they beat the incumbent

Key constraint: promotion requires positive test PnL/game OR 10%+ higher fitness with better test PPG than current champion. This prevents strategies that only look good on paper from being promoted.

### Cron System

- `/api/poll` — POST with Bearer auth, called every ~4 min by external cron (cron-job.org). Catches up on missed games, scores predictions, commits new ones. Always returns 200.
- `/api/sync` — GET (Vercel cron) or POST (external cron). Daily backfill + one evolution generation.
- `/api/daily-pick` — GET (Vercel cron). Selects highest-fitness champion, generates picks, finds best hour from live data.
- `/api/sync-manual` — POST, no auth. Browser-triggered sync.
- `/api/evolve` — POST. On-demand evolution trigger.

### Arthur (AI Mascot)

Arthur is a stateless AI personality on the Live Monitor page. His thought engine (`computeArthurFull` in `app/monitor/page.tsx`) builds layered commentary from:
- **Reactive**: current streak detection, last-result reactions, spot-level hot/cold today
- **Trend-based**: weekly spot performance opinions, day-over-day comparisons, profitable day ratios, all-time best win memory
- **Mood system**: fire/good/steady/down/waiting — drives UI color (pulse dot, gradient background)
- Outputs a main thought + up to 2 secondary observations

### Prize Tables & Math

`lib/keno-odds.ts` contains actual Maryland Keno payouts (1-10 spot), bonus/super bonus multiplier distributions, and hypergeometric probability calculations for EV. `lib/keno/prizes.ts` re-exports the lookup function.

## Environment Variables

| Variable | Scope | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Client + Server | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Client + Server | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only | Bypasses RLS, used in all API routes |
| `CRON_SECRET` | Server only | Bearer token for poll/sync endpoints |

## Conventions

- Path alias `@/*` maps to project root
- Dark theme: `bg: #0e0e10`, `surface: #16161a`, `crimson: #8B1A4A` — defined in both `tailwind.config.js` and CSS vars in `globals.css`
- All tables grant full CRUD to `anon` role (no RLS)
- Migrations in `supabase/migrations/` are applied manually via Supabase SQL editor
- Realtime enabled on: `games`, `system_events`, `live_results`, `strategies`, `strategy_results`
- Data source: Maryland Lottery Keno API proxied through `/api/lottery` (no CORS on source)
- `lib/prediction-engine.ts` is an older non-evolutionary prediction system used only by the Prediction Portal page; the evolution engine is the primary system
