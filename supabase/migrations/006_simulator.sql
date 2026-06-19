-- Remove duplicate (strategy_id, game_num) rows, keeping only the newest.
DELETE FROM live_results a
USING live_results b
WHERE a.strategy_id = b.strategy_id
  AND a.game_num = b.game_num
  AND a.id < b.id;

-- Now safe to create the unique index.
CREATE UNIQUE INDEX IF NOT EXISTS live_results_strategy_game_uniq
  ON live_results (strategy_id, game_num);
