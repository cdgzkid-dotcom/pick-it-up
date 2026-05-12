export const impliedProbability = (oddsDecimal: number): number => 1 / oddsDecimal;

export const edgeOf = (realProb: number, oddsDecimal: number): number =>
  realProb - impliedProbability(oddsDecimal);

export const adjustedEdgeScore = (realProb: number, oddsDecimal: number): number => {
  const e = edgeOf(realProb, oddsDecimal);
  return e * Math.sqrt(oddsDecimal);
};

export const expectedReturn = (realProb: number, oddsDecimal: number): number =>
  realProb * (oddsDecimal - 1) - (1 - realProb);

export type MarketSource = 'draftkings_ml' | 'espn_bpi' | 'other_book_ml' | 'pinnacle_ml';

export interface MarketConsensus {
  sources: MarketSource[];
  sources_count: number;
  avg_implied_prob: number; // 0-1
  edge_vs_market: number; // realProb - avg_implied
  /** edge_vs_pinnacle is a SEPARATE field from edge_vs_market — Pinnacle
   *  feeds into the simple-average consensus like any other source, but
   *  Auditoría 2 v2 also checks the standalone Pinnacle disagreement
   *  (lock_edge_vs_pinnacle_below_2pct) to raise the bar on LOCK picks
   *  when sharp money is available. null when Pinnacle didn't contribute. */
  edge_vs_pinnacle: number | null;
}

/**
 * Average market-book ML, ESPN BPI, and Pinnacle ML implied probabilities
 * for the picked side. All inputs are 0-1 probs OR null. The downstream
 * gate requires `sources_count >= 2` to apply the floor; one or zero
 * sources keeps the tier at whatever Claude chose organically.
 *
 * IMPORTANT: avg_implied_prob is a simple (unweighted) mean. The floor's
 * tier thresholds (3pp for LOCK, 2pp for STRONG) were calibrated against
 * a simple-mean consensus; switching to weighted would silently shift
 * which picks reach LOCK. Pinnacle therefore counts as 1 of N like any
 * other source — its "sharpness" advantage is captured via the
 * standalone edge_vs_pinnacle field that Auditoría 2 v2 checks.
 *
 * `bookSlug` is the ESPN-normalized provider name (e.g. "draftkings",
 * "caesars"). ESPN rotates providers between seasons (especially NFL), so
 * we accept whatever they hand us and just label non-DraftKings sources
 * as 'other_book_ml' in the persisted sources array.
 */
export function computeMarketConsensus(
  marketBookImplied: number | null,
  bookSlug: string | null,
  espnBpiImplied: number | null,
  pinnacleImplied: number | null,
  realProb: number,
): MarketConsensus | null {
  const sources: MarketSource[] = [];
  const values: number[] = [];
  if (marketBookImplied != null && marketBookImplied > 0 && marketBookImplied < 1) {
    const slug: MarketSource = bookSlug === 'draftkings' ? 'draftkings_ml' : 'other_book_ml';
    sources.push(slug);
    values.push(marketBookImplied);
  }
  if (espnBpiImplied != null && espnBpiImplied > 0 && espnBpiImplied < 1) {
    sources.push('espn_bpi');
    values.push(espnBpiImplied);
  }
  if (pinnacleImplied != null && pinnacleImplied > 0 && pinnacleImplied < 1) {
    sources.push('pinnacle_ml');
    values.push(pinnacleImplied);
  }
  if (values.length === 0) return null;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const edgeVsPinnacle =
    pinnacleImplied != null && pinnacleImplied > 0 && pinnacleImplied < 1
      ? realProb - pinnacleImplied
      : null;
  return {
    sources,
    sources_count: values.length,
    avg_implied_prob: avg,
    edge_vs_market: realProb - avg,
    edge_vs_pinnacle: edgeVsPinnacle,
  };
}
