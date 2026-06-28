-- Migration 011: Dedicated Daily Pick Play tracking
-- Arthur's daily-pick window play is now tracked in its own table, fully
-- decoupled from the champion's continuous shadow play in live_results.
-- This lets the daily pick enforce a hard per-day game cap (recommended_games)
-- and report an accurate W-L/P&L without being contaminated by the champion's
-- normal evolution play, which must stay unbounded for fitness scoring.

create table if not exists daily_pick_plays (
  id               bigserial primary key,
  pick_date        date    not null,
  game_num         int     not null,
  spot_count       int     not null,
  picks            int[]   not null,
  bonus_type       text    not null default 'none',
  base_wager       numeric not null default 1,
  wager_per_game   numeric not null default 1,
  matches          int,
  prize            numeric,
  pnl              numeric,
  bonus_multiplier numeric default 1,
  scored           boolean default false,
  created_at       timestamptz default now(),
  scored_at        timestamptz
);

-- One play per game per day. Lets poll commit the next game's play idempotently
-- (upsert ignoreDuplicates) without double-counting toward the daily cap.
create unique index if not exists daily_pick_plays_date_game_uniq
  on daily_pick_plays (pick_date, game_num);

create index if not exists daily_pick_plays_date_idx
  on daily_pick_plays (pick_date);

grant select, insert, update, delete on daily_pick_plays to anon;
grant usage, select on sequence daily_pick_plays_id_seq to anon;
