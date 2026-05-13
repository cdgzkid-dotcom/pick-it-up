import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import type { Bet, BankrollLog } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INITIAL_SEED = 300;

/**
 * Rebuilds bankroll_current from source of truth:
 *   bankroll = INITIAL_SEED
 *            + sum(bankroll_log.amount) where type IN ('deposit','withdraw')
 *            + sum(payout - amount) for ALL bets
 *
 * Where bet payout:
 *   pending          → 0  (so contributes -amount, money locked)
 *   win/early_payout → amount * odds_decimal  (stake + profit returned)
 *   loss             → 0  (stake gone, contributes -amount)
 *   push             → amount  (stake refunded, net 0)
 *   cashout          → cashout_amount
 *
 * Ignores `stake/win/loss/push/cashout` log entries — those are an audit
 * trail of bet impacts and would double-count if added to bets.
 *
 * GET returns the calc without writing. POST writes settings.bankroll_current.
 */
async function compute() {
  const supabase = supabaseAdmin();

  const [logRes, betsRes, settingsRes] = await Promise.all([
    supabase.from('bankroll_log').select('*'),
    supabase.from('bets').select('*'),
    supabase.from('settings').select('bankroll_current').eq('id', 1).single(),
  ]);

  if (logRes.error) throw new Error(`log fetch: ${logRes.error.message}`);
  if (betsRes.error) throw new Error(`bets fetch: ${betsRes.error.message}`);
  if (settingsRes.error) throw new Error(`settings fetch: ${settingsRes.error.message}`);

  const logs = (logRes.data as BankrollLog[]) ?? [];
  const bets = (betsRes.data as Bet[]) ?? [];
  const currentBankroll = Number(settingsRes.data.bankroll_current);

  const deposits = logs
    .filter((l) => l.type === 'deposit')
    .reduce((s, l) => s + Number(l.amount), 0);
  const withdrawals = logs
    .filter((l) => l.type === 'withdraw')
    .reduce((s, l) => s + Number(l.amount), 0); // already negative

  const pending = bets.filter((b) => b.result === 'pending');
  const wins = bets.filter((b) => b.result === 'win' || b.result === 'early_payout');
  const losses = bets.filter((b) => b.result === 'loss');
  const pushes = bets.filter((b) => b.result === 'push');
  const cashouts = bets.filter((b) => b.result === 'cashout');

  const pendingStakes = pending.reduce((s, b) => s + Number(b.amount), 0);
  const winPayouts = wins.reduce((s, b) => s + Number(b.amount) * Number(b.odds_decimal), 0);
  const winStakes = wins.reduce((s, b) => s + Number(b.amount), 0);
  const lossStakes = losses.reduce((s, b) => s + Number(b.amount), 0);
  const pushNet = 0; // pushes refund the stake — net zero
  const cashoutPayouts = cashouts.reduce((s, b) => s + Number(b.cashout_amount ?? 0), 0);
  const cashoutStakes = cashouts.reduce((s, b) => s + Number(b.amount), 0);

  const correctBankroll =
    INITIAL_SEED +
    deposits +
    withdrawals + // negative
    (winPayouts - winStakes) +
    (-lossStakes) +
    pushNet +
    (cashoutPayouts - cashoutStakes) +
    (-pendingStakes);

  return {
    current_in_db: currentBankroll,
    correct: Math.round(correctBankroll * 100) / 100,
    diff: Math.round((correctBankroll - currentBankroll) * 100) / 100,
    breakdown: {
      initial_seed: INITIAL_SEED,
      deposits,
      withdrawals,
      pending: { count: pending.length, total_stakes: pendingStakes },
      wins: {
        count: wins.length,
        gross_payouts: winPayouts,
        stakes: winStakes,
        net: winPayouts - winStakes,
      },
      losses: { count: losses.length, total_stakes_lost: lossStakes },
      pushes: { count: pushes.length },
      cashouts: {
        count: cashouts.length,
        total_payouts: cashoutPayouts,
        stakes: cashoutStakes,
        net: cashoutPayouts - cashoutStakes,
      },
    },
  };
}

export async function GET() {
  try {
    const calc = await compute();
    return NextResponse.json({ ok: true, ...calc, applied: false });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST() {
  try {
    const supabase = supabaseAdmin();
    const calc = await compute();
    if (calc.diff === 0) {
      return NextResponse.json({ ok: true, ...calc, applied: false, note: 'No change' });
    }
    // Atomic adjust: settings UPDATE + bankroll_log INSERT in one PL/pgSQL
    // block. Replaces the old 2-statement non-atomic pattern.
    const { error: rpcErr } = await supabase.rpc('adjust_bankroll_atomic', {
      p_delta: calc.diff,
      p_type: calc.diff > 0 ? 'deposit' : 'withdraw',
      p_note: `Recálculo automático: ${calc.diff > 0 ? '+' : ''}$${calc.diff} para alinear con bets+log`,
    });
    if (rpcErr) throw new Error(rpcErr.message);
    return NextResponse.json({ ok: true, ...calc, applied: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
