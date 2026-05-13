-- Atomic manual bankroll adjustment. Used by:
--   * PATCH /api/bankroll (path E — user edits bankroll in UI)
--   * POST /api/bankroll/recalculate (path F — sync with Draftea real)
--
-- p_delta is signed: positive = deposit/recalc-up, negative = withdraw/
-- recalc-down. p_type is the bankroll_log.type to record ('deposit',
-- 'withdraw', or any other free-form string the caller uses).

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
