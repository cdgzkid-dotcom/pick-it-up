import type { Game } from './types';

interface SportConfig {
  scoreboardPath: string;
  coreSport: string;
  coreLeague: string;
  league?: string;
}

const SPORTS: Record<string, SportConfig> = {
  NBA: {
    scoreboardPath: 'basketball/nba',
    coreSport: 'basketball',
    coreLeague: 'nba',
  },
  NFL: {
    scoreboardPath: 'football/nfl',
    coreSport: 'football',
    coreLeague: 'nfl',
  },
  MLB: {
    scoreboardPath: 'baseball/mlb',
    coreSport: 'baseball',
    coreLeague: 'mlb',
  },
  NHL: {
    scoreboardPath: 'hockey/nhl',
    coreSport: 'hockey',
    coreLeague: 'nhl',
  },
  'Liga MX': {
    scoreboardPath: 'soccer/mex.1',
    coreSport: 'soccer',
    coreLeague: 'mex.1',
    league: 'Liga MX',
  },
  'Premier League': {
    scoreboardPath: 'soccer/eng.1',
    coreSport: 'soccer',
    coreLeague: 'eng.1',
    league: 'Premier League',
  },
  Champions: {
    scoreboardPath: 'soccer/uefa.champions',
    coreSport: 'soccer',
    coreLeague: 'uefa.champions',
    league: 'UEFA Champions League',
  },
  UFC: {
    scoreboardPath: 'mma/ufc',
    coreSport: 'mma',
    coreLeague: 'ufc',
  },
};

export const ESPN_SPORTS = Object.keys(SPORTS);
export const FAVORITE_SPORTS: string[] = ['NBA', 'MLB', 'NHL', 'Liga MX', 'Premier League'];

const CACHE_SECONDS = 300;

interface EspnTeam {
  displayName: string;
  shortDisplayName?: string;
  abbreviation?: string;
}

interface EspnRecord {
  type: string;
  summary: string;
}

interface EspnCompetitor {
  homeAway: 'home' | 'away';
  team: EspnTeam;
  records?: EspnRecord[];
  curatedRank?: { current: number };
}

interface EspnOdds {
  provider?: { name?: string; priority?: number };
  details?: string;
  overUnder?: number;
  spread?: number;
  homeTeamOdds?: { moneyLine?: number | null };
  awayTeamOdds?: { moneyLine?: number | null };
}

interface EspnCompetition {
  id: string;
  competitors: EspnCompetitor[];
  odds?: EspnOdds[];
  notes?: { type: string; headline: string }[];
  venue?: { fullName?: string };
  status?: { type?: { state?: string; completed?: boolean } };
}

interface EspnEvent {
  id: string;
  date: string;
  name: string;
  shortName?: string;
  status: { type: { state: 'pre' | 'in' | 'post'; completed: boolean; name?: string } };
  competitions: EspnCompetition[];
}

interface EspnScoreboard {
  events?: EspnEvent[];
}

interface CoreOddsItem {
  provider?: { name?: string; priority?: number };
  details?: string;
  overUnder?: number;
  spread?: number;
  homeTeamOdds?: { moneyLine?: number | null };
  awayTeamOdds?: { moneyLine?: number | null };
}

interface CoreOddsResponse {
  items?: CoreOddsItem[];
}

const americanToDecimal = (american: number | null | undefined): number | null => {
  if (american == null || !Number.isFinite(american)) return null;
  if (american === 0) return null;
  if (american > 0) return Number((1 + american / 100).toFixed(3));
  return Number((1 + 100 / Math.abs(american)).toFixed(3));
};

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      next: { revalidate: CACHE_SECONDS },
      headers: { Accept: 'application/json', 'User-Agent': 'pick-it-up/1.0' },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function fetchScoreboard(sport: string): Promise<EspnEvent[]> {
  const cfg = SPORTS[sport];
  if (!cfg) return [];
  const data = await fetchJson<EspnScoreboard>(
    `https://site.api.espn.com/apis/site/v2/sports/${cfg.scoreboardPath}/scoreboard`,
  );
  return data?.events ?? [];
}

async function fetchCoreOdds(sport: string, eventId: string, competitionId: string): Promise<CoreOddsItem[]> {
  const cfg = SPORTS[sport];
  if (!cfg) return [];
  const data = await fetchJson<CoreOddsResponse>(
    `https://sports.core.api.espn.com/v2/sports/${cfg.coreSport}/leagues/${cfg.coreLeague}/events/${eventId}/competitions/${competitionId}/odds`,
  );
  return data?.items ?? [];
}

const isLiveProvider = (name?: string) =>
  !!name && /live/i.test(name);

