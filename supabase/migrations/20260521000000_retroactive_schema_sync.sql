-- Retroactive schema sync: these columns exist in production but were never
-- captured in a local migration.  The stored procedures place_bet_atomic and
-- resolve_bet_atomic already reference them.
--
-- Using ADD COLUMN IF NOT EXISTS so this migration is idempotent.

alter table bets add column if not exists odds_at_bet   numeric;
alter table bets add column if not exists final_score   text;
alter table bets add column if not exists odds_at_close numeric;
alter table bets add column if not exists clv           numeric;
