-- Migration 008: Fresh Start for Arthur
-- Clears all evolution-generated data so Arthur starts from scratch.
-- Keeps the games table (raw lottery draws) intact.

-- 1. Clear live results (Arthur's shadow plays and replays)
TRUNCATE TABLE live_results;

-- 2. Clear all predictions
TRUNCATE TABLE pending_predictions;

-- 3. Clear strategy results (evaluation history)
TRUNCATE TABLE strategy_results;

-- 4. Delete all strategies
DELETE FROM strategies;

-- 5. Clear the archive table from migration 007
DELETE FROM strategies_archive;

-- 6. Clear daily picks
TRUNCATE TABLE daily_picks;

-- 7. Clear activity log
TRUNCATE TABLE system_events;

-- 8. Reset evolution state to generation 0
UPDATE evolution_state
SET current_generation = 0,
    last_run_at = NULL,
    last_run_duration_ms = NULL,
    total_strategies_ever = 0,
    notes = 'Fresh start - all data cleared'
WHERE id = 1;

-- 9. Log the fresh start
INSERT INTO system_events (event_type, severity, message, metadata)
VALUES (
  'fresh_start',
  'info',
  'Arthur fresh start: all evolution data cleared. Ready for first evolution run.',
  '{"reason": "fresh_start_v1"}'::jsonb
);
