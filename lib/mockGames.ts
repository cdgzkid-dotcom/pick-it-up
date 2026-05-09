import type { Game } from './types';

export const SUPPORTED_SPORTS = [
  'NBA',
  'NFL',
  'MLB',
  'Fútbol',
  'NHL',
  'Tennis',
  'UFC',
  'Boxing',
] as const;

export const FAVORITE_SPORTS: string[] = ['NBA', 'NFL', 'MLB', 'Fútbol'];

export const MOCK_GAMES: Game[] = [
  {
    sport: 'NBA',
    league: 'Regular Season',
    home_team: 'Oklahoma City Thunder',
    away_team: 'Los Angeles Lakers',
    game_label: 'Lakers @ Thunder',
    start_time: '2026-05-09T19:00:00-06:00',
    odds: {
      moneyline: { home: 1.65, away: 2.35 },
      spread: { home_line: -4.5, home_odds: 1.91, away_line: 4.5, away_odds: 1.91 },
      total: { line: 224.5, over: 1.87, under: 1.95 },
    },
    odds_comparison: {
      moneyline: { Draftea: 1.65, Caliente: 1.62, Bet365: 1.66 },
    },
    injuries: 'Lakers: LeBron James cuestionable (descanso)',
    notable_stats: {
      thunder_home_record: '24-8',
      lakers_road_record: '12-19',
      thunder_pace: 102.4,
    },
  },
  {
    sport: 'NBA',
    league: 'Regular Season',
    home_team: 'Boston Celtics',
    away_team: 'Miami Heat',
    game_label: 'Heat @ Celtics',
    start_time: '2026-05-09T19:30:00-06:00',
    odds: {
      moneyline: { home: 1.45, away: 2.85 },
      total: { line: 211.5, over: 1.91, under: 1.91 },
    },
    odds_comparison: {
      moneyline: { Draftea: 1.45, Caliente: 1.44 },
    },
    injuries: 'Heat: Tyler Herro (lesión menor) probable',
    notable_stats: {
      celtics_home_record: '28-5',
      heat_road_record: '15-17',
    },
  },
  {
    sport: 'MLB',
    league: 'Regular Season',
    home_team: 'New York Yankees',
    away_team: 'Boston Red Sox',
    game_label: 'Red Sox @ Yankees',
    start_time: '2026-05-09T18:05:00-06:00',
    odds: {
      moneyline: { home: 1.72, away: 2.20 },
      total: { line: 8.5, over: 1.91, under: 1.95 },
    },
    odds_comparison: {
      moneyline: { Draftea: 1.72, Caliente: 1.70 },
    },
    injuries: 'Yankees: Aaron Judge sano. Red Sox: rotación de relevos cansada',
    notable_stats: {
      yankees_starter: 'Gerrit Cole, ERA 2.84',
      red_sox_starter: 'Brayan Bello, ERA 4.12',
    },
  },
  {
    sport: 'NFL',
    league: 'Regular Season',
    home_team: 'Kansas City Chiefs',
    away_team: 'Buffalo Bills',
    game_label: 'Bills @ Chiefs',
    start_time: '2026-05-09T17:25:00-06:00',
    odds: {
      moneyline: { home: 1.83, away: 2.05 },
      spread: { home_line: -2.5, home_odds: 1.91, away_line: 2.5, away_odds: 1.91 },
      total: { line: 47.5, over: 1.91, under: 1.91 },
    },
    odds_comparison: {
      moneyline: { Draftea: 1.83, Caliente: 1.85, Bet365: 1.84 },
    },
    injuries: 'Bills: Stefon Diggs duda (tobillo). Chiefs: Mahomes 100%',
    notable_stats: {
      chiefs_home_streak: 'Ganan últimos 7 en casa',
      bills_road_streak: '4-2 últimos 6 de visita',
    },
  },
  {
    sport: 'Fútbol',
    league: 'Liga MX',
    home_team: 'Club América',
    away_team: 'Chivas de Guadalajara',
    game_label: 'Chivas vs América',
    start_time: '2026-05-09T20:00:00-06:00',
    odds: {
      moneyline: { home: 2.10, away: 3.40, draw: 3.20 },
      total: { line: 2.5, over: 2.05, under: 1.78 },
    },
    odds_comparison: {
      moneyline: { Draftea: 2.10, Caliente: 2.05, Bet365: 2.15 },
    },
    injuries: 'América: plantel completo. Chivas: 2 defensas suspendidos',
    notable_stats: {
      clasico_h2h_last_5: 'América 3W - Chivas 1W - 1D',
      america_home_form: '8-1-1 últimos 10',
    },
  },
  {
    sport: 'Fútbol',
    league: 'Premier League',
    home_team: 'Manchester City',
    away_team: 'Arsenal',
    game_label: 'Arsenal @ Man City',
    start_time: '2026-05-09T11:30:00-06:00',
    odds: {
      moneyline: { home: 1.85, away: 4.00, draw: 3.50 },
      total: { line: 2.5, over: 1.65, under: 2.30 },
    },
    odds_comparison: {
      moneyline: { Draftea: 1.85, Bet365: 1.87 },
    },
    injuries: 'City: Haaland 100%. Arsenal: Saka duda',
    notable_stats: {
      city_home_unbeaten: '15 partidos en casa sin perder',
    },
  },
  {
    sport: 'NHL',
    league: 'Regular Season',
    home_team: 'Edmonton Oilers',
    away_team: 'Vegas Golden Knights',
    game_label: 'Knights @ Oilers',
    start_time: '2026-05-09T19:00:00-06:00',
    odds: {
      moneyline: { home: 1.75, away: 2.15 },
      total: { line: 6.5, over: 1.91, under: 1.91 },
    },
    odds_comparison: {
      moneyline: { Draftea: 1.75, Caliente: 1.73 },
    },
    injuries: 'Oilers: McDavid sano. Knights: portero titular descansa',
    notable_stats: {
      oilers_pp_pct: '28.4%',
      knights_back_to_back: true,
    },
  },
  {
    sport: 'UFC',
    league: 'UFC 305',
    home_team: 'Israel Adesanya',
    away_team: 'Dricus du Plessis',
    game_label: 'Adesanya vs du Plessis',
    start_time: '2026-05-09T22:00:00-06:00',
    odds: {
      moneyline: { home: 1.95, away: 1.85 },
    },
    odds_comparison: {
      moneyline: { Draftea: 1.95, Caliente: 1.92 },
    },
    injuries: 'Ambos llegan completos al pesaje',
    notable_stats: {
      adesanya_record: '24-3',
      ddp_record: '21-2',
    },
  },
];

export const gamesForSports = (sports: string[]): Game[] => {
  if (sports.length === 0) return [];
  const set = new Set(sports.map((s) => s.toLowerCase()));
  return MOCK_GAMES.filter((g) => set.has(g.sport.toLowerCase()));
};

export const sportsWithGamesToday = (): string[] => {
  const set = new Set<string>();
  for (const g of MOCK_GAMES) set.add(g.sport);
  return Array.from(set);
};
