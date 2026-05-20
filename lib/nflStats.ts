// NFL stats — ESPN public API (free, no key).
// Pulls standings, team offensive/defensive stats, and recent game results.
// NFL season runs Sep–Feb; module returns empty data gracefully in offseason.

import { cached } from './cache';

const ESPN_BASE = 'https://site.api.espn.com/apis';

const NFL_SEASON = (() => {
  const now = new Date();
  const m = now.getUTCMonth();
  const y = now.getUTCFullYear();
  // NFL "2025 season" runs Sep 2025 → Feb 2026. If we're Jan-Jul, use
  // previous year's season. If Aug+, use current year.
  return m >= 7 ? y : y - 1;
})();

// ─── ESPN Standings ───────────────────────────────────────────────────

interface EspnStandingEntry {
  team: { id: string; displayName: string; abbreviation: string };
  stats: Array<{ name: string; displayValue: string; value?: number }>;
}

export interface NflStandingRow {
  espnId: string;
  team: string;
  abbr: string;
  wins: number;
  losses: number;
  ties: number;
  record: string;
  homeRecord?: string;
  awayRecord?: string;
  divisionRecord?: string;
  conferenceRecord?: string;
  streak?: string;
  pointsFor?: number;
  pointsAgainst?: number;
  pointDiff?: number;
  playoffSeed?: number;
}

export async function fetchNflStandings(): Promise<Map<string, NflStandingRow>> {
  return cached(`nfl:standings:${NFL_SEASON}`, 120, async () => {
    const res = await fetch(
      `${ESPN_BASE}/v2/sports/football/nfl/standings?season=${NFL_SEASON}`,
      { next: { revalidate: 7200 } },
    );
    if (!res.ok) return new Map();
    const data = await res.json();
    const map = new Map<string, NflStandingRow>();

    for (const conf of data.children ?? []) {
      for (const entry of (conf.standings?.entries ?? []) as EspnStandingEntry[]) {
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

        const wins = numStat('wins') ?? 0;
        const losses = numStat('losses') ?? 0;
        const ties = numStat('ties') ?? 0;

        map.set(team.displayName.toUpperCase(), {
          espnId: team.id,
          team: team.displayName,
          abbr: team.abbreviation,
          wins,
          losses,
          ties,
          record: `${wins}-${losses}${ties > 0 ? `-${ties}` : ''}`,
          homeRecord: stat('Home'),
          awayRecord: stat('Road'),
          divisionRecord: stat('vs. Div.'),
          conferenceRecord: stat('vs. Conf.'),
          streak: stat('streak'),
          pointsFor: numStat('pointsFor'),
          pointsAgainst: numStat('pointsAgainst'),
          pointDiff: numStat('pointDifferential') ?? numStat('differential'),
          playoffSeed: numStat('playoffSeed'),
        });
      }
    }
    return map;
  });
}

// ─── ESPN Team Stats ──────────────────────────────────────────────────

export interface NflTeamStats {
  // Passing
  completionPct?: number;
  passingYardsPerGame?: number;
  passingTDs?: number;
  interceptions?: number;
  yardsPerAttempt?: number;
  // Rushing
  rushingYardsPerGame?: number;
  yardsPerRush?: number;
  rushingTDs?: number;
  // Scoring
  totalPoints?: number;
  pointsPerGame?: number;
  // Turnovers
  fumbles?: number;
  fumblesLost?: number;
  takeaways?: number;
  turnoverDiff?: number;
  // Efficiency
  thirdDownPct?: number;
  fourthDownPct?: number;
  redZonePct?: number;
  // Defense
  sacks?: number;
  defensiveInterceptions?: number;
  defensiveTDs?: number;
  // Penalties
  penaltyYards?: number;
  penaltiesPerGame?: number;
  // General
  gamesPlayed?: number;
  firstDowns?: number;
  totalYards?: number;
  yardsPerPlay?: number;
}

