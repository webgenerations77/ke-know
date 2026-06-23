-- Migration 007: Genetic Algorithm Overhaul
-- Adds source tracking to live_results, new fitness columns to strategy_results,
-- archives old strategies, and resets evolution to generation 0.

-- 1. Add source column to live_results to distinguish pre-committed predictions
--    from retroactive replays. Fitness function only trusts 'prediction' source.
ALTER TABLE live_results
  ADD COLUMN IF NOT EXISTS source text DEFAULT 'replay';

-- Backfill: mark existing results from pending_predictions as 'prediction'
UPDATE live_results lr
SET source = 'prediction'
WHERE EXISTS (
  SELECT 1 FROM pending_predictions pp
  WHERE pp.strategy_id = lr.strategy_id
    AND pp.predicted_for_game_num = lr.game_num
    AND pp.scored = true
);

CREATE INDEX IF NOT EXISTS live_results_source_idx ON live_results (source);

-- 2. Add new fitness columns to strategy_results for the overhauled algorithm
ALTER TABLE strategy_results
  ADD COLUMN IF NOT EXISTS oos_ppg numeric,
  ADD COLUMN IF NOT EXISTS overfit_gap numeric,
  ADD COLUMN IF NOT EXISTS diversity_bonus numeric,
  ADD COLUMN IF NOT EXISTS live_trust_factor numeric;

-- 3. Archive current strategies before reset
CREATE TABLE IF NOT EXISTS strategies_archive (
  LIKE strategies INCLUDING ALL
);

INSERT INTO strategies_archive
SELECT * FROM strategies
WHERE status IN ('active', 'promoted', 'retired');

-- 4. Log the reset
INSERT INTO system_events (event_type, severity, message, metadata)
VALUES (
  'algorithm_reset',
  'warning',
  'Algorithm overhaul: archived all strategies, resetting to generation 0. New genome (12 genes), 3-fold CV fitness, trust-scaled live PPG, diversity bonus.',
  '{"reason": "algorithm_overhaul_v2", "archived_count": 0}'::jsonb
);

-- Update archived count in the event metadata
UPDATE system_events
SET metadata = jsonb_set(
  metadata,
  '{archived_count}',
  (SELECT COUNT(*)::text::jsonb FROM strategies_archive)
)
WHERE event_type = 'algorithm_reset'
  AND metadata->>'reason' = 'algorithm_overhaul_v2';

-- 5. Retire all current strategies (don't delete — keep for reference)
UPDATE strategies SET status = 'retired' WHERE status IN ('active', 'promoted');

-- 6. Reset evolution state to generation 0 so the next sync seeds fresh
UPDATE evolution_state SET current_generation = 0, notes = 'Reset for algorithm overhaul v2' WHERE id = 1;

-- 7. Clear pending predictions (they reference old strategy IDs)
DELETE FROM pending_predictions WHERE scored = false;
