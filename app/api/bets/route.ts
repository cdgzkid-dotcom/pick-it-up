import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase';

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
    const { data: pickRow } = await supabase
      .from('picks')
      .select('espn_event_id, game_start_time')
      .eq('id', pick_id)
      .maybeSingle();
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
  const { data: bet } = await supabase
    .from('bets')
    .select('*')
    .eq('id', result.bet_id)
    .maybeSingle();

  return NextResponse.json({ ...bet, bankroll_current: result.bankroll_current });
}
