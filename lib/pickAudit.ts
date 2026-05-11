// Quality audit for picks before they reach Telegram.
//
// Run after CAPA-1 mapping + gate of floor + CAPA-2/3 lock-in flow decides
// the side / tier / consensus. The audit is the LAST safety net: a pick
// that passes all upstream filters still needs to clear quality criteria
// derived from the 2026-05-10 post-mortem before it gets sent to the user.
//
// Failures put the pick in DB with status='filtered_quality_audit' (visible
// in /tracker for manual review) but DO NOT send Telegram.
// Warnings are persisted to audit_failures but do not block notification.

export interface AuditablePick {
  tier: string;
  edge: number;
  edge_vs_market: number | null;
  market_sources_count: number;
  floor_applied: 'lock' | 'strong' | 'none' | null;
  confidence: number;
  confidence_raw: number;
  odds_decimal: number;
  risk_factors: string | null;
}

export interface QualityAuditResult {
  passed: boolean;
  failures: string[];
  warnings: string[];
}

/**
 * Audit a single pick against quality criteria. Failures filter the pick
 * (status='filtered_quality_audit'). Warnings persist as audit_failures
 * but don't block notification.
 */
export function auditPickQuality(row: AuditablePick): QualityAuditResult {
  const failures: string[] = [];
  const warnings: string[] = [];

  // ── CRITICAL CHECKS (fail = filter the pick) ───────────────────────────

  // 1. Full market consensus required (DK ML + ESPN BPI both contributed).
  if ((row.market_sources_count ?? 0) < 2) {
    failures.push('market_sources_count_below_2');
  }

  // 2. edge_vs_market must be computed (consensus exists).
  if (row.edge_vs_market === null || row.edge_vs_market === undefined) {
    failures.push('edge_vs_market_null');
  }

  // 3. Floor must have promoted — gate confirmed the edge is real,
  // OR Claude's organic confidence cleared the tier threshold.
  if (!row.floor_applied || row.floor_applied === 'none') {
    failures.push('floor_not_applied');
  }

  // 4. DK odds usable (defensive — earlier filters should have caught this).
  if (!row.odds_decimal || row.odds_decimal <= 1.01) {
    failures.push('invalid_dk_odds');
  }

  // 5. Tier-specific minimum edge_vs_market.
  if (row.tier === 'lock') {
    if (row.edge_vs_market === null || row.edge_vs_market < 0.03) {
      failures.push('lock_tier_edge_vs_market_below_3pct');
    }
  } else if (row.tier === 'strong') {
    if (row.edge_vs_market === null || row.edge_vs_market < 0.02) {
      failures.push('strong_tier_edge_vs_market_below_2pct');
    }
  }

  // ── CONSISTENCY CHECKS (warning only, do not filter) ───────────────────

  // 6. Gap between raw edge and edge_vs_market. If big, our real_probability
  //    is far from the implied — could be a legit edge or an outlier model.
  if (row.edge_vs_market !== null && row.edge !== null) {
    const gap = Math.abs(row.edge - row.edge_vs_market);
    if (gap > 0.03) {
      warnings.push(`edge_market_gap_${(gap * 100).toFixed(1)}pct`);
    }
  }

  // 7. Confidence boost from floor too aggressive — large delta means the
  //    organic Claude conviction was much lower than the post-floor value.
  if (row.confidence !== null && row.confidence_raw !== null) {
    const delta = row.confidence - row.confidence_raw;
    if (delta > 25) {
      warnings.push(`confidence_floor_boost_${delta}pp`);
    }
  }

  // 8. Risk factors that contradict a LOCK/STRONG tier — heuristic keyword
  //    check on the Claude-provided risk_factors string.
  if ((row.tier === 'lock' || row.tier === 'strong') && row.risk_factors) {
    const criticalKeywords = [
      'critical',
      'major injury',
      'starting pitcher out',
      'goalie pulled',
      'star player out',
    ];
    const rfLower = row.risk_factors.toLowerCase();
    const hits = criticalKeywords.filter((k) => rfLower.includes(k));
    if (hits.length > 0) {
      warnings.push(`risk_factors_contradict_${row.tier}_tier`);
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    warnings,
  };
}
