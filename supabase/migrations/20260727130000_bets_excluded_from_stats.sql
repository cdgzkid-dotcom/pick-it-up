-- Structural exclusion flag for bets that are NOT model output.
--
-- Context (2026-07-27): 11 bets were backfilled from Draftea screenshots to
-- reconcile the bankroll. They are real money and MUST count toward bankroll,
-- but they never came out of the pick pipeline, so counting them as model
-- performance is wrong. They were marked with notes = 'manual_backfill_27jul...'
-- and NOTHING read that marker: every aggregation kept including them, showing
-- 44W-35L / +19.0% ROI when the system's actual record was 35W-33L / -5.0%.
--
-- The marker was decorative. A substring match on a free-text column is a
-- fragile protection that invites exactly that failure, so the exclusion
-- becomes a real column that aggregations filter on explicitly.
--
-- Semantics: excluded_from_stats = true means "this bet is real money that
-- belongs in the bankroll, but it is not evidence about the model."
-- Bankroll reconstruction MUST keep counting these rows.

alter table bets
  add column if not exists excluded_from_stats boolean not null default false;

-- One-time migration of the existing text marker to the structural flag. After
-- this runs, the column is the source of truth and notes is documentation only.
update bets
   set excluded_from_stats = true
 where notes like '%manual_backfill_27jul%'
   and excluded_from_stats = false;

-- Partial index: aggregations filter on `excluded_from_stats = false`, which is
-- the overwhelming majority, so index the rare true side for the audit queries
-- that ask "which bets are excluded and why".
create index if not exists bets_excluded_from_stats_idx
  on bets(excluded_from_stats) where excluded_from_stats = true;

comment on column bets.excluded_from_stats is
  'True when the bet is real money but not model output (manual/backfilled). Counts toward bankroll, excluded from every performance and calibration metric.';
