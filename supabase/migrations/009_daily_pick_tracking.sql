-- Migration 009: Daily Pick Active Play Tracking
-- Arthur now plays his daily pick recommendations during the suggested window.

ALTER TABLE daily_picks
  ADD COLUMN IF NOT EXISTS games_played int DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'pending';
