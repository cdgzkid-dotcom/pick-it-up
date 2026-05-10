-- pick-it-up schema
-- Note: this DB is shared with other apps (Hunter Robotics tables, etc.).
-- All tables created here use IF NOT EXISTS and have the pick-it-up domain
-- (picks/bets/bankroll_log/settings). RLS is intentionally OFF since all
-- access goes through Next.js API routes using the service_role key.

create extension if not exists "pgcrypto";

create table if not exists picks (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  sport text not null,
  game text not null,
  league text,
  home_team text not null,
  away_team text not null,
  home_team_abbr text,
  away_team_abbr text,
  espn_event_id text,
  pick text not null,
  pick_detail text,
  bet_type text not null,
  odds_decimal numeric not null,
  best_odds numeric,
  best_odds_source text,
  odds_comparison jsonb,
  confidence int,
  tier text,
  real_probability numeric,
  implied_probability numeric,
  edge numeric,
  recommended_amount numeric,
  analysis text,
  risk_factors text,
  injuries text,
  key_stats jsonb,
  early_payout_eligible boolean not null default false,
  early_payout_threshold text,
  line_movement_note text,
  regression_flags text,
  status text not null default 'pending',
  is_parlay boolean not null default false,
  parlay_legs jsonb,
  game_start_time timestamptz,
  picks_generated_at timestamptz,
  telegram_notified_at timestamptz
);

create index if not exists picks_created_at_idx on picks(created_at desc);
create index if not exists picks_status_idx on picks(status);
create index if not exists picks_sport_idx on picks(sport);
create index if not exists picks_game_start_time_idx on picks(game_start_time);
create index if not exists picks_espn_event_id_idx on picks(espn_event_id);

create table if not exists bets (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  pick_id uuid references picks(id) on delete set null,
  sport text not null,
  game text not null,
  home_team text,
  away_team text,
  home_team_abbr text,
  away_team_abbr text,
  espn_event_id text,
  pick text not null,
  bet_type text not null,
  odds_decimal numeric not null,
  amount numeric not null,
  tier text,
  result text not null default 'pending',
  cashout_amount numeric,
  payout numeric,
  date text,
  notes text,
  result_notified_at timestamptz
);

create index if not exists bets_result_idx on bets(result);
create index if not exists bets_created_at_idx on bets(created_at desc);
create index if not exists bets_pick_id_idx on bets(pick_id);
create index if not exists bets_espn_event_id_idx on bets(espn_event_id);

create table if not exists bankroll_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  type text not null,
  amount numeric not null,
  balance_after numeric not null,
  note text
);

create index if not exists bankroll_log_created_at_idx on bankroll_log(created_at desc);

create table if not exists settings (
  id int primary key default 1,
  bankroll_current numeric not null default 300,
  unit_percentage numeric not null default 5,
  auto_sports text[] not null default array['NBA','MLB','NHL','Liga MX','Premier League']::text[],
  auto_enabled boolean not null default true,
  constraint settings_singleton check (id = 1)
);

insert into settings (id, bankroll_current, unit_percentage)
values (1, 300, 5)
on conflict (id) do nothing;

-- Disable RLS explicitly so service_role server routes work freely.
alter table picks disable row level security;
alter table bets disable row level security;
alter table bankroll_log disable row level security;
alter table settings disable row level security;
