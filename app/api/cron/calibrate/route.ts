// Weekly calibration cron. Reads factor_performance, derives per-factor
// weights, upserts system_weights, and posts a Telegram summary including
// the strongest/weakest factors plus a per-sport weekly breakdown.
//
// Auth: Authorization: Bearer ${CRON_SECRET}.

import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { sendTelegramMessage } from '@/lib/telegram';
import { computeStats } from '@/lib/stats';
import type { Bet } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface FactorRow {
  id: string;
  factor_name: string;
  factor_value: string | null;
  sport: string | null;
  total_picks: number;
  wins: number;
  losses: number;
  total_profit: number;
  win_rate: number;
}

function weightFor(winRate: number): number {
  if (winRate > 0.58) return 1.5;
  if (winRate > 0.53) return 1.0;
  if (winRate > 0.48) return 0.5;
  return 0.0;
}

function authOk(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const header = req.headers.get('authorization') ?? '';
  return header === `Bearer ${expected}`;
}

async function handle(req: Request) {
  if (!authOk(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = supabaseAdmin();

  const { data: factorsData, error: factorsErr } = await supabase
    .from('factor_performance')
    .select('*')
    .gte('total_picks', 20);
  if (factorsErr) {
    return NextResponse.json({ error: factorsErr.message }, { status: 500 });
  }

  const factors = (factorsData as FactorRow[]) ?? [];
  if (factors.length === 0) {
    return NextResponse.json({
      ok: true,
      message: 'Not enough data yet (need 20+ picks per factor)',
      calibrated: 0,
    });
  }

  const weights = factors.map((f) => ({
    sport: f.sport ?? 'unknown',
    factor_name: f.factor_name,
    weight: weightFor(Number(f.win_rate)),
    sample_size: f.total_picks,
    last_calibrated: new Date().toISOString(),
  }));

  let upserted = 0;
  for (const w of weights) {
    const { error } = await supabase
      .from('system_weights')
      .upsert(w, { onConflict: 'sport,factor_name' });
    if (error) console.error('[calibrate] upsert failed', error, w);
    else upserted++;
  }

  // ─── Telegram report ──────────────────────────────────────────────────
  const strong = weights
    .map((w, i) => ({ w, f: factors[i] }))
    .filter((x) => x.w.weight >= 1.5)
    .sort((a, b) => Number(b.f.win_rate) - Number(a.f.win_rate));
  const weak = weights
    .map((w, i) => ({ w, f: factors[i] }))
    .filter((x) => x.w.weight <= 0.5)
    .sort((a, b) => Number(a.f.win_rate) - Number(b.f.win_rate));

  // Weekly summary on settled bets from the past 7 days
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: weeklyBetsData } = await supabase
    .from('bets')
    .select('*')
    .gte('created_at', weekAgo);
  const weeklyBets = (weeklyBetsData as Bet[]) ?? [];
  const weeklyStats = computeStats(weeklyBets);
  const weeklyPl = weeklyStats.pl;

  const { data: settings } = await supabase
    .from('settings')
    .select('bankroll_current')
    .eq('id', 1)
    .single();
  const bankrollNow = Number(settings?.bankroll_current ?? 0);

  // Per-sport from the same 7-day window
  const sportPerf: Record<string, { wins: number; losses: number; pl: number }> = {};
  for (const b of weeklyBets) {
    if (b.result !== 'win' && b.result !== 'loss') continue;
    const key = b.sport || 'unknown';
    if (!sportPerf[key]) sportPerf[key] = { wins: 0, losses: 0, pl: 0 };
    if (b.result === 'win') sportPerf[key].wins++;
    else sportPerf[key].losses++;
    sportPerf[key].pl += Number(b.payout ?? 0) - Number(b.amount);
  }

  // Per-tier from the same 7-day window
  const tierPerf: Record<string, { wins: number; losses: number }> = {};
  for (const b of weeklyBets) {
    if (b.result !== 'win' && b.result !== 'loss') continue;
    const tier = (b.tier ?? 'value') as string;
    if (!tierPerf[tier]) tierPerf[tier] = { wins: 0, losses: 0 };
    if (b.result === 'win') tierPerf[tier].wins++;
    else tierPerf[tier].losses++;
  }

  // CLV avg over the week
  const clvVals = weeklyBets
    .filter((b) => b.clv != null && (b.result === 'win' || b.result === 'loss'))
    .map((b) => Number(b.clv));
  const clvAvg = clvVals.length > 0 ? clvVals.reduce((s, x) => s + x, 0) / clvVals.length : null;

  const lines: string[] = [];
  lines.push('📊 *RESUMEN SEMANAL — Pick It Up*');
  lines.push('');
  lines.push(`💰 Bankroll: $${Math.round(bankrollNow)}${weeklyPl !== 0 ? ` (${weeklyPl >= 0 ? '+' : '-'}$${Math.abs(Math.round(weeklyPl))} esta semana)` : ''}`);
  lines.push(`📈 ROI semanal: ${weeklyStats.roi >= 0 ? '+' : ''}${weeklyStats.roi.toFixed(1)}%`);
  lines.push(`🎯 Record: ${weeklyStats.wins}W-${weeklyStats.losses}L (${weeklyStats.win_rate.toFixed(1)}%)`);
  lines.push('');

  if (Object.keys(sportPerf).length > 0) {
    lines.push('Por deporte:');
    const sportEmoji: Record<string, string> = { MLB: '⚾', NHL: '🏒', NBA: '🏀', NFL: '🏈' };
    for (const [sport, p] of Object.entries(sportPerf)) {
      const emoji = sportEmoji[sport] ?? '🏆';
      const sign = p.pl >= 0 ? '+' : '-';
      lines.push(`${emoji} ${sport}: ${p.wins}W-${p.losses}L (${sign}$${Math.abs(Math.round(p.pl))})`);
    }
    lines.push('');
  }

  if (Object.keys(tierPerf).length > 0) {
    const tierEmoji: Record<string, string> = { lock: '🔒', strong: '✅', value: '⚠️', parlay: '🎯' };
    const tierName: Record<string, string> = { lock: 'LOCKs', strong: 'STRONGs', value: 'VALUEs', parlay: 'PARLAYs' };
    for (const [tier, p] of Object.entries(tierPerf)) {
      const total = p.wins + p.losses;
      const wr = total > 0 ? (p.wins / total) * 100 : 0;
      lines.push(`${tierEmoji[tier] ?? ''} ${tierName[tier] ?? tier}: ${p.wins}W-${p.losses}L (${wr.toFixed(1)}%)`);
    }
    lines.push('');
  }

  if (clvAvg != null) {
    lines.push(`📊 CLV promedio: ${clvAvg >= 0 ? '+' : ''}${clvAvg.toFixed(3)} ${clvAvg >= 0 ? '✅' : '⚠️'}`);
  }

  if (strong.length > 0) {
    lines.push('');
    lines.push('🧠 *Factores que más ganan:*');
    for (const { w, f } of strong.slice(0, 5)) {
      lines.push(`✅ ${w.factor_name}: ${Math.round(Number(f.win_rate) * 100)}% (${w.sample_size} picks) — peso ${w.weight}`);
    }
  }

  if (weak.length > 0) {
    lines.push('');
    lines.push('⚠️ *Factores débiles:*');
    for (const { w, f } of weak.slice(0, 5)) {
      lines.push(`⚠️ ${w.factor_name}: ${Math.round(Number(f.win_rate) * 100)}% (${w.sample_size} picks) — bajando peso a ${w.weight}`);
    }
  }

  await sendTelegramMessage(lines.join('\n'));

  return NextResponse.json({
    ok: true,
    calibrated: upserted,
    strong_count: strong.length,
    weak_count: weak.length,
    weekly_record: { wins: weeklyStats.wins, losses: weeklyStats.losses },
  });
}

export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  return handle(req);
}
