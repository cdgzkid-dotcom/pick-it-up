// Simple ELO rating system. Stored in `elo_ratings` table keyed by (sport, team).
// All teams start at 1500. K=20. Home advantage = +50 ELO. Margin-of-victory
// multiplier dampens blowouts.

import type { SupabaseClient } from '@supabase/supabase-js';

const K = 20;
const HOME_ADVANTAGE = 50;
const DEFAULT_ELO = 1500;

interface EloRow {
  sport: string;
  team: string;
  abbreviation?: string | null;
  elo: number;
  games_played: number;
}

export async function getOrInit(
  supabase: SupabaseClient,
  sport: string,
  team: string,
  abbreviation?: string | null,
): Promise<EloRow> {
  const { data } = await supabase
    .from('elo_ratings')
    .select('*')
    .eq('sport', sport)
    .eq('team', team)
    .maybeSingle();
  if (data) return data as EloRow;
  const fresh: EloRow = {
    sport,
    team,
    abbreviation: abbreviation ?? null,
    elo: DEFAULT_ELO,
    games_played: 0,
  };
  await supabase.from('elo_ratings').insert([fresh]);
  return fresh;
}

export async function getRatingsForGames(
  supabase: SupabaseClient,
  pairs: Array<{ sport: string; home_team: string; away_team: string; home_team_abbr?: string | null; away_team_abbr?: string | null }>,
): Promise<Record<string, { home: EloRow; away: EloRow }>> {
  const result: Record<string, { home: EloRow; away: EloRow }> = {};
  for (const p of pairs) {
    const [home, away] = await Promise.all([
      getOrInit(supabase, p.sport, p.home_team, p.home_team_abbr),
      getOrInit(supabase, p.sport, p.away_team, p.away_team_abbr),
    ]);
    result[`${p.sport}|${p.home_team}|${p.away_team}`] = { home, away };
  }
  return result;
}

export async function applyResult(
  supabase: SupabaseClient,
  sport: string,
  homeTeam: string,
  awayTeam: string,
  homeScore: number,
  awayScore: number,
): Promise<void> {
  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return;
  if (homeScore === awayScore) return; // ties handled differently in some sports; skip for simplicity

  const home = await getOrInit(supabase, sport, homeTeam);
  const away = await getOrInit(supabase, sport, awayTeam);

  const eloHome = Number(home.elo) + HOME_ADVANTAGE;
  const eloAway = Number(away.elo);

  const expectedHome = 1 / (1 + Math.pow(10, (eloAway - eloHome) / 400));
  const expectedAway = 1 - expectedHome;

  const homeWon = homeScore > awayScore;
  const margin = Math.abs(homeScore - awayScore);
  // Margin multiplier: log scale so blowouts count more but not insanely
  const marginMult = Math.log(margin + 1) + 1; // 1..~3 range

  const homeResult = homeWon ? 1 : 0;
  const awayResult = homeWon ? 0 : 1;

  const newHome = Number(home.elo) + K * marginMult * (homeResult - expectedHome);
  const newAway = Number(away.elo) + K * marginMult * (awayResult - expectedAway);

  await Promise.all([
    supabase
      .from('elo_ratings')
      .update({
        elo: newHome,
        games_played: Number(home.games_played) + 1,
        last_updated: new Date().toISOString(),
      })
      .eq('sport', sport)
      .eq('team', homeTeam),
    supabase
      .from('elo_ratings')
      .update({
        elo: newAway,
        games_played: Number(away.games_played) + 1,
        last_updated: new Date().toISOString(),
      })
      .eq('sport', sport)
      .eq('team', awayTeam),
  ]);
}

export function eloWinProbability(homeElo: number, awayElo: number): number {
  return 1 / (1 + Math.pow(10, (awayElo - (homeElo + HOME_ADVANTAGE)) / 400));
}
