-- Retroactive schema sync round 3
-- Columns game_start_time and draftea_ticket_id already exist in production
-- but were never captured in local migrations.

ALTER TABLE bets ADD COLUMN IF NOT EXISTS game_start_time timestamptz;
ALTER TABLE bets ADD COLUMN IF NOT EXISTS draftea_ticket_id text;
