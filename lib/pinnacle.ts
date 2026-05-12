// Pinnacle Guest API — second market source for the consensus gate.
//
// Why: ESPN BPI returns HTTP 400 for NHL, so until this commit Auditoría
// 2 v2's market_sources_count_below_2 check blocked 100% of hockey picks
// structurally. Pinnacle covers MLB/NBA/NFL/NHL and is the reference
// "sharp" book — they price first and others copy, so their line is the
// closest free signal to the efficient market.
//
// CONTRACT (matches the inventory approved 2026-05-12):
//   • Pinnacle COMPLEMENTS DK + BPI; never replaces.
//   • computeMarketConsensus' avg_implied_prob stays simple-mean to
//     avoid recalibrating the floor's tier thresholds.
//   • edge_vs_pinnacle is a SEPARATE field consumed by Auditoría 2 v2.
//   • Every error path is graceful — if Pinnacle is unreachable the
//     system continues exactly as before (DK + BPI). Status field carries
//     the failure reason for debugging.
//
// AUTH: public "guest" token historically embedded in pinnacle.com's
// SPA. No quota, no per-user limits observed in 24h of probing. If the
// token ever rotates, `pinnacle_status='api_error'` flags it loudly via
// the healthChecks.pinnacle_api alert.

import type { SupabaseClient } from '@supabase/supabase-js';

const PINNACLE_BASE = 'https://guest.api.arcadia.pinnacle.com/0.1';
const PINNACLE_TOKEN = 'CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R';

/** Map Pick-It-Up sport → Pinnacle sport id. Other sports (Soccer 29,
 *  Tennis 33) intentionally omitted — they're out of scope today. */
const SPORT_TO_PINNACLE_ID: Record<string, number> = {
  MLB: 3,
  NBA: 4,
  NFL: 15,
  NHL: 19,
};

const PINNACLE_CACHE_TTL_SEC = 600; // 10 min — Pinnacle moves slowly enough
const PINNACLE_TIMEOUT_MS = 6_000;

export type PinnacleStatus =
  | 'available'
  | 'matchup_not_found'
  | 'no_ml_open'
  | 'sport_unsupported'
  | 'api_error'
  | 'not_called';

export interface PinnacleOddsResult {
  status: PinnacleStatus;
  /** 0-1 implied probability for the home side. null when unavailable. */
  home_implied: number | null;
  away_implied: number | null;
  /** Pinnacle internal matchup id — useful for debug + cache key. */
  matchup_id: number | null;
}

interface PinnacleMatchup {
  id: number;
  startTime?: string;
  status?: string;
  league?: { name?: string };
  participants?: Array<{ name?: string; alignment?: 'home' | 'away' }>;
}

interface PinnacleMarket {
  type?: string;
  period?: number;
  status?: string;
  prices?: Array<{ designation?: string; price?: number }>;
}

/** Convert an American line to implied probability (0-1).
 *  +200 → 100/(200+100) = 0.333
 *  -150 → 150/(150+100) = 0.600 */
function americanToImplied(american: number): number | null {
  if (!Number.isFinite(american) || american === 0) return null;
  if (american > 0) return 100 / (american + 100);
  return -american / (-american + 100);
}

