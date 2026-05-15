/**
 * POST /api/bets/from-image/confirm
 *
 * Receives the user-confirmed extraction data and:
 *  1. Updates picks.odds_decimal for legs where the real odds differ.
 *  2. Creates the bet record(s).
 *     - PENDIENTE tickets → place_bet_atomic RPC (debits bankroll).
 *     - Settled tickets (GANADA/PERDIDA/CASHOUT/ANULADA) → direct INSERT
 *       for historical record only (bankroll is managed separately by user).
 *  3. Stores draftea_ticket_id for deduplication.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── Validation schema ──────────────────────────────────────────────────────

const LegSchema = z.object({
  sport: z.string(),
  league: z.string().nullable(),
  teams: z.string(),
  selection: z.string(),
  market_type: z.string(),
  line: z.string().nullable(),
  odds_decimal: z.coerce.number().min(1.01).max(200),
  event_time: z.string().nullable(),
  // Matching results (from /api/bets/from-image response)
  matched_pick_id: z.string().uuid().nullable(),
  odds_changed: z.boolean(),
  original_odds: z.coerce.number().nullable(),
});

const ConfirmSchema = z.object({
  // Ticket header
  bet_type: z.string().nullable(),
  total_odds_decimal: z.coerce.number().min(1.01).max(10000),
  wager_mxn: z.coerce.number().positive(),
  potential_payout_mxn: z.coerce.number().nullable(),
  potential_winnings_mxn: z.coerce.number().nullable(),
  // 'PENDIENTE' | 'GANADA' | 'PERDIDA' | 'CASHOUT' | 'ANULADA'
  status_draftea: z.string().nullable(),
  bet_id_draftea: z.string().nullable(),
  placed_at: z.string().nullable(),
  legs: z.array(LegSchema).min(1),
  // Pass-through for bonus logging
  usage_tokens_in: z.number().optional(),
  usage_tokens_out: z.number().optional(),
  usage_cost_usd: z.number().optional(),
  confidence: z.string().optional(),
});

type ConfirmData = z.infer<typeof ConfirmSchema>;

// ── Helpers ────────────────────────────────────────────────────────────────

function drafteaStatusToBetResult(
  s: string | null,
): 'pending' | 'win' | 'loss' | 'cashout' | 'push' {
  switch (s) {
    case 'GANADA':  return 'win';
    case 'PERDIDA': return 'loss';
    case 'CASHOUT': return 'cashout';
    case 'ANULADA': return 'push';
    default:        return 'pending';
  }
}

function buildBetDescription(data: ConfirmData): {
  sport: string;
  game: string;
  pick: string;
  bet_type: string;
  pick_id: string | null;
  notes: string | null;
} {
  const isParlay = data.legs.length > 1;
  const first = data.legs[0];

  const sport = isParlay
    ? // Multi-sport parlay → use first leg sport or 'Parlay'
      (new Set(data.legs.map((l) => l.sport)).size > 1 ? 'Parlay' : first.sport)
    : first.sport;

  const game = isParlay
    ? data.legs.map((l) => l.selection).join(' + ')
    : first.teams || first.selection;

  const pick = isParlay
    ? `COMBINADA (${data.legs.length}): ${data.legs.map((l) => l.selection).join(' · ')}`
    : first.selection;

  const bet_type = isParlay ? 'Parlay' : (first.market_type || 'ML');

  // Single bet: link to matched pick if available
  const pick_id = !isParlay ? (data.legs[0]?.matched_pick_id ?? null) : null;

  // Notes: Draftea ticket ID + individual legs for parlays
  const noteParts: string[] = [];
  if (data.bet_id_draftea) noteParts.push(`draftea:${data.bet_id_draftea}`);
  if (isParlay) {
    noteParts.push(
      data.legs
        .map((l, i) => `${i + 1}. ${l.selection} @${l.odds_decimal.toFixed(2)}`)
        .join(' | '),
    );
  }

  return {
    sport,
    game: game.slice(0, 255), // guard against very long combinadas
    pick: pick.slice(0, 500),
    bet_type,
    pick_id,
    notes: noteParts.length ? noteParts.join(' · ').slice(0, 1000) : null,
  };
}

// ── Handler ────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const parsed = ConfirmSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Bad request', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const data = parsed.data;
  const supabase = supabaseAdmin();
  const betResult = drafteaStatusToBetResult(data.status_draftea);
  const isPending = betResult === 'pending';

  // ── Step 1: Update pick odds if they changed ──────────────────────────

  const changedLegs = data.legs.filter(
    (l) => l.matched_pick_id && l.odds_changed && l.odds_decimal >= 1.01,
  );

  const oddsUpdated: Array<{ pick_id: string; new_odds: number }> = [];

  for (const leg of changedLegs) {
    const { error } = await supabase
      .from('picks')
      .update({
        odds_decimal: leg.odds_decimal,
        updated_at: new Date().toISOString(),
      })
      .eq('id', leg.matched_pick_id!);

    if (error) {
      console.error('[confirm] pick odds update failed', leg.matched_pick_id, error);
    } else {
      oddsUpdated.push({ pick_id: leg.matched_pick_id!, new_odds: leg.odds_decimal });
    }
  }

  // ── Step 2: Build bet fields ──────────────────────────────────────────

  const { sport, game, pick, bet_type, pick_id, notes } = buildBetDescription(data);
  const gameStartTime = data.legs[0]?.event_time ?? null;

  // ── Step 3a: PENDIENTE → place_bet_atomic (debits bankroll) ──────────

  if (isPending) {
    const { data: rpcData, error: rpcErr } = await supabase.rpc('place_bet_atomic', {
      p_pick_id: pick_id,
      p_sport: sport,
      p_game: game,
      p_home_team: null,
      p_away_team: null,
      p_home_team_abbr: null,
      p_away_team_abbr: null,
      p_espn_event_id: null,
      p_pick: pick,
      p_bet_type: bet_type,
      p_odds_decimal: data.total_odds_decimal,
      p_amount: data.wager_mxn,
      p_tier: null,
      p_date: data.placed_at
        ? new Date(data.placed_at).toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City' })
        : null,
      p_notes: notes,
      p_game_start_time: gameStartTime,
    });

    if (rpcErr) {
      const msg = rpcErr.message ?? '';
      if (msg.startsWith('duplicate_bet:')) {
        return NextResponse.json({ error: 'Esta apuesta ya está registrada' }, { status: 409 });
      }
      if (msg.startsWith('insufficient_bankroll')) {
        return NextResponse.json(
          { error: 'Bankroll insuficiente. Ajusta el monto o tu bankroll primero.' },
          { status: 409 },
        );
      }
      console.error('[confirm] place_bet_atomic failed', msg);
      return NextResponse.json(
        { error: 'Error al guardar la apuesta', detail: msg },
        { status: 500 },
      );
    }

    const rpc = rpcData as { ok: boolean; bet_id: string; bankroll_current: number };

    // Store Draftea ticket ID for future dedup
    if (data.bet_id_draftea) {
      await supabase
        .from('bets')
        .update({ draftea_ticket_id: data.bet_id_draftea })
        .eq('id', rpc.bet_id);
    }

    return NextResponse.json({
      ok: true,
      bet_id: rpc.bet_id,
      bankroll_current: rpc.bankroll_current,
      odds_updated: oddsUpdated,
      historical: false,
    });
  }

  // ── Step 3b: Already settled → historical INSERT (no bankroll change) ─

  const payout =
    betResult === 'win'
      ? data.potential_payout_mxn ?? Math.round(data.wager_mxn * data.total_odds_decimal * 100) / 100
      : betResult === 'loss'
      ? 0
      : betResult === 'cashout'
      ? (data.potential_payout_mxn ?? data.wager_mxn)
      : data.wager_mxn; // push / anulada → stake back

  const { data: inserted, error: insertErr } = await supabase
    .from('bets')
    .insert({
      pick_id,
      sport,
      game,
      pick,
      bet_type,
      odds_decimal: data.total_odds_decimal,
      amount: data.wager_mxn,
      result: betResult,
      payout,
      cashout_amount: betResult === 'cashout' ? payout : null,
      date: data.placed_at
        ? new Date(data.placed_at).toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City' })
        : null,
      notes,
      game_start_time: gameStartTime,
      draftea_ticket_id: data.bet_id_draftea ?? null,
    })
    .select('id')
    .single();

  if (insertErr || !inserted) {
    console.error('[confirm] historical insert failed', insertErr);
    return NextResponse.json(
      { error: 'Error al guardar la apuesta histórica', detail: insertErr?.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    bet_id: inserted.id,
    bankroll_current: null, // user manages bankroll separately for historical bets
    odds_updated: oddsUpdated,
    historical: true,
    message: `Apuesta ${data.status_draftea?.toLowerCase()} registrada en historial. Tu bankroll actual no fue modificado — ajústalo manualmente si es necesario.`,
  });
}
