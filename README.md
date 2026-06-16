# Ke-Know — Maryland Keno Research App

A personal tool for analyzing Maryland Keno draw history, generating data-driven pick suggestions, and tracking results. Built with Next.js 14, Supabase, TypeScript, Tailwind CSS, and Recharts.

---

## Features

- **Live Monitor** — system status bar, live game/prediction feed, evolution pulse sparkline, rolling P&L (24h/7d/all-time), realtime activity log, cron health validator
- **Dashboard** — summary stats, top/bottom 10 numbers, bonus distribution charts, evolution engine status (generation, champion, trend)
- **Strategy Lab** — overall + per-spot-count champions, sortable 200-strategy leaderboard, evolution history chart, live prediction feed, genome explorer
- **Spot Advisor** — EV analysis across all 10 spot counts, bonus/super bonus comparison, wager-aware prize scaling
- **My Picks** — manual (hot/balanced/cold/streak) and evolved (genetic-algorithm champion) strategies, composite scoring, save picks with full metadata
- **Saved Picks** — review past picks, log results with live prize/P&L preview, track win rate and per-strategy P&L leaderboard
- **Heatmap** — 80-number grid color-coded by frequency/recency/composite score
- **Frequency Table** — sortable full table of all 80 numbers
- **Bonus Patterns** — multiplier distributions from real data, per-level hottest numbers, historical EV comparison
- **Time Patterns** — draws by hour/day, hottest numbers per hour window, weekly volume trend
- **Draw History** — paginated full history with filters (date range, number appeared, bonus value)
- **Data Ingestion** — one-time backfill, manual sync, DB stats, clear DB

---

## Prerequisites

