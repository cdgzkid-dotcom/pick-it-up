import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase';
import { potentialWin } from '@/lib/units';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ResolveSchema = z.object({
  result: z.enum(['win', 'loss', 'cashout', 'early_payout']),
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
  } else if (parsed.data.result === 'cashout') {
    const ca = Number(parsed.data.cashout_amount ?? 0);
    if (ca <= 0) {
      return NextResponse.json({ error: 'cashout_amount required and > 0' }, { status: 400 });
    }
    payout = ca;
    credit = ca;
  }

  const { data: settings, error: setErr } = await supabase
    .from('settings')
    .select('bankroll_current')
    .eq('id', 1)
    .single();
  if (setErr) {
    return NextResponse.json({ error: 'Settings missing' }, { status: 500 });
  }
  const newBankroll = Number(settings.bankroll_current) + credit;

  const { error: updErr } = await supabase
    .from('bets')
    .update({
      result: parsed.data.result,
      cashout_amount: parsed.data.result === 'cashout' ? parsed.data.cashout_amount : null,
      payout,
    })
    .eq('id', id);
  if (updErr) {
    return NextResponse.json({ error: 'Update failed', detail: updErr.message }, { status: 500 });
  }

  if (credit !== 0) {
    await supabase.from('settings').update({ bankroll_current: newBankroll }).eq('id', 1);
  }

  await supabase.from('bankroll_log').insert([
    {
      type: parsed.data.result,
      amount: credit,
      balance_after: newBankroll,
      note: `${parsed.data.result.toUpperCase()} on ${bet.pick} (${bet.game})`,
    },
  ]);

  return NextResponse.json({
    ok: true,
    result: parsed.data.result,
    payout,
    pl: payout - amount,
    bankroll_current: newBankroll,
  });
}
