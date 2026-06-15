-- Migration 002: Remove unreliable ingestion-time-derived fields
-- draw_time and draw_hour were derived from ingestedOn (API ingestion timestamp),
-- not the actual draw time, making them misleading for pattern analysis.
-- draw_dow is now re-derived from draw_date (the actual draw date).

alter table games drop column if exists draw_time;
alter table games drop column if exists draw_hour;
drop index if exists games_draw_hour_idx;

-- Re-compute draw_dow from draw_date for all existing rows
update games
set draw_dow = extract(dow from draw_date::date)
where draw_date is not null;
