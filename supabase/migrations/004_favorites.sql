-- Favorites table for My Favorites page
create table if not exists favorites (
  id serial primary key,
  created_at timestamptz default now(),
  name text not null,
  spot_count integer not null,
  numbers integer[] not null,
  bonus_type text default 'none',
  draws integer default 1,
  wager_amount numeric default 1
);

grant select, insert, update, delete on favorites to anon;
grant usage, select on sequence favorites_id_seq to anon;
