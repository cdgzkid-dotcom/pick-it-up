import type { SupabaseClient } from '@supabase/supabase-js';
import type { Tier } from './types';

export const TIER_UNITS: Record<Tier, number> = {
  lock: 2,
  strong: 1.5,
  value: 1,
  parlay: 0.5,
};

export function tierFromProbability(
  realProbability: number,
  sport: string,
  oddsDecimal?: number,
): Tier | null {
  const thresholds: Record<string, { lock: number; strong: number; value: number }> = {
    MLB:  { lock: 0.65, strong: 0.60, value: 0.55 },
    NHL:  { lock: 0.65, strong: 0.60, value: 0.55 },
    NBA:  { lock: 0.68, strong: 0.62, value: 0.55 },
    NFL:  { lock: 0.68, strong: 0.62, value: 0.55 },
    WNBA: { lock: 0.68, strong: 0.62, value: 0.55 },
  };

  const t = thresholds[sport] ?? thresholds.MLB;

  let tier: Tier | null = null;
  if (realProbability >= t.lock) tier = 'lock';
  else if (realProbability >= t.strong) tier = 'strong';
  else if (realProbability >= t.value) tier = 'value';
  else return null;

  if (oddsDecimal != null && oddsDecimal < 1.40) {
    if (tier === 'lock') return 'strong';
    if (tier === 'strong') return 'value';
    if (tier === 'value') return null;
  }

  return tier;
}

/**
 * Half Kelly fractional bet sizing.
 * Returns { amount, fraction }. fraction is the % of bankroll wagered (0..0.10).
 * If Kelly is non-positive (no edge), returns { amount: 0, fraction: 0 }.
 *
 * Half Kelly is conservative: cuts the variance and bankroll-blow risk in half
 * vs. full Kelly, at the cost of slightly slower compounding. Capped at 10%
 * of bankroll regardless of edge magnitude (no all-in scenarios).
 */
export const kellyAmount = (
  bankroll: number,
  realProbability: number,
  oddsDecimal: number,
  options: { conservative?: boolean } = {},
): { amount: number; fraction: number } => {
  const b = oddsDecimal - 1;
  if (b <= 0 || !Number.isFinite(realProbability)) return { amount: 0, fraction: 0 };
  const p = Math.max(0, Math.min(1, realProbability));
  const q = 1 - p;
  const kelly = (p * b - q) / b;
  if (kelly <= 0) return { amount: 0, fraction: 0 };
  // half Kelly normally; quarter Kelly when trap detected (extra conservative)
  const divisor = options.conservative ? 4 : 2;
  const fractionalKelly = kelly / divisor;
  const fraction = Math.max(0.01, Math.min(0.1, fractionalKelly));
  const amount = Math.max(1, Math.round(bankroll * fraction));
  return { amount, fraction };
};

export const potentialWin = (amount: number, oddsDecimal: number): number =>
  Math.round(amount * (oddsDecimal - 1));

/**
 * Learned per-sport Kelly multiplier. Half Kelly is the baseline (0.5). When
 * the system has 30+ resolved bets in a given sport, the multiplier is
 * adjusted toward more aggressive (winning sport) or more conservative
 * (losing sport). Defaults to half Kelly while data is thin.
 */
export async function sportKellyMultiplier(
  supabase: SupabaseClient,
  sport: string,
): Promise<number> {
  try {
    const { data } = await supabase
      .from('factor_performance')
      .select('wins, losses')
      .eq('factor_name', 'sport')
      .eq('factor_value', sport)
      .maybeSingle();
    if (!data) return 0.5;
    const wins = Number(data.wins ?? 0);
    const losses = Number(data.losses ?? 0);
    const total = wins + losses;
    if (total < 30) return 0.5;
    const wr = wins / total;
    if (wr > 0.58) return 0.6;
    if (wr > 0.53) return 0.5;
    if (wr > 0.48) return 0.35;
    return 0.25;
  } catch (e) {
    console.error('[units] sportKellyMultiplier threw', e);
    return 0.5;
  }
}

const TIER_RANGE: Record<Tier, string> = {
  lock: '85-100%',
  strong: '70-84%',
  value: '55-69%',
  parlay: '',
};

export const TIER_EMOJI: Record<Tier, string> = {
  lock: '🔒',
  strong: '✅',
  value: '⚠️',
  parlay: '🎯',
};

export const TIER_NAME: Record<Tier, string> = {
  lock: 'LOCK',
  strong: 'STRONG',
  value: 'VALUE',
  parlay: 'PARLAY',
};

const TIER_STRENGTH: Record<Exclude<Tier, 'parlay'>, number> = {
  lock: 3,
  strong: 2,
  value: 1,
};

export const computeParlayTier = (legTiers: Tier[]): Tier => {
  let min: Exclude<Tier, 'parlay'> = 'lock';
  for (const t of legTiers) {
    const key = t === 'parlay' ? 'value' : t;
    if (TIER_STRENGTH[key] < TIER_STRENGTH[min]) min = key;
  }
  return min;
};

export const tierLabel = (tier: Tier, confidence?: number | null): string => {
  const base = `${TIER_EMOJI[tier]} ${TIER_NAME[tier]}`;
  const range = TIER_RANGE[tier];
  if (tier === 'parlay') return base;
  const conf = confidence != null ? ` · ${Math.round(confidence)}%` : '';
  return `${base} ${range}${conf}`;
};
