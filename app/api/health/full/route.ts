/**
 * GET /api/health/full
 *
 * CAMBIO 3: Aggregate system-health dashboard.
 *
 * Called by Vercel's hourly cron (vercel.json) and available for manual GET.
 * Behaviour:
 *   alert_level=red   → sends Telegram alert
 *   alert_level=yellow → console.warn only
 *   alert_level=green  → no action
 *
 * Fields returned:
 *   last_successful_cron_run      ISO timestamp of the last cron_run without errors
 *   last_anthropic_call_status    ok | 529 | error | skipped
 *   games_today_total             max(games_fetched) from today's cron runs (ESPN total)
 *   games_today_analyzed          sum(games_analyzed) from today's cron runs
 *   games_today_pending_in_window games_in_window from the most recent cron run
 *   alert_level                   green | yellow | red
 *   alert_reasons                 list of strings explaining yellow/red
 */

import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { sendTelegramMessage } from '@/lib/telegram';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Alert thresholds (cron-job.org fires every ~10 min)
const RED_THRESHOLD_MIN = 30;    // missed ≥3 firings → red
const YELLOW_THRESHOLD_MIN = 20; // missed ≥2 firings → yellow

interface CronRunRow {
  started_at: string;
  duration_ms: number;
  generated_picks: number;
  games_fetched: number;
  games_in_window: number;
  games_analyzed: number;
  anthropic_status: string;
  errors: Record<string, string> | null;
}

export async function GET(_req: Request) {
  const supabase = supabaseAdmin();
  const now = new Date();

  // CDMX today string (YYYY-MM-DD) for filtering today's runs
  const cdmxDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Mexico_City' }).format(now);
  const todayStartCdmx = new Date(`${cdmxDate}T00:00:00-06:00`).toISOString();

  // ── 1. Last successful cron run (no errors field) ─────────────────────
  const { data: lastSuccessfulRow } = await supabase
    .from('cron_runs')
    .select('started_at, games_analyzed, anthropic_status')
    .eq('workflow', 'analyze')
    .is('errors', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // ── 2. Most recent cron run (any — for in-window count + anthropic status)
  const { data: lastRunRow } = await supabase
    .from('cron_runs')
    .select('started_at, games_in_window, anthropic_status, errors')
    .eq('workflow', 'analyze')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // ── 3. Today's cron runs (for totals) ────────────────────────────────
  const { data: todayRows } = await supabase
    .from('cron_runs')
    .select('games_fetched, games_analyzed')
    .eq('workflow', 'analyze')
    .gte('started_at', todayStartCdmx);

  const runs = (todayRows ?? []) as Pick<CronRunRow, 'games_fetched' | 'games_analyzed'>[];

  // games_today_total: max(games_fetched) — represents the ESPN slate size at peak
  const gamesTodayTotal = runs.reduce((max, r) => Math.max(max, r.games_fetched ?? 0), 0);
  // games_today_analyzed: sum(games_analyzed) — unique games that went through Claude
  const gamesTodayAnalyzed = runs.reduce((sum, r) => sum + (r.games_analyzed ?? 0), 0);
  // games_today_pending_in_window: from the most recent run
  const gamesTodayPendingInWindow = (lastRunRow as Partial<CronRunRow> | null)?.games_in_window ?? 0;

  // ── 4. Alert level ────────────────────────────────────────────────────
  const lastSuccessfulAt = lastSuccessfulRow?.started_at
    ? new Date(lastSuccessfulRow.started_at)
    : null;
  const minSinceLastSuccess = lastSuccessfulAt
    ? (now.getTime() - lastSuccessfulAt.getTime()) / 60_000
    : Infinity;

  const lastAnthropicStatus =
    (lastRunRow as Partial<CronRunRow> | null)?.anthropic_status ?? 'unknown';

  let alertLevel: 'green' | 'yellow' | 'red' = 'green';
  const alertReasons: string[] = [];

  if (minSinceLastSuccess > RED_THRESHOLD_MIN || lastAnthropicStatus === 'error') {
    alertLevel = 'red';
    if (minSinceLastSuccess > RED_THRESHOLD_MIN) {
      alertReasons.push(
        `sin cron exitoso en los últimos ${Math.round(minSinceLastSuccess)} min (umbral ${RED_THRESHOLD_MIN} min)`,
      );
    }
    if (lastAnthropicStatus === 'error') {
      alertReasons.push('último llamado a Anthropic API terminó en error (no-529)');
    }
  } else if (minSinceLastSuccess > YELLOW_THRESHOLD_MIN || lastAnthropicStatus === '529') {
    alertLevel = 'yellow';
    if (minSinceLastSuccess > YELLOW_THRESHOLD_MIN) {
      alertReasons.push(
        `sin cron exitoso en los últimos ${Math.round(minSinceLastSuccess)} min (umbral ${YELLOW_THRESHOLD_MIN} min)`,
      );
    }
    if (lastAnthropicStatus === '529') {
      alertReasons.push('último llamado a Anthropic API recibió 529 (overloaded)');
    }
  }

  // ── 5. Compose response ───────────────────────────────────────────────
  const body = {
    checked_at: now.toISOString(),
    last_successful_cron_run: lastSuccessfulRow?.started_at ?? null,
    last_anthropic_call_status: lastAnthropicStatus,
    games_today_total: gamesTodayTotal,
    games_today_analyzed: gamesTodayAnalyzed,
    games_today_pending_in_window: gamesTodayPendingInWindow,
    alert_level: alertLevel,
    alert_reasons: alertReasons,
  };

  // ── 6. Telegram alert if red; log if yellow ───────────────────────────
  if (alertLevel === 'red') {
    const reasons = alertReasons.join(' · ');
    void sendTelegramMessage(
      `🔴 *Health alert* — ${reasons}\n\n` +
        `Último cron exitoso: ${lastSuccessfulAt ? lastSuccessfulAt.toLocaleString('es-MX', { timeZone: 'America/Mexico_City' }) : 'nunca'}\n` +
        `Anthropic: ${lastAnthropicStatus} · Analizados hoy: ${gamesTodayAnalyzed}`,
    );
  } else if (alertLevel === 'yellow') {
    console.warn('[health/full] yellow alert:', alertReasons);
  } else {
    console.log('[health/full] green', {
      min_since_last_success: Math.round(minSinceLastSuccess),
      anthropic: lastAnthropicStatus,
    });
  }

  return NextResponse.json(body);
}
