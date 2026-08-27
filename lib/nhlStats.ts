// NHL API integration — api-web.nhle.com + api.nhle.com/stats (free, no key)
// + ESPN public API for additional team stats (shooting%, faceoff%, save%).
// Pulls standings, team summary, goalies, recent game results, and ESPN
// team metrics for a given NHL game.

import { cached } from './cache';

const SEASON = (() => {
  const now = new Date();
  const y = now.getUTCFullYear();
  return now.getUTCMonth() >= 8 ? `${y}${y + 1}` : `${y - 1}${y}`;
})();

const ESPN_BASE = 'https://site.api.espn.com/apis';

// ─── NHLE Standings ───────────────────────────────────────────────────

interface NhlStandingTeam {
  teamCommonName?: { default?: string };
  teamName?: { default?: string };
  teamAbbrev?: { default?: string };
  wins: number;
  losses: number;
  otLosses?: number;
  points: number;
  streakCode?: string;
  streakCount?: number;
  homeWins?: number;
  homeLosses?: number;
  homeOtLosses?: number;
  roadWins?: number;
  roadLosses?: number;
  roadOtLosses?: number;
  l10Wins?: number;
  l10Losses?: number;
  l10OtLosses?: number;
  goalFor?: number;
  goalAgainst?: number;
}

interface StandingsResp {
  standings?: NhlStandingTeam[];
}

export interface NhlStandingRow {
  abbr: string;
  teamName: string;
  record: string;
  points: number;
  streak?: string;
  homeRecord?: string;
  awayRecord?: string;
  last10?: string;
  goalsFor?: number;
  goalsAgainst?: number;
  goalDiff?: number;
}

export async function fetchNhlStandings(): Promise<Map<string, NhlStandingRow>> {
  return cached('nhl:standings', 120, async () => {
    const r = await fetch('https://api-web.nhle.com/v1/standings/now', { cache: 'no-store' });
    if (!r.ok) return new Map();
    const data: StandingsResp = await r.json();
    const map = new Map<string, NhlStandingRow>();
    for (const t of data.standings ?? []) {
      const abbr = t.teamAbbrev?.default;
      if (!abbr) continue;
      const gf = t.goalFor ?? 0;
      const ga = t.goalAgainst ?? 0;
      map.set(abbr.toUpperCase(), {
        abbr: abbr.toUpperCase(),
        teamName: t.teamName?.default ?? t.teamCommonName?.default ?? abbr,
        record: `${t.wins}-${t.losses}-${t.otLosses ?? 0}`,
        points: t.points,
        streak: t.streakCode && t.streakCount ? `${t.streakCode}${t.streakCount}` : undefined,
        homeRecord: t.homeWins != null ? `${t.homeWins}-${t.homeLosses ?? 0}-${t.homeOtLosses ?? 0}` : undefined,
        awayRecord: t.roadWins != null ? `${t.roadWins}-${t.roadLosses ?? 0}-${t.roadOtLosses ?? 0}` : undefined,
        last10: t.l10Wins != null ? `${t.l10Wins}-${t.l10Losses ?? 0}-${t.l10OtLosses ?? 0}` : undefined,
        goalsFor: gf,
        goalsAgainst: ga,
        goalDiff: gf - ga,
      });
    }
    return map;
  });
}

// ─── NHLE Team Summary (PP%, PK%, GF/GP, GA/GP, shots) ───────────────

interface TeamSummaryRow {
  teamFullName?: string;
  triCode?: string;
  goalsForPerGame?: number;
  goalsAgainstPerGame?: number;
  powerPlayPct?: number;
  penaltyKillPct?: number;
  shotsForPerGame?: number;
  shotsAgainstPerGame?: number;
  faceoffWinPct?: number;
}

interface TeamSummaryResp {
  data?: TeamSummaryRow[];
}

export interface NhlTeamSummary {
  abbr: string;
  goalsForPerGame?: number;
  goalsAgainstPerGame?: number;
  ppPct?: number;
  pkPct?: number;
  shotsFor?: number;
  shotsAgainst?: number;
  faceoffPct?: number;
}

