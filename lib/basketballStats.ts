import { cached } from './cache';

// ─── ESPN endpoints (primary, always available) ───────────────────────

const ESPN_BASE = 'https://site.api.espn.com/apis';

interface EspnStandingEntry {
  team: { id: string; displayName: string; abbreviation: string };
  stats: Array<{ name: string; displayValue: string; value?: number }>;
}

export interface NbaStandingRow {
  espnId: string;
  team: string;
  abbr: string;
  wins: number;
  losses: number;
  homeRecord?: string;
  awayRecord?: string;
  last10?: string;
  streak?: string;
  ppg?: number;
  oppPpg?: number;
  pointDiff?: number;
  playoffSeed?: number;
}

async function fetchEspnStandings(league: string = 'nba'): Promise<Map<string, NbaStandingRow>> {
  return cached(`${league}:espn:standings`, 120, async () => {
    const res = await fetch(`${ESPN_BASE}/v2/sports/basketball/${league}/standings`, {
      cache: 'no-store',
    });
    if (!res.ok) return new Map();
    const data = await res.json();
    const map = new Map<string, NbaStandingRow>();

    for (const child of data.children ?? []) {
      for (const group of child.standings?.entries ?? []) {
        const entry = group as EspnStandingEntry;
        const team = entry.team;
        if (!team?.displayName) continue;

        const stat = (name: string): string | undefined => {
          const s = entry.stats?.find((s: { name: string }) => s.name === name);
          return s?.displayValue ?? undefined;
        };
        const numStat = (name: string): number | undefined => {
          const s = entry.stats?.find((s: { name: string }) => s.name === name);
          return s?.value ?? undefined;
        };

        map.set(team.displayName.toUpperCase(), {
          espnId: team.id,
          team: team.displayName,
          abbr: team.abbreviation,
          wins: numStat('wins') ?? 0,
          losses: numStat('losses') ?? 0,
          homeRecord: stat('Home'),
          awayRecord: stat('Road'),
          last10: stat('Last Ten Games') || stat('L10'),
          streak: stat('streak'),
          ppg: numStat('avgPointsFor') ?? numStat('pointsFor'),
          oppPpg: numStat('avgPointsAgainst') ?? numStat('pointsAgainst'),
          pointDiff: numStat('differential') ?? numStat('pointDifferential'),
          playoffSeed: numStat('playoffSeed'),
        });
      }
    }
    return map;
  });
}

interface EspnStatItem {
  name: string;
  displayValue: string;
  value?: number;
}

interface EspnStatsCategory {
  name: string;
  displayName: string;
  stats: EspnStatItem[];
}

export interface NbaTeamStats {
  avgPoints?: number;
  fgPct?: number;
  fg3Pct?: number;
  ftPct?: number;
  avgRebounds?: number;
  avgAssists?: number;
  avgTurnovers?: number;
  avgSteals?: number;
  avgBlocks?: number;
  assistTurnoverRatio?: number;
}

async function fetchEspnTeamStats(espnTeamId: string, league: string = 'nba'): Promise<NbaTeamStats | null> {
  return cached(`${league}:espn:teamStats:${espnTeamId}`, 240, async () => {
    const res = await fetch(
      `${ESPN_BASE}/site/v2/sports/basketball/${league}/teams/${espnTeamId}/statistics`,
      { cache: 'no-store' },
    );
    if (!res.ok) return null;
    const data = await res.json();

    const allStats = new Map<string, number>();
    for (const cat of (data.results?.stats?.categories ?? []) as EspnStatsCategory[]) {
      for (const s of cat.stats ?? []) {
        if (s.value != null) allStats.set(s.name, s.value);
        else if (s.displayValue) {
          const n = parseFloat(s.displayValue);
          if (!isNaN(n)) allStats.set(s.name, n);
        }
      }
    }

    if (allStats.size === 0) return null;
    return {
      avgPoints: allStats.get('avgPoints'),
      fgPct: allStats.get('fieldGoalPct'),
      fg3Pct: allStats.get('threePointFieldGoalPct') ?? allStats.get('threePointPct'),
      ftPct: allStats.get('freeThrowPct'),
      avgRebounds: allStats.get('avgRebounds'),
      avgAssists: allStats.get('avgAssists'),
      avgTurnovers: allStats.get('avgTurnovers'),
      avgSteals: allStats.get('avgSteals'),
      avgBlocks: allStats.get('avgBlocks'),
      assistTurnoverRatio: allStats.get('assistTurnoverRatio'),
    };
  });
}

