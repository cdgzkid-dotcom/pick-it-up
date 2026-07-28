-- Kill switch: settings.system_enabled cuts EVERY write path.
--
-- Why: auto_enabled=false only early-returns runAnalyzeWindow()
-- (app/api/cron/analyze/route.ts:146). runResultsCheck() and
-- cleanupOrphanedPicks() never consult it, and 14 API routes write with no
-- auth at all — so until now the system had no way to stop. Documented in
-- .fase0/DISENO-endpoints-y-kill-switch.md (approved 2026-07-28).
--
-- auto_enabled is NOT overloaded: it keeps meaning "don't generate picks
-- automatically" (bets still resolve). system_enabled=false means "the
-- system writes NOTHING": no picks, no bet resolution, no bankroll moves.
--
-- Three layers; this migration is layers 0 (flag) and 3 (RPC guards — the
-- layer no route can bypass, same pattern as the observation_only guard in
-- place_bet_atomic). Layers 1-2 (handler + route gates returning 503) ship
-- in the code deploy that follows this push. Migration FIRST, deploy AFTER.
--
-- Reversible: drop the three columns and assert_system_enabled(), and
-- re-run the three previous function definitions
-- (20260727120000 for place_bet_atomic, 20260512050001 for
-- resolve_bet_atomic, 20260512050002 for adjust_bankroll_atomic).

alter table settings add column if not exists system_enabled boolean not null default true;
alter table settings add column if not exists system_disabled_reason text;
alter table settings add column if not exists system_disabled_at timestamptz;

comment on column settings.system_enabled is
  'Kill switch. false = no write path runs: cron handlers and write routes return 503, atomic RPCs raise system_disabled. Distinct from auto_enabled (which only stops pick generation).';

-- Shared guard. Missing settings row degrades to enabled so a broken
-- singleton can never brick reads or the guard itself.
create or replace function assert_system_enabled() returns void
language plpgsql
as $$
declare
  v_enabled boolean;
begin
  select system_enabled into v_enabled from settings where id = 1;
  if v_enabled is false then
    raise exception 'system_disabled: writes are disabled (see settings.system_disabled_reason)'
      using errcode = '22023';
  end if;
end;
$$;

-- ── place_bet_atomic: identical to 20260727120000, plus the guard ──────────

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
  perform assert_system_enabled();

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

-- ── resolve_bet_atomic: identical to 20260512050001, plus the guard ────────

create or replace function resolve_bet_atomic(
  p_bet_id uuid,
  p_result text,
  p_payout numeric,
  p_credit numeric,
  p_cashout_amount numeric,
  p_final_score text,
  p_odds_at_close numeric,
  p_clv numeric,
  p_note text
) returns jsonb
language plpgsql
security definer
as $$
declare
  v_old_result text;
  v_amount numeric;
  v_current numeric;
  v_new numeric;
begin
  perform assert_system_enabled();

  select result, amount into v_old_result, v_amount
  from bets where id = p_bet_id for update;
  if v_old_result is null then
    raise exception 'bet_not_found:%', p_bet_id using errcode = 'P0002';
  end if;

  if v_old_result <> 'pending' then
    return jsonb_build_object(
      'ok', true,
      'skipped', true,
      'reason', 'already_resolved',
      'old_result', v_old_result
    );
  end if;

  update bets set
    result = p_result,
    payout = p_payout,
    cashout_amount = case when p_result = 'cashout' then p_cashout_amount else null end,
    final_score = coalesce(p_final_score, final_score),
    odds_at_close = coalesce(p_odds_at_close, odds_at_close),
    clv = coalesce(p_clv, clv),
    result_notified_at = null
  where id = p_bet_id;

  if p_credit <> 0 then
    select bankroll_current into v_current from settings where id = 1 for update;
    v_new := v_current + p_credit;
    update settings set bankroll_current = v_new where id = 1;
  else
    select bankroll_current into v_new from settings where id = 1;
  end if;

  insert into bankroll_log (type, amount, balance_after, note)
  values (p_result, p_credit, v_new, p_note);

  return jsonb_build_object(
    'ok', true,
    'skipped', false,
    'bankroll_current', v_new,
    'payout', p_payout,
    'credit', p_credit
  );
end;
$$;

-- ── adjust_bankroll_atomic: identical to 20260512050002, plus the guard ────

create or replace function adjust_bankroll_atomic(
  p_delta numeric,
  p_type text,
  p_note text
) returns jsonb
language plpgsql
security definer
as $$
declare
  v_current numeric;
  v_new numeric;
begin
  perform assert_system_enabled();

  select bankroll_current into v_current from settings where id = 1 for update;
  if v_current is null then
    raise exception 'settings_missing' using errcode = 'P0002';
  end if;

  v_new := v_current + p_delta;
  if v_new < 0 then
    raise exception 'negative_bankroll_blocked:current=%,delta=%', v_current, p_delta
      using errcode = '22023';
  end if;

  update settings set bankroll_current = v_new where id = 1;
  insert into bankroll_log (type, amount, balance_after, note)
  values (p_type, p_delta, v_new, p_note);

  return jsonb_build_object('ok', true, 'bankroll_current', v_new);
end;
$$;
