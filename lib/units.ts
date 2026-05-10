import type { Tier } from './types';

const TIER_UNITS: Record<Tier, number> = {
  lock: 2,
  strong: 1.5,
  value: 1,
  parlay: 0.5,
};

const TIER_DOWNGRADE: Record<Tier, Tier> = {
  lock: 'strong',
  strong: 'value',
  value: 'value',
  parlay: 'parlay',
};

export const unitSize = (bankroll: number, unitPercentage: number): number =>
  bankroll * (unitPercentage / 100);

export const tierForOdds = (tier: Tier, oddsDecimal: number): Tier =>
  oddsDecimal < 1.4 ? TIER_DOWNGRADE[tier] : tier;

export const tierFromConfidence = (confidence: number): Tier => {
  if (confidence >= 85) return 'lock';
  if (confidence >= 70) return 'strong';
  if (confidence >= 55) return 'value';
  return 'parlay';
};

export const recommendedAmount = (
  tier: Tier,
  unit: number,
  oddsDecimal: number,
): number => {
  const adjustedTier = tierForOdds(tier, oddsDecimal);
  const units = TIER_UNITS[adjustedTier];
  return Math.round(units * unit);
};

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

const TIER_RANGE: Record<Tier, string> = {
  lock: '85-100%',
  strong: '70-84%',
  value: '55-69%',
  parlay: '',
};

const TIER_EMOJI: Record<Tier, string> = {
  lock: '🔒',
  strong: '✅',
  value: '⚠️',
  parlay: '🎯',
};

const TIER_NAME: Record<Tier, string> = {
  lock: 'LOCK',
  strong: 'STRONG',
  value: 'VALUE',
  parlay: 'PARLAY',
};

export const tierLabel = (tier: Tier, confidence?: number | null): string => {
  const base = `${TIER_EMOJI[tier]} ${TIER_NAME[tier]}`;
  const range = TIER_RANGE[tier];
  if (tier === 'parlay') return base;
  const conf = confidence != null ? ` · ${Math.round(confidence)}%` : '';
  return `${base} ${range}${conf}`;
};