async function pinnacleFetch<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${PINNACLE_BASE}${path}`, {
      headers: {
        'x-api-key': PINNACLE_TOKEN,
        'User-Agent': 'pick-it-up/1.0',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(PINNACLE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Find the Pinnacle matchup that corresponds to an ESPN event by exact
 *  team-name match (case-insensitive). Returns null if no clean match.
 *  startTime within ±60 min is a soft sanity guard (some matchups have
 *  stale or unscheduled entries; the time window keeps us on the right
 *  game when both teams play multiple games per day, e.g. doubleheaders). */
function findMatchupByTeams(
  matchups: PinnacleMatchup[],
  home_team: string,
  away_team: string,
  game_start_time: string | null,
  leagueName: string,
): PinnacleMatchup | null {
  const home_l = home_team.toLowerCase().trim();
  const away_l = away_team.toLowerCase().trim();
  const targetMs = game_start_time ? new Date(game_start_time).getTime() : null;
  const candidates = matchups.filter((m) => {
    if (m.league?.name !== leagueName) return false;
    const parts = m.participants ?? [];
    if (parts.length < 2) return false;
    const homeP = parts.find((p) => p.alignment === 'home');
    const awayP = parts.find((p) => p.alignment === 'away');
    if (!homeP?.name || !awayP?.name) return false;
    return (
      homeP.name.toLowerCase().trim() === home_l &&
      awayP.name.toLowerCase().trim() === away_l
    );
  });
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  // Multiple matches (rare: doubleheaders). Pick the one closest in start time.
  if (!targetMs) return candidates[0];
  let best = candidates[0];
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    if (!c.startTime) continue;
    const delta = Math.abs(new Date(c.startTime).getTime() - targetMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = c;
    }
  }
  return best;
}

/** Extract home/away moneyline implied prob from the full-game ML market
 *  (type='moneyline', period=0, status='open'). Returns nulls if the
 *  market is missing or one side is missing — we treat asymmetric data
 *  as no data to keep the consensus gate honest. */
function extractMlFromMarkets(markets: PinnacleMarket[]): {
  home: number;
  away: number;
} | null {
  // Pinnacle returns multiple moneyline rows per period=0 — some are
  // derivative props (3-way with draw, futures). Pick the first one
  // with clean home+away designations.
  const candidates = markets.filter(
    (m) => m.type === 'moneyline' && m.period === 0 && m.status === 'open',
  );
  for (const m of candidates) {
    const prices = m.prices ?? [];
    const homeP = prices.find((p) => p.designation === 'home');
    const awayP = prices.find((p) => p.designation === 'away');
    if (homeP?.price != null && awayP?.price != null) {
      const home = americanToImplied(homeP.price);
      const away = americanToImplied(awayP.price);
      if (home != null && away != null) return { home, away };
    }
  }
  return null;
}

/** Read a fresh-enough cache row. Returns null on miss/expired/error. */
async function readCache(
  supabase: SupabaseClient,
  espn_event_id: string,
): Promise<PinnacleOddsResult | null> {
  try {
    const { data, error } = await supabase
      .from('pinnacle_cache')
      .select('pinnacle_matchup_id, home_implied, away_implied, fetched_at, ttl_seconds')
      .eq('espn_event_id', espn_event_id)
      .maybeSingle();
    if (error || !data) return null;
    const ageSec =
      (Date.now() - new Date(data.fetched_at as string).getTime()) / 1000;
    const ttl = (data.ttl_seconds as number) ?? PINNACLE_CACHE_TTL_SEC;
    if (ageSec > ttl) return null;
    const home = data.home_implied != null ? Number(data.home_implied) : null;
    const away = data.away_implied != null ? Number(data.away_implied) : null;
    if (home == null || away == null) return null;
    return {
      status: 'available',
      home_implied: home,
      away_implied: away,
      matchup_id:
        data.pinnacle_matchup_id != null ? Number(data.pinnacle_matchup_id) : null,
    };
  } catch {
    return null;
  }
}

async function writeCache(
  supabase: SupabaseClient,
  espn_event_id: string,
  sport: string,
  home_team: string,
  away_team: string,
  matchup_id: number,
  home_implied: number,
  away_implied: number,
): Promise<void> {
  try {
    await supabase.from('pinnacle_cache').upsert(
      {
        espn_event_id,
        pinnacle_matchup_id: matchup_id,
        sport,
        home_team,
        away_team,
        home_implied,
        away_implied,
        fetched_at: new Date().toISOString(),
        ttl_seconds: PINNACLE_CACHE_TTL_SEC,
      },
      { onConflict: 'espn_event_id' },
    );
  } catch {
    /* cache write failures don't break the flow */
  }
}

/**
 * Public entrypoint. Given an ESPN event + teams, return Pinnacle's
 * full-game ML implied probabilities for both sides. Always resolves —
 * the `status` field carries success/failure for downstream logging.
 */
export async function fetchPinnacleOddsForEspnEvent(
  supabase: SupabaseClient,
  espn_event_id: string,
  sport: string,
  home_team: string,
  away_team: string,
  game_start_time: string | null,
): Promise<PinnacleOddsResult> {
  const sportId = SPORT_TO_PINNACLE_ID[sport];
  if (!sportId) {
    return {
      status: 'sport_unsupported',
      home_implied: null,
      away_implied: null,
      matchup_id: null,
    };
  }

  // 1. Cache check
  const cached = await readCache(supabase, espn_event_id);
  if (cached) return cached;

  // 2. List matchups for the sport
  const matchupsResp = await pinnacleFetch<PinnacleMatchup[] | { matchups?: PinnacleMatchup[] }>(
    `/sports/${sportId}/matchups?withSpecials=false&brandId=0`,
  );
  if (!matchupsResp) {
    return {
      status: 'api_error',
      home_implied: null,
      away_implied: null,
      matchup_id: null,
    };
  }
  const matchups: PinnacleMatchup[] = Array.isArray(matchupsResp)
    ? matchupsResp
    : (matchupsResp.matchups ?? []);

  // 3. Find this event's matchup
  const matchup = findMatchupByTeams(matchups, home_team, away_team, game_start_time, sport);
  if (!matchup) {
    return {
      status: 'matchup_not_found',
      home_implied: null,
      away_implied: null,
      matchup_id: null,
    };
  }

  // 4. Fetch markets for the matchup
  const marketsResp = await pinnacleFetch<PinnacleMarket[]>(
    `/matchups/${matchup.id}/markets/related/straight`,
  );
  if (!marketsResp) {
    return {
      status: 'api_error',
      home_implied: null,
      away_implied: null,
      matchup_id: matchup.id,
    };
  }

  const ml = extractMlFromMarkets(marketsResp);
  if (!ml) {
    return {
      status: 'no_ml_open',
      home_implied: null,
      away_implied: null,
      matchup_id: matchup.id,
    };
  }

  // 5. Persist cache (best-effort, errors swallowed)
  await writeCache(
    supabase,
    espn_event_id,
    sport,
    home_team,
    away_team,
    matchup.id,
    ml.home,
    ml.away,
  );

  return {
    status: 'available',
    home_implied: ml.home,
    away_implied: ml.away,
    matchup_id: matchup.id,
  };
}

/** Lightweight health probe — just confirms the /sports endpoint
 *  responds with a non-empty list. Used by lib/healthChecks. */
export async function pingPinnacle(): Promise<{ ok: boolean; detail?: string }> {
  try {
    const res = await fetch(`${PINNACLE_BASE}/sports`, {
      headers: {
        'x-api-key': PINNACLE_TOKEN,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const body = (await res.json()) as unknown;
    const len = Array.isArray(body) ? body.length : 0;
    if (len === 0) return { ok: false, detail: 'empty sports list' };
    return { ok: true, detail: `${len} sports` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}
