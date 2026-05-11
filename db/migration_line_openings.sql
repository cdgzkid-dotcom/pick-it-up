-- Migration: line_openings table for RLM (reverse line movement) detection.
-- Captures opening odds the first time a game is seen, then later runs
-- compare current odds vs these openings to detect sharp action / traps.
-- Run once against your Supabase project.

CREATE TABLE IF NOT EXISTS line_openings (
  id bigserial PRIMARY KEY,
  espn_event_id text UNIQUE NOT NULL,
  sport text NOT NULL,
  game_label text,
  home_team text,
  away_team text,
  home_ml_open numeric,
  away_ml_open numeric,
  spread_line_open numeric,
  spread_home_odds_open numeric,
  total_line_open numeric,
  over_odds_open numeric,
  under_odds_open numeric,
  opened_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_line_openings_event ON line_openings (espn_event_id);
CREATE INDEX IF NOT EXISTS idx_line_openings_sport_opened ON line_openings (sport, opened_at DESC);
