// NHL API integration — api-web.nhle.com + api.nhle.com/stats (free, no key).
// Pulls standings, team summary, and goalie summary for a given NHL game.

import { cached } from './cache';

const SEASON = (() => {
  const now = new Date();
  const y = now.getUTCFullYear();
  // NHL season "2025-26" runs Oct 2025 → Jun 2026. Pick whichever start year
  // is current.
  return now.getUTCMonth() >= 8 ? `${y}${y + 1}` : `${y - 1}${y}`;
})();

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
  record: string; // W-L-OTL
  points: number;
  streak?: string;
  homeRecord?: string;
  awayRecord?: string;
  last10?: string;
  goalsFor?: number;
  goalsAgainst?: number;
}

export async function fetchNhlStandings(): Promise<Map<string, NhlStandingRow>> {
  return cached('nhl:standings', 120, async () => {
    const r = await fetch('https://api-web.nhle.com/v1/standings/now', { next: { revalidate: 7200 } });
    if (!r.ok) return new Map();
    const data: StandingsResp = await r.json();
    const map = new Map<string, NhlStandingRow>();
    for (const t of data.standings ?? []) {
      const abbr = t.teamAbbrev?.default;
      if (!abbr) continue;
      map.set(abbr.toUpperCase(), {
        abbr: abbr.toUpperCase(),
        teamName: t.teamName?.default ?? t.teamCommonName?.default ?? abbr,
        record: `${t.wins}-${t.losses}-${t.otLosses ?? 0}`,
        points: t.points,
        streak: t.streakCode && t.streakCount ? `${t.streakCode}${t.streakCount}` : undefined,
        homeRecord: t.homeWins != null ? `${t.homeWins}-${t.homeLosses ?? 0}-${t.homeOtLosses ?? 0}` : undefined,
        awayRecord: t.roadWins != null ? `${t.roadWins}-${t.roadLosses ?? 0}-${t.roadOtLosses ?? 0}` : undefined,
        last10: t.l10Wins != null ? `${t.l10Wins}-${t.l10Losses ?? 0}-${t.l10OtLosses ?? 0}` : undefined,
        goalsFor: t.goalFor,
        goalsAgainst: t.goalAgainst,
      });
    }
    return map;
  });
}

interface TeamSummaryRow {
  teamFullName?: string;
  triCode?: string;
  goalsForPerGame?: number;
  goalsAgainstPerGame?: number;
  powerPlayPct?: number;
  penaltyKillPct?: number;
  shotsForPerGame?: number;
  shotsAgainstPerGame?: number;
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
}

export async function fetchNhlTeamSummary(): Promise<Map<string, NhlTeamSummary>> {
  return cached(`nhl:teamSummary:${SEASON}`, 240, async () => {
    const url = `https://api.nhle.com/stats/rest/en/team/summary?cayenneExp=seasonId=${SEASON}`;
    const r = await fetch(url, { next: { revalidate: 14400 } });
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
      });
    }
    return map;
  });
}

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
    const r = await fetch(url, { next: { revalidate: 14400 } });
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

export interface NhlGameContext {
  homeStanding?: NhlStandingRow;
  awayStanding?: NhlStandingRow;
  homeSummary?: NhlTeamSummary;
  awaySummary?: NhlTeamSummary;
  /** Top 2 goalies by GP per team (could be the starter + backup) */
  homeGoalies?: NhlGoalieRow[];
  awayGoalies?: NhlGoalieRow[];
}

export async function buildNhlGameContext(
  homeAbbr?: string | null,
  awayAbbr?: string | null,
): Promise<NhlGameContext> {
  if (!homeAbbr || !awayAbbr) return {};
  const homeUp = homeAbbr.toUpperCase();
  const awayUp = awayAbbr.toUpperCase();

  const [standings, teams, goalies] = await Promise.all([
    fetchNhlStandings().catch(() => new Map()),
    fetchNhlTeamSummary().catch(() => new Map()),
    fetchNhlGoalies().catch(() => [] as NhlGoalieRow[]),
  ]);

  return {
    homeStanding: standings.get(homeUp),
    awayStanding: standings.get(awayUp),
    homeSummary: teams.get(homeUp),
    awaySummary: teams.get(awayUp),
    homeGoalies: goalies.filter((g) => g.team === homeUp).sort((a, b) => b.gp - a.gp).slice(0, 2),
    awayGoalies: goalies.filter((g) => g.team === awayUp).sort((a, b) => b.gp - a.gp).slice(0, 2),
  };
}
