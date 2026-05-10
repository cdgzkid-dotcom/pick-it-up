// The Odds API integration — the-odds-api.com (free tier 500 req/mo).
// Optional: returns null when ODDS_API_KEY isn't set so pickGen falls back
// to ESPN's single-book odds.

import { cached } from './cache';

const SPORT_KEYS: Record<string, string> = {
  MLB: 'baseball_mlb',
  NBA: 'basketball_nba',
  NHL: 'icehockey_nhl',
  NFL: 'americanfootball_nfl',
};

interface OddsApiBookmaker {
  key: string;
  title: string;
  last_update: string;
  markets: Array<{
    key: 'h2h' | 'spreads' | 'totals' | string;
    outcomes: Array<{ name: string; price: number; point?: number }>;
  }>;
}

interface OddsApiEvent {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: OddsApiBookmaker[];
}

export interface MultiOddsRow {
  source: string;
  home_ml?: number;
  away_ml?: number;
  draw_ml?: number;
  spread?: { home_line: number; home_odds: number; away_odds: number };
  total?: { line: number; over: number; under: number };
  last_update: string;
}

export async function fetchMultiOdds(sport: string): Promise<OddsApiEvent[] | null> {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return null;
  const sportKey = SPORT_KEYS[sport];
  if (!sportKey) return null;

  return cached(`odds:${sportKey}`, 5, async () => {
    try {
      const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?apiKey=${apiKey}&regions=us&markets=h2h,spreads,totals&oddsFormat=decimal`;
      const r = await fetch(url, { next: { revalidate: 300 } });
      if (!r.ok) {
        console.warn(`[odds] ${sport} ${r.status}`);
        return null;
      }
      const data = (await r.json()) as OddsApiEvent[];
      return data;
    } catch (e) {
      console.warn(`[odds] ${sport} failed`, e);
      return null;
    }
  });
}

export function findOddsForGame(
  events: OddsApiEvent[] | null,
  homeTeam: string,
  awayTeam: string,
): MultiOddsRow[] {
  if (!events) return [];
  const homeNorm = homeTeam.toLowerCase();
  const awayNorm = awayTeam.toLowerCase();
  const ev = events.find(
    (e) =>
      e.home_team.toLowerCase().includes(homeNorm.split(' ').slice(-1)[0]) &&
      e.away_team.toLowerCase().includes(awayNorm.split(' ').slice(-1)[0]),
  );
  if (!ev) return [];
  const rows: MultiOddsRow[] = [];
  for (const bm of ev.bookmakers) {
    const row: MultiOddsRow = { source: bm.title, last_update: bm.last_update };
    for (const m of bm.markets) {
      if (m.key === 'h2h') {
        for (const o of m.outcomes) {
          const name = o.name.toLowerCase();
          if (name.includes(ev.home_team.toLowerCase().split(' ').slice(-1)[0])) row.home_ml = o.price;
          else if (name.includes(ev.away_team.toLowerCase().split(' ').slice(-1)[0])) row.away_ml = o.price;
          else if (name === 'draw') row.draw_ml = o.price;
        }
      } else if (m.key === 'spreads') {
        const home = m.outcomes.find((o) => o.name.toLowerCase().includes(ev.home_team.toLowerCase().split(' ').slice(-1)[0]));
        const away = m.outcomes.find((o) => o.name.toLowerCase().includes(ev.away_team.toLowerCase().split(' ').slice(-1)[0]));
        if (home?.point != null && home.price && away?.price) {
          row.spread = { home_line: home.point, home_odds: home.price, away_odds: away.price };
        }
      } else if (m.key === 'totals') {
        const over = m.outcomes.find((o) => o.name.toLowerCase() === 'over');
        const under = m.outcomes.find((o) => o.name.toLowerCase() === 'under');
        if (over?.point != null) {
          row.total = { line: over.point, over: over.price, under: under?.price ?? over.price };
        }
      }
    }
    rows.push(row);
  }
  return rows;
}

export interface BestOdds {
  side: 'home' | 'away';
  decimal: number;
  source: string;
}

export function bestMoneylineByBook(rows: MultiOddsRow[]): { home?: BestOdds; away?: BestOdds } {
  let best_home: BestOdds | undefined;
  let best_away: BestOdds | undefined;
  for (const r of rows) {
    if (r.home_ml && (!best_home || r.home_ml > best_home.decimal)) {
      best_home = { side: 'home', decimal: r.home_ml, source: r.source };
    }
    if (r.away_ml && (!best_away || r.away_ml > best_away.decimal)) {
      best_away = { side: 'away', decimal: r.away_ml, source: r.source };
    }
  }
  return { home: best_home, away: best_away };
}
