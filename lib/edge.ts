export const impliedProbability = (oddsDecimal: number): number => 1 / oddsDecimal;

export const edgeOf = (realProb: number, oddsDecimal: number): number =>
  realProb - impliedProbability(oddsDecimal);

export const adjustedEdgeScore = (realProb: number, oddsDecimal: number): number => {
  const e = edgeOf(realProb, oddsDecimal);
  return e * Math.sqrt(oddsDecimal);
};

export const expectedReturn = (realProb: number, oddsDecimal: number): number =>
  realProb * (oddsDecimal - 1) - (1 - realProb);