export async function fetchNhlTeamSummary(): Promise<Map<string, NhlTeamSummary>> {
  return cached(`nhl:teamSummary:${SEASON}`, 240, async () => {
    const url = `https://api.nhle.com/stats/rest/en/team/summary?cayenneExp=seasonId=${SEASON}`;
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return new Map();
    const data: TeamSummaryResp = await r.json();
    const map = new Map<string, NhlTeamSummary>();
    for (const t of data.data ?? []) {
      const abbr = t.triCode;
      if (!abbr) continue;
      map.set(abbr.toUpperCase(), {
        abbr: abbr.toUpperCase(),
        goalsForPerGame: t.goalsForPerGame,
        goalsAgainstPerGame: t.goalsAgainstPerGame,
        ppPct: t.powerPlayPct ? Number((t.powerPlayPct * 100).toFixed(1)) : undefined,
        pkPct: t.penaltyKillPct ? Number((t.penaltyKillPct * 100).toFixed(1)) : undefined,
        shotsFor: t.shotsForPerGame,
        shotsAgainst: t.shotsAgainstPerGame,
        faceoffPct: t.faceoffWinPct ? Number((t.faceoffWinPct * 100).toFixed(1)) : undefined,
      });
    }
    return map;
  });
}

// ─── NHLE Goalies ─────────────────────────────────────────────────────

interface GoalieRow {
  goalieFullName?: string;
  teamAbbrevs?: string;
  gamesPlayed?: number;
  wins?: number;
  losses?: number;
  goalsAgainstAverage?: number;
  savePct?: number;
  shutouts?: number;
}

interface GoalieResp {
  data?: GoalieRow[];
}

export interface NhlGoalieRow {
  name: string;
  team: string;
  gp: number;
  record: string;
  gaa?: number;
  svPct?: number;
  shutouts?: number;
}

export async function fetchNhlGoalies(): Promise<NhlGoalieRow[]> {
  return cached(`nhl:goalies:${SEASON}`, 240, async () => {
    const url = `https://api.nhle.com/stats/rest/en/goalie/summary?cayenneExp=seasonId=${SEASON}&limit=120`;
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return [];
    const data: GoalieResp = await r.json();
    return (data.data ?? [])
      .filter((g) => g.goalieFullName && g.teamAbbrevs)
      .map((g) => ({
        name: g.goalieFullName!,
        team: g.teamAbbrevs!.split(',').pop()!.trim().toUpperCase(),
        gp: g.gamesPlayed ?? 0,
        record: `${g.wins ?? 0}-${g.losses ?? 0}`,
        gaa: g.goalsAgainstAverage,
        svPct: g.savePct ? Number((g.savePct * 1000).toFixed(0)) / 1000 : undefined,
        shutouts: g.shutouts,
      }));
  });
}

// ─── NHLE Recent Games ────────────────────────────────────────────────

interface NhleScheduleGame {
  gameDate?: string;
  gameState?: string;
  gameType?: number;
  homeTeam?: { abbrev?: string; score?: number };
  awayTeam?: { abbrev?: string; score?: number };
}

export interface NhlRecentGame {
  date: string;
  opponent: string;
  homeAway: 'home' | 'away';
  won: boolean;
  score: string;
  goalsFor: number;
  goalsAgainst: number;
  isPlayoff: boolean;
}

async function fetchRecentGames(
  teamAbbr: string,
  limit = 10,
): Promise<NhlRecentGame[]> {
  return cached(`nhl:recentGames:${teamAbbr}:${SEASON}`, 120, async () => {
    const url = `https://api-web.nhle.com/v1/club-schedule-season/${teamAbbr}/${SEASON}`;
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return [];
    const data = await r.json();
    const games: NhlRecentGame[] = [];

    for (const g of (data.games ?? []) as NhleScheduleGame[]) {
      if (g.gameState !== 'OFF' && g.gameState !== 'FINAL') continue;
      const isHome = g.homeTeam?.abbrev?.toUpperCase() === teamAbbr.toUpperCase();
      const gf = isHome ? (g.homeTeam?.score ?? 0) : (g.awayTeam?.score ?? 0);
      const ga = isHome ? (g.awayTeam?.score ?? 0) : (g.homeTeam?.score ?? 0);
      const opp = isHome
        ? (g.awayTeam?.abbrev ?? '?')
        : (g.homeTeam?.abbrev ?? '?');

      games.push({
        date: g.gameDate ?? '',
        opponent: opp,
        homeAway: isHome ? 'home' : 'away',
        won: gf > ga,
        score: `${gf}-${ga}`,
        goalsFor: gf,
        goalsAgainst: ga,
        isPlayoff: g.gameType === 3,
      });
    }

    return games.slice(-limit);
  });
}

// ─── ESPN Team Stats (shooting%, faceoff%, save%) ─────────────────────

interface EspnStatItem {
  name: string;
  displayValue: string;
  value?: number;
}

interface EspnStatsCategory {
  name: string;
  stats: EspnStatItem[];
}

export interface NhlEspnStats {
  shootingPct?: number;
  faceoffPct?: number;
  savePct?: number;
  gaa?: number;
  ppGoals?: number;
  shGoals?: number;
  penaltyMinutes?: number;
}

