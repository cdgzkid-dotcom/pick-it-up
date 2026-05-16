/**
 * Canonical sport and bet_type values used throughout the system.
 * All entry points that create bets (cron, vision, manual) must produce these.
 */

const SPORT_MAP: Record<string, string> = {
  // Baseball
  beisbol: 'MLB',
  béisbol: 'MLB',
  baseball: 'MLB',
  'mlb baseball': 'MLB',
  // Basketball
  basketball: 'NBA',
  'nba basketball': 'NBA',
  wnba: 'WNBA',
  // Hockey
  hockey: 'NHL',
  'nhl hockey': 'NHL',
  'ice hockey': 'NHL',
  // American football
  'american football': 'NFL',
  'nfl football': 'NFL',
  // Soccer — 'football' maps to soccer in Mexican context
  soccer: 'Fútbol',
  fútbol: 'Fútbol',
  futbol: 'Fútbol',
  football: 'Fútbol',
  'liga mx': 'Liga MX',
  'premier league': 'Premier League',
  'champions league': 'Champions League',
  'mls': 'MLS',
  // Combat
  mma: 'UFC',
  boxing: 'Boxeo',
  boxeo: 'Boxeo',
};

const BET_TYPE_MAP: Record<string, string> = {
  // Moneyline variants from Draftea tickets
  moneyline: 'ML',
  'moneyline (pa - para ganar)': 'ML',
  'moneyline (pa – para ganar)': 'ML',
  'para ganar': 'ML',
  'ganador': 'ML',
  'ganador del partido': 'ML',
  'ganador (incluye ot)': 'ML',
  'ganador (ml)': 'ML',
  'ml': 'ML',
  // Spread
  spread: 'Spread',
  handicap: 'Spread',
  'run line': 'Spread',
  runline: 'Spread',
  'puck line': 'Spread',
  puckline: 'Spread',
  'asian handicap': 'Spread',
  // Totals
  total: 'Total',
  'over/under': 'Total',
  'o/u': 'Total',
  over: 'Total',
  under: 'Total',
  totales: 'Total',
  // Player props
  props: 'Props',
  'player props': 'Props',
  'jugador props': 'Props',
  'jugador_props': 'Props',
  prop: 'Props',
  // Parlay
  parlay: 'Parlay',
  combinada: 'Parlay',
  sgp: 'SGP',
  'same game parlay': 'SGP',
};

export function normalizeSport(raw: string): string {
  const key = raw.trim().toLowerCase();
  return SPORT_MAP[key] ?? raw.trim();
}

export function normalizeBetType(raw: string): string {
  const key = raw.trim().toLowerCase();
  return BET_TYPE_MAP[key] ?? raw.trim();
}
