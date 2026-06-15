-- Maryland Keno Research App — initial schema
-- Run this in Supabase SQL editor or via supabase db push

-- Historical draw data
create table if not exists games (
  game_num integer primary key,
  draw_date date not null,
  draw_time time,
  draw_iso timestamptz,
  draw_hour smallint,
  draw_dow smallint,  -- 0=Sun through 6=Sat
  bonus integer,
  super_bonus integer,
  hits integer[] not null  -- array of 20 drawn numbers
);

create index if not exists games_draw_iso_idx on games (draw_iso);
create index if not exists games_draw_date_idx on games (draw_date);
create index if not exists games_draw_hour_idx on games (draw_hour);

-- Sync history
create table if not exists sync_log (
  id serial primary key,
  synced_at timestamptz default now(),
  games_added integer default 0,
  source text check (source in ('backfill', 'auto', 'manual')),
  latest_game_num integer,
  notes text
);

-- Saved picks
create table if not exists saved_picks (
  id serial primary key,
  saved_at timestamptz default now(),
  label text,
  spot_count integer not null,
  strategy text not null,
  numbers integer[] not null,
  wager integer,
  wager_type text default 'classic',
  bonus_type text default 'none',
  notes text,
  score_snapshot jsonb,
  result_game_num integer,
  result_matches integer
);

-- Grant anon role read/write access (single-user app, no RLS needed)
grant select, insert, update, delete on games to anon;
grant select, insert, update, delete on sync_log to anon;
grant select, insert, update, delete on saved_picks to anon;
grant usage, select on sequence saved_picks_id_seq to anon;
grant usage, select on sequence sync_log_id_seq to anon;
