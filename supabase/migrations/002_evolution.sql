-- Strategy genomes
create table strategies (
  id serial primary key,
  created_at timestamptz default now(),
  generation integer not null default 1,
  spot_count integer not null,
  parent_ids integer[],
  mutation_log jsonb,
  genome jsonb not null,
  status text not null default 'active',
  promoted_at timestamptz,
  real_world_plays integer default 0,
  real_world_pnl numeric default 0,
  constraint strategies_status_check check (status in ('active','retired','promoted'))
);
create index on strategies (spot_count, status);
create index on strategies (generation);

-- Backtest results per strategy per evaluation run
create table strategy_results (
  id serial primary key,
  strategy_id integer references strategies(id) on delete cascade,
  evaluated_at timestamptz default now(),
  generation integer not null,
  spot_count integer not null,
  games_in_training integer,
  games_in_test integer,
  training_pnl numeric,
  training_pnl_per_game numeric,
  test_pnl numeric,
  test_pnl_per_game numeric,
  win_rate numeric,
  avg_matches numeric,
  best_single_win numeric,
  max_losing_streak integer,
  fitness_score numeric,
  picks_snapshot integer[],
  wager_assumed numeric default 1
);
create index on strategy_results (strategy_id, evaluated_at desc);
create index on strategy_results (spot_count, fitness_score desc);

-- Evolution run state (single row, always id=1)
create table evolution_state (
  id integer primary key default 1,
  current_generation integer default 0,
  last_run_at timestamptz,
  last_run_duration_ms integer,
  total_strategies_ever integer default 0,
  notes text
);
insert into evolution_state (id) values (1) on conflict do nothing;

-- Pre-committed predictions (locked in before draw result is known)
create table pending_predictions (
  id serial primary key,
  created_at timestamptz default now(),
  strategy_id integer references strategies(id),
  spot_count integer not null,
  predicted_for_game_num integer not null,
  picks integer[] not null,
  scored boolean default false,
  unique (strategy_id, predicted_for_game_num)
);
create index on pending_predictions (predicted_for_game_num, scored);

-- Scored live shadow play results
create table live_results (
  id serial primary key,
  scored_at timestamptz default now(),
  strategy_id integer references strategies(id),
  game_num integer references games(game_num),
  spot_count integer not null,
  picks integer[] not null,
  actual_hits integer[] not null,
  matches integer not null,
  prize numeric not null,
  pnl numeric not null,
  is_shadow_play boolean default true
);
create index on live_results (strategy_id, scored_at desc);
create index on live_results (game_num);

-- System event log (powers Live Monitor page)
create table system_events (
  id serial primary key,
  occurred_at timestamptz default now(),
  event_type text not null,
  severity text default 'info',
  message text not null,
  metadata jsonb,
  constraint system_events_severity_check check (severity in ('info','success','warning','error'))
);
create index on system_events (occurred_at desc);
create index on system_events (event_type);

-- Add strategy_id FK and result_pnl to saved_picks
alter table saved_picks
  add column if not exists strategy_id integer references strategies(id),
  add column if not exists result_pnl numeric;

-- Enable Realtime (postgres_changes) for tables the Live Monitor / Strategy Lab
-- pages subscribe to. Idempotent — skips any table already in the publication
-- (e.g. `games`, if it was enabled manually when 001_schema.sql was set up).
do $$
declare
  t text;
begin
  foreach t in array array['games', 'system_events', 'live_results', 'strategies', 'strategy_results'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table %I', t);
    end if;
  end loop;
end $$;
