import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase';
import { systemDisabledResponse } from '@/lib/systemState';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreateBetSchema = z.object({
  pick_id: z.string().uuid().optional().nullable(),
  sport: z.string(),
  game: z.string(),
  home_team: z.string().optional().nullable(),
  away_team: z.string().optional().nullable(),
  home_team_abbr: z.string().optional().nullable(),
  away_team_abbr: z.string().optional().nullable(),
  espn_event_id: z.string().optional().nullable(),
  pick: z.string(),
  bet_type: z.string(),
  odds_decimal: z.coerce.number().positive(),
  amount: z.coerce.number().positive(),
  tier: z.enum(['lock', 'strong', 'value', 'parlay']).optional().nullable(),
  date: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

export async function POST(req: Request) {
  const disabled = await systemDisabledResponse('bets');
  if (disabled) return disabled;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = CreateBetSchema.safeParse(body);
  if (!parsed.success) {
    console.error('[POST /api/bets] validation failed', JSON.stringify(parsed.error.flatten()), 'body:', JSON.stringify(body));
    return NextResponse.json(
      { error: 'Bad request', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  console.log(`[POST /api/bets] ${parsed.data.pick_id ? 'pick' : 'MANUAL'} ${parsed.data.pick} ${parsed.data.bet_type} @${parsed.data.odds_decimal} $${parsed.data.amount} (${parsed.data.sport})`);

  const supabase = supabaseAdmin();
  const { pick_id, ...fields } = parsed.data;

  // If the pick has an espn_event_id / game_start_time, copy to the bet.
  // The duplicate-bet check used to live here; now it's inside the RPC
  // (raises 'duplicate_bet:<existing_id>' with errcode 23505).
  let espn_event_id = fields.espn_event_id ?? null;
  let game_start_time: string | null = null;
  if (pick_id) {
    const { data: pickRow, error: pickErr } = await supabase
      .from('picks')
      .select('espn_event_id, game_start_time, observation_only')
      .eq('id', pick_id)
      .maybeSingle();

    // A read ERROR (not "no row") must stop here, BEFORE the bankroll is
    // debited: otherwise the bet lands without espn_event_id/game_start_time
    // and the observation_only guard is silently skipped. A missing row
    // (pick_id not found) keeps the previous behaviour: proceed with nulls
    // and let place_bet_atomic decide.
    if (pickErr) {
      console.error('[POST /api/bets] pick lookup failed', pick_id, pickErr);
      return NextResponse.json(
        { error: 'No se pudo leer el pick asociado', detail: pickErr.message },
        { status: 500 },
      );
    }

    // Preseason observation picks are NOT bettable. Reject loudly here (and
    // again inside place_bet_atomic) rather than letting an exhibition game
    // reach the bankroll.
    if (pickRow?.observation_only === true) {
      console.error('[POST /api/bets] REJECTED observation_only pick', {
        pick_id,
        pick: parsed.data.pick,
        sport: parsed.data.sport,
        amount: parsed.data.amount,
        reason: 'preseason observation pick — betting is disabled for this pick',
      });
      return NextResponse.json(
        {
          error:
            'Este pick es de PRETEMPORADA (observación). No se puede apostar ni registrar como apuesta.',
          code: 'observation_only_pick',
        },
        { status: 422 },
      );
    }

    if (!espn_event_id) espn_event_id = pickRow?.espn_event_id ?? null;
    game_start_time = pickRow?.game_start_time ?? null;
  }

  // Atomic placement: INSERT bet + UPDATE bankroll + INSERT log + UPDATE
  // picks.status all happen inside a single PL/pgSQL block. Any failure
  // (duplicate, insufficient bankroll, etc.) rolls back every change.
  const { data: rpcData, error: rpcErr } = await supabase.rpc('place_bet_atomic', {
    p_pick_id: pick_id ?? null,
    p_sport: fields.sport,
    p_game: fields.game,
    p_home_team: fields.home_team ?? null,
    p_away_team: fields.away_team ?? null,
    p_home_team_abbr: fields.home_team_abbr ?? null,
    p_away_team_abbr: fields.away_team_abbr ?? null,
    p_espn_event_id: espn_event_id,
    p_pick: fields.pick,
    p_bet_type: fields.bet_type,
    p_odds_decimal: fields.odds_decimal,
    p_amount: fields.amount,
    p_tier: fields.tier ?? null,
    p_date: fields.date ?? null,
    p_notes: fields.notes ?? null,
    p_game_start_time: game_start_time,
  });

  if (rpcErr) {
    const msg = rpcErr.message ?? '';
    if (msg.startsWith('duplicate_bet:') || rpcErr.code === '23505') {
      return NextResponse.json({ error: 'Ya apostaste en este pick' }, { status: 409 });
    }
    if (msg.startsWith('insufficient_bankroll')) {
      return NextResponse.json(
        { error: 'Bankroll insuficiente para esta apuesta', detail: msg },
        { status: 409 },
      );
    }
    if (msg.startsWith('observation_only_pick')) {
      // Raised by place_bet_atomic — the DB-level backstop for the check
      // above. Reaching this means something bypassed the route guard.
      console.error('[POST /api/bets] place_bet_atomic rejected observation_only pick', {
        pick_id,
        detail: msg,
      });
      return NextResponse.json(
        {
          error:
            'Este pick es de PRETEMPORADA (observación). No se puede apostar ni registrar como apuesta.',
          code: 'observation_only_pick',
        },
        { status: 422 },
      );
    }
    if (msg.startsWith('settings_missing')) {
      return NextResponse.json({ error: 'Settings missing' }, { status: 500 });
    }
    return NextResponse.json(
      { error: 'place_bet_atomic failed', detail: msg },
      { status: 500 },
    );
  }
  const result = rpcData as { ok: boolean; bet_id: string; bankroll_current: number };

  // Re-fetch the bet to return the same shape as before (UI consumers
  // expect the full row, not just id + bankroll).
  // The bet is already placed at this point, so a failed re-fetch is NOT a
  // 500 — return the ids so the client can still reconcile.
  const { data: bet, error: betErr } = await supabase
    .from('bets')
    .select('*')
    .eq('id', result.bet_id)
    .maybeSingle();
  if (betErr) {
    console.error('[POST /api/bets] bet re-fetch failed (bet WAS placed)', result.bet_id, betErr);
  }

  return NextResponse.json({
    id: result.bet_id,
    ...(bet ?? {}),
    bankroll_current: result.bankroll_current,
  });
}
