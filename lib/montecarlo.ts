// Monte Carlo simulation for a slate of picks. Runs 10K trials of the day's
// picks treating each as an independent Bernoulli at its `real_probability`,
// reporting profit distribution stats.

export interface MCPick {
  real_probability: number;
  odds_decimal: number;
  recommended_amount: number;
}

export interface SimResult {
  simulations: number;
  profit_probability: number; // P(total profit > 0)
  expected_value: number;
  worst_case_5p: number;
  best_case_95p: number;
  median: number;
  total_at_risk: number;
}

const SIMULATIONS = 10000;

export function simulateDay(picks: MCPick[]): SimResult {
  if (picks.length === 0) {
    return {
      simulations: 0,
      profit_probability: 0,
      expected_value: 0,
      worst_case_5p: 0,
      best_case_95p: 0,
      median: 0,
      total_at_risk: 0,
    };
  }

  const profits: number[] = new Array(SIMULATIONS);
  const totalAtRisk = picks.reduce((s, p) => s + p.recommended_amount, 0);

  for (let i = 0; i < SIMULATIONS; i++) {
    let dayProfit = 0;
    for (const p of picks) {
      const won = Math.random() < p.real_probability;
      if (won) dayProfit += p.recommended_amount * (p.odds_decimal - 1);
      else dayProfit -= p.recommended_amount;
    }
    profits[i] = dayProfit;
  }

  profits.sort((a, b) => a - b);
  const idx = (pct: number) => profits[Math.floor(SIMULATIONS * pct)];
  const positive = profits.filter((p) => p > 0).length;
  const ev = profits.reduce((a, b) => a + b, 0) / SIMULATIONS;

  return {
    simulations: SIMULATIONS,
    profit_probability: positive / SIMULATIONS,
    expected_value: ev,
    worst_case_5p: idx(0.05),
    best_case_95p: idx(0.95),
    median: idx(0.5),
    total_at_risk: totalAtRisk,
  };
}
