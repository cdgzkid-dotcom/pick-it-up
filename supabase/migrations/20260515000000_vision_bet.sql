-- Vision bet registration: Draftea screenshot extraction
-- Adds draftea_ticket_id to bets and creates ai_usage_log table.

-- draftea_ticket_id for dedup (user can't scan same ticket twice)
alter table bets add column if not exists draftea_ticket_id text;
create index if not exists bets_draftea_ticket_id_idx
  on bets(draftea_ticket_id) where draftea_ticket_id is not null;

-- game_start_time was added in a previous migration; belt-and-suspenders guard.
alter table bets add column if not exists game_start_time timestamptz;

-- AI usage log for cost tracking per extraction
create table if not exists ai_usage_log (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  task_type       text not null,         -- 'vision_extract_bet', 'pick_gen', etc.
  model           text not null,
  tokens_in       int,
  tokens_out      int,
  cost_usd        numeric(10,6),
  success         boolean not null default true,
  confidence_level text,                 -- 'HIGH'/'MEDIUM'/'LOW' from Claude
  metadata        jsonb                  -- extra context (bet_type, legs_count, …)
);

create index if not exists ai_usage_log_created_at_idx on ai_usage_log(created_at desc);
create index if not exists ai_usage_log_task_type_idx  on ai_usage_log(task_type);
alter table ai_usage_log disable row level security;
