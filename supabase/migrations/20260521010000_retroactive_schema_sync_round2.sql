-- Retroactive schema sync round 2: these columns exist in production but were
-- never captured in a local migration.
--
-- Using ADD COLUMN IF NOT EXISTS so this migration is idempotent.

alter table bets add column if not exists bet_direction text;
alter table bets add column if not exists spread_line   numeric;
alter table bets add column if not exists total_line    numeric;
