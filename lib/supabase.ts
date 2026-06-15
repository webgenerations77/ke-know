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