async function fetchEspnTeamStats(espnTeamId: string): Promise<NflTeamStats | null> {
  return cached(`nfl:espn:stats:${espnTeamId}:${NFL_SEASON}`, 240, async () => {
    const res = await fetch(
      `${ESPN_BASE}/site/v2/sports/football/nfl/teams/${espnTeamId}/statistics?season=${NFL_SEASON}`,
      { next: { revalidate: 14400 } },
    );
    if (!res.ok) return null;
    const data = await res.json();

    const all = new Map<string, number>();
    for (const cat of data.results?.stats?.categories ?? []) {
      for (const s of (cat as { stats: Array<{ name: string; displayValue: string; value?: number }> }).stats ?? []) {
        if (s.value != null) all.set(s.name, s.value);
        else if (s.displayValue) {
          const n = parseFloat(s.displayValue.replace(/,/g, ''));
          if (!isNaN(n)) all.set(s.name, n);
        }
      }
    }
    if (all.size === 0) return null;

    const gp = all.get('gamesPlayed') ?? 17;
    const totalYards = (all.get('netPassingYards') ?? 0) + (all.get('rushingYards') ?? 0);
    const totalPlays = (all.get('passingAttempts') ?? 0) + (all.get('rushingAttempts') ?? 0);
    const defInts = all.get('interceptions') ?? 0;
    const fumblesRec = all.get('fumblesRecovered') ?? 0;
    const takeawaysTotal = defInts + fumblesRec;

    return {
      completionPct: all.get('completionPct'),
      passingYardsPerGame: all.get('netPassingYardsPerGame'),
      passingTDs: all.get('passingTouchdowns'),
      interceptions: all.get('interceptions'),
      yardsPerAttempt: all.get('yardsPerPassAttempt'),
      rushingYardsPerGame: all.get('rushingYardsPerGame'),
      yardsPerRush: all.get('yardsPerRushAttempt'),
      rushingTDs: all.get('rushingTouchdowns'),
      totalPoints: all.get('totalPoints'),
      pointsPerGame: all.get('totalPoints') != null ? Number(((all.get('totalPoints')!) / gp).toFixed(1)) : undefined,
      fumbles: all.get('fumbles'),
      fumblesLost: all.get('fumblesLost') || undefined,
      takeaways: takeawaysTotal > 0 ? takeawaysTotal : undefined,
      thirdDownPct: all.get('thirdDownConvPct'),
      fourthDownPct: all.get('fourthDownConvPct'),
      redZonePct: all.get('redZonePct'),
      sacks: all.get('sacks'),
      defensiveInterceptions: all.get('interceptions'),
      penaltyYards: all.get('penaltyYards'),
      penaltiesPerGame: all.get('penalties') != null ? Number(((all.get('penalties')!) / gp).toFixed(1)) : undefined,
      gamesPlayed: gp,
      firstDowns: all.get('firstDowns'),
      totalYards: totalYards > 0 ? totalYards : undefined,
      yardsPerPlay: totalPlays > 0 ? Number((totalYards / totalPlays).toFixed(1)) : undefined,
    };
  });
}

// ─── ESPN Recent Games ────────────────────────────────────────────────

export interface NflRecentGame {
  date: string;
  week?: number;
  opponent: string;
  homeAway: 'home' | 'away';
  won: boolean;
  score: string;
  teamScore: number;
  oppScore: number;
  isPlayoff: boolean;
}

async function fetchRecentGames(
  espnTeamId: string,
  limit = 10,
): Promise<NflRecentGame[]> {
  return cached(`nfl:espn:schedule:${espnTeamId}:${NFL_SEASON}`, 120, async () => {
    const res = await fetch(
      `${ESPN_BASE}/site/v2/sports/football/nfl/teams/${espnTeamId}/schedule?season=${NFL_SEASON}`,
      { next: { revalidate: 7200 } },
    );
    if (!res.ok) return [];
    const data = await res.json();

    const games: NflRecentGame[] = [];
    for (const ev of data.events ?? []) {
      const status = ev.competitions?.[0]?.status;
      if (!status?.type?.completed) continue;

      const comps = ev.competitions?.[0]?.competitors ?? [];
      const us = comps.find((c: { id?: string }) => String(c.id) === String(espnTeamId));
      const them = comps.find((c: { id?: string }) => String(c.id) !== String(espnTeamId));
      if (!us || !them) continue;

      const teamScore = Number(us.score?.displayValue ?? us.score ?? 0);
      const oppScore = Number(them.score?.displayValue ?? them.score ?? 0);
      const week = ev.week?.number;
      const seasonType = ev.seasonType?.type ?? ev.season?.type;

      games.push({
        date: ev.date?.substring(0, 10) ?? '',
        week: week ? Number(week) : undefined,
        opponent: them.team?.displayName ?? them.team?.name ?? '?',
        homeAway: us.homeAway === 'home' ? 'home' : 'away',
        won: teamScore > oppScore,
        score: `${teamScore}-${oppScore}`,
        teamScore,
        oppScore,
        isPlayoff: seasonType === 3 || seasonType === '3',
      });
    }

    return games.slice(-limit);
  });
}

