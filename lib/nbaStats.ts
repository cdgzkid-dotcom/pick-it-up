// NBA stats — stats.nba.com requires Referer + User-Agent headers, often
// rate-limits, and is occasionally blocked by Vercel egress IPs. We try it
// first with caching; if it fails, we degrade gracefully and let Claude
// rely on its training knowledge + the ESPN injuries we already pass.

import { cached } from './cache';

const SEASON = (() => {
  const now = new Date();
  const y = now.getUTCFullYear();
  return now.getUTCMonth() >= 8 ? `${y}-${(y + 1).toString().slice(2)}` : `${y - 1}-${y.toString().slice(2)}`;
})();

const HEADERS = {
  Referer: 'https://www.nba.com/',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'x-nba-stats-origin': 'stats',
  'x-nba-stats-token': 'true',
};

interface NbaResultSet {
  headers: string[];
  rowSet: Array<Array<string | number>>;
}

interface NbaResp {
  resultSets?: Array<{ name: string; headers: string[]; rowSet: Array<Array<string | number>> }>;
}

function rowsToObjects(rs: NbaResultSet | undefined): Array<Record<string, string | number>> {
  if (!rs) return [];
  return rs.rowSet.map((row) => Object.fromEntries(rs.headers.map((h, i) => [h, row[i]])));
}

export interface NbaTeamRow {
  team: string;
  abbr?: string;
  wins?: number;
  losses?: number;
  ppg?: number;
  fgPct?: number;
  fg3Pct?: number;
  ftPct?: number;
  pace?: number;
  offRtg?: number;
  defRtg?: number;
  netRtg?: number;
}

export async function fetchNbaTeamStats(): Promise<Map<string, NbaTeamRow> | null> {
  return cached(`nba:teamStats:${SEASON}`, 240, async () => {
    try {
      const url = `https://stats.nba.com/stats/leaguedashteamstats?Season=${SEASON}&SeasonType=Regular+Season&PerMode=PerGame&MeasureType=Base&PaceAdjust=N&PlusMinus=N&Rank=N&LastNGames=0&Period=0&GameSegment=&Outcome=&SeasonSegment=&Location=&DateFrom=&DateTo=&Conference=&Division=&LeagueID=00&Month=0&OpponentTeamID=0&PORound=0&ShotClockRange=&TeamID=0&TwoWay=0&VsConference=&VsDivision=`;
      const advUrl = `https://stats.nba.com/stats/leaguedashteamstats?Season=${SEASON}&SeasonType=Regular+Season&PerMode=PerGame&MeasureType=Advanced&PaceAdjust=N&PlusMinus=N&Rank=N&LastNGames=0&Period=0&GameSegment=&Outcome=&SeasonSegment=&Location=&DateFrom=&DateTo=&Conference=&Division=&LeagueID=00&Month=0&OpponentTeamID=0&PORound=0&ShotClockRange=&TeamID=0&TwoWay=0&VsConference=&VsDivision=`;
      const [base, adv] = await Promise.all([
        fetch(url, { headers: HEADERS, next: { revalidate: 14400 } }).then((r) => (r.ok ? r.json() : null)),
        fetch(advUrl, { headers: HEADERS, next: { revalidate: 14400 } }).then((r) => (r.ok ? r.json() : null)),
      ]);
      if (!base) return null;

      const baseRows = rowsToObjects((base as NbaResp).resultSets?.[0]);
      const advRows = adv ? rowsToObjects((adv as NbaResp).resultSets?.[0]) : [];
      const advByTeam = new Map<string, Record<string, string | number>>();
      for (const a of advRows) advByTeam.set(String(a.TEAM_NAME).toUpperCase(), a);

      const map = new Map<string, NbaTeamRow>();
      for (const r of baseRows) {
        const teamName = String(r.TEAM_NAME);
        const a = advByTeam.get(teamName.toUpperCase()) ?? {};
        map.set(teamName.toUpperCase(), {
          team: teamName,
          wins: Number(r.W ?? 0),
          losses: Number(r.L ?? 0),
          ppg: Number(r.PTS ?? 0),
          fgPct: Number(r.FG_PCT ?? 0),
          fg3Pct: Number(r.FG3_PCT ?? 0),
          ftPct: Number(r.FT_PCT ?? 0),
          pace: a.PACE ? Number(a.PACE) : undefined,
          offRtg: a.OFF_RATING ? Number(a.OFF_RATING) : undefined,
          defRtg: a.DEF_RATING ? Number(a.DEF_RATING) : undefined,
          netRtg: a.NET_RATING ? Number(a.NET_RATING) : undefined,
        });
      }
      return map;
    } catch (e) {
      console.warn('[nba] stats.nba.com fetch failed, returning null', e);
      return null;
    }
  });
}

export interface NbaGameContext {
  home?: NbaTeamRow;
  away?: NbaTeamRow;
}

export async function buildNbaGameContext(
  homeName: string,
  awayName: string,
): Promise<NbaGameContext> {
  const stats = await fetchNbaTeamStats().catch(() => null);
  if (!stats) return {};
  const homeKey = homeName.toUpperCase();
  const awayKey = awayName.toUpperCase();
  return {
    home: stats.get(homeKey),
    away: stats.get(awayKey),
  };
}