- Node.js 18+
- A [Supabase](https://supabase.com) project (free tier is fine)
- A [Vercel](https://vercel.com) account for deployment
- A free [cron-job.org](https://cron-job.org) account — this app does **not** use Vercel's built-in cron; both the 4-minute poll and the 60-minute sync are scheduled externally so they aren't capped by Vercel Hobby plan's daily-cron limit

---

## Setup

### 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) and create a new project.
2. Note your **Project URL** and **anon/public key** from Settings → API.
3. Also copy the **service_role key** (keep this secret — server-side only).

### 2. Run the database migrations

In the Supabase SQL Editor, run the contents of `supabase/migrations/001_schema.sql`, then `supabase/migrations/002_evolution.sql`, in that order.

`001_schema.sql` creates:
- `games` — historical draw data (game_num, date, hits, bonus, super_bonus)
- `sync_log` — record of every sync run
- `saved_picks` — your saved pick sets

`002_evolution.sql` creates the evolution engine schema:
- `strategies` — genetic-algorithm genomes (one row per strategy per generation)
- `strategy_results` — backtest fitness results per strategy per evaluation run
- `evolution_state` — single-row table tracking the current generation and last run
- `pending_predictions` — picks committed before a draw, awaiting the real result
- `live_results` — scored shadow-play outcomes once a draw lands
- `system_events` — event log that powers the Live Monitor page
- adds `strategy_id` / `result_pnl` columns to `saved_picks`
- enables Supabase Realtime (`postgres_changes`) on `games`, `system_events`, `live_results`, `strategies`, and `strategy_results` — required for the Live Monitor and Strategy Lab pages to update without polling

### 3. Configure environment variables

Copy `.env.local.example` to `.env.local` and fill in your values:

```bash
cp .env.local.example .env.local
```

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
CRON_SECRET=<generate with: openssl rand -hex 32>
```

### 4. Install dependencies and run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### 5. Run the initial backfill

1. Navigate to **Data Ingestion** in the sidebar.
2. Click **Start Backfill**.
3. The app fetches 100-game batches from the MD Lottery API in your browser until 5,000 games are stored. Takes about 2–3 minutes. You can watch progress in the live activity log.

---

## Deployment to Vercel

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "init ke-know"
git remote add origin https://github.com/YOUR_USER/ke-know.git
git push -u origin main
```

### 2. Import to Vercel

1. Go to [vercel.com](https://vercel.com/new) and import your repo.
2. Add the environment variables from `.env.local` in the Vercel dashboard under **Settings → Environment Variables**. Also add:

```
NEXT_PUBLIC_SITE_URL=https://your-app.vercel.app
```

(This lets the manual-sync route call `/api/sync` server-side with the correct base URL.)

### 3. Set up cron-job.org

Scheduling is handled entirely by [cron-job.org](https://cron-job.org) (free), not Vercel's built-in cron — `vercel.json` intentionally has no `crons` entry. Create two jobs:

**Job 1 — Poll (every 4 minutes)**
```
POST https://your-app.vercel.app/api/poll
Header: Authorization: Bearer YOUR_CRON_SECRET
```
Checks for a new draw, scores any `pending_predictions` for it into `live_results`, updates strategies' real-world P&L, and commits the next round of predictions. Always returns HTTP 200 (errors are logged to `system_events` instead of surfaced as a 5xx) so cron-job.org never retries aggressively.

**Job 2 — Sync (every 60 minutes)**
```
POST https://your-app.vercel.app/api/sync
Header: Authorization: Bearer YOUR_CRON_SECRET
```
Runs the batched backfill/catch-up sync against the MD Lottery API, then triggers one generation of the evolution engine (`runEvolution()` in `lib/evolution/evolve.ts`) — scoring the current population, breeding/mutating the next generation, and promoting new champions where the fitness formula calls for it.

Both routes check the `Authorization: Bearer` header against `CRON_SECRET` before doing any work.

### 4. Manual sync

The **Sync Now** button in the sidebar calls `POST /api/sync-manual`, which proxies to `/api/sync` server-side so `CRON_SECRET` is never exposed to the browser.

---

## Data Source

MD Lottery public API (no authentication required, CORS-open):

```
GET https://api.prod.gkvmdl.mindgrb.io/v1/api/games/keno?limit=100&start={gameNum}
```

- `start` = game number to begin from (fetches that game and backward)
- Omit `start` to get the latest game
- Max 100 per call; the backfill adds a 150ms delay between batches

---

## Architecture Notes

- **Browser Supabase client** (`lib/supabase.ts`) — uses the anon key; safe for all client-side reads and the backfill inserts
- **Server Supabase client** (`lib/supabase-server.ts`) — uses the service role key; only used in `/api/sync` and `/api/poll`
- **`/api/sync`** — protected with `CRON_SECRET`; called by cron-job.org every 60 minutes and by `/api/sync-manual`. Backfills new games, then runs one evolution generation.
- **`/api/poll`** — protected with `CRON_SECRET`; called by cron-job.org every 4 minutes. Checks for a new draw, scores pending predictions, commits the next round. Always returns HTTP 200.
- **`/api/sync-manual`** — public (no auth needed from browser); calls `/api/sync` internally with the secret
- All upserts use `onConflict: 'game_num', ignoreDuplicates: true` — fully idempotent

## Evolution Engine

`lib/evolution/` implements a genetic algorithm that evolves Keno number-picking strategies over time, independently per spot count (1–10):

- **Genome** (`genome.ts`) — a `StrategyGenome` is a set of weights (lookback window, recency-gap threshold/weight, frequency vs. gap balance, etc.) that deterministically produces a set of picks from recent draw history.
- **Fitness** (`fitness.ts`) — an in-memory TypeScript simulation (using typed arrays for speed) backtests a genome against a train/test split of real game history and combines test P&L/game, live shadow-play P&L/game, win rate, and consistency into a single fitness score.
- **Evolution loop** (`evolve.ts`) — each hourly `/api/sync` run advances the population by one generation: scores the current population, keeps the top 10 survivors per spot count, breeds 10 children each via mutation/crossover (mutation rate and magnitude anneal down over generations), and promotes new champions that beat the existing one.
- **Shadow play** — every generation's champions get their next-game picks committed to `pending_predictions` before the draw happens; `/api/poll` scores them into `live_results` once the real numbers are known. This is real-world validation, not just backtesting.

Read the **Strategy Lab** page to see current generation, leaderboards, and genome details; read the **Live Monitor** page to watch the poll/sync crons and evolution pulse in real time.

---

## Keno Rules & EV Math

EV per $1 wager is computed from the official Maryland prize table using the hypergeometric distribution:

```
P(catch k | n spots, 20 drawn from 80) = C(n,k) × C(80−n, 20−k) / C(80, 20)
EV = Σ P(catch k) × prize(k)
```

Bonus/Super Bonus EV uses actual DB multiplier frequencies when enough data is available, falling back to theoretical distributions otherwise. The Spot Advisor shows all math transparently.

---

## License

Personal use only.
