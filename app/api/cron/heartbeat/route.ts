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
    .select(
      'id, status, locked_at, telegram_notified_at, tier, edge, edge_vs_market, market_sources_count, floor_applied, confidence, confidence_raw, is_parlay',
    )
    .gte('created_at', since24h);
  const generated = picks24h?.length ?? 0;
  const notified = picks24h?.filter((p) => p.telegram_notified_at).length ?? 0;
  // Split CAPA-2/3 supersedes (real lock-in flow) from legacy bare 'superseded'
  // (pre-CAPA-2 mechanism, kept around as 'superseded_legacy' for audit).
  const supersededCapa = picks24h?.filter((p) =>
    p.status === 'superseded_edge_evaporated' ||
    p.status === 'superseded_line_moved_against' ||
    p.status === 'superseded_flipped_side',
  ).length ?? 0;
  const supersededLegacy = picks24h?.filter((p) =>
    p.status === 'superseded' || p.status === 'superseded_legacy',
  ).length ?? 0;
  // Lockable picks = post-CAPA-2 singles. Parlays never take the lock-in
  // path (server regenerates parlay combinations every run), so we filter
  // them out defensively even though they normally have locked_at=null.
  // This is the canonical sample for BOTH the supersede-ratio auto-alert
  // and the CAPA-3 quality metrics block.
  const lockablePicks = picks24h?.filter((p) => p.locked_at !== null && !p.is_parlay) ?? [];
  // Auto-alert (existing): supersede ratio. Threshold of 30% picked because
  // 0-15% is normal and >30% is pathological for a sticky lock-in.
  const capaSupersedeRatio =
    lockablePicks.length > 0 ? supersededCapa / lockablePicks.length : 0;
  const alertLine =
    lockablePicks.length >= 10 && capaSupersedeRatio > 0.30
      ? `\n⚠️ ALERT: ${(capaSupersedeRatio * 100).toFixed(0)}% CAPA supersede ratio (${supersededCapa}/${lockablePicks.length}). Investigate.`
      : '';
  const supersededStr =
    supersededLegacy > 0
      ? `${supersededCapa} CAPA, ${supersededLegacy} legacy`
      : `${supersededCapa} superseded`;

  // ── CAPA-3 quality metrics ────────────────────────────────────────────
  // Surface pick-quality signals so the user can tell BEFORE betting whether
  // today's picks are trustworthy. We only emit the block when the sample
  // is statistically meaningful (>= 5 lockable picks); below that, metrics
  // would mislead more than inform.
  const notifiedLockable = lockablePicks.filter((p) => p.telegram_notified_at);
  const haveSample = lockablePicks.length >= 5;
  const qualityAlerts: string[] = [];
  let qualityMetrics = '';
  if (haveSample) {
    // (1) avg edge vs market — only picks with consensus contribute.
    const withConsensus = lockablePicks.filter((p) => p.edge_vs_market !== null);
    const avgEdgeVsMarket =
      withConsensus.length > 0
        ? withConsensus.reduce((s, p) => s + Number(p.edge_vs_market), 0) / withConsensus.length
        : null;
    // (2) % with full market consensus (DK + BPI).
    const fullConsensusCount = lockablePicks.filter((p) => (p.market_sources_count ?? 0) >= 2).length;
    const fullConsensusPct = (fullConsensusCount / lockablePicks.length) * 100;
    // (3) % of notified picks with floor applied (vs Claude-organic tier).
    const notifiedWithFloor = notifiedLockable.filter(
      (p) => p.floor_applied && p.floor_applied !== 'none',
    ).length;
    const floorAppliedPct =
      notifiedLockable.length > 0 ? (notifiedWithFloor / notifiedLockable.length) * 100 : 0;
    // (4) STRONG/LOCK with insufficient market consensus — most dangerous combo.
    const strongLockTotal = notifiedLockable.filter(
      (p) => p.tier === 'strong' || p.tier === 'lock',
    ).length;
    const strongLockMissingConsensus = notifiedLockable.filter(
      (p) => (p.tier === 'strong' || p.tier === 'lock') && (p.market_sources_count ?? 0) < 2,
    ).length;

    qualityMetrics =
      `\n\n🎯 *Calidad de picks 24h:*\n` +
      `Avg edge vs market: ${avgEdgeVsMarket !== null ? (avgEdgeVsMarket * 100).toFixed(1) + '%' : 'n/a'}\n` +
      `Picks con consenso completo: ${fullConsensusCount}/${lockablePicks.length} (${fullConsensusPct.toFixed(0)}%)\n` +
      `Notificados con floor aplicado: ${notifiedWithFloor}/${notifiedLockable.length} (${floorAppliedPct.toFixed(0)}%)`;

    // Thresholds derived from system logic, not arbitrary:
    //   • avg edge < 1pp → likely fantasma edge (post-mortem 2026-05-10 pattern)
    //   • <50% consensus → most picks were promoted on partial data
    //   • STRONG/LOCK without consensus → exactly the failure mode from post-mortem
    //   • <60% floor applied on notified → Claude organic confidence drove the tier
    if (avgEdgeVsMarket !== null && avgEdgeVsMarket < 0.01) {
      qualityAlerts.push(
        `Avg edge vs market is ${(avgEdgeVsMarket * 100).toFixed(1)}% — likely edge fantasma`,
      );
    }
    if (fullConsensusPct < 50) {
      qualityAlerts.push(
        `Only ${fullConsensusPct.toFixed(0)}% picks have full market consensus (need >=50%)`,
      );
    }
    if (strongLockTotal > 0 && strongLockMissingConsensus > 0) {
      qualityAlerts.push(
        `${strongLockMissingConsensus} of ${strongLockTotal} STRONG/LOCK picks lack market consensus — HIGH RISK`,
      );
    }
    if (notifiedLockable.length >= 3 && floorAppliedPct < 60) {
      qualityAlerts.push(
        `Only ${floorAppliedPct.toFixed(0)}% of notified picks had floor applied — Claude may be over-confident`,
      );
    }
  }

  const { data: bets24h } = await sb
    .from('bets')
    .select(
      'id, result, amount, payout, pick_id, created_at, game_start_time, odds_at_bet, odds_at_close, clv',
    )
    .gte('created_at', since24h)
    .in('result', ['win', 'loss', 'push']);
  const wins = bets24h?.filter((b) => b.result === 'win').length ?? 0;
  const losses = bets24h?.filter((b) => b.result === 'loss').length ?? 0;
  const pl = bets24h?.reduce(
    (s, b) => s + (Number(b.payout ?? 0) - Number(b.amount ?? 0)),
    0,
  ) ?? 0;

  // ── Decision quality 24h (Auditoría 4) ─────────────────────────────────
  // CLV (Closing Line Value) per bet is already persisted with the implied-
  // probability-difference convention. Here we average across resolved
  // wins/losses + compute response-time gaps for the user behavior side.
  const resolvedBets = bets24h?.filter((b) => b.result === 'win' || b.result === 'loss') ?? [];
  const betsWithClv = resolvedBets.filter((b) => b.clv !== null && b.clv !== undefined);
  const clvSum = betsWithClv.reduce((s, b) => s + Number(b.clv), 0);
  const clvCount = betsWithClv.length;
  const avgClv = clvCount > 0 ? clvSum / clvCount : null;

  const pickIds = resolvedBets
    .map((b) => b.pick_id)
    .filter((x): x is string => Boolean(x));
  let pickMap = new Map<string, { telegram_notified_at: string | null }>();
  if (pickIds.length > 0) {
    const { data: picks } = await sb
      .from('picks')
      .select('id, telegram_notified_at')
      .in('id', pickIds);
    pickMap = new Map(
      (picks ?? []).map((p) => [p.id, { telegram_notified_at: p.telegram_notified_at ?? null }]),
    );
  }

  let pickToBetGapSum = 0;
  let pickToBetGapCount = 0;
  let betToGameGapSum = 0;
  let betToGameGapCount = 0;
  for (const bet of resolvedBets) {
    if (bet.pick_id) {
      const p = pickMap.get(bet.pick_id);
      if (p?.telegram_notified_at) {
        const gap =
          (new Date(bet.created_at).getTime() - new Date(p.telegram_notified_at).getTime()) /
          60000;
        // sanity: must be 0..24h. Negative would be bet-before-notify (rare,
        // happens with manual bets); >24h is stale data.
        if (gap >= 0 && gap < 24 * 60) {
          pickToBetGapSum += gap;
          pickToBetGapCount += 1;
        }
      }
    }
    if (bet.game_start_time) {
      const gap =
        (new Date(bet.game_start_time).getTime() - new Date(bet.created_at).getTime()) / 60000;
      // sanity: 0..7d. Negative = bet after game start (shouldn't happen).
      if (gap >= 0 && gap < 7 * 24 * 60) {
        betToGameGapSum += gap;
        betToGameGapCount += 1;
      }
    }
  }
  const avgPickToBetMin = pickToBetGapCount > 0 ? pickToBetGapSum / pickToBetGapCount : null;
  const avgBetToGameMin = betToGameGapCount > 0 ? betToGameGapSum / betToGameGapCount : null;

  // CLV alert: 5+ bets with negative avg → market consistently moved against
  // us → system likely identifying false edges.
  if (clvCount >= 5 && avgClv !== null && avgClv < -0.01) {
    qualityAlerts.push(
      `Avg CLV is ${(avgClv * 100).toFixed(1)}pp over ${clvCount} bets — market moved against us (system may not have edge)`,
    );
  }

  let decisionQuality = '';
  if (clvCount >= 1) {
    const clvSign = avgClv !== null && avgClv >= 0 ? '+' : '';
    const clvStr = avgClv !== null ? `${clvSign}${(avgClv * 100).toFixed(1)}pp` : 'n/a';
    decisionQuality = `\n\n🎯 *Decision quality 24h:*\n`;
    decisionQuality += `Avg CLV: ${clvStr} (${clvCount} bets)\n`;
    if (avgPickToBetMin !== null) {
      decisionQuality += `Avg pick → bet: ${avgPickToBetMin.toFixed(0)} min\n`;
    }
    if (avgBetToGameMin !== null) {
      decisionQuality += `Avg bet → game: ${avgBetToGameMin.toFixed(0)} min`;
    }
  }

  // Build alerts block AFTER all alert pushes (quality + CLV) finish.
  const qualityAlertsBlock =
    qualityAlerts.length > 0
      ? `\n\n⚠️ *ALERTS:*\n` + qualityAlerts.map((a) => `• ${a}`).join('\n')
      : '';

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
  const SPORT_RETURNS: Record<string, string> = {
    espn_predictor_nfl: 'sep',
    espn_predictor_nba: 'oct',
    espn_predictor_nhl: 'oct',
    espn_predictor_mlb: 'mar',
  };
  let healthSummary = 'unknown';
  let offSeasonLine = '';
  try {
    const r = await fetch(healthUrl, { signal: AbortSignal.timeout(15000) });
    const h = (await r.json()) as {
      ok: boolean;
      summary: { ok: number; errors: number; warnings: number; total: number; off_season?: string[] };
    };
    healthSummary = h.ok
      ? `✅ ${h.summary.ok}/${h.summary.total} checks ok`
      : `❌ ${h.summary.errors} errors, ${h.summary.warnings} warnings`;
    if (h.summary.off_season && h.summary.off_season.length > 0) {
      const parts = h.summary.off_season.map((name) => {
        const sport = name.replace('espn_predictor_', '').toUpperCase();
        const ret = SPORT_RETURNS[name] ?? '?';
        return `${sport} (vuelve ${ret})`;
      });
      offSeasonLine = `\n💤 Off-season: ${parts.join(', ')}`;
    }
  } catch {
    healthSummary = '⚠️ health endpoint unreachable';
  }

  const today = new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
  const plSign = pl >= 0 ? '+' : '';
  const stuckLine = (stuck?.length ?? 0) > 0 ? `\n⚠️ Stuck pending bets: ${stuck!.length}` : '';

  return `📊 *Daily Health · ${today}*
─────────────────────
Picks generated 24h: ${generated}
Notified: ${notified} (${supersededStr})
Bets resolved: ${wins}W-${losses}L (P/L ${plSign}$${pl.toFixed(2)})
Bankroll: $${bankroll.toFixed(2)}
System: ${healthSummary}${offSeasonLine}${stuckLine}${alertLine}${qualityMetrics}${decisionQuality}${qualityAlertsBlock}`;
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
