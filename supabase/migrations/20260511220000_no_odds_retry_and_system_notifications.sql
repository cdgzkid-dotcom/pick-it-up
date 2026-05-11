-- Fix B: allow re-analysis of analyzed_no_odds_data markers after a cool-off.
-- Adds retry_count to picks so the dedup guard in cron/analyze can decide
-- whether to retry a marker (DK published odds late, etc.) up to N attempts.
alter table picks add column if not exists retry_count integer default 0;

-- Fix C: anti-spam ledger for system-level notifications (e.g. "slate without
-- DK odds"). Keyed by `kind` so the cron can check whether it already
-- notified the user about the same condition within a recent window before
-- sending again.
create table if not exists system_notifications (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  sent_at timestamptz default now(),
  payload jsonb
);

create index if not exists idx_system_notifications_kind_sent
  on system_notifications (kind, sent_at desc);
