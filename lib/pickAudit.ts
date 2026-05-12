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
//
// 2026-05-12 update — Lakers @ 5.25 LOCK hallucination post-mortem.
// Added outlier-detection checks (#9-11) and escalated structural warnings
// to FAIL when the tier asserts high conviction (LOCK / STRONG). The
// pre-existing checks #1-5 only verified that DATA was present; they did
// not verify that the data was REASONABLE. A LOCK pick on a +425 underdog
// with edge_vs_market=27% (vs market consensus ≈25%) cleared every prior
// check while being a textbook hallucination. The new checks attack that
// pattern from three angles: statistical outlier, weak base signal, and
// structural absurdity (long odds + LOCK tier).

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
  /** Pinnacle integration (2026-05-12). When pinnacle_status='available'
   *  the audit enforces an extra check on LOCK picks: a 2pp disagreement
   *  vs Pinnacle is the minimum bar to claim sharp-confirmed edge. */
  pinnacle_status?: string | null;
  edge_vs_pinnacle?: number | null;
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

  // ── CRITICAL CHECKS — STRUCTURAL (fail = filter the pick) ──────────────

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

  // ── CRITICAL CHECKS — OUTLIER DETECTION (post-Lakers hallucination) ────

  // 9. Excessive edge vs market — sharp markets (MLB/NBA/NFL/NHL) are
  //    accurate to a few pp; an edge > 15pp vs the consensus is almost
  //    never legitimate, it's the model hallucinating.
  //    Lakers @ 5.25: edge_vs_market = 0.27 → blocked.
  if (row.edge_vs_market !== null && row.edge_vs_market !== undefined) {
    if (row.edge_vs_market > 0.15) {
      failures.push('edge_vs_market_excessive');
    }
  }

  // 10. LOCK tier with weak base confidence — the floor gate may promote
  //     confidence to 85 even when Claude's organic confidence_raw was
  //     low. A LOCK is a max-conviction pick; promoting from <65 base is
  //     amplifying weak signal into false certainty.
  //     Lakers: tier=lock, confidence_raw=58 → blocked.
  if (row.tier === 'lock' && row.confidence_raw < 65) {
    failures.push('lock_with_low_raw_confidence');
  }

  // 11. LOCK tier with long odds — LOCKs are meant to be high-conviction
  //     plays, typically on favorites or modest underdogs. A LOCK on
  //     odds > 2.5 (= +150 American) is structurally suspicious: real
  //     LOCKs at long odds imply huge edges that themselves are bug-prone.
  //     Lakers @ 5.25 → blocked.
  if (row.tier === 'lock' && row.odds_decimal > 2.5) {
    failures.push('lock_tier_long_odds');
  }

  // 12. LOCK tier without enough disagreement vs Pinnacle (2026-05-12).
  //     Pinnacle is the sharp-book reference; when their line is available
  //     we hold LOCK picks to a stricter bar: real_probability must beat
  //     Pinnacle's implied by ≥ 2pp. If Pinnacle is not available
  //     (api_error, matchup_not_found, sport_unsupported, no_ml_open) this
  //     check is skipped — the system still uses DK + BPI consensus.
  if (
    row.tier === 'lock' &&
    row.pinnacle_status === 'available' &&
    (row.edge_vs_pinnacle == null || row.edge_vs_pinnacle < 0.02)
  ) {
    failures.push('lock_edge_vs_pinnacle_below_2pct');
  }

  // ── CONSISTENCY CHECKS (tier-sensitive: WARN for value, FAIL for high tiers) ─

  // 6. Gap between raw edge and edge_vs_market. If big, our real_probability
  //    is far from the implied — could be a legit edge or an outlier model.
  //    For LOCK / STRONG tiers this is a blocking failure: high-conviction
  //    picks shouldn't sit on a wobbly internal/external disagreement.
  if (row.edge_vs_market !== null && row.edge !== null) {
    const gap = Math.abs(row.edge - row.edge_vs_market);
    if (gap > 0.03) {
      const label = `edge_market_gap_${(gap * 100).toFixed(1)}pct`;
      if (row.tier === 'lock' || row.tier === 'strong') {
        failures.push(`${label}_${row.tier}_blocking`);
      } else {
        warnings.push(label);
      }
    }
  }

  // 7. Confidence boost from floor too aggressive — large delta means the
  //    organic Claude conviction was much lower than the post-floor value.
  //    For LOCK tier this is a FAIL: we don't sell max conviction on a
  //    >25pp amplified signal. STRONG/VALUE remains a warning.
  if (row.confidence !== null && row.confidence_raw !== null) {
    const delta = row.confidence - row.confidence_raw;
    if (delta > 25) {
      const label = `confidence_floor_boost_${delta}pp`;
      if (row.tier === 'lock') {
        failures.push(`${label}_lock_blocking`);
      } else {
        warnings.push(label);
      }
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