function pickPrimaryOdds(items: { provider?: { name?: string }; homeTeamOdds?: { moneyLine?: number | null }; awayTeamOdds?: { moneyLine?: number | null }; spread?: number; overUnder?: number; details?: string }[]) {
  const withML = items.filter(
    (o) =>
      !isLiveProvider(o.provider?.name) &&
      typeof o.homeTeamOdds?.moneyLine === 'number' &&
      typeof o.awayTeamOdds?.moneyLine === 'number',
  );
  if (withML.length > 0) return withML[0];
  const anyNonLive = items.find((o) => !isLiveProvider(o.provider?.name));
  return anyNonLive ?? items[0] ?? null;
}

async function eventToGame(sport: string, ev: EspnEvent): Promise<Game | null> {
  if (ev.status.type.completed || ev.status.type.state === 'post') return null;
  const comp = ev.competitions[0];
  if (!comp) return null;

  const home = comp.competitors.find((c) => c.homeAway === 'home');
  const away = comp.competitors.find((c) => c.homeAway === 'away');
  if (!home || !away) return null;

  let oddsItems: { provider?: { name?: string }; homeTeamOdds?: { moneyLine?: number | null }; awayTeamOdds?: { moneyLine?: number | null }; spread?: number; overUnder?: number; details?: string }[] = comp.odds ?? [];

  const needsCore = !oddsItems.some(
    (o) =>
      typeof o.homeTeamOdds?.moneyLine === 'number' &&
      typeof o.awayTeamOdds?.moneyLine === 'number',
  );
  if (needsCore) {
    const core = await fetchCoreOdds(sport, ev.id, comp.id);
    if (core.length > 0) oddsItems = core;
  }

  const primary = pickPrimaryOdds(oddsItems);
  const odds: Game['odds'] = {};
  const oddsComparison: Record<string, Record<string, number>> = {};

  if (primary) {
    const h = americanToDecimal(primary.homeTeamOdds?.moneyLine);
    const a = americanToDecimal(primary.awayTeamOdds?.moneyLine);
    if (h && a) odds.moneyline = { home: h, away: a };
    if (typeof primary.spread === 'number') {
      odds.spread = {
        home_line: primary.spread,
        home_odds: 1.91,
        away_line: -primary.spread,
        away_odds: 1.91,
      };
    }
    if (typeof primary.overUnder === 'number') {
      odds.total = { line: primary.overUnder, over: 1.91, under: 1.91 };
    }

    for (const o of oddsItems) {
      const name = o.provider?.name;
      if (!name || isLiveProvider(name)) continue;
      const ml: Record<string, number> = {};
      const hh = americanToDecimal(o.homeTeamOdds?.moneyLine);
      const aa = americanToDecimal(o.awayTeamOdds?.moneyLine);
      if (hh) ml.home = hh;
      if (aa) ml.away = aa;
      if (Object.keys(ml).length > 0) oddsComparison[name] = ml;
    }
  }

  if (!odds.moneyline && !odds.spread && !odds.total) return null;

  const cfg = SPORTS[sport];
  const homeRecord = home.records?.find((r) => r.type === 'total')?.summary ?? home.records?.[0]?.summary;
  const awayRecord = away.records?.find((r) => r.type === 'total')?.summary ?? away.records?.[0]?.summary;

  const notes = comp.notes?.map((n) => n.headline).filter(Boolean) ?? [];

  const game: Game = {
    sport,
    league: cfg.league,
    home_team: home.team.displayName,
    away_team: away.team.displayName,
    game_label:
      ev.shortName && ev.shortName.length < 80
        ? ev.shortName
        : `${away.team.displayName} @ ${home.team.displayName}`,
    start_time: ev.date,
    odds,
    odds_comparison: Object.keys(oddsComparison).length > 0 ? oddsComparison : undefined,
    notable_stats: {
      home_record: homeRecord,
      away_record: awayRecord,
      status: ev.status.type.state,
      venue: comp.venue?.fullName,
      ...(notes.length > 0 ? { notes } : {}),
    },
  };
  return game;
}

export async function fetchGames(sports: string[]): Promise<Game[]> {
  const valid = sports.filter((s) => SPORTS[s]);
  const perSport = await Promise.all(
    valid.map(async (s) => {
      const events = await fetchScoreboard(s);
      const games = await Promise.all(events.map((ev) => eventToGame(s, ev)));
      return games.filter((g): g is Game => g !== null);
    }),
  );
  return perSport.flat();
}

export async function gameCountsBySport(): Promise<Record<string, number>> {
  const entries = await Promise.all(
    ESPN_SPORTS.map(async (s) => {
      const events = await fetchScoreboard(s);
      const playable = events.filter(
        (ev) => !ev.status.type.completed && ev.status.type.state !== 'post',
      );
      return [s, playable.length] as const;
    }),
  );
  return Object.fromEntries(entries);
}
