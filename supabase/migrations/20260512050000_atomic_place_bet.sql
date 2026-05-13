-- Atomic bet placement (path A: POST /api/bets).
-- Before this migration, INSERT bets / UPDATE settings / INSERT bankroll_log
-- were 3 separate calls. Any failure between them left the DB inconsistent
-- (historic evidence: two -$20 jumps in bankroll_log.balance_after without
-- matching entries, fixed by hand via compensating deposits).
--
-- Wrapping in PL/pgSQL makes the whole block atomic via PostgreSQL's
-- implicit transaction: any RAISE EXCEPTION rolls back every prior change.
-- SECURITY DEFINER lets the service_role caller invoke without extra grants.

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
begin
  if p_pick_id is not null then
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
