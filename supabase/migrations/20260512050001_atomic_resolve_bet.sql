-- Atomic, idempotent bet resolution. Used by:
--   * manual PATCH /api/bets/:id (path B)
--   * legacy POST /api/check-results (path C)
--   * cron analyze runResultsCheck (path D — the main user path)
--
-- Idempotency is the critical guarantee here: when two paths race on the
-- same bet (e.g. cron + manual click), only the first should credit the
-- bankroll. The OLD non-atomic code could double-credit because each
-- caller did UPDATE bets + UPDATE settings + INSERT bankroll_log without
-- locking or any "is it already resolved" check.
--
-- Returns {ok, skipped:true, reason:'already_resolved', old_result} when
-- the bet has been resolved before. Caller can log + ignore.

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
