-- Auto-learning system: pick_factors, factor_performance, system_weights.
-- All tables are additive (IF NOT EXISTS) and do not modify existing schema.

create table if not exists pick_factors (
  id uuid primary key default gen_random_uuid(),
  pick_id uuid references picks(id),
  bet_id uuid references bets(id),
  sport text,
  factors jsonb not null,
  result text,
  profit numeric,
  created_at timestamptz default now()
);

create table if not exists factor_performance (
  id uuid primary key default gen_random_uuid(),
  factor_name text not null,
  factor_value text,
  sport text,
  total_picks int default 0,
  wins int default 0,
  losses int default 0,
  total_profit numeric default 0,
  avg_edge numeric default 0,
  win_rate numeric default 0,
  last_updated timestamptz default now(),
  unique (factor_name, factor_value, sport)
);

create table if not exists system_weights (
  id uuid primary key default gen_random_uuid(),
  sport text not null,
  factor_name text not null,
  weight numeric not null default 1.0,
  sample_size int default 0,
  last_calibrated timestamptz default now(),
  unique (sport, factor_name)
);

create index if not exists pick_factors_pick_id_idx on pick_factors(pick_id);
create index if not exists pick_factors_bet_id_idx on pick_factors(bet_id);
create index if not exists factor_perf_sport_idx on factor_performance(sport);
create index if not exists system_weights_sport_idx on system_weights(sport);
