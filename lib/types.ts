export type Tier = 'lock' | 'strong' | 'value' | 'parlay';
export type BetType = 'ML' | 'Spread' | 'O-U' | 'Prop' | 'Parlay';
export type BetResult = 'pending' | 'win' | 'loss' | 'cashout' | 'early_payout';
export type PickStatus = 'pending' | 'bet' | 'skipped';

export interface KeyStat {
  label: string;
  value: string;
  flag?: 'green' | 'yellow' | 'red' | null;
}

export interface Pick {
  id: string;
  created_at: string;
  updated_at?: string;
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
}

export interface Bet {
  id: string;
  created_at: string;
  pick_id?: string | null;
  sport: string;
  game: string;
  home_team?: string | null;
  away_team?: string | null;
  home_team_abbr?: string | null;
  away_team_abbr?: string | null;
  espn_event_id?: string | null;
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
  type: 'deposit' | 'withdraw' | 'win' | 'loss' | 'cashout' | 'early_payout';
  amount: number;
  balance_after: number;
  note?: string | null;
}

export interface Settings {
  id: 1;
  bankroll_current: number;
  unit_percentage: number;
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
  injuries?: string;
  notable_stats?: Record<string, unknown>;
}
