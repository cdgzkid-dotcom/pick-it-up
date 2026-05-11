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

// ── Player props ────────────────────────────────────────────────────────────
// The Odds API serves props via the same /odds endpoint with different market
// keys. Free tier may not include them — we attempt and silently return null.

export interface PropLine {
  player: string;
  market: string;
  /** Home team name of the event this prop belongs to — used to join with games. */
  event_home?: string;
  event_away?: string;
  over_line?: number;
  over_odds?: number;
  under_odds?: number;
  books: Array<{ source: string; over_odds?: number; under_odds?: number; line?: number }>;
}

const PROP_MARKETS_BY_SPORT: Record<string, string[]> = {
  MLB: ['pitcher_strikeouts', 'batter_home_runs', 'batter_hits', 'batter_total_bases'],
  NHL: ['player_shots_on_goal', 'player_goals', 'player_assists', 'player_points'],
  NBA: ['player_points', 'player_rebounds', 'player_assists', 'player_threes'],
};

export async function fetchPlayerProps(sport: string): Promise<PropLine[] | null> {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return null;
  const sportKey = SPORT_KEYS[sport];
  const markets = PROP_MARKETS_BY_SPORT[sport];
  if (!sportKey || !markets) return null;

  return cached(`props:${sportKey}`, 5, async () => {
    try {
      // Most sportsbooks expose props per-event, not on the season-wide
      // /odds endpoint. We need to: (1) list events to get IDs, (2) hit
      // each event's /odds with the prop markets.
      const eventsUrl = `https://api.the-odds-api.com/v4/sports/${sportKey}/events?apiKey=${apiKey}`;
      const evRes = await fetch(eventsUrl, { next: { revalidate: 300 } });
      if (!evRes.ok) {
        console.warn(`[odds/props] ${sport} events list ${evRes.status}`);
        return null;
      }
      const eventList = (await evRes.json()) as Array<{ id: string; home_team: string; away_team: string }>;
      if (!eventList || eventList.length === 0) return null;

      // Cap to 8 events so we don't burn through quota on slow days.
      const targets = eventList.slice(0, 8);
      const lines: PropLine[] = [];

      await Promise.all(
        targets.map(async (evMeta) => {
          try {
            const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${evMeta.id}/odds?apiKey=${apiKey}&regions=us&markets=${markets.join(',')}&oddsFormat=decimal`;
            const r = await fetch(url, { next: { revalidate: 300 } });
            if (!r.ok) return;
            const ev = (await r.json()) as OddsApiEvent;
            for (const bm of ev.bookmakers ?? []) {
              for (const m of bm.markets) {
                if (!markets.includes(m.key)) continue;
                const byPlayer = new Map<string, { over?: { price: number; point?: number }; under?: { price: number; point?: number } }>();
                for (const o of m.outcomes) {
                  // The Odds API per-event format: outcome.name is "Over"/"Under",
                  // description is the player name. Fall back to legacy shape too.
                  const desc = ((o as Record<string, unknown>).description as string | undefined) ?? '';
                  const player = desc || o.name;
                  const sideName = (desc ? o.name : ((o as Record<string, unknown>).description as string | undefined) ?? '').toLowerCase();
                  const existing = byPlayer.get(player) ?? {};
                  if (sideName.includes('over') || (!desc && o.name.toLowerCase().includes('over'))) {
                    existing.over = { price: o.price, point: o.point };
                  } else if (sideName.includes('under') || (!desc && o.name.toLowerCase().includes('under'))) {
                    existing.under = { price: o.price, point: o.point };
                  }
                  byPlayer.set(player, existing);
                }
                byPlayer.forEach((sides, player) => {
                  let line = lines.find((l) => l.player === player && l.market === m.key && l.event_home === evMeta.home_team);
                  if (!line) {
                    line = {
                      player,
                      market: m.key,
                      event_home: evMeta.home_team,
                      event_away: evMeta.away_team,
                      over_line: sides.over?.point,
                      over_odds: sides.over?.price,
                      under_odds: sides.under?.price,
                      books: [],
                    };
                    lines.push(line);
                  }
                  line.books.push({ source: bm.title, over_odds: sides.over?.price, under_odds: sides.under?.price, line: sides.over?.point ?? sides.under?.point });
                });
              }
            }
          } catch (e) {
            console.warn(`[odds/props] ${sport} event ${evMeta.id} failed`, e);
          }
        }),
      );

      if (lines.length > 0) {
        console.log(`[odds/props] ${sport} found ${lines.length} prop lines across ${targets.length} events`);
      }
      return lines.length > 0 ? lines : null;
    } catch (e) {
      console.warn(`[odds/props] ${sport} failed`, e);
      return null;
    }
  });
}

/**
 * Sharp money analysis — uses Pinnacle as the "true price" benchmark.
 * Pinnacle has the highest limits + lowest margin in the industry, so its
 * implied probability is the closest we get to the consensus sharp view.
 *
 * Returns null when Pinnacle isn't in the rows (free tier of The Odds API
 * doesn't always include them — depends on region/sport).
 */
export interface SharpAnalysis {
  pinnacle_home_ml: number;
  pinnacle_away_ml: number;
  sharp_prob_home: number;
  sharp_prob_away: number;
  /** Per-book edge vs Pinnacle (positive = book is paying more than sharp). */
  edges: Array<{
    book: string;
    home_ml?: number;
    away_ml?: number;
    home_edge_vs_sharp?: number; // sharp_prob_home - (1/book.home_ml)
    away_edge_vs_sharp?: number;
  }>;
  /** Best edge by side (which book + how much over sharp). */
  best_home?: { book: string; ml: number; edge_vs_sharp: number };
  best_away?: { book: string; ml: number; edge_vs_sharp: number };
}

export function sharpAnalysis(rows: MultiOddsRow[]): SharpAnalysis | null {
  const pinn = rows.find((r) => /pinnacle/i.test(r.source));
  if (!pinn?.home_ml || !pinn?.away_ml) return null;
  const sharpProbHome = 1 / pinn.home_ml;
  const sharpProbAway = 1 / pinn.away_ml;

  const edges = rows
    .filter((r) => !/pinnacle/i.test(r.source))
    .map((r) => ({
      book: r.source,
      home_ml: r.home_ml,
      away_ml: r.away_ml,
      home_edge_vs_sharp: r.home_ml ? sharpProbHome - 1 / r.home_ml : undefined,
      away_edge_vs_sharp: r.away_ml ? sharpProbAway - 1 / r.away_ml : undefined,
    }));

  let best_home: SharpAnalysis['best_home'];
  let best_away: SharpAnalysis['best_away'];
  for (const e of edges) {
    if (e.home_ml && e.home_edge_vs_sharp != null && e.home_edge_vs_sharp > 0) {
      if (!best_home || e.home_edge_vs_sharp > best_home.edge_vs_sharp) {
        best_home = { book: e.book, ml: e.home_ml, edge_vs_sharp: e.home_edge_vs_sharp };
      }
    }
    if (e.away_ml && e.away_edge_vs_sharp != null && e.away_edge_vs_sharp > 0) {
      if (!best_away || e.away_edge_vs_sharp > best_away.edge_vs_sharp) {
        best_away = { book: e.book, ml: e.away_ml, edge_vs_sharp: e.away_edge_vs_sharp };
      }
    }
  }

  return {
    pinnacle_home_ml: pinn.home_ml,
    pinnacle_away_ml: pinn.away_ml,
    sharp_prob_home: sharpProbHome,
    sharp_prob_away: sharpProbAway,
    edges,
    best_home,
    best_away,
  };
}
