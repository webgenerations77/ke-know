-- Fitness-over-generations chart source.
--
-- The Simulator chart previously read strategy_results with
--   .order('generation', asc).limit(2000)
-- but PostgREST caps responses at 1000 rows, so with ~300+ result rows per
-- generation the chart only ever received generations 1–2 (the earliest rows).
-- Generation 19 alone accumulated ~40k rows during an evolution stall, which
-- would also swamp any naive descending fetch.
--
-- This function collapses the table to one row per (generation, spot_count)
-- holding that group's best fitness — at most ~ (#generations × 10) rows — so
-- the client gets every generation regardless of how many raw rows exist.

create or replace function fitness_by_generation()
returns table (
  generation  integer,
  spot_count  integer,
  fitness_score double precision
)
language sql
stable
as $$
  select
    generation,
    spot_count,
    max(fitness_score) as fitness_score
  from strategy_results
  where generation is not null
  group by generation, spot_count
  order by generation, spot_count;
$$;

-- Browser client uses the anon role (no RLS in this project).
grant execute on function fitness_by_generation() to anon;
grant execute on function fitness_by_generation() to service_role;
