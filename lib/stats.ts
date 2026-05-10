import type { Bet } from './types';

export interface BetStats {
  total: number;
  pending: number;
  wins: number;
  losses: number;
  cashouts: number;
  early_payouts: number;
  win_rate: number;
  total_staked: number;
  total_returned: number;
  pl: number;
  roi: number;
  current_streak: { type: 'W' | 'L' | null; n: number };
  longest_win_streak: number;
}

export function computeStats(bets: Bet[]): BetStats {
  const settled = bets.filter((b) => b.result !== 'pending');
  const wins = settled.filter((b) => b.result === 'win' || b.result === 'early_payout');
  const losses = settled.filter((b) => b.result === 'loss');
  const cashouts = settled.filter((b) => b.result === 'cashout');

  const total_staked = settled.reduce((s, b) => s + Number(b.amount || 0), 0);
  const total_returned = settled.reduce((s, b) => s + Number(b.payout || 0), 0);
  const pl = total_returned - total_staked;
  const roi = total_staked > 0 ? (pl / total_staked) * 100 : 0;

  const sortedDesc = [...settled].sort((a, b) =>
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  let streakType: 'W' | 'L' | null = null;
  let streakN = 0;
  for (const b of sortedDesc) {
    const isW = b.result === 'win' || b.result === 'early_payout';
    const isL = b.result === 'loss';
    if (!isW && !isL) continue;
    const t = isW ? 'W' : 'L';
    if (streakType === null) {
      streakType = t;
      streakN = 1;
    } else if (streakType === t) {
      streakN++;
    } else {
      break;
    }
  }

  let longestW = 0;
  let runW = 0;
  for (const b of [...settled].reverse()) {
    if (b.result === 'win' || b.result === 'early_payout') {
      runW++;
      if (runW > longestW) longestW = runW;
    } else if (b.result === 'loss') {
      runW = 0;
    }
  }

  return {
    total: bets.length,
    pending: bets.filter((b) => b.result === 'pending').length,
    wins: wins.length,
    losses: losses.length,
    cashouts: cashouts.length,
    early_payouts: settled.filter((b) => b.result === 'early_payout').length,
    win_rate: wins.length + losses.length > 0
      ? (wins.length / (wins.length + losses.length)) * 100
      : 0,
    total_staked,
    total_returned,
    pl,
    roi,
    current_streak: { type: streakType, n: streakN },
    longest_win_streak: longestW,
  };
}

export function groupBy<T>(arr: T[], key: (t: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const x of arr) {
    const k = key(x) || 'other';
    (out[k] ??= []).push(x);
  }
  return out;
}

export interface ClvSummary {
  count: number;
  average: number;
  positive_count: number;
  negative_count: number;
}

export function computeClv(bets: Bet[]): { overall: ClvSummary; bySport: Record<string, ClvSummary> } {
  const withClv = bets.filter((b) => b.clv != null && Number.isFinite(Number(b.clv)));
  const summary = (xs: Bet[]): ClvSummary => {
    if (xs.length === 0) return { count: 0, average: 0, positive_count: 0, negative_count: 0 };
    const vals = xs.map((b) => Number(b.clv));
    return {
      count: xs.length,
      average: vals.reduce((a, b) => a + b, 0) / xs.length,
      positive_count: vals.filter((v) => v > 0).length,
      negative_count: vals.filter((v) => v < 0).length,
    };
  };
  const bySport: Record<string, ClvSummary> = {};
  for (const [sport, xs] of Object.entries(groupBy(withClv, (b) => b.sport))) {
    bySport[sport] = summary(xs);
  }
  return { overall: summary(withClv), bySport };
}

export interface WeekPoint {
  week: string;
  win_rate: number;
  bets: number;
}

const TIER_UNITS_FIXED: Record<string, number> = {
  lock: 2,
  strong: 1.5,
  value: 1,
  parlay: 0.5,
};

export function computeWeeklyWinRate(bets: Bet[]): WeekPoint[] {
  const settled = bets.filter((b) => b.result === 'win' || b.result === 'loss' || b.result === 'early_payout');
  const byWeek = new Map<string, Bet[]>();
  for (const b of settled) {
    const d = new Date(b.created_at);
    // ISO-week-ish: YYYY-Www (Monday-based)
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() - day + 1);
    const key = d.toISOString().slice(0, 10);
    const arr = byWeek.get(key) ?? [];
    arr.push(b);
    byWeek.set(key, arr);
  }
  const out: WeekPoint[] = [];
  const sortedKeys: string[] = [];
  byWeek.forEach((_v, k) => sortedKeys.push(k));
  sortedKeys.sort();
  for (const k of sortedKeys) {
    const arr = byWeek.get(k)!;
    const wins = arr.filter((b) => b.result === 'win' || b.result === 'early_payout').length;
    const losses = arr.filter((b) => b.result === 'loss').length;
    const total = wins + losses;
    if (total === 0) continue;
    out.push({
      week: k.slice(5),
      win_rate: (wins / total) * 100,
      bets: total,
    });
  }
  return out;
}

export interface KellyVsFixed {
  kelly_staked: number;
  kelly_returned: number;
  kelly_pl: number;
  kelly_roi: number;
  fixed_staked: number;
  fixed_returned: number;
  fixed_pl: number;
  fixed_roi: number;
  reference_bankroll: number;
}

/**
 * Approximate comparison between actual Kelly-sized stakes and what would
 * have happened with flat-units-by-tier sizing. Uses the *current* bankroll
 * as the reference for fixed-unit calc retroactively (rough approximation —
 * a real backtest would track bankroll evolution per-bet).
 */
export function computeKellyVsFixed(
  bets: Bet[],
  currentBankroll: number,
  unitPercentage = 5,
): KellyVsFixed {
  const settled = bets.filter((b) => b.result === 'win' || b.result === 'loss' || b.result === 'early_payout' || b.result === 'cashout');
  let kelly_staked = 0;
  let kelly_returned = 0;
  let fixed_staked = 0;
  let fixed_returned = 0;

  const unit = currentBankroll * (unitPercentage / 100);

  for (const b of settled) {
    const stake = Number(b.amount);
    const payout = Number(b.payout ?? 0);
    const odds = Number(b.odds_decimal);
    kelly_staked += stake;
    kelly_returned += payout;

    const tier = (b.tier ?? 'value') as keyof typeof TIER_UNITS_FIXED;
    const units = TIER_UNITS_FIXED[tier] ?? 1;
    const fixedStake = unit * units;
    fixed_staked += fixedStake;

    const won = b.result === 'win' || b.result === 'early_payout';
    const cashout = b.result === 'cashout';
    if (won) fixed_returned += fixedStake * odds; // amount + profit
    else if (cashout) fixed_returned += fixedStake * (payout / Math.max(1, stake)); // proportional
    // else loss: 0 returned
  }

  const kelly_pl = kelly_returned - kelly_staked;
  const fixed_pl = fixed_returned - fixed_staked;
  return {
    kelly_staked,
    kelly_returned,
    kelly_pl,
    kelly_roi: kelly_staked > 0 ? (kelly_pl / kelly_staked) * 100 : 0,
    fixed_staked,
    fixed_returned,
    fixed_pl,
    fixed_roi: fixed_staked > 0 ? (fixed_pl / fixed_staked) * 100 : 0,
    reference_bankroll: currentBankroll,
  };
}
