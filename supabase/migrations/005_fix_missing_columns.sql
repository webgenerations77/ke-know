-- Fix missing columns that score-predictions.ts expects but were never added
-- to the original 002_evolution.sql migration.
-- Without these, every scorePendingPredictions() call fails silently,
-- preventing live_results from accumulating and blocking champion promotions.

ALTER TABLE pending_predictions
  ADD COLUMN IF NOT EXISTS bonus_type text DEFAULT 'none';

ALTER TABLE live_results
  ADD COLUMN IF NOT EXISTS bonus_type text DEFAULT 'none';

ALTER TABLE live_results
  ADD COLUMN IF NOT EXISTS bonus_multiplier numeric DEFAULT 1;
