import type { SupabaseClient } from '@supabase/supabase-js';
import type { Tier } from './types';

export const TIER_UNITS: Record<Tier, number> = {
  lock: 2,
  strong: 1.5,
  value: 1,
  parlay: 0.5,
};

/**
 * Per-sport tier thresholds on real_probability.
 *
 * The VALUE floor must sit ABOVE the sport's home base rate, otherwise the
 * tier measures home-field advantage instead of edge. MLB is the reference
 * relationship: 54% base rate → 55% floor. NFL follows it (57% base → 59%
 * floor, ~2pp above). LOCK stays where the average favorite's hit rate
 * (~66.6%) is already cleared.
 *
 * Exported because tierRange() and tierBands() derive every user-facing label
 * from these numbers. Hardcoded legends have drifted twice: TIER_RANGE showed
 * "LOCK 85-100%" while the system emitted LOCK from 65% (fixed in 24af709),
 * and the home-page legend claimed "VALUE 55%+ todos los deportes" while NFL
 * had required 59% since 25804d7. Do not write these numbers anywhere else.
 */
export const SPORT_THRESHOLDS: Record<string, { lock: number; strong: number; value: number }> = {
  MLB:  { lock: 0.65, strong: 0.60, value: 0.55 },
  NHL:  { lock: 0.65, strong: 0.60, value: 0.55 },
  NBA:  { lock: 0.68, strong: 0.62, value: 0.55 },
  NFL:  { lock: 0.68, strong: 0.63, value: 0.59 },
  WNBA: { lock: 0.68, strong: 0.62, value: 0.55 },
};

export const BOOK_SPREAD_DISCOUNT: Record<string, number> = {
  // Mediana del spread de precio Draftea vs DraftKings, en puntos de
  // probabilidad implícita. CALIBRADA CON n=11 (captura simultánea
  // 2026-07-28; rango 0.65–7.34pp; 2/11 con matching dudoso por hora
  // exacta). RECALIBRAR cuando bets.book_spread_pp acumule n>=30 —
  // trigger documentado en el scratchpad de deuda técnica.
  draftea: 0.0235,
};

/**
 * Minimum decimal odds at which a pick is still worth taking at the
 * execution book. 1.05 preserves the original +5% EV bar
 * (p × odds >= 1.05). That 5% is INHERITED from EDGE_THRESHOLD, not
 * calibrated — documented per Christian's decision 2026-07-28.
 * Rounds UP to 2 decimals (conservative: never understate the bar).
 */
export const minAcceptableOdds = (realProbability: number): number =>
  Math.ceil((1.05 / realProbability) * 100 - 1e-9) / 100;

export function tierFromProbability(
  realProbability: number,
  sport: string,
  oddsDecimal?: number,
): Tier | null {
  const t = SPORT_THRESHOLDS[sport] ?? SPORT_THRESHOLDS.MLB;

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
    // This lookup is deliberately best-effort: pick generation must retain
    // the half-Kelly default when learned weights are unavailable.
    const { data, error } = await supabase
      .from('factor_performance')
      .select('wins, losses')
      .eq('factor_name', 'sport')
      .eq('factor_value', sport)
      .maybeSingle();
    if (error) {
      console.error('[units] sportKellyMultiplier read failed; using default 0.5', error);
      return 0.5;
    }
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

const pct = (n: number) => Math.round(n * 100);

/**
 * User-facing probability band for a tier, derived from SPORT_THRESHOLDS so
 * the legend can never drift from the thresholds that actually emit the tier.
 * Falls back to MLB when the sport is unknown/absent, matching
 * tierFromProbability.
 */
export const tierRange = (tier: Tier, sport?: string | null): string => {
  if (tier === 'parlay') return '';
  const t = (sport ? SPORT_THRESHOLDS[sport] : undefined) ?? SPORT_THRESHOLDS.MLB;
  if (tier === 'lock') return `${pct(t.lock)}-100%`;
  if (tier === 'strong') return `${pct(t.strong)}-${pct(t.lock) - 1}%`;
  return `${pct(t.value)}-${pct(t.strong) - 1}%`;
};

/**
 * Same band as tierRange(), but across every sport at once and collapsed by
 * shared range: "MLB/NHL 60-64% | NBA/WNBA 62-67% | NFL 63-67%".
 *
 * Exists so the tier legend can list per-sport bands without hardcoding either
 * the numbers or which sports happen to share them today — both drifted before
 * (see the note on SPORT_THRESHOLDS).
 */
export const tierBands = (tier: Exclude<Tier, 'parlay'>): string => {
  const groups: { range: string; sports: string[] }[] = [];
  for (const sport of Object.keys(SPORT_THRESHOLDS)) {
    const range = tierRange(tier, sport);
    const existing = groups.find((g) => g.range === range);
    if (existing) existing.sports.push(sport);
    else groups.push({ range, sports: [sport] });
  }
  return groups.map((g) => `${g.sports.join('/')} ${g.range}`).join(' | ');
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

export const tierLabel = (
  tier: Tier,
  sport?: string | null,
  confidence?: number | null,
): string => {
  const base = `${TIER_EMOJI[tier]} ${TIER_NAME[tier]}`;
  if (tier === 'parlay') return base;
  const range = tierRange(tier, sport);
  const conf = confidence != null ? ` · ${Math.round(confidence)}%` : '';
  return `${base} ${range}${conf}`;
};
