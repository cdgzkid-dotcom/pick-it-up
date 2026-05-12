-- Pinnacle as a second market source (complementing DK + ESPN BPI).
--
-- Why now: 2026-05-12 backtest revealed 5/5 historical NHL picks were
-- structurally blocked by Auditoría 2 v2's market_sources_count_below_2
-- check, because ESPN BPI returns HTTP 400 for NHL. Pinnacle covers NHL
-- and gives us a second source so the gate can actually evaluate hockey.
--
-- Design (from approved inventory):
--   * Pinnacle COMPLEMENTS DK + BPI; never replaces them.
--   * avg_implied_prob still uses simple average (no weighted change) to
--     avoid recalibrating the gate's tier thresholds.
--   * edge_vs_pinnacle is a SEPARATE field so Auditoría 2 v2 can add a
--     new critical check (#12: lock_edge_vs_pinnacle_below_2pct) without
--     coupling to the existing edge_vs_market logic.
--
-- Cache table: 10-min TTL keyed by espn_event_id. Sport/home/away columns
-- included for debug visibility in /tracker and post-mortems.

alter table picks add column if not exists pinnacle_implied numeric;
alter table picks add column if not exists pinnacle_status text;
alter table picks add column if not exists edge_vs_pinnacle numeric;

create table if not exists pinnacle_cache (
  espn_event_id text primary key,
  pinnacle_matchup_id bigint,
  sport text,
  home_team text,
  away_team text,
  home_implied numeric,
  away_implied numeric,
  fetched_at timestamptz default now(),
  ttl_seconds integer default 600
);

create index if not exists idx_pinnacle_cache_fetched
  on pinnacle_cache (fetched_at desc);