export interface NbaRecentGame {
  date: string;
  opponent: string;
  homeAway: 'home' | 'away';
  won: boolean;
  score: string;
  teamScore: number;
  oppScore: number;
}

async function fetchEspnRecentGames(
  espnTeamId: string,
  limit = 10,
  league: string = 'nba',
): Promise<NbaRecentGame[]> {
  return cached(`${league}:espn:schedule:${espnTeamId}`, 120, async () => {
    const res = await fetch(
      `${ESPN_BASE}/site/v2/sports/basketball/${league}/teams/${espnTeamId}/schedule`,
      { cache: 'no-store' },
    );
    if (!res.ok) return [];
    const data = await res.json();

    const games: NbaRecentGame[] = [];
    for (const ev of data.events ?? []) {
      const status = ev.competitions?.[0]?.status;
      if (!status?.type?.completed) continue;

      const comps = ev.competitions?.[0]?.competitors ?? [];
      const us = comps.find(
        (c: { id?: string }) => String(c.id) === String(espnTeamId),
      );
      const them = comps.find(
        (c: { id?: string }) => String(c.id) !== String(espnTeamId),
      );
      if (!us || !them) continue;

      const teamScore = Number(us.score?.value ?? us.score ?? 0);
      const oppScore = Number(them.score?.value ?? them.score ?? 0);

      games.push({
        date: ev.date?.substring(0, 10) ?? '',
        opponent: them.team?.displayName ?? them.team?.name ?? '?',
        homeAway: us.homeAway === 'home' ? 'home' : 'away',
        won: us.winner === true,
        score: `${teamScore}-${oppScore}`,
        teamScore,
        oppScore,
      });
    }

    return games.slice(-limit);
  });
}

// ─── stats.nba.com (optional enrichment, NBA-only) ───────────────────

const NBA_STATS_SEASON = (() => {
  const now = new Date();
  const y = now.getUTCFullYear();
  return now.getUTCMonth() >= 8
    ? `${y}-${(y + 1).toString().slice(2)}`
    : `${y - 1}-${y.toString().slice(2)}`;
})();

const NBA_STATS_HEADERS = {
  Referer: 'https://www.nba.com/',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'x-nba-stats-origin': 'stats',
  'x-nba-stats-token': 'true',
};

interface NbaAdvancedRow {
  pace?: number;
  offRtg?: number;
  defRtg?: number;
  netRtg?: number;
}

async function fetchAdvancedFromNbaStats(): Promise<Map<string, NbaAdvancedRow> | null> {
  return cached(`nba:advanced:${NBA_STATS_SEASON}`, 240, async () => {
    try {
      const url = `https://stats.nba.com/stats/leaguedashteamstats?Season=${NBA_STATS_SEASON}&SeasonType=Regular+Season&PerMode=PerGame&MeasureType=Advanced&PaceAdjust=N&PlusMinus=N&Rank=N&LastNGames=0&Period=0&GameSegment=&Outcome=&SeasonSegment=&Location=&DateFrom=&DateTo=&Conference=&Division=&LeagueID=00&Month=0&OpponentTeamID=0&PORound=0&ShotClockRange=&TeamID=0&TwoWay=0&VsConference=&VsDivision=`;
      const res = await fetch(url, {
        headers: NBA_STATS_HEADERS,
        signal: AbortSignal.timeout(5_000),
        cache: 'no-store',
      });
      if (!res.ok) return null;
      const data = await res.json();
      const rs = data.resultSets?.[0];
      if (!rs?.headers || !rs?.rowSet) return null;

      const headers: string[] = rs.headers;
      const nameIdx = headers.indexOf('TEAM_NAME');
      const paceIdx = headers.indexOf('PACE');
      const offIdx = headers.indexOf('OFF_RATING');
      const defIdx = headers.indexOf('DEF_RATING');
      const netIdx = headers.indexOf('NET_RATING');

      const map = new Map<string, NbaAdvancedRow>();
      for (const row of rs.rowSet) {
        const name = String(row[nameIdx]).toUpperCase();
        map.set(name, {
          pace: paceIdx >= 0 ? Number(row[paceIdx]) : undefined,
          offRtg: offIdx >= 0 ? Number(row[offIdx]) : undefined,
          defRtg: defIdx >= 0 ? Number(row[defIdx]) : undefined,
          netRtg: netIdx >= 0 ? Number(row[netIdx]) : undefined,
        });
      }
      return map;
    } catch {
      return null;
    }
  });
}

