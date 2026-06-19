-- Prevent duplicate scoring when the replay engine re-scores a champion
-- strategy against a game it has already been scored on (via shadow play
-- or a previous replay run).
CREATE UNIQUE INDEX IF NOT EXISTS live_results_strategy_game_uniq
  ON live_results (strategy_id, game_num);
