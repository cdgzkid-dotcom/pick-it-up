// HTTP health probe. Thin wrapper around lib/healthChecks — the actual
// check functions live there so cron/analyze can call them directly
// (Auditoría 5 — visible health indicator in Telegram messages) without
// paying for an outbound fetch to this route.
//
// Response shape is preserved: { ok, summary: {total, ok, warnings, errors},
// duration_ms, timestamp, checks }. HTTP 503 if any check errored, 200
// otherwise.

import { NextResponse } from 'next/server';
import { runHealthChecks, buildHealthSummary } from '@/lib/healthChecks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET() {
  const t0 = Date.now();
  const checks = await runHealthChecks();
  const summary = buildHealthSummary(checks);
  return NextResponse.json(
    {
      ok: summary.errors === 0,
      summary: {
        total: summary.total,
        ok: summary.ok,
        warnings: summary.warnings,
        errors: summary.errors,
        off_season: summary.offSeasonNames,
      },
      duration_ms: Date.now() - t0,
      timestamp: new Date().toISOString(),
      checks,
    },
    { status: summary.errors > 0 ? 503 : 200 },
  );
}
