import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { systemDisabledResponse } from '@/lib/systemState';
import type { Bet, BankrollLog } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INITIAL_SEED = 300;

// bankroll_log rows written by place_bet_atomic / resolve_bet_atomic. They
// mirror the bets table and must NOT be summed here (double count). Anything
// else in the log is real cash movement or a manual correction and MUST be.
const BET_IMPACT_TYPES: ReadonlySet<string> = new Set([
  'stake', 'win', 'loss', 'push', 'cashout', 'early_payout',
]);
const KNOWN_CASH_TYPES: ReadonlySet<string> = new Set(['deposit', 'withdraw', 'reconciliation']);

/**
 * Rebuilds bankroll_current from source of truth:
 *   bankroll = INITIAL_SEED
 *            + sum(bankroll_log.amount) where type NOT IN (bet-impact types)
 *              — i.e. deposit, withdraw, reconciliation and any manual
 *              adjustment type someone inserts by hand (signed amounts)
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
 * DELIBERATELY UNFILTERED: this is the one aggregation over `bets` that must
 * NOT apply isModelBet()/excluded_from_stats. Bets flagged excluded are real
 * money — manual backfills reconciled from Draftea screenshots — and the
 * balance only reconstructs correctly if every stake and payout counts. What
 * that flag excludes is *model performance*, not *money*. The counts in the
 * breakdown below are money buckets (which rows moved the balance and by how
 * much), not a W-L record; the record lives in computeStats(), which filters.
 * If you ever add a real performance metric here, filter that metric alone.
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
    .reduce((s, l) => s + Number(l.amount), 0); // stored negative
  // Reconciliation / manual adjustments (e.g. the -17.32 reconciliation row
  // from 2026-05-16) plus any ad-hoc type inserted by hand. Signed amounts,
  // summed as-is. Unknown types are reported so a typo doesn't hide money.
  const adjustmentRows = logs.filter(
    (l) => !BET_IMPACT_TYPES.has(String(l.type)) && l.type !== 'deposit' && l.type !== 'withdraw',
  );
  const adjustments = adjustmentRows.reduce((s, l) => s + Number(l.amount), 0);
  const unknownTypes = Array.from(
    new Set(adjustmentRows.map((l) => String(l.type)).filter((t) => !KNOWN_CASH_TYPES.has(t))),
  );
  if (unknownTypes.length > 0) {
    console.warn('[bankroll/recalculate] unknown bankroll_log types counted as adjustments', unknownTypes);
  }

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
    adjustments + // signed (reconciliation / manual)
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
      adjustments: {
        count: adjustmentRows.length,
        total: adjustments,
        types: Array.from(new Set(adjustmentRows.map((l) => String(l.type)))),
        unknown_types: unknownTypes,
      },
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
  const disabled = await systemDisabledResponse('bankroll/recalculate');
  if (disabled) return disabled;

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
