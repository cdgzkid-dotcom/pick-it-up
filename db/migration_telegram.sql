-- Migration: auto-analyze cron + Telegram notifications (2026-05)
-- Run this in Supabase SQL editor. All operations are aditivas.

-- picks: track game start time, when picks were generated, and Telegram notification
alter table picks
  add column if not exists espn_event_id text,
  add column if not exists home_team_abbr text,
  add column if not exists away_team_abbr text,
  add column if not exists updated_at timestamptz,
  add column if not exists line_movement_note text,
  add column if not exists regression_flags text,
  add column if not exists game_start_time timestamptz,
  add column if not exists picks_generated_at timestamptz,
  add column if not exists telegram_notified_at timestamptz;

create index if not exists picks_game_start_time_idx on picks(game_start_time);
create index if not exists picks_espn_event_id_idx on picks(espn_event_id);

-- bets: track Telegram result notification + espn fields if missing
alter table bets
  add column if not exists espn_event_id text,
  add column if not exists home_team_abbr text,
  add column if not exists away_team_abbr text,
  add column if not exists result_notified_at timestamptz;

create index if not exists bets_espn_event_id_idx on bets(espn_event_id);

-- settings: configurable list of sports for auto-analyze + master switch
alter table settings
  add column if not exists auto_sports text[] not null default array['NBA','MLB','NHL','Liga MX','Premier League']::text[],
  add column if not exists auto_enabled boolean not null default true;
