export const impliedProbability = (oddsDecimal: number): number => 1 / oddsDecimal;

export const edgeOf = (realProb: number, oddsDecimal: number): number =>
  realProb - impliedProbability(oddsDecimal);

export const adjustedEdgeScore = (realProb: number, oddsDecimal: number): number => {
  const e = edgeOf(realProb, oddsDecimal);
  return e * Math.sqrt(oddsDecimal);
};

export const expectedReturn = (realProb: number, oddsDecimal: number): number =>
  realProb * (oddsDecimal - 1) - (1 - realProb);

export type MarketSource = 'draftkings_ml' | 'espn_bpi' | 'other_book_ml';

export interface MarketConsensus {
  sources: MarketSource[];
  sources_count: number;
  avg_implied_prob: number; // 0-1
  edge_vs_market: number; // realProb - avg_implied
}

/**
 * Average market-book ML and ESPN BPI implied probabilities for the picked
 * side. Both inputs are 0-1 probs OR null. The downstream gate requires
 * `sources_count >= 2` to apply the floor; one or zero sources keeps the
 * tier at whatever Claude chose organically.
 *
 * `bookSlug` is the ESPN-normalized provider name (e.g. "draftkings",
 * "caesars"). ESPN rotates providers between seasons (especially NFL), so
 * we accept whatever they hand us and just label non-DraftKings sources
 * as 'other_book_ml' in the persisted sources array. The implied prob
 * itself is still used in the consensus — losing it would degrade the
 * gate without reason.
 */
export function computeMarketConsensus(
  marketBookImplied: number | null,
  bookSlug: string | null,
  espnBpiImplied: number | null,
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
  if (values.length === 0) return null;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return {
    sources,
    sources_count: values.length,
    avg_implied_prob: avg,
    edge_vs_market: realProb - avg,
  };
}
