// MLB Stats API integration — statsapi.mlb.com (free, no key).
// Pulls probable pitchers, pitcher season stats, team batting stats,
// bullpen ERA, and standings for a given MLB game. Returns a structured
// object that pickGen attaches to the game payload sent to Claude.

import { cached } from './cache';

const BASE = 'https://statsapi.mlb.com/api/v1';

interface ScheduleResp {
  dates?: Array<{
    games?: Array<{
      gamePk: number;
      gameDate: string;
      teams?: {
        away?: {
          team?: { id: number; name: string; abbreviation?: string };
          probablePitcher?: { id: number; fullName: string };
          leagueRecord?: { wins: number; losses: number; pct?: string };
        };
        home?: {
          team?: { id: number; name: string; abbreviation?: string };
          probablePitcher?: { id: number; fullName: string };
          leagueRecord?: { wins: number; losses: number; pct?: string };
        };
      };
    }>;
  }>;
}

interface ProbablePitcher {
  id: number;
  name: string;
}

export interface MlbScheduleEntry {
  gamePk: number;
  gameDate: string;
  away: {
    teamId: number;
    teamName: string;
    abbr?: string;
    record?: string;
    probable?: ProbablePitcher;
  };
  home: {
    teamId: number;
    teamName: string;
    abbr?: string;
    record?: string;
    probable?: ProbablePitcher;
  };
}

export async function fetchMlbScheduleForDate(date: string): Promise<MlbScheduleEntry[]> {
  return cached(`mlb:schedule:${date}`, 30, async () => {
    const url = `${BASE}/schedule?sportId=1&date=${date}&hydrate=probablePitcher,linescore,team`;
    const r = await fetch(url, { next: { revalidate: 1800 } });
    if (!r.ok) throw new Error(`MLB schedule ${r.status}`);
    const data: ScheduleResp = await r.json();
    const out: MlbScheduleEntry[] = [];
    for (const day of data.dates ?? []) {
      for (const g of day.games ?? []) {
        const home = g.teams?.home;
        const away = g.teams?.away;
        if (!home?.team || !away?.team) continue;
        out.push({
          gamePk: g.gamePk,
          gameDate: g.gameDate,
          home: {
            teamId: home.team.id,
            teamName: home.team.name,
            abbr: home.team.abbreviation,
            record: home.leagueRecord ? `${home.leagueRecord.wins}-${home.leagueRecord.losses}` : undefined,
            probable: home.probablePitcher ? { id: home.probablePitcher.id, name: home.probablePitcher.fullName } : undefined,
          },
          away: {
            teamId: away.team.id,
            teamName: away.team.name,
            abbr: away.team.abbreviation,
            record: away.leagueRecord ? `${away.leagueRecord.wins}-${away.leagueRecord.losses}` : undefined,
            probable: away.probablePitcher ? { id: away.probablePitcher.id, name: away.probablePitcher.fullName } : undefined,
          },
        });
      }
    }
    return out;
  });
}

interface PersonStatsResp {
  people?: Array<{
    id: number;
    fullName: string;
    stats?: Array<{
      type?: { displayName?: string };
      group?: { displayName?: string };
      splits?: Array<{
        season?: string;
        stat?: Record<string, unknown>;
      }>;
    }>;
  }>;
}

export interface PitcherStats {
  name: string;
  era?: string;
  whip?: string;
  k9?: string;
  bb9?: string;
  ip?: string;
  wins?: number;
  losses?: number;
  saves?: number;
  /** Last 5 starts: ERA + W-L summary */
  last5?: { era?: string; record?: string };
}

