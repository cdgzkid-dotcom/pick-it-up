-- Add bankroll_initial to settings so the stats chart can show the
-- correct starting point ($300) independent of bankroll_log history.
alter table settings
  add column if not exists bankroll_initial numeric not null default 300;

-- Seed the existing row with the confirmed real initial deposit.
update settings set bankroll_initial = 300 where id = 1;
