-- Migration 010: Commitment Tracking
-- Arthur locks in picks for a set number of games before regenerating.
-- Tracks current committed picks and remaining games on each strategy.

ALTER TABLE strategies
  ADD COLUMN IF NOT EXISTS current_picks integer[] DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS commitment_remaining integer DEFAULT 0;