export async function fetchPitcherStats(playerId: number, season = String(new Date().getUTCFullYear())): Promise<PitcherStats | null> {
  return cached(`mlb:pitcher:${playerId}:${season}`, 120, async () => {
    const url = `${BASE}/people/${playerId}?hydrate=stats(group=[pitching],type=[season,gameLog],season=${season})`;
    const r = await fetch(url, { next: { revalidate: 7200 } });
    if (!r.ok) return null;
    const data: PersonStatsResp = await r.json();
    const person = data.people?.[0];
    if (!person) return null;

    const seasonStat = person.stats?.find((s) => s.type?.displayName === 'season')?.splits?.[0]?.stat as Record<string, unknown> | undefined;
    const gameLog = person.stats?.find((s) => s.type?.displayName === 'gameLog')?.splits ?? [];
    const last5 = gameLog.slice(-5);

    let last5Wins = 0;
    let last5Losses = 0;
    let last5IpSum = 0;
    let last5ErSum = 0;
    for (const g of last5) {
      const st = (g.stat ?? {}) as Record<string, unknown>;
      const ip = parseFloat(String(st.inningsPitched ?? '0')) || 0;
      const er = Number(st.earnedRuns ?? 0);
      last5IpSum += ip;
      last5ErSum += er;
      if (st.wins) last5Wins += Number(st.wins);
      if (st.losses) last5Losses += Number(st.losses);
    }
    const last5Era = last5IpSum > 0 ? ((last5ErSum * 9) / last5IpSum).toFixed(2) : undefined;

    return {
      name: person.fullName,
      era: seasonStat?.era as string | undefined,
      whip: seasonStat?.whip as string | undefined,
      k9: seasonStat?.strikeoutsPer9Inn as string | undefined,
      bb9: seasonStat?.walksPer9Inn as string | undefined,
      ip: seasonStat?.inningsPitched as string | undefined,
      wins: seasonStat?.wins ? Number(seasonStat.wins) : undefined,
      losses: seasonStat?.losses ? Number(seasonStat.losses) : undefined,
      saves: seasonStat?.saves ? Number(seasonStat.saves) : undefined,
      last5: last5.length > 0 ? { era: last5Era, record: `${last5Wins}-${last5Losses}` } : undefined,
    };
  });
}

interface TeamStatsResp {
  stats?: Array<{
    splits?: Array<{ stat?: Record<string, unknown> }>;
  }>;
}

export interface TeamBattingStats {
  ops?: string;
  avg?: string;
  homeRuns?: number;
  runs?: number;
  runsPerGame?: number;
}

export interface TeamPitchingStats {
  era?: string;
  whip?: string;
  saves?: number;
  /** Bullpen-specific not directly exposed; using team era as proxy */
}

export async function fetchTeamHittingStats(teamId: number, season = String(new Date().getUTCFullYear())): Promise<TeamBattingStats | null> {
  return cached(`mlb:team:hit:${teamId}:${season}`, 240, async () => {
    const url = `${BASE}/teams/${teamId}/stats?stats=season&group=hitting&season=${season}`;
    const r = await fetch(url, { next: { revalidate: 14400 } });
    if (!r.ok) return null;
    const data: TeamStatsResp = await r.json();
    const stat = data.stats?.[0]?.splits?.[0]?.stat;
    if (!stat) return null;
    const games = Number(stat.gamesPlayed ?? 0);
    const runs = Number(stat.runs ?? 0);
    return {
      ops: stat.ops as string | undefined,
      avg: stat.avg as string | undefined,
      homeRuns: stat.homeRuns ? Number(stat.homeRuns) : undefined,
      runs,
      runsPerGame: games > 0 ? Number((runs / games).toFixed(2)) : undefined,
    };
  });
}

export async function fetchTeamPitchingStats(teamId: number, season = String(new Date().getUTCFullYear())): Promise<TeamPitchingStats | null> {
  return cached(`mlb:team:pit:${teamId}:${season}`, 240, async () => {
    const url = `${BASE}/teams/${teamId}/stats?stats=season&group=pitching&season=${season}`;
    const r = await fetch(url, { next: { revalidate: 14400 } });
    if (!r.ok) return null;
    const data: TeamStatsResp = await r.json();
    const stat = data.stats?.[0]?.splits?.[0]?.stat;
    if (!stat) return null;
    return {
      era: stat.era as string | undefined,
      whip: stat.whip as string | undefined,
      saves: stat.saves ? Number(stat.saves) : undefined,
    };
  });
}

interface StandingsResp {
  records?: Array<{
    teamRecords?: Array<{
      team?: { id: number; name: string };
      wins: number;
      losses: number;
      streak?: { streakCode?: string };
      records?: {
        splitRecords?: Array<{ type: string; wins: number; losses: number }>;
      };
    }>;
  }>;
}