async function fetchEspnNhlTeamId(teamAbbr: string): Promise<string | null> {
  return cached('nhl:espn:teamMap', 1440, async () => {
    const res = await fetch(`${ESPN_BASE}/site/v2/sports/hockey/nhl/teams`, {
      cache: 'no-store',
    });
    if (!res.ok) return new Map<string, string>();
    const data = await res.json();
    const map = new Map<string, string>();
    for (const entry of data.sports?.[0]?.leagues?.[0]?.teams ?? []) {
      const t = entry.team;
      if (t?.abbreviation && t?.id) {
        map.set(t.abbreviation.toUpperCase(), String(t.id));
      }
    }
    return map;
  }).then((map) => (map as Map<string, string>).get(teamAbbr.toUpperCase()) ?? null);
}

async function fetchEspnTeamStats(teamAbbr: string): Promise<NhlEspnStats | null> {
  const espnId = await fetchEspnNhlTeamId(teamAbbr).catch(() => null);
  if (!espnId) return null;

  return cached(`nhl:espn:stats:${espnId}`, 240, async () => {
    const res = await fetch(
      `${ESPN_BASE}/site/v2/sports/hockey/nhl/teams/${espnId}/statistics?seasontype=2`,
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
      shootingPct: allStats.get('shootingPct') ?? allStats.get('shootingPctg'),
      faceoffPct: allStats.get('faceoffPercent') ?? allStats.get('faceoffPct'),
      savePct: allStats.get('savePct'),
      gaa: allStats.get('avgGoalsAgainst'),
      ppGoals: allStats.get('powerPlayGoals'),
      shGoals: allStats.get('shortHandedGoals'),
      penaltyMinutes: allStats.get('penaltyMinutes'),
    };
  });
}

// ─── Public interface ─────────────────────────────────────────────────

export interface NhlGameContext {
  homeStanding?: NhlStandingRow;
  awayStanding?: NhlStandingRow;
  homeSummary?: NhlTeamSummary;
  awaySummary?: NhlTeamSummary;
  homeGoalies?: NhlGoalieRow[];
  awayGoalies?: NhlGoalieRow[];
  homeRecentGames?: NhlRecentGame[];
  awayRecentGames?: NhlRecentGame[];
  homeEspnStats?: NhlEspnStats;
  awayEspnStats?: NhlEspnStats;
}

export async function buildNhlGameContext(
  homeAbbr?: string | null,
  awayAbbr?: string | null,
): Promise<NhlGameContext> {
  if (!homeAbbr || !awayAbbr) return {};
  const homeUp = homeAbbr.toUpperCase();
  const awayUp = awayAbbr.toUpperCase();

  const [standings, teams, goalies, homeRecent, awayRecent, homeEspn, awayEspn] =
    await Promise.all([
      fetchNhlStandings().catch(() => new Map<string, NhlStandingRow>()),
      fetchNhlTeamSummary().catch(() => new Map<string, NhlTeamSummary>()),
      fetchNhlGoalies().catch(() => [] as NhlGoalieRow[]),
      fetchRecentGames(homeUp, 10).catch(() => [] as NhlRecentGame[]),
      fetchRecentGames(awayUp, 10).catch(() => [] as NhlRecentGame[]),
      fetchEspnTeamStats(homeUp).catch(() => null),
      fetchEspnTeamStats(awayUp).catch(() => null),
    ]);

  const ctx: NhlGameContext = {
    homeStanding: standings.get(homeUp),
    awayStanding: standings.get(awayUp),
    homeSummary: teams.get(homeUp),
    awaySummary: teams.get(awayUp),
    homeGoalies: goalies.filter((g) => g.team === homeUp).sort((a, b) => b.gp - a.gp).slice(0, 2),
    awayGoalies: goalies.filter((g) => g.team === awayUp).sort((a, b) => b.gp - a.gp).slice(0, 2),
    homeRecentGames: homeRecent.length > 0 ? homeRecent : undefined,
    awayRecentGames: awayRecent.length > 0 ? awayRecent : undefined,
    homeEspnStats: homeEspn ?? undefined,
    awayEspnStats: awayEspn ?? undefined,
  };

  console.log(
    `[DATA][NHL] ${awayUp}@${homeUp}`,
    ctx.homeStanding ? `home:${ctx.homeStanding.record} L10:${ctx.homeStanding.last10 ?? '?'}` : 'home:no-data',
    ctx.awayStanding ? `away:${ctx.awayStanding.record} L10:${ctx.awayStanding.last10 ?? '?'}` : 'away:no-data',
    ctx.homeSummary ? `PP:${ctx.homeSummary.ppPct}% PK:${ctx.homeSummary.pkPct}%` : '',
    homeRecent.length > 0 ? `recent:${homeRecent.length}g` : '',
  );

  return ctx;
}
