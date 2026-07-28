-- Preseason observation mode (2026-07-27).
--
-- NFL preseason (HOF Game 6 Aug 2026; weeks 1-3, 13-29 Aug) is allowed back
-- into the pipeline, but strictly in OBSERVATION mode: those picks are
-- generated, stored and displayed, yet they must never become a bet and must
-- never contribute to calibration, tier stats, factor_performance or any other
-- aggregate.
--
-- The flag lives on `picks` (not on `bets`) on purpose: a bet derived from an
-- observation pick is exactly what this change forbids, so there is no bet row
-- to flag. Persistent + NOT NULL + DEFAULT false so every existing row and
-- every future insert has an unambiguous value — never null, never "unknown".
--
-- NOT APPLIED YET. This migration is a HARD PREREQUISITE for deploying the
-- accompanying code: lib/pickGen.ts writes `observation_only` on every pick
-- INSERT and several routes SELECT it. Ship the migration first, code second.

alter table picks
  add column if not exists observation_only boolean not null default false;

comment on column picks.observation_only is
  'True when the pick comes from an ESPN event with season.type=1 (preseason / exhibition). Such picks are display-only: place_bet_atomic refuses them and every aggregate metric excludes them.';

-- Partial index: the hot queries are "exclude observation picks" (pending
-- picks, manual-bet selector) and "show me the observation ones". A partial
-- index on the true rows stays tiny — preseason is a few weeks a year.
create index if not exists picks_observation_only_idx
  on picks (observation_only)
  where observation_only = true;

-- ── Bet placement backstop ────────────────────────────────────────────────
-- The API routes already reject observation picks before calling this RPC.
-- This is the layer that cannot be bypassed: any caller (route, script, psql,
-- future endpoint) placing a bet against an observation pick gets an explicit
-- exception instead of a silently accepted wager.
--
-- Only the observation guard is new; the rest of the body is byte-identical to
-- 20260512050000_atomic_place_bet.sql.

create or replace function place_bet_atomic(
  p_pick_id uuid,
  p_sport text,
  p_game text,
  p_home_team text,
  p_away_team text,
  p_home_team_abbr text,
  p_away_team_abbr text,
  p_espn_event_id text,
  p_pick text,
  p_bet_type text,
  p_odds_decimal numeric,
  p_amount numeric,
  p_tier text,
  p_date text,
  p_notes text,
  p_game_start_time timestamptz
) returns jsonb
language plpgsql
security definer
as $$
declare
  v_current numeric;
  v_new numeric;
  v_bet_id uuid;
  v_existing_bet_id uuid;
  v_observation_only boolean;
begin
  if p_pick_id is not null then
    -- Observation guard FIRST: fail before touching bankroll or bets.
    select observation_only into v_observation_only from picks where id = p_pick_id;
    if v_observation_only is true then
      raise exception 'observation_only_pick:%', p_pick_id using errcode = '22023';
    end if;

    select id into v_existing_bet_id from bets where pick_id = p_pick_id limit 1;
    if v_existing_bet_id is not null then
      raise exception 'duplicate_bet:%', v_existing_bet_id using errcode = '23505';
    end if;
  end if;

  select bankroll_current into v_current from settings where id = 1 for update;
  if v_current is null then
    raise exception 'settings_missing' using errcode = 'P0002';
  end if;

  v_new := v_current - p_amount;
  if v_new < 0 then
    raise exception 'insufficient_bankroll:current=%,stake=%', v_current, p_amount
      using errcode = '22023';
  end if;

  insert into bets (
    pick_id, sport, game, home_team, away_team,
    home_team_abbr, away_team_abbr, espn_event_id,
    pick, bet_type, odds_decimal, amount, tier,
    date, notes, game_start_time,
    result, odds_at_bet
  ) values (
    p_pick_id, p_sport, p_game, p_home_team, p_away_team,
    p_home_team_abbr, p_away_team_abbr, p_espn_event_id,
    p_pick, p_bet_type, p_odds_decimal, p_amount, p_tier,
    p_date, p_notes, p_game_start_time,
    'pending', p_odds_decimal
  ) returning id into v_bet_id;

  update settings set bankroll_current = v_new where id = 1;

  insert into bankroll_log (type, amount, balance_after, note)
  values ('stake', -p_amount, v_new, 'Apuesta: ' || p_pick || ' (' || p_game || ')');

  if p_pick_id is not null then
    update picks set status = 'bet' where id = p_pick_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'bet_id', v_bet_id,
    'bankroll_current', v_new
  );
end;
$$;
