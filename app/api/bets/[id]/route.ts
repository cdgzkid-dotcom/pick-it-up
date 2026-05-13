import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase';
import { potentialWin } from '@/lib/units';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ResolveSchema = z.object({
  result: z.enum(['win', 'loss', 'push', 'cashout', 'early_payout']),
  cashout_amount: z.coerce.number().optional().nullable(),
});

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
  const id = params.id;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = ResolveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Bad request', detail: parsed.error.flatten() }, { status: 400 });
  }

  const supabase = supabaseAdmin();
  const { data: bet, error: fetchErr } = await supabase
    .from('bets')
    .select('*')
    .eq('id', id)
    .single();
  if (fetchErr || !bet) {
    return NextResponse.json({ error: 'Bet not found' }, { status: 404 });
  }
  if (bet.result !== 'pending') {
    return NextResponse.json({ error: 'Bet already resolved' }, { status: 409 });
  }

  const amount = Number(bet.amount);
  const odds = Number(bet.odds_decimal);
  let payout = 0;
  // Bankroll was already debited on bet creation. On resolve we credit
  // back what the user receives.
  let credit = 0;

  if (parsed.data.result === 'win' || parsed.data.result === 'early_payout') {
    payout = amount + potentialWin(amount, odds);
    credit = payout;
  } else if (parsed.data.result === 'loss') {
    payout = 0;
    credit = 0;
  } else if (parsed.data.result === 'push') {
    payout = amount; // refund stake
    credit = amount;
  } else if (parsed.data.result === 'cashout') {
    const ca = Number(parsed.data.cashout_amount ?? 0);
    if (ca <= 0) {
      return NextResponse.json({ error: 'cashout_amount required and > 0' }, { status: 400 });
    }
    payout = ca;
    credit = ca;
  }

  // Atomic resolution: UPDATE bets + UPDATE bankroll + INSERT log in one
  // PL/pgSQL block. Idempotent — if another caller (cron/check-results)
  // resolved this bet first, the RPC returns skipped:true and we surface
  // a 409 so the manual UI shows "already resolved".
  const { data: rpcData, error: rpcErr } = await supabase.rpc('resolve_bet_atomic', {
    p_bet_id: id,
    p_result: parsed.data.result,
    p_payout: payout,
    p_credit: credit,
    p_cashout_amount: parsed.data.result === 'cashout' ? (parsed.data.cashout_amount ?? null) : null,
    p_final_score: null,
    p_odds_at_close: null,
    p_clv: null,
    p_note: `${parsed.data.result.toUpperCase()} on ${bet.pick} (${bet.game})`,
  });
  if (rpcErr) {
    const msg = rpcErr.message ?? '';
    if (msg.startsWith('bet_not_found')) {
      return NextResponse.json({ error: 'Bet not found' }, { status: 404 });
    }
    return NextResponse.json({ error: 'resolve_bet_atomic failed', detail: msg }, { status: 500 });
  }
  const result = rpcData as { ok: boolean; skipped?: boolean; bankroll_current?: number; old_result?: string };
  if (result.skipped) {
    return NextResponse.json(
      { error: 'Bet already resolved', old_result: result.old_result },
      { status: 409 },
    );
  }

  return NextResponse.json({
    ok: true,
    result: parsed.data.result,
    payout,
    pl: payout - amount,
    bankroll_current: result.bankroll_current,
  });
}
