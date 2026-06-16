import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(url, anonKey);

export interface Game {
  game_num: number;
  draw_date: string;
  draw_iso: string | null;
  draw_dow: number | null; // 0=Sun…6=Sat
  bonus: number | null;
  super_bonus: number | null;
  hits: number[];
}

export interface SyncLog {
  id: number;
  synced_at: string;
  games_added: number;
  source: 'backfill' | 'auto' | 'manual';
  latest_game_num: number | null;
  notes: string | null;
}

export interface SavedPick {
  id: number;
  saved_at: string;
  label: string | null;
  spot_count: number;
  strategy: string;
  numbers: number[];
  wager: number | null;
  wager_type: string;
  bonus_type: string;
  notes: string | null;
  score_snapshot: Record<number, number> | null;
  result_game_num: number | null;
  result_matches: number | null;
  result_pnl: number | null;
  strategy_id: number | null;
}

export interface SimulatorSession {
  id: number;
  created_at: string;
  updated_at: string;
  status: 'running' | 'paused' | 'complete';
  spot_count: number;
  strategy: string;
  wager: number;
  bonus_type: string;
  budget: number;
  games_target: number;
  games_played: number;
  total_wagered: number;
  total_won: number;
  wins: number;
  losses: number;
  picks: number[];
  starting_game_num: number | null;
  notes: string | null;
}

export interface MyPlay {
  id: number;
  created_at: string;
  name: string;
  numbers: number[];
  spot_count: number;
  wager: number;
  wager_type: string;
  bonus_type: string;
  active: boolean;
  notes: string | null;
}

export interface Strategy {
  id: number;
  created_at: string;
  generation: number;
  spot_count: number;
  parent_ids: number[] | null;
  mutation_log: { action: string; details: string[] } | null;
  genome: Record<string, unknown>;
  status: 'active' | 'retired' | 'promoted';
  promoted_at: string | null;
  real_world_plays: number;
  real_world_pnl: number;
}

export interface StrategyResult {
  id: number;
  strategy_id: number;
  evaluated_at: string;
  generation: number;
  spot_count: number;
  games_in_training: number | null;
  games_in_test: number | null;
  training_pnl: number | null;
  training_pnl_per_game: number | null;
  test_pnl: number | null;
  test_pnl_per_game: number | null;
  win_rate: number | null;
  avg_matches: number | null;
  best_single_win: number | null;
  max_losing_streak: number | null;
  fitness_score: number | null;
  picks_snapshot: number[] | null;
  wager_assumed: number;
}

export interface LiveResult {
  id: number;
  scored_at: string;
  strategy_id: number;
  game_num: number;
  spot_count: number;
  picks: number[];
  actual_hits: number[];
  matches: number;
  prize: number;
  pnl: number;
  is_shadow_play: boolean;
}

export interface PendingPrediction {
  id: number;
  created_at: string;
  strategy_id: number;
  spot_count: number;
  predicted_for_game_num: number;
  picks: number[];
  scored: boolean;
}

export interface SystemEvent {
  id: number;
  occurred_at: string;
  event_type: string;
  severity: 'info' | 'success' | 'warning' | 'error';
  message: string;
  metadata: Record<string, unknown> | null;
}

export interface EvolutionState {
  id: number;
  current_generation: number;
  last_run_at: string | null;
  last_run_duration_ms: number | null;
  total_strategies_ever: number;
  notes: string | null;
}
