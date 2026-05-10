-- Migration: add spread/total columns to bets for auto-resolve
-- Run once against your Supabase project.

ALTER TABLE bets ADD COLUMN IF NOT EXISTS spread_line numeric;
ALTER TABLE bets ADD COLUMN IF NOT EXISTS total_line numeric;
ALTER TABLE bets ADD COLUMN IF NOT EXISTS bet_direction text;
