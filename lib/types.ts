export type Tier = 'lock' | 'strong' | 'value' | 'parlay';
export type BetType = 'ML' | 'Spread' | 'O-U' | 'Prop' | 'Parlay';
export type BetResult = 'pending' | 'win' | 'loss' | 'push' | 'cashout' | 'early_payout';
export type PickStatus =
  | 'pending'
  | 'bet'
  | 'skipped'
  | 'analyzed_no_edge'
  | 'analyzed_no_odds_data'
  | 'superseded_edge_evaporated'
  | 'superseded_flipped_side'
  | 'superseded_line_moved_against'
  | 'superseded_legacy';

export interface KeyStat {
  label: string;
  value: string;
  flag?: 'green' | 'yellow' | 'red' | null;
}

export interface Pick {
  id: string;
  created_at: string;
  updated_at?: string;
  line_movement_note?: string | null;
  regression_flags?: string | null;
  trap_warning?: string | null;
  sport: string;
  game: string;
  league?: string | null;
  home_team: string;
  away_team: string;
  home_team_abbr?: string | null;
  away_team_abbr?: string | null;
  espn_event_id?: string | null;
  pick: string;
  pick_detail?: string | null;
  bet_type: BetType | string;
  odds_decimal: number;
  best_odds?: number | null;
  best_odds_source?: string | null;
  odds_comparison?: Record<string, number> | null;
  confidence?: number | null;
  tier?: Tier | null;
  real_probability?: number | null;
  implied_probability?: number | null;
  edge?: number | null;
  edge_vs_market?: number | null;
  market_consensus_implied?: number | null;
  market_sources_count?: number | null;
  market_sources?: string[] | null;
  floor_applied?: 'lock' | 'strong' | 'none' | null;
  confidence_raw?: number | null;
  recommended_amount?: number | null;
  analysis?: string | null;
  risk_factors?: string | null;
  injuries?: string | null;
  key_stats?: KeyStat[] | Record<string, unknown> | null;
  early_payout_eligible: boolean;
  early_payout_threshold?: string | null;
  status: PickStatus;
  is_parlay: boolean;
  parlay_legs?: unknown[] | null;
  game_start_time?: string | null;
  picks_generated_at?: string | null;
  telegram_notified_at?: string | null;
  // CAPA-2 lock-in: first run that produced a positive-edge pick freezes
  // the side + real_probability. Subsequent runs only refresh odds/edge for
  // the same side. See lib/pickGen.ts applyLockIn().
  locked_at?: string | null;
  original_real_probability?: number | null;
  original_odds?: number | null;
  reanalysis_count?: number | null;
  lock_reason?: string | null;
}

export interface Bet {
  id: string;
  created_at: string;
  pick_id?: string | null;
  sport: string;
  game: string;
  odds_at_bet?: number | null;
  odds_at_close?: number | null;
  clv?: number | null;
  spread_line?: number | null;
  total_line?: number | null;
  bet_direction?: 'over' | 'under' | string | null;
  final_score?: string | null;
  home_team?: string | null;
  away_team?: string | null;
  home_team_abbr?: string | null;
  away_team_abbr?: string | null;
  espn_event_id?: string | null;
  game_start_time?: string | null;
  pick: string;
  bet_type: string;
  odds_decimal: number;
  amount: number;
  tier?: Tier | null;
  result: BetResult;
  cashout_amount?: number | null;
  payout?: number | null;
  date?: string | null;
  notes?: string | null;
}

export interface BankrollLog {
  id: string;
  created_at: string;
  type: 'deposit' | 'withdraw' | 'win' | 'loss' | 'push' | 'cashout' | 'early_payout' | 'stake';
  amount: number;
  balance_after: number;
  note?: string | null;
}

export interface Settings {
  id: 1;
  bankroll_current: number;
  unit_percentage: number;
  auto_sports?: string[];
  auto_enabled?: boolean;
}

export interface Game {
  sport: string;
  league?: string;
  home_team: string;
  away_team: string;
  home_team_abbr?: string;
  away_team_abbr?: string;
  espn_event_id?: string;
  game_label: string;
  start_time?: string;
  odds: {
    moneyline?: { home: number; away: number; draw?: number };
    spread?: { home_line: number; home_odds: number; away_line: number; away_odds: number };
    total?: { line: number; over: number; under: number };
  };
  odds_comparison?: Record<string, Record<string, number>>;
  notable_stats?: Record<string, unknown>;
  injuries?: Array<{ player: string; position?: string; status: string; detail?: string }>;
  /**
   * Real-time stats pulled from sport-specific APIs (MLB Stats, NHL API, NBA
   * stats) before sending to Claude. Free-form per sport — Claude reads the
   * structure as JSON in the prompt.
   */
  real_data?: Record<string, unknown>;
  multi_odds?: Array<{
    source: string;
    home_ml?: number;
    away_ml?: number;
    spread?: unknown;
    total?: unknown;
  }>;
}