// ─── Public interface ─────────────────────────────────────────────────

export interface NflTeamRow {
  team: string;
  abbr: string;
  wins: number;
  losses: number;
  ties: number;
  record: string;
  homeRecord?: string;
  awayRecord?: string;
  divisionRecord?: string;
  conferenceRecord?: string;
  streak?: string;
  pointsFor?: number;
  pointsAgainst?: number;
  pointDiff?: number;
  playoffSeed?: number;
  // Offense
  completionPct?: number;
  passingYardsPerGame?: number;
  rushingYardsPerGame?: number;
  pointsPerGame?: number;
  yardsPerPlay?: number;
  // Efficiency
  thirdDownPct?: number;
  redZonePct?: number;
  // Turnovers
  turnoverDiff?: number;
  // Defense
  sacks?: number;
  defensiveInterceptions?: number;
  // Full stats
  offenseStats?: NflTeamStats;
  // Recent form
  recentGames?: NflRecentGame[];
}

export interface NflGameContext {
  home?: NflTeamRow;
  away?: NflTeamRow;
}

export async function buildNflGameContext(
  homeName: string,
  awayName: string,
): Promise<NflGameContext> {
  const standings = await fetchNflStandings().catch(() => new Map<string, NflStandingRow>());

  const build = async (teamName: string): Promise<NflTeamRow | undefined> => {
    const key = teamName.toUpperCase();
    const st = standings.get(key);
    if (!st) return undefined;

    const [stats, recent] = await Promise.all([
      fetchEspnTeamStats(st.espnId).catch(() => null),
      fetchRecentGames(st.espnId, 10).catch(() => [] as NflRecentGame[]),
    ]);

    return {
      team: st.team,
      abbr: st.abbr,
      wins: st.wins,
      losses: st.losses,
      ties: st.ties,
      record: st.record,
      homeRecord: st.homeRecord,
      awayRecord: st.awayRecord,
      divisionRecord: st.divisionRecord,
      conferenceRecord: st.conferenceRecord,
      streak: st.streak,
      pointsFor: st.pointsFor,
      pointsAgainst: st.pointsAgainst,
      pointDiff: st.pointDiff,
      playoffSeed: st.playoffSeed,
      completionPct: stats?.completionPct,
      passingYardsPerGame: stats?.passingYardsPerGame,
      rushingYardsPerGame: stats?.rushingYardsPerGame,
      pointsPerGame: stats?.pointsPerGame,
      yardsPerPlay: stats?.yardsPerPlay,
      thirdDownPct: stats?.thirdDownPct,
      redZonePct: stats?.redZonePct,
      sacks: stats?.sacks,
      defensiveInterceptions: stats?.defensiveInterceptions,
      offenseStats: stats ?? undefined,
      recentGames: recent.length > 0 ? recent : undefined,
    };
  };

  const [home, away] = await Promise.all([build(homeName), build(awayName)]);

  if (home || away) {
    console.log(
      `[DATA][NFL] ${awayName} @ ${homeName}`,
      home ? `home:${home.record} PPG:${home.pointsPerGame ?? '?'} YPP:${home.yardsPerPlay ?? '?'} 3rd:${home.thirdDownPct ?? '?'}%` : 'home:no-data',
      away ? `away:${away.record} PPG:${away.pointsPerGame ?? '?'} YPP:${away.yardsPerPlay ?? '?'} 3rd:${away.thirdDownPct ?? '?'}%` : 'away:no-data',
    );
  }

  return { home, away };
}
