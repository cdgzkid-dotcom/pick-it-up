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