// ─── Public interface ─────────────────────────────────────────────────

export interface NbaTeamRow {
  team: string;
  abbr?: string;
  wins?: number;
  losses?: number;
  homeRecord?: string;
  awayRecord?: string;
  last10?: string;
  streak?: string;
  ppg?: number;
  oppPpg?: number;
  pointDiff?: number;
  playoffSeed?: number;
  fgPct?: number;
  fg3Pct?: number;
  ftPct?: number;
  avgRebounds?: number;
  avgAssists?: number;
  avgTurnovers?: number;
  avgSteals?: number;
  avgBlocks?: number;
  assistTurnoverRatio?: number;
  pace?: number;
  offRtg?: number;
  defRtg?: number;
  netRtg?: number;
  recentGames?: NbaRecentGame[];
}

export interface BasketballGameContext {
  home?: NbaTeamRow;
  away?: NbaTeamRow;
}

export type NbaGameContext = BasketballGameContext;

// ─── Shared builder (not exported) ───────────────────────────────────

async function buildBasketballGameContext(
  homeName: string,
  awayName: string,
  league: string,
): Promise<BasketballGameContext> {
  const [standings, advanced] = await Promise.all([
    fetchEspnStandings(league).catch(() => new Map<string, NbaStandingRow>()),
    league === 'nba'
      ? fetchAdvancedFromNbaStats().catch(() => null)
      : Promise.resolve(null),
  ]);

  const build = async (teamName: string): Promise<NbaTeamRow | undefined> => {
    const key = teamName.toUpperCase();
    const st = standings.get(key);
    if (!st) return undefined;

    const [stats, recent] = await Promise.all([
      fetchEspnTeamStats(st.espnId, league).catch(() => null),
      fetchEspnRecentGames(st.espnId, 10, league).catch(() => [] as NbaRecentGame[]),
    ]);
    const adv = advanced?.get(key);

    return {
      team: st.team,
      abbr: st.abbr,
      wins: st.wins,
      losses: st.losses,
      homeRecord: st.homeRecord,
      awayRecord: st.awayRecord,
      last10: st.last10,
      streak: st.streak,
      ppg: st.ppg,
      oppPpg: st.oppPpg,
      pointDiff: st.pointDiff,
      playoffSeed: st.playoffSeed,
      fgPct: stats?.fgPct,
      fg3Pct: stats?.fg3Pct,
      ftPct: stats?.ftPct,
      avgRebounds: stats?.avgRebounds,
      avgAssists: stats?.avgAssists,
      avgTurnovers: stats?.avgTurnovers,
      avgSteals: stats?.avgSteals,
      avgBlocks: stats?.avgBlocks,
      assistTurnoverRatio: stats?.assistTurnoverRatio,
      pace: adv?.pace,
      offRtg: adv?.offRtg,
      defRtg: adv?.defRtg,
      netRtg: adv?.netRtg,
      recentGames: recent.length > 0 ? recent : undefined,
    };
  };

  const [home, away] = await Promise.all([build(homeName), build(awayName)]);

  if (home || away) {
    console.log(
      `[DATA][${league.toUpperCase()}] ${awayName} @ ${homeName}`,
      home ? `home: ${home.wins}-${home.losses} PPG:${home.ppg ?? '?'} OffRtg:${home.offRtg ?? '?'} L10:${home.last10 ?? '?'}` : 'home: no data',
      away ? `away: ${away.wins}-${away.losses} PPG:${away.ppg ?? '?'} OffRtg:${away.offRtg ?? '?'} L10:${away.last10 ?? '?'}` : 'away: no data',
    );
  }

  return { home, away };
}

// ─── Thin wrappers ───────────────────────────────────────────────────

export async function buildNbaGameContext(
  homeName: string,
  awayName: string,
): Promise<BasketballGameContext> {
  return buildBasketballGameContext(homeName, awayName, 'nba');
}

export async function buildWnbaGameContext(
  homeName: string,
  awayName: string,
): Promise<BasketballGameContext> {
  return buildBasketballGameContext(homeName, awayName, 'wnba');
}
