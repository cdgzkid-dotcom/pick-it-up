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

/** Log a swallowed fetch failure before the caller falls back to empty.
 *  A silent empty hid a 3-week ESPN 403 (see lib/healthChecks.ts) — never again. */
function warnFetchFailed(what: string, e: unknown): void {
  console.warn(`[nflStats] fetch failed ${what} ${e instanceof Error ? e.message : String(e)}`);
}

export async function fetchNflStandings(): Promise<Map<string, NflStandingRow>> {
  return cached(`nfl:standings:${NFL_SEASON}`, 120, async () => {
    const url = `${ESPN_BASE}/v2/sports/football/nfl/standings?season=${NFL_SEASON}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) { console.warn(`[nflStats] HTTP ${res.status} ${url}`); return new Map(); }
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

    // ESPN serves a full 32-team standings table for a season that has not
    // started yet, with every record at 0-0-0. Those zeros are indistinguishable
    // from real data downstream: build() finds a row for each team and produces
    // a complete NflTeamRow with record "0-0" and pointsFor 0, so the model
    // reasons over an empty slate as if it were evidence.
    //
    // Verified 27 Jul 2026: season=2026 returned 32 rows all at 0-0-0, while
    // season=2025 returned real records. Collapsing to an empty map makes
    // "no data yet" detectable by callers instead of silently truthy.
    let anyGamesPlayed = false;
    map.forEach((r) => {
      if (r.wins + r.losses + r.ties > 0) anyGamesPlayed = true;
    });
    if (!anyGamesPlayed) return new Map();

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
    const baseUrl = `${ESPN_BASE}/site/v2/sports/football/nfl/teams/${espnTeamId}/statistics`;
    const seasonUrl = `${baseUrl}?season=${NFL_SEASON}`;
    let res = await fetch(seasonUrl, { cache: 'no-store' });
    if (res.status === 404) {
      console.warn('[nflStats] ESPN team statistics HTTP', res.status, seasonUrl, '— retrying without season');
      res = await fetch(baseUrl, { cache: 'no-store' });
    }
    if (!res.ok) { console.warn(`[nflStats] HTTP ${res.status} ${res.status === 404 ? baseUrl : seasonUrl}`); return null; }
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
    const url = `${ESPN_BASE}/site/v2/sports/football/nfl/teams/${espnTeamId}/schedule?season=${NFL_SEASON}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) { console.warn(`[nflStats] HTTP ${res.status} ${url}`); return []; }
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
  /**
   * False when fetchNflStandings collapsed to an empty map — i.e. ESPN served
   * a full 32-team table with every record at 0-0-0 because the season hasn't
   * started (the normal state through NFL preseason). Explicit so the prompt
   * can TELL the model it has no standings instead of handing it an empty
   * object it might read as "nothing notable". See the blindaje in
   * fetchNflStandings (commit bdb6fc1) — never silently refill with zeros.
   */
  standings_available: boolean;
  /** Human-readable reason surfaced to the model when data is missing. */
  data_note?: string;
}

export async function buildNflGameContext(
  homeName: string,
  awayName: string,
): Promise<NflGameContext> {
  const standings = await fetchNflStandings().catch((e) => { warnFetchFailed('standings', e); return new Map<string, NflStandingRow>(); });
  const standingsAvailable = standings.size > 0;

  const build = async (teamName: string): Promise<NflTeamRow | undefined> => {
    const key = teamName.toUpperCase();
    const st = standings.get(key);
    if (!st) return undefined;

    const [stats, recent] = await Promise.all([
      fetchEspnTeamStats(st.espnId).catch((e) => { warnFetchFailed(`espn stats ${st.espnId}`, e); return null; }),
      fetchRecentGames(st.espnId, 10).catch((e) => { warnFetchFailed(`recent games ${st.espnId}`, e); return [] as NflRecentGame[]; }),
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

  if (!standingsAvailable) {
    console.log('[DATA][NFL] standings unavailable (all rows 0-0-0 for the season) —', `${awayName} @ ${homeName}`);
    return {
      home,
      away,
      standings_available: false,
      data_note:
        'ESPN no publica standings ni team stats para esta temporada todavía ' +
        '(toda la tabla está en 0-0). NO hay récords, PF/PA, ni forma reciente ' +
        'para estos equipos. No asumas 0-0 como evidencia: es ausencia de datos.',
    };
  }

  return { home, away, standings_available: true };
}
