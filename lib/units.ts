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

export const potentialWin = (amount: number, oddsDecimal: number): number =>
  Math.round(amount * (oddsDecimal - 1));

export const tierLabel = (tier: Tier): string => {
  switch (tier) {
    case 'lock':
      return '🔒 LOCK';
    case 'strong':
      return '✅ STRONG';
    case 'value':
      return '⚠️ VALUE';
    case 'parlay':
      return '🎲 PARLAY';
  }
};