export interface MlbStandingRow {
  teamId: number;
  teamName: string;
  wins: number;
  losses: number;
  streak?: string;
  homeRecord?: string;
  awayRecord?: string;
  last10?: string;
}

export async function fetchMlbStandings(season = String(new Date().getUTCFullYear())): Promise<Map<number, MlbStandingRow>> {
  return cached(`mlb:standings:${season}`, 120, async () => {
    const url = `${BASE}/standings?leagueId=103,104&season=${season}`;
    const r = await fetch(url, { next: { revalidate: 7200 } });
    if (!r.ok) return new Map();
    const data: StandingsResp = await r.json();
    const map = new Map<number, MlbStandingRow>();
    for (const div of data.records ?? []) {
      for (const t of div.teamRecords ?? []) {
        if (!t.team) continue;
        const splits = t.records?.splitRecords ?? [];
        const home = splits.find((s) => s.type === 'home');
        const away = splits.find((s) => s.type === 'away');
        const last10 = splits.find((s) => s.type === 'lastTen');
        map.set(t.team.id, {
          teamId: t.team.id,
          teamName: t.team.name,
          wins: t.wins,
          losses: t.losses,
          streak: t.streak?.streakCode,
          homeRecord: home ? `${home.wins}-${home.losses}` : undefined,
          awayRecord: away ? `${away.wins}-${away.losses}` : undefined,
          last10: last10 ? `${last10.wins}-${last10.losses}` : undefined,
        });
      }
    }
    return map;
  });
}

export interface MlbGameContext {
  schedule?: MlbScheduleEntry;
  homePitcher?: PitcherStats | null;
  awayPitcher?: PitcherStats | null;
  homeBatting?: TeamBattingStats | null;
  awayBatting?: TeamBattingStats | null;
  homePitching?: TeamPitchingStats | null;
  awayPitching?: TeamPitchingStats | null;
  homeStanding?: MlbStandingRow;
  awayStanding?: MlbStandingRow;
}

/**
 * Best-effort MLB context for one game. Matches by team name OR abbr.
 * Returns null entries when data isn't available — caller should still
 * pass partial context to Claude.
 */
export async function buildMlbGameContext(
  homeTeamName: string,
  awayTeamName: string,
  homeAbbr?: string | null,
  awayAbbr?: string | null,
  date?: string,
): Promise<MlbGameContext> {
  const today = date ?? new Date().toISOString().slice(0, 10);
  const schedule = await fetchMlbScheduleForDate(today).catch(() => [] as MlbScheduleEntry[]);

  const matches = (entryName: string, abbr?: string, name?: string) =>
    (abbr && entryName.toLowerCase().includes(abbr.toLowerCase())) ||
    (name && entryName.toLowerCase().includes(name.toLowerCase().split(' ').slice(-1)[0]));

  const entry = schedule.find(
    (e) =>
      matches(e.home.teamName, homeAbbr ?? undefined, homeTeamName) &&
      matches(e.away.teamName, awayAbbr ?? undefined, awayTeamName),
  );

  const ctx: MlbGameContext = { schedule: entry };
  if (!entry) return ctx;

  const standings = await fetchMlbStandings().catch(() => new Map());
  ctx.homeStanding = standings.get(entry.home.teamId);
  ctx.awayStanding = standings.get(entry.away.teamId);

  const tasks: Promise<unknown>[] = [];
  if (entry.home.probable) tasks.push(fetchPitcherStats(entry.home.probable.id).then((v) => (ctx.homePitcher = v)).catch(() => null));
  if (entry.away.probable) tasks.push(fetchPitcherStats(entry.away.probable.id).then((v) => (ctx.awayPitcher = v)).catch(() => null));
  tasks.push(fetchTeamHittingStats(entry.home.teamId).then((v) => (ctx.homeBatting = v)).catch(() => null));
  tasks.push(fetchTeamHittingStats(entry.away.teamId).then((v) => (ctx.awayBatting = v)).catch(() => null));
  tasks.push(fetchTeamPitchingStats(entry.home.teamId).then((v) => (ctx.homePitching = v)).catch(() => null));
  tasks.push(fetchTeamPitchingStats(entry.away.teamId).then((v) => (ctx.awayPitching = v)).catch(() => null));
  await Promise.all(tasks);

  return ctx;
}
