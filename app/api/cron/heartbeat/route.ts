import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { sendTelegramMessage } from '@/lib/telegram';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function authOk(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  return req.headers.get('authorization') === `Bearer ${expected}`;
}

async function buildHeartbeat(): Promise<string> {
  const sb = supabaseAdmin();
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: picks24h } = await sb
    .from('picks')
    .select('id, status, telegram_notified_at')
    .gte('created_at', since24h);
  const generated = picks24h?.length ?? 0;
  const notified = picks24h?.filter((p) => p.telegram_notified_at).length ?? 0;
  const superseded = picks24h?.filter((p) => p.status?.startsWith('superseded')).length ?? 0;

  const { data: bets24h } = await sb
    .from('bets')
    .select('id, result, amount, payout')
    .gte('created_at', since24h)
    .in('result', ['win', 'loss', 'push']);
  const wins = bets24h?.filter((b) => b.result === 'win').length ?? 0;
  const losses = bets24h?.filter((b) => b.result === 'loss').length ?? 0;
  const pl = bets24h?.reduce(
    (s, b) => s + (Number(b.payout ?? 0) - Number(b.amount ?? 0)),
    0,
  ) ?? 0;

  const { data: settings } = await sb
    .from('settings')
    .select('bankroll_current')
    .eq('id', 1)
    .single();
  const bankroll = Number(settings?.bankroll_current ?? 0);

  const cutoffStuck = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: stuck } = await sb
    .from('bets')
    .select('pick')
    .eq('result', 'pending')
    .lt('game_start_time', cutoffStuck);

  const healthUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'https://pick-it-up.vercel.app'}/api/health`;
  let healthSummary = 'unknown';
  try {
    const r = await fetch(healthUrl, { signal: AbortSignal.timeout(15000) });
    const h = (await r.json()) as {
      ok: boolean;
      summary: { ok: number; errors: number; warnings: number; total: number };
    };
    healthSummary = h.ok
      ? `✅ ${h.summary.ok}/${h.summary.total} checks ok`
      : `❌ ${h.summary.errors} errors, ${h.summary.warnings} warnings`;
  } catch {
    healthSummary = '⚠️ health endpoint unreachable';
  }

  const today = new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
  const plSign = pl >= 0 ? '+' : '';
  const stuckLine = (stuck?.length ?? 0) > 0 ? `\n⚠️ Stuck pending bets: ${stuck!.length}` : '';

  return `📊 *Daily Health · ${today}*
─────────────────────
Picks generated 24h: ${generated}
Notified: ${notified} (${superseded} superseded)
Bets resolved: ${wins}W-${losses}L (P/L ${plSign}$${pl.toFixed(2)})
Bankroll: $${bankroll.toFixed(2)}
System: ${healthSummary}${stuckLine}`;
}

async function handle(req: Request) {
  if (!authOk(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const text = await buildHeartbeat();
    const send = await sendTelegramMessage(text);
    return NextResponse.json({ ok: send.ok, text });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}
