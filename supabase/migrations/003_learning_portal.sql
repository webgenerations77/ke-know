-- Learning Center: auto-play simulation sessions
create table if not exists simulator_sessions (
  id serial primary key,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  status text check (status in ('running', 'paused', 'complete')) default 'running',
  spot_count integer not null,
  strategy text not null default 'balanced',
  wager integer not null default 1,
  bonus_type text not null default 'none',
  budget integer not null,
  games_target integer not null,
  games_played integer not null default 0,
  total_wagered integer not null default 0,
  total_won integer not null default 0,
  wins integer not null default 0,
  losses integer not null default 0,
  picks integer[] not null default '{}',
  starting_game_num integer,
  notes text
);

-- Prediction Portal: user's regular plays to track
create table if not exists my_plays (
  id serial primary key,
  created_at timestamptz default now(),
  name text not null,
  numbers integer[] not null,
  spot_count integer not null,
  wager integer not null default 1,
  wager_type text not null default 'classic',
  bonus_type text not null default 'none',
  active boolean not null default true,
  notes text
);

-- Grants for anon (single-user app, no RLS)
grant select, insert, update, delete on simulator_sessions to anon;
grant select, insert, update, delete on my_plays to anon;
grant usage, select on sequence simulator_sessions_id_seq to anon;
grant usage, select on sequence my_plays_id_seq to anon;
