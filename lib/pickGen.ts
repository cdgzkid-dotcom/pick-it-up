// Shared pick generation logic — used by /api/generate-picks (manual) and
// /api/cron/analyze (automatic). Takes pre-fetched ESPN games and returns
// inserted/updated counts plus the picks themselves (so callers can notify).

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { callClaudeJson } from './claude';
import { PICK_GENERATION_SYSTEM, buildPickGenerationUserPrompt, LEGACY_SCHEMA_SUNSET } from './prompts';
import { adjustedEdgeScore, impliedProbability, computeMarketConsensus } from './edge';
import type { MarketSource } from './edge';
import { kellyAmount, sportKellyMultiplier, tierForOdds, tierFromConfidence } from './units';
import { getRatingsForGames } from './elo';
import { fetchGameWeather, isDome } from './weather';
import { buildMlbGameContext } from './mlbStats';
import { buildNhlGameContext } from './nhlStats';
import { buildNbaGameContext } from './nbaStats';
import { fetchEspnGameOdds, fetchEspnPredictor } from './espn';
import type { EspnOddsResult, EspnPredictor } from './espn';
import { captureOrLoadOpening, computeMovement } from './lineMovement';
import { auditPickQuality } from './pickAudit';
import type { MovementSignal } from './lineMovement';
import { recordPickFactors, getWeightsForPrompt } from './learning';
import type { Game, Pick, Tier } from './types';

const BATCH_SIZE = 2;

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

const KeyStatSchema = z.object({
  label: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]).transform((v) => String(v)),
  flag: z.enum(['green', 'yellow', 'red']).optional().nullable(),
});

// CAPA 1: schema where Claude returns probabilities for BOTH sides and lets
// the server pick the actual side / compute edge / assign tier.
const ClaudeProbabilitySchema = z.object({
  sport: z.string(),
  league: z.string().optional().nullable(),
  home_team: z.string(),
  away_team: z.string(),
  home_team_abbr: z.string().optional().nullable(),
  away_team_abbr: z.string().optional().nullable(),
  real_probability_home: z.coerce.number().min(0).max(1),
  real_probability_away: z.coerce.number().min(0).max(1),
  confidence: z.coerce.number().int().min(0).max(100),
  analysis: z.string().optional().nullable(),
  risk_factors: z.string().optional().nullable(),
  injuries: z.string().optional().nullable(),
  key_stats: z.array(KeyStatSchema).optional().nullable(),
  regression_flags: z.string().optional().nullable(),
  trap_warning: z.string().optional().nullable(),
  line_movement_note: z.string().optional().nullable(),
});
export type ClaudeProbabilityPick = z.infer<typeof ClaudeProbabilitySchema>;

// LEGACY: schema where Claude returned a single pick text + odds_decimal.
// Kept only for backward-compatibility during transition. Trips an explicit
// throw after `LEGACY_SCHEMA_SUNSET` so we don't carry it forever.
const ClaudePickSchema = z.object({
  sport: z.string(),
  league: z.string().optional().nullable(),
  home_team: z.string(),
  away_team: z.string(),
  home_team_abbr: z.string().optional().nullable(),
  away_team_abbr: z.string().optional().nullable(),
  pick: z.string(),
  pick_detail: z.string().optional().nullable(),
  bet_type: z.string(),
  odds_decimal: z.coerce.number(),
  confidence: z.coerce.number().int().min(0).max(100),
  tier: z.enum(['lock', 'strong', 'value', 'parlay']).optional().nullable(),
  real_probability: z.coerce.number().min(0).max(1),
  implied_probability: z.coerce.number().optional().nullable(),
  edge: z.coerce.number().optional().nullable(),
  analysis: z.string().optional().nullable(),
  risk_factors: z.string().optional().nullable(),
  injuries: z.string().optional().nullable(),
  key_stats: z.array(KeyStatSchema).optional().nullable(),
  early_payout_eligible: z.coerce.boolean().optional(),
  early_payout_threshold: z.string().optional().nullable(),
  line_movement_note: z.string().optional().nullable(),
  regression_flags: z.string().optional().nullable(),
  trap_warning: z.string().optional().nullable(),
});

const ClaudeParlayLegSchema = z.object({
  game: z.string(),
  pick: z.string(),
  odds_decimal: z.coerce.number(),
  real_probability: z.coerce.number().min(0).max(1).optional(),
});

const ClaudeParlaySchema = z.object({
  legs: z.array(ClaudeParlayLegSchema).min(2),
  combined_odds: z.coerce.number(),
  combined_probability: z.coerce.number().min(0).max(1),
  implied_probability: z.coerce.number().optional().nullable(),
  edge: z.coerce.number().optional().nullable(),
  confidence: z.coerce.number().int().min(0).max(100).optional(),
  tier: z.enum(['lock', 'strong', 'value', 'parlay']).optional().nullable(),
  analysis: z.string().optional().nullable(),
});

// CAPA 1 response wrapper. Claude only returns `picks`; counts and parlays
// are derived server-side (counts are logged from the audit pass, parlays
// are generated post-mapping). Removing analyzed_count/discarded_count from
// the contract avoids Claude hallucinating numbers or pre-filtering picks
// that should reach the server.
const ClaudeProbabilityResponseSchema = z.object({
  picks: z.array(ClaudeProbabilitySchema).default([]),
});

// Legacy response shape — kept for fallback parsing only.
const ClaudeResponseSchema = z.object({
  analyzed_count: z.coerce.number().int().optional(),
  discarded_count: z.coerce.number().int().optional(),
  picks: z.array(ClaudePickSchema).default([]),
  parlays: z.array(ClaudeParlaySchema).optional().default([]),
});

/**
 * Parse Claude's response, preferring the new probability schema. If parse
 * fails, attempts to adapt a legacy {pick, odds_decimal} response into the
 * new shape — but ONLY if the sunset date hasn't passed. After sunset, an
 * explicit error is thrown so the legacy compatibility branch can't silently
 * keep masking a regressed prompt.
 */
function parseClaudeResponse(claudeOutput: unknown, batchIdx: number): ClaudeProbabilityPick[] | null {
  const newAttempt = ClaudeProbabilityResponseSchema.safeParse(claudeOutput);
  if (newAttempt.success) return newAttempt.data.picks;

  // Try legacy schema as fallback.
  const legacyAttempt = ClaudeResponseSchema.safeParse(claudeOutput);
  if (!legacyAttempt.success) {
    console.error(
      `[AUDIT][batch ${batchIdx}] VALIDATION FAILED — neither new nor legacy schema matched`,
      JSON.stringify(newAttempt.error.flatten()),
    );
    return null;
  }

  const now = new Date();
  if (now >= LEGACY_SCHEMA_SUNSET) {
    throw new Error(
      `Legacy Claude schema detected after sunset ${LEGACY_SCHEMA_SUNSET.toISOString()}. ` +
        `Prompt regressed — fix prompts.ts so Claude returns the CAPA-1 probability schema.`,
    );
  }
  const daysUntilSunset = Math.ceil((LEGACY_SCHEMA_SUNSET.getTime() - now.getTime()) / 86_400_000);
  console.warn(
    `[SCHEMA_FALLBACK] batch ${batchIdx} parsed via legacy schema. ${legacyAttempt.data.picks.length} picks adapted. days_until_sunset=${daysUntilSunset}`,
  );

  // Adapt legacy → new: derive home/away probabilities from the picked side.
  return legacyAttempt.data.picks.map((p) => {
    const pickLower = p.pick.toLowerCase();
    const homeLast = p.home_team.split(/\s+/).pop()?.toLowerCase() ?? '';
    const isHome = homeLast.length >= 3 && pickLower.includes(homeLast);
    const home = isHome ? p.real_probability : 1 - p.real_probability;
    return {
      sport: p.sport,
      league: p.league ?? null,
      home_team: p.home_team,
      away_team: p.away_team,
      home_team_abbr: p.home_team_abbr ?? null,
      away_team_abbr: p.away_team_abbr ?? null,
      real_probability_home: home,
      real_probability_away: 1 - home,
      confidence: p.confidence,
      analysis: p.analysis ?? null,
      risk_factors: p.risk_factors ?? null,
      injuries: p.injuries ?? null,
      key_stats: p.key_stats ?? null,
      regression_flags: p.regression_flags ?? null,
      trap_warning: p.trap_warning ?? null,
      line_movement_note: p.line_movement_note ?? null,
    };
  });
}

export interface AnalyzeOpts {
  bankroll: number;
  unitPercentage: number;
}

export interface AnalyzeResult {
  inserted: number;
  updated: number;
  insertedPicks: PickRow[];
  insertedParlays: PickRow[];
  /** Kelly fraction map keyed by pick.pick + pick.bet_type for telegram lookup */
  kellyByKey: Record<string, number>;
  withEdge: number;
  parlayCount: number;
  /** CAPA-2 + CAPA-3 counters for the lock-in flow. */
  supersededEdgeEvaporated: number;
  supersededLineMoved: number;
  flippedSideIgnored: number;
  /** Quality-audit counter: picks that passed all gates but failed the
   * final quality audit (Rail 5). Persisted as status='filtered_quality_audit'. */
  filteredByAudit: number;
  /** Detail of each superseded pick — used by cron to send a standalone
   * Telegram alert when the only thing that happened was a supersede AND
   * at least one was previously notified. Discriminated by `reason`. */
  supersededList: Array<
    | { pick: string; tier: string | null; was_notified: boolean; reason: 'edge_evaporated' }
    | {
        pick: string;
        tier: string | null;
        was_notified: boolean;
        reason: 'line_moved_against';
        original_odds: number;
        current_odds: number;
      }
  >;
  /** Fix C (slate-without-odds notification): how many games in this run
   * ended in the analyzed_no_odds_data branch (including re-attempts that
   * UPDATED an existing marker). Used by cron/analyze to decide whether to
   * fire the no_odds_alert Telegram. */
  insertedNoOddsCount: number;
  /** Metadata for the games behind insertedNoOddsCount. The cron passes
   * this to formatNoOddsAlertMessage so the user sees which games are
   * waiting on DK odds. */
  noOddsEvents: Array<{
    espn_event_id: string;
    sport: string;
    home_team: string;
    away_team: string;
    game_start_time: string | null;
  }>;
}
/** Convenience alias for one entry in AnalyzeResult.supersededList. */
export type SupersededEntry = AnalyzeResult['supersededList'][number];

interface PickRow {
  id?: string;
  sport: string;
  league: string | null;
  game: string;
  home_team: string;
  away_team: string;
  home_team_abbr: string | null;
  away_team_abbr: string | null;
  espn_event_id: string | null;
  pick: string;
  pick_detail: string | null;
  bet_type: string;
  odds_decimal: number;
  best_odds: number | null;
  best_odds_source: string | null;
  odds_comparison: unknown;
  edge_vs_market: number | null;
  market_consensus_implied: number | null;
  market_sources_count: number | null;
  market_sources: MarketSource[] | null;
  floor_applied: 'lock' | 'strong' | 'none' | null;
  confidence: number;
  confidence_raw: number | null;
  tier: Tier;
  real_probability: number;
  implied_probability: number;
  edge: number;
  recommended_amount: number;
  analysis: string | null;
  risk_factors: string | null;
  injuries: string | null;
  key_stats: unknown;
  early_payout_eligible: boolean;
  early_payout_threshold: string | null;
  line_movement_note: string | null;
  regression_flags: string | null;
  trap_warning: string | null;
  status: string;
  is_parlay: boolean;
  parlay_legs: unknown;
  game_start_time: string | null;
  updated_at: string;
  // CAPA-2 lock-in fields (populated by applyLockIn).
  locked_at?: string | null;
  original_real_probability?: number | null;
  original_odds?: number | null;
  reanalysis_count?: number | null;
  lock_reason?: string | null;
  // Quality-audit findings (failures for Rail 5 rows, warnings for healthy
  // singleRows). Persists as jsonb in DB.
  audit_failures?: string[] | null;
  // Fix B (no-odds retry): counts how many times the marker for an event
  // has been re-evaluated. Bounded by the dedup guard in cron/analyze
  // (currently retry_count<3 + age>20min). Only set on analyzed_no_odds_data
  // rows in practice — other statuses leave it at the DB default (0).
  retry_count?: number | null;
}

interface EnrichedGame extends Game {
  home_elo?: number;
  away_elo?: number;
  weather?: {
    temp_f: number;
    wind_mph: number;
    wind_dir: string;
    humidity: number;
    precip_chance: number;
    condition: string;
    is_dome?: boolean;
  } | null;
}

export async function analyzeGames(
  games: Game[],
  supabase: SupabaseClient,
  opts: AnalyzeOpts,
): Promise<AnalyzeResult> {
  const t0 = Date.now();

  // Enrich games with ELO + weather BEFORE sending to Claude.
  // ELO: pulled from elo_ratings table (1500 default for new teams).
  // Weather: optional — only fetched when WEATHER_API_KEY is set + outdoor venue.
  const enriched: EnrichedGame[] = games.map((g) => ({ ...g }));
  try {
    const ratings = await getRatingsForGames(
      supabase,
      enriched.map((g) => ({
        sport: g.sport,
        home_team: g.home_team,
        away_team: g.away_team,
        home_team_abbr: g.home_team_abbr,
        away_team_abbr: g.away_team_abbr,
      })),
    );
    for (const g of enriched) {
      const r = ratings[`${g.sport}|${g.home_team}|${g.away_team}`];
      if (r) {
        g.home_elo = Math.round(Number(r.home.elo));
        g.away_elo = Math.round(Number(r.away.elo));
      }
    }
  } catch (e) {
    console.error('[pickGen] ELO lookup failed (proceeding without)', e);
  }

  if (process.env.WEATHER_API_KEY) {
    await Promise.all(
      enriched.map(async (g) => {
        const venue = (g.notable_stats as Record<string, unknown> | undefined)?.venue as string | undefined;
        if (!venue) return;
        if (isDome(venue)) {
          g.weather = { temp_f: 72, wind_mph: 0, wind_dir: '', humidity: 50, precip_chance: 0, condition: 'Indoor', is_dome: true };
          return;
        }
        try {
          const w = await fetchGameWeather(venue, g.start_time ?? null);
          if (w) g.weather = w;
        } catch {
          /* ignore */
        }
      }),
    );
  }

  // ── Phase 3: real-data enrichment per sport ──────────────────────────────
  // Pull live stats from sport-specific APIs (MLB Stats, NHL API, NBA stats).
  // Multi-book odds and player props from The Odds API were dropped — see
  // 2026-05 post-mortem: ODDS_API_KEY was effectively unusable in prod and
  // the gate now consumes DraftKings ML (ESPN /odds) + ESPN BPI gameProjection
  // (ESPN /predictor) instead, both fetched per-game below. Each fetch has
  // its own try/catch so a single API outage degrades the run gracefully.
  const today = new Date().toISOString().slice(0, 10);

  // Hard timeout for any single enrichment call so a hung external API
  // doesn't burn our 60s Vercel budget. NBA stats.nba.com in particular
  // is often blocked from Vercel egress and hangs without timing out.
  function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
    ]);
  }
  const ENRICH_TIMEOUT_MS = 8_000;

  await Promise.all(
    enriched.map(async (g) => {
      g.real_data = g.real_data ?? {};
      try {
        if (g.sport === 'MLB') {
          const ctx = await withTimeout(
            buildMlbGameContext(g.home_team, g.away_team, g.home_team_abbr, g.away_team_abbr, today),
            ENRICH_TIMEOUT_MS,
            {} as Awaited<ReturnType<typeof buildMlbGameContext>>,
          );
          g.real_data = ctx as unknown as Record<string, unknown>;
          console.log(
            `[DATA][MLB] ${g.away_team} @ ${g.home_team} pitchers=${ctx.awayPitcher?.name ?? '?'} (ERA ${ctx.awayPitcher?.era ?? '?'}) vs ${ctx.homePitcher?.name ?? '?'} (ERA ${ctx.homePitcher?.era ?? '?'}) standings=${ctx.awayStanding?.wins}-${ctx.awayStanding?.losses} vs ${ctx.homeStanding?.wins}-${ctx.homeStanding?.losses}`,
          );
        } else if (g.sport === 'NHL') {
          const ctx = await withTimeout(
            buildNhlGameContext(g.home_team_abbr, g.away_team_abbr),
            ENRICH_TIMEOUT_MS,
            {} as Awaited<ReturnType<typeof buildNhlGameContext>>,
          );
          g.real_data = ctx as unknown as Record<string, unknown>;
          console.log(
            `[DATA][NHL] ${g.away_team_abbr}@${g.home_team_abbr} ${ctx.awayStanding?.record} vs ${ctx.homeStanding?.record} GF/GP ${ctx.awaySummary?.goalsForPerGame?.toFixed(2)} vs ${ctx.homeSummary?.goalsForPerGame?.toFixed(2)}`,
          );
        } else if (g.sport === 'NBA') {
          const ctx = await withTimeout(
            buildNbaGameContext(g.home_team, g.away_team),
            ENRICH_TIMEOUT_MS,
            {} as Awaited<ReturnType<typeof buildNbaGameContext>>,
          );
          g.real_data = ctx as unknown as Record<string, unknown>;
          if (ctx.home || ctx.away) {
            console.log(
              `[DATA][NBA] ${g.away_team} @ ${g.home_team} OffRtg ${ctx.away?.offRtg?.toFixed(1) ?? '?'} vs ${ctx.home?.offRtg?.toFixed(1) ?? '?'}`,
            );
          } else {
            console.log(`[DATA][NBA] ${g.away_team} @ ${g.home_team} stats.nba.com unavailable (or timeout), falling back to ESPN context`);
          }
        }
      } catch (e) {
        console.warn(`[pickGen] real-data enrichment failed for ${g.sport} ${g.game_label}`, e);
      }

      // Market consensus enrichment — two independent zero-key sources:
      //   (1) DraftKings ML via ESPN /odds (market proxy)
      //   (2) ESPN BPI gameProjection via /predictor (analytical proxy)
      // Each call is allSettled so a 4xx on one source doesn't kill the other.
      // NHL /predictor returns {error:...} → fetchEspnPredictor returns null;
      // the downstream gate sees sources_count=1 and blocks the floor, which
      // is the intended conservative behavior for hockey.
      if (g.espn_event_id) {
        const [dkRes, bpiRes] = await Promise.allSettled([
          withTimeout(fetchEspnGameOdds(g.sport, g.espn_event_id), ENRICH_TIMEOUT_MS, null as EspnOddsResult | null),
          withTimeout(fetchEspnPredictor(g.sport, g.espn_event_id), ENRICH_TIMEOUT_MS, null as EspnPredictor | null),
        ]);
        const rd = g.real_data as Record<string, unknown>;
        if (dkRes.status === 'fulfilled' && dkRes.value) {
          rd.dk_odds = dkRes.value;
        }
        if (bpiRes.status === 'fulfilled' && bpiRes.value) {
          rd.espn_bpi = bpiRes.value;
        }
        console.log(
          `[DATA][MARKET] ${g.game_label} dk=${rd.dk_odds ? 'Y' : 'N'} bpi=${rd.espn_bpi ? 'Y' : 'N'}`,
        );
      }

      // ── RLM / line-movement signal ──────────────────────────────────────
      // Capture opening odds on first sight; compare current vs opening on
      // subsequent runs. Stored in line_openings table per espn_event_id.
      if (g.espn_event_id) {
        const ml = g.odds?.moneyline;
        const sp = g.odds?.spread;
        const tot = g.odds?.total;
        try {
          const opening = await captureOrLoadOpening(supabase, {
            espn_event_id: g.espn_event_id,
            sport: g.sport,
            game_label: g.game_label,
            home_team: g.home_team,
            away_team: g.away_team,
            home_ml_now: ml?.home ?? null,
            away_ml_now: ml?.away ?? null,
            spread_line: sp?.home_line ?? null,
            spread_home_odds: sp?.home_odds ?? null,
            total_line: tot?.line ?? null,
            over_odds: tot?.over ?? null,
            under_odds: tot?.under ?? null,
          });
          if (opening && ml?.home && ml?.away) {
            const sig = computeMovement(opening, ml.home, ml.away);
            if (sig) {
              (g.real_data as Record<string, unknown>).line_movement = sig;
              console.log(
                `[DATA][RLM] ${g.game_label} rlm=${sig.rlm} steam=${sig.steam_side ?? '∅'} trap_side=${sig.rlm_trap_side ?? '∅'} home Δ=${(sig.home_delta ?? 0 * 100).toFixed(1)}% away Δ=${(sig.away_delta ?? 0 * 100).toFixed(1)}%`,
              );
            }
          }
        } catch (e) {
          console.warn(`[pickGen] line movement capture failed for ${g.game_label}`, e);
        }
      }
    }),
  );
  // ─────────────────────────────────────────────────────────────────────────

  // TZ DEBUG: print raw start_time + UTC parse + CDMX conversion for each
  // game so we can settle the Yankees-game offset bug in production logs.
  for (const g of enriched) {
    if (!g.start_time) continue;
    const d = new Date(g.start_time);
    const cdmx = d.toLocaleTimeString('es-MX', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'America/Mexico_City',
    });
    console.log(
      `[TZ] ${g.game_label} raw=${g.start_time} utc=${d.toISOString()} cdmx=${cdmx}`,
    );
  }

  const batches = chunk(enriched, BATCH_SIZE);
  console.log(`[pickGen] launching ${batches.length} batches for ${games.length} games`);

  const learnedWeights = await getWeightsForPrompt(supabase);

  // Promise.allSettled with per-batch timeout (55s) — partial slate is better
  // than failing the whole route at maxDuration=60.
  const PER_BATCH_TIMEOUT_MS = 55_000;
  const batchPromises = batches.map((b, i) =>
    Promise.race([
      (async () => {
        const tStart = Date.now();
        try {
          const claudeOutput = await callClaudeJson(
            PICK_GENERATION_SYSTEM,
            buildPickGenerationUserPrompt(b) + learnedWeights,
            { retry: false, maxTokens: 4096 },
          );
          const parsedPicks = parseClaudeResponse(claudeOutput, i);
          if (parsedPicks == null) {
            console.error(`[AUDIT][batch ${i}] raw output sample:`, JSON.stringify(claudeOutput).slice(0, 1500));
            return { picks: [], dropped: b.length, idx: i, ms: Date.now() - tStart };
          }
          console.log(
            `[AUDIT][batch ${i}] input games=${b.length} (${b.map((g) => `${g.away_team_abbr ?? '?'}@${g.home_team_abbr ?? '?'}`).join(',')}) → claude returned ${parsedPicks.length} picks in ${Date.now() - tStart}ms`,
          );
          for (const p of parsedPicks) {
            console.log(
              `[AUDIT][batch ${i}] pick raw: ${p.away_team} @ ${p.home_team} (${p.sport}) conf=${p.confidence} home_p=${(p.real_probability_home * 100).toFixed(1)}% away_p=${(p.real_probability_away * 100).toFixed(1)}% trap=${p.trap_warning ? 'YES' : 'no'}`,
            );
          }
          return { picks: parsedPicks, dropped: 0, idx: i, ms: Date.now() - tStart };
        } catch (err) {
          console.error(`[pickGen] batch ${i} failed`, err);
          return { picks: [], dropped: b.length, idx: i, ms: Date.now() - tStart };
        }
      })(),
      new Promise<{ picks: ClaudeProbabilityPick[]; dropped: number; idx: number; ms: number; timedOut: true }>((resolve) =>
        setTimeout(() => resolve({ picks: [], dropped: b.length, idx: i, ms: PER_BATCH_TIMEOUT_MS, timedOut: true }), PER_BATCH_TIMEOUT_MS),
      ),
    ]),
  );

  const settled = await Promise.allSettled(batchPromises);
  const batchResults = settled.map((s) => (s.status === 'fulfilled' ? s.value : { picks: [] as ClaudeProbabilityPick[], dropped: 0, idx: -1, ms: 0 }));

  const totalDropped = batchResults.reduce((acc, r) => acc + ('dropped' in r ? r.dropped : 0), 0);
  const timedOutBatches = batchResults.filter((r) => 'timedOut' in r && r.timedOut).map((r) => r.idx);
  if (totalDropped > 0) {
    console.warn(`[pickGen] dropped ${totalDropped} games — timed-out batches: [${timedOutBatches.join(',')}]`);
  }

  const raw = {
    picks: batchResults.flatMap((r) => r.picks),
  };

  const gameByMatchup = new Map<string, Game>();
  const teamAbbrByName = new Map<string, string>();
  for (const g of games) {
    gameByMatchup.set(`${g.home_team.toLowerCase()}|${g.away_team.toLowerCase()}`, g);
    if (g.home_team_abbr) teamAbbrByName.set(g.home_team.toLowerCase(), g.home_team_abbr);
    if (g.away_team_abbr) teamAbbrByName.set(g.away_team.toLowerCase(), g.away_team_abbr);
  }

  console.log(
    `[AUDIT] total raw from claude: ${raw.picks.length} picks (across ${batches.length} batches). parlays generated server-side post-mapping.`,
  );

  // Per-sport Kelly multiplier learned from history. Defaults to 0.5 (= half
  // Kelly, matching the baseline divisor inside kellyAmount) until we have
  // 30+ resolved bets in a given sport. We scale the kelly result by
  // (multiplier / 0.5) so the existing kellyAmount function stays untouched.
  const sportsForKelly = Array.from(new Set(raw.picks.map((p) => p.sport)));
  const kellyMultipliers: Record<string, number> = {};
  await Promise.all(
    sportsForKelly.map(async (s) => {
      kellyMultipliers[s] = await sportKellyMultiplier(supabase, s);
    }),
  );

  // CAPA-1 server-side processing of Claude's probability estimates.
  // For each game Claude evaluated:
  //   1. Match game by exact home_team + away_team. Discard on mismatch.
  //   2. Read dk_odds from real_data. Without it we can't compute edge.
  //   3. Normalize probabilities (Claude must produce sum ≈ 1.0).
  //   4. Compute edge for both sides against the DraftKings line.
  //   5. Pick the side with greater positive edge. If neither side has
  //      edge ≥ 2%, discard.
  //   6. Build pick text "<team> ML" + bet_type "ML" server-side.
  //   7. Run the existing market-consensus floor gate (unchanged).
  type MappedRow = {
    sport: string;
    league: string | null;
    home_team: string;
    away_team: string;
    home_team_abbr: string | null;
    away_team_abbr: string | null;
    espn_event_id: string | null;
    game_start_time: string | null;
    side: 'home' | 'away';
    pick: string;
    pick_detail: string | null;
    bet_type: 'ML';
    odds_decimal: number;
    real_probability: number; // for the picked side, post-normalization
    implied_probability: number;
    edge: number;
    confidence: number; // floor-adjusted
    confidence_raw: number; // pre-floor snapshot
    tier: Tier;
    trap_warning: string | null;
    risk_factors: string | null;
    injuries: string | null;
    key_stats: ClaudeProbabilityPick['key_stats'];
    regression_flags: string | null;
    line_movement_note: string | null;
    analysis: string | null;
    recommended_amount: number;
    kelly_fraction: number;
    best_odds_source: string | null;
    odds_comparison: Array<{ source: string; ml: number }> | null;
    edge_vs_market: number | null;
    market_consensus_implied: number | null;
    market_sources_count: number;
    market_sources: MarketSource[] | null;
    floor_applied: 'lock' | 'strong' | 'none';
    // Populated by the post-mapping quality audit pass. When set on a row
    // that survives (audit.passed=true) these are non-blocking warnings;
    // when set on a row routed to Rail 5 (audit.passed=false) these are
    // the blocking failures.
    audit_failures?: string[] | null;
    _score: number;
  };

  const reasons: Record<string, number> = {
    pass: 0,
    fail_mismatch: 0,
    fail_prob_sum: 0,
    fail_no_dk_odds: 0,
    fail_no_positive_edge: 0,
    fail_edge_below_threshold: 0,
    fail_confidence: 0,
    fail_kelly_zero: 0,
    fail_culero_low_edge: 0,
  };

  // Side channel: games that reached the mapping but had no DraftKings line
  // available. We insert marker rows (status='analyzed_no_odds_data') so the
  // cron's dedup guard skips them on subsequent runs within the next 10 min —
  // avoids burning Claude tokens on games that structurally can't generate
  // a pick under CAPA-1. Resets implicitly when the cron query window rolls
  // forward and the marker falls outside the "today" filter.
  const noOddsDataMarkers: Array<{
    sport: string;
    league: string | null;
    home_team: string;
    away_team: string;
    home_team_abbr: string | null;
    away_team_abbr: string | null;
    espn_event_id: string;
    game_start_time: string | null;
  }> = [];

  const mapped: MappedRow[] = raw.picks.flatMap((p): MappedRow[] => {
    // (1) Game match — exact home_team / away_team (case-insensitive).
    const matchedGame = gameByMatchup.get(`${p.home_team.toLowerCase()}|${p.away_team.toLowerCase()}`);
    if (!matchedGame) {
      console.log('[SCHEMA_MISMATCH]', {
        claude_home: p.home_team,
        claude_away: p.away_team,
        claude_sport: p.sport,
        reason: 'no matching game in batch input',
      });
      reasons.fail_mismatch++;
      return [];
    }
    if (matchedGame.sport !== p.sport) {
      console.log('[SCHEMA_MISMATCH]', {
        claude_sport: p.sport,
        actual_sport: matchedGame.sport,
        teams: `${p.away_team}@${p.home_team}`,
        reason: 'sport mismatch',
      });
      reasons.fail_mismatch++;
      return [];
    }

    // (2) Probability sum validation. Server tolerance is ±0.03 (the prompt
    // asks for ±0.02 — stricter — leaving 0.01 slack for honest rounding).
    // Beyond ±0.03 we discard outright; do not normalize garbage values.
    const sum = p.real_probability_home + p.real_probability_away;
    if (Math.abs(sum - 1.0) > 0.03) {
      console.log('[PROB_SUM_INVALID]', {
        teams: `${p.away_team}@${p.home_team}`,
        home: p.real_probability_home,
        away: p.real_probability_away,
        sum: Number(sum.toFixed(4)),
        reason: 'Claude probabilities do not sum to ~1.0 (±0.03 tolerance)',
      });
      reasons.fail_prob_sum++;
      return [];
    }
    // Light normalization for the residual rounding noise inside ±0.03.
    const homeProb = p.real_probability_home / sum;
    const awayProb = p.real_probability_away / sum;

    // (3) DraftKings odds — required to compute edge under CAPA-1.
    const rdMatched = (matchedGame.real_data ?? {}) as Record<string, unknown>;
    const dkOdds = rdMatched.dk_odds as EspnOddsResult | undefined;
    const espnBpi = rdMatched.espn_bpi as EspnPredictor | undefined;
    if (!dkOdds || !dkOdds.home_ml_decimal || !dkOdds.away_ml_decimal) {
      console.log('[NO_DK_ODDS]', {
        teams: `${p.away_team}@${p.home_team}`,
        sport: p.sport,
        reason: 'no DraftKings line available; cannot compute edge',
      });
      reasons.fail_no_dk_odds++;
      if (matchedGame.espn_event_id) {
        noOddsDataMarkers.push({
          sport: p.sport,
          league: p.league ?? null,
          home_team: p.home_team,
          away_team: p.away_team,
          home_team_abbr: p.home_team_abbr ?? null,
          away_team_abbr: p.away_team_abbr ?? null,
          espn_event_id: matchedGame.espn_event_id,
          game_start_time: matchedGame.start_time ?? null,
        });
      }
      return [];
    }
    if (dkOdds.source_slug && dkOdds.source_slug !== 'draftkings') {
      console.log('[MARKET] non-default provider used:', dkOdds.source, `(slug=${dkOdds.source_slug})`);
    }

    // (4) Edge per side against DK line.
    const homeOdds = dkOdds.home_ml_decimal;
    const awayOdds = dkOdds.away_ml_decimal;
    const edgeHome = homeProb - 1 / homeOdds;
    const edgeAway = awayProb - 1 / awayOdds;

    // (5) Pick the side with the larger positive edge.
    const EDGE_THRESHOLD = 0.02;
    if (edgeHome <= 0 && edgeAway <= 0) {
      console.log('[NO_POSITIVE_EDGE]', {
        teams: `${p.away_team}@${p.home_team}`,
        edge_home: Number(edgeHome.toFixed(4)),
        edge_away: Number(edgeAway.toFixed(4)),
      });
      reasons.fail_no_positive_edge++;
      return [];
    }
    const side: 'home' | 'away' = edgeHome >= edgeAway ? 'home' : 'away';
    const bestEdge = side === 'home' ? edgeHome : edgeAway;
    if (bestEdge < EDGE_THRESHOLD) {
      console.log('[EDGE_BELOW_THRESHOLD]', {
        teams: `${p.away_team}@${p.home_team}`,
        side,
        edge: Number(bestEdge.toFixed(4)),
        threshold: EDGE_THRESHOLD,
      });
      reasons.fail_edge_below_threshold++;
      return [];
    }

    // (6) Build pick text server-side.
    const pickedTeam = side === 'home' ? p.home_team : p.away_team;
    const pickText = `${pickedTeam} ML`;
    const pickedProb = side === 'home' ? homeProb : awayProb;
    const pickedOdds = side === 'home' ? homeOdds : awayOdds;
    const implied = impliedProbability(pickedOdds);
    const e = bestEdge;

    // Consensus: market book + ESPN BPI for the picked side.
    let bpiImplied: number | null = null;
    if (espnBpi) {
      const bpiPct = side === 'home' ? espnBpi.home_win_prob : espnBpi.away_win_prob;
      if (bpiPct != null && bpiPct > 0 && bpiPct < 100) bpiImplied = bpiPct / 100;
    }
    const marketBookImplied = 1 / pickedOdds;
    const marketBookSlug = dkOdds.source_slug ?? null;
    const consensus = computeMarketConsensus(marketBookImplied, marketBookSlug, bpiImplied, pickedProb);
    const edgeVsMarket = consensus?.edge_vs_market ?? null;
    const sourcesCount = consensus?.sources_count ?? 0;
    const consensusImplied = consensus?.avg_implied_prob ?? null;
    const sourcesList: MarketSource[] = consensus?.sources ?? [];

    const bestOddsSource = dkOdds.source ?? 'DraftKings';
    const oddsComparison: Array<{ source: string; ml: number }> = [{ source: bestOddsSource, ml: pickedOdds }];

    // (7) RLM trap merge + market-consensus floor gate. UNCHANGED logic, just
    // sourced from `side` instead of isHome/isAway booleans.
    let rlmTrapNote: string | null = null;
    const lm = rdMatched.line_movement as MovementSignal | undefined;
    if (lm && lm.rlm && lm.rlm_trap_side === side) {
      const otherWasOpen = side === 'home' ? lm.away_ml_open : lm.home_ml_open;
      const otherIsNow = side === 'home' ? lm.away_ml_now : lm.home_ml_now;
      rlmTrapNote = `Reverse line movement: dinero sharp en el otro lado — línea se movió ${otherWasOpen?.toFixed(2)}→${otherIsNow.toFixed(2)} (${side === 'home' ? 'visitante' : 'local'})`;
    }
    const mergedTrap = [p.trap_warning, rlmTrapNote].filter(Boolean).join(' · ') || null;

    const confRaw = p.confidence;
    let conf = p.confidence;
    let floorApplied: 'lock' | 'strong' | 'none' = 'none';
    const oddsOk = pickedOdds > 1.5;
    const noTrap = !mergedTrap;
    const fullConsensus = sourcesCount >= 2;
    const lockMarketOk = fullConsensus && edgeVsMarket != null && edgeVsMarket >= 0.03;
    const strongMarketOk = fullConsensus && edgeVsMarket != null && edgeVsMarket >= 0.02;

    if (e > 0.07 && oddsOk && noTrap && lockMarketOk) {
      conf = Math.max(conf, 85);
      floorApplied = 'lock';
    } else if (e > 0.05 && oddsOk && noTrap && strongMarketOk) {
      conf = Math.max(conf, 70);
      floorApplied = 'strong';
    } else if (e > 0.05 && noTrap) {
      // Edge clears the bracket but at least one gate condition failed.
      // Audit the exact blocker so post-mortems can distinguish "no sharp
      // confirmation" from "odds too thin for floor". oddsOk = pickedOdds>1.5
      // is an intentional economic rule (don't promote heavy favorites where
      // edges tend to be illusory); we report it explicitly here.
      let reason: string;
      if (!oddsOk) reason = 'odds_too_low_for_floor';
      else if (sourcesCount === 0) reason = 'no_market_data';
      else if (sourcesCount === 1) reason = `partial_consensus_${sourcesList[0]}`;
      else reason = 'market_below_threshold';
      console.log('[FLOOR_BLOCKED]', {
        pick: pickText,
        edge: Number(e.toFixed(4)),
        edge_vs_market: edgeVsMarket != null ? Number(edgeVsMarket.toFixed(4)) : null,
        odds: pickedOdds,
        sources: sourcesList,
        reason,
      });
    }
    if (floorApplied !== 'none') {
      console.log('[FLOOR_APPLIED]', {
        pick: pickText,
        tier_promoted_to: floorApplied,
        edge: Number(e.toFixed(4)),
        edge_vs_market: edgeVsMarket != null ? Number(edgeVsMarket.toFixed(4)) : null,
        sources: sourcesList,
      });
    }

    const baseTier: Tier = tierFromConfidence(conf);
    const adjustedTier = tierForOdds(baseTier, pickedOdds);
    const hasTrap = !!mergedTrap;
    const k = kellyAmount(opts.bankroll, pickedProb, pickedOdds, { conservative: hasTrap });
    const learnedMult = kellyMultipliers[p.sport] ?? 0.5;
    if (learnedMult !== 0.5 && k.amount > 0) {
      const scale = learnedMult / 0.5;
      k.amount = Math.max(1, Math.round(k.amount * scale));
      k.fraction = Math.min(0.1, k.fraction * scale);
    }
    const score = adjustedEdgeScore(pickedProb, pickedOdds);

    const homeAbbr = p.home_team_abbr?.toLowerCase() ?? teamAbbrByName.get(p.home_team.toLowerCase()) ?? null;
    const awayAbbr = p.away_team_abbr?.toLowerCase() ?? teamAbbrByName.get(p.away_team.toLowerCase()) ?? null;

    return [{
      sport: p.sport,
      league: p.league ?? null,
      home_team: p.home_team,
      away_team: p.away_team,
      home_team_abbr: homeAbbr,
      away_team_abbr: awayAbbr,
      espn_event_id: matchedGame.espn_event_id ?? null,
      game_start_time: matchedGame.start_time ?? null,
      side,
      pick: pickText,
      pick_detail: null,
      bet_type: 'ML',
      odds_decimal: pickedOdds,
      real_probability: pickedProb,
      implied_probability: implied,
      edge: e,
      confidence: conf,
      confidence_raw: confRaw,
      tier: adjustedTier,
      trap_warning: mergedTrap,
      risk_factors: p.risk_factors ?? null,
      injuries: p.injuries ?? null,
      key_stats: p.key_stats ?? null,
      regression_flags: p.regression_flags ?? null,
      line_movement_note: p.line_movement_note ?? null,
      analysis: p.analysis ?? null,
      recommended_amount: k.amount,
      kelly_fraction: k.fraction,
      best_odds_source: bestOddsSource,
      odds_comparison: oddsComparison,
      edge_vs_market: edgeVsMarket,
      market_consensus_implied: consensusImplied,
      market_sources_count: sourcesCount,
      market_sources: sourcesList.length > 0 ? sourcesList : null,
      floor_applied: floorApplied,
      _score: score,
    }];
  });

  // Post-mapping filter: kelly>0, confidence>=55, plus the historical
  // "culero" guard (heavy favorites with thin edge).
  const enrichedSingles = mapped
    .filter((p) => {
      const reasons_for_this: string[] = [];
      if (!(p.confidence >= 55)) reasons_for_this.push(`conf<55 (${p.confidence})`);
      if (!(p.recommended_amount > 0)) reasons_for_this.push('kelly=0');
      if (p.odds_decimal < 1.4 && p.edge < 0.05) reasons_for_this.push(`culero (odds=${p.odds_decimal} edge=${(p.edge * 100).toFixed(1)}%)`);
      if (reasons_for_this.length > 0) {
        console.log(
          `[AUDIT] DISCARD ${p.pick} (${p.sport}) — reasons: ${reasons_for_this.join('; ')} | conf=${p.confidence} odds=${p.odds_decimal} real=${(p.real_probability * 100).toFixed(1)}% edge=${(p.edge * 100).toFixed(2)}% kelly=$${p.recommended_amount}`,
        );
        if (!(p.confidence >= 55)) reasons.fail_confidence++;
        else if (!(p.recommended_amount > 0)) reasons.fail_kelly_zero++;
        else reasons.fail_culero_low_edge++;
        return false;
      }
      console.log(
        `[AUDIT] KEEP ${p.pick} (${p.sport}) — tier=${p.tier} conf=${p.confidence} odds=${p.odds_decimal} edge=${(p.edge * 100).toFixed(2)}% kelly=$${p.recommended_amount} (${(p.kelly_fraction * 100).toFixed(1)}%) floor=${p.floor_applied}`,
      );
      reasons.pass++;
      return true;
    })
    .sort((a, b) => b._score - a._score);

  console.log(`[AUDIT] filter summary: ${JSON.stringify(reasons)}`);

  // ── Quality audit (Auditoría 2 pre-Telegram) ────────────────────────────
  // Last safety net before picks reach Telegram. Picks that survive all
  // upstream filters (gate, kelly, culero, etc.) still need to clear the
  // quality criteria derived from the 2026-05-10 post-mortem. Failures route
  // to a separate rail with status='filtered_quality_audit'. Warnings
  // persist non-blocking in audit_failures.
  const auditedSingles: typeof enrichedSingles = [];
  const filteredByAudit: typeof enrichedSingles = [];
  for (const row of enrichedSingles) {
    const audit = auditPickQuality(row);
    if (!audit.passed) {
      console.log('[QUALITY_AUDIT_FAILED]', {
        pick: row.pick,
        espn_event_id: row.espn_event_id,
        tier: row.tier,
        edge: Number(row.edge.toFixed(4)),
        edge_vs_market: row.edge_vs_market != null ? Number(row.edge_vs_market.toFixed(4)) : null,
        market_sources_count: row.market_sources_count,
        floor_applied: row.floor_applied,
        failures: audit.failures,
      });
      filteredByAudit.push({ ...row, audit_failures: audit.failures });
    } else {
      if (audit.warnings.length > 0) {
        console.log('[QUALITY_AUDIT_WARN]', {
          pick: row.pick,
          tier: row.tier,
          warnings: audit.warnings,
        });
      }
      auditedSingles.push({
        ...row,
        audit_failures: audit.warnings.length > 0 ? audit.warnings : null,
      });
    }
  }
  console.log(
    `[QUALITY_AUDIT] summary: ${auditedSingles.length} passed, ${filteredByAudit.length} filtered`,
  );

  // ── Server-side parlay generation ───────────────────────────────────────
  // Replaces Claude-side parlays. Rules (D1):
  //   • Only legs with edge ≥ 3% AND floor_applied ≠ 'none' (STRONG/LOCK)
  //   • Max 3 legs per parlay
  //   • Different espn_event_id required between legs
  //   • combined_edge ≥ 5% to keep
  //   • Cap to top 5 parlays by combined_edge
  //   • Filtered-audit singles excluded (status !== 'filtered_quality_audit'
  //     implicit: we use auditedSingles, not enrichedSingles).
  const parlayCandidates = auditedSingles.filter(
    (p) => p.edge >= 0.03 && p.floor_applied !== 'none' && p.espn_event_id,
  );
  type GeneratedParlay = {
    pick: string;
    pick_detail: string;
    odds_decimal: number;
    real_probability: number;
    implied_probability: number;
    edge: number;
    confidence: number;
    recommended_amount: number;
    kelly_fraction: number;
    analysis: string | null;
    parlay_legs: Array<{ game: string; pick: string; odds_decimal: number; real_probability: number; espn_event_id: string }>;
  };
  const generatedParlays: GeneratedParlay[] = [];
  const seen = new Set<string>();
  const legKey = (leg: MappedRow) => `${leg.espn_event_id}|${leg.pick}`;
  const buildParlay = (legs: MappedRow[]): GeneratedParlay | null => {
    const odds = legs.reduce((a, l) => a * l.odds_decimal, 1);
    const realProb = legs.reduce((a, l) => a * l.real_probability, 1);
    const implied = 1 / odds;
    const edge = realProb - implied;
    if (edge < 0.05) return null;
    const k = kellyAmount(opts.bankroll, realProb, odds);
    if (k.amount <= 0) return null;
    const conf = Math.round(realProb * 100);
    const pickText = legs.map((l) => l.pick).join(' + ');
    return {
      pick: pickText,
      pick_detail: legs.map((l) => `${l.away_team} @ ${l.home_team}: ${l.pick}`).join(' | '),
      odds_decimal: odds,
      real_probability: realProb,
      implied_probability: implied,
      edge,
      confidence: conf,
      recommended_amount: k.amount,
      kelly_fraction: k.fraction,
      analysis: `Parlay server-side de ${legs.length} legs con consenso de mercado: ${legs.map((l) => `${l.pick} (edge ${(l.edge * 100).toFixed(1)}%, ${l.floor_applied})`).join(', ')}.`,
      parlay_legs: legs.map((l) => ({
        game: `${l.away_team} @ ${l.home_team}`,
        pick: l.pick,
        odds_decimal: l.odds_decimal,
        real_probability: l.real_probability,
        espn_event_id: l.espn_event_id!,
      })),
    };
  };
  for (let i = 0; i < parlayCandidates.length; i++) {
    for (let j = i + 1; j < parlayCandidates.length; j++) {
      const a = parlayCandidates[i];
      const b = parlayCandidates[j];
      if (a.espn_event_id === b.espn_event_id) continue;
      const par = buildParlay([a, b]);
      if (par) {
        const key = [legKey(a), legKey(b)].sort().join('::');
        if (!seen.has(key)) {
          seen.add(key);
          generatedParlays.push(par);
        }
      }
      for (let k2 = j + 1; k2 < parlayCandidates.length; k2++) {
        const c = parlayCandidates[k2];
        if (c.espn_event_id === a.espn_event_id || c.espn_event_id === b.espn_event_id) continue;
        const par3 = buildParlay([a, b, c]);
        if (par3) {
          const key = [legKey(a), legKey(b), legKey(c)].sort().join('::');
          if (!seen.has(key)) {
            seen.add(key);
            generatedParlays.push(par3);
          }
        }
      }
    }
  }
  const enrichedParlays = generatedParlays
    .sort((a, b) => b.edge - a.edge)
    .slice(0, 5);
  console.log(
    `[AUDIT] server parlays: ${enrichedParlays.length} kept from ${generatedParlays.length} candidates (${parlayCandidates.length} eligible singles)`,
  );

  const now = new Date().toISOString();

  const singleRows: PickRow[] = auditedSingles.map((p) => ({
    sport: p.sport,
    league: p.league,
    game: `${p.away_team} @ ${p.home_team}`,
    home_team: p.home_team,
    away_team: p.away_team,
    home_team_abbr: p.home_team_abbr,
    away_team_abbr: p.away_team_abbr,
    espn_event_id: p.espn_event_id,
    pick: p.pick,
    pick_detail: p.pick_detail,
    bet_type: p.bet_type,
    odds_decimal: p.odds_decimal,
    best_odds: p.odds_decimal,
    best_odds_source: p.best_odds_source,
    odds_comparison: p.odds_comparison,
    edge_vs_market: p.edge_vs_market,
    market_consensus_implied: p.market_consensus_implied,
    market_sources_count: p.market_sources_count,
    market_sources: p.market_sources,
    floor_applied: p.floor_applied,
    confidence: p.confidence,
    confidence_raw: p.confidence_raw,
    tier: p.tier,
    real_probability: p.real_probability,
    implied_probability: p.implied_probability,
    edge: p.edge,
    recommended_amount: p.recommended_amount,
    analysis: p.analysis,
    risk_factors: p.risk_factors,
    injuries: p.injuries,
    key_stats: p.key_stats,
    early_payout_eligible: false,
    early_payout_threshold: null,
    line_movement_note: p.line_movement_note,
    regression_flags: p.regression_flags,
    trap_warning: p.trap_warning,
    status: 'pending',
    is_parlay: false,
    parlay_legs: null,
    game_start_time: p.game_start_time,
    updated_at: now,
    audit_failures: p.audit_failures ?? null,
  }));

  // Rail 5 source: rows that failed the quality audit. Persisted with
  // status='filtered_quality_audit', visible in /tracker for manual review,
  // never sent to Telegram automatically.
  const filteredAuditRows: PickRow[] = filteredByAudit.map((p) => ({
    sport: p.sport,
    league: p.league,
    game: `${p.away_team} @ ${p.home_team}`,
    home_team: p.home_team,
    away_team: p.away_team,
    home_team_abbr: p.home_team_abbr,
    away_team_abbr: p.away_team_abbr,
    espn_event_id: p.espn_event_id,
    pick: p.pick,
    pick_detail: p.pick_detail,
    bet_type: p.bet_type,
    odds_decimal: p.odds_decimal,
    best_odds: p.odds_decimal,
    best_odds_source: p.best_odds_source,
    odds_comparison: p.odds_comparison,
    edge_vs_market: p.edge_vs_market,
    market_consensus_implied: p.market_consensus_implied,
    market_sources_count: p.market_sources_count,
    market_sources: p.market_sources,
    floor_applied: p.floor_applied,
    confidence: p.confidence,
    confidence_raw: p.confidence_raw,
    tier: p.tier,
    real_probability: p.real_probability,
    implied_probability: p.implied_probability,
    edge: p.edge,
    recommended_amount: p.recommended_amount,
    analysis: p.analysis,
    risk_factors: p.risk_factors,
    injuries: p.injuries,
    key_stats: p.key_stats,
    early_payout_eligible: false,
    early_payout_threshold: null,
    line_movement_note: p.line_movement_note,
    regression_flags: p.regression_flags,
    trap_warning: p.trap_warning,
    status: 'filtered_quality_audit',
    is_parlay: false,
    parlay_legs: null,
    game_start_time: p.game_start_time,
    updated_at: now,
    audit_failures: p.audit_failures ?? null,
  }));

  const parlayRows: PickRow[] = enrichedParlays.map((par) => ({
    sport: 'Parlay',
    league: null,
    game: par.pick,
    home_team: '',
    away_team: '',
    home_team_abbr: null,
    away_team_abbr: null,
    espn_event_id: null,
    pick: par.pick,
    pick_detail: par.pick_detail,
    bet_type: 'Parlay',
    odds_decimal: par.odds_decimal,
    best_odds: par.odds_decimal,
    best_odds_source: null,
    odds_comparison: null,
    edge_vs_market: null,
    market_consensus_implied: null,
    market_sources_count: null,
    market_sources: null,
    floor_applied: null,
    confidence: par.confidence,
    confidence_raw: par.confidence,
    tier: 'parlay' as Tier,
    real_probability: par.real_probability,
    implied_probability: par.implied_probability,
    edge: par.edge,
    recommended_amount: par.recommended_amount,
    analysis: par.analysis,
    risk_factors: null,
    injuries: null,
    key_stats: null,
    early_payout_eligible: false,
    early_payout_threshold: null,
    line_movement_note: null,
    regression_flags: null,
    trap_warning: null,
    status: 'pending',
    is_parlay: true,
    parlay_legs: par.parlay_legs as unknown as PickRow['parlay_legs'],
    game_start_time: null,
    updated_at: now,
    audit_failures: null,
  }));

  // Marker rows for games whose Phase 3 enrichment didn't yield DK odds —
  // inserted alongside real picks so the cron's dedup query (which includes
  // status='analyzed_no_odds_data') skips them on subsequent runs.
  const noOddsDataRows: PickRow[] = noOddsDataMarkers.map((m) => ({
    sport: m.sport,
    league: m.league,
    game: `${m.away_team} @ ${m.home_team}`,
    home_team: m.home_team,
    away_team: m.away_team,
    home_team_abbr: m.home_team_abbr,
    away_team_abbr: m.away_team_abbr,
    espn_event_id: m.espn_event_id,
    pick: '—',
    pick_detail: null,
    bet_type: 'ML',
    odds_decimal: 1,
    best_odds: null,
    best_odds_source: null,
    odds_comparison: null,
    edge_vs_market: null,
    market_consensus_implied: null,
    market_sources_count: null,
    market_sources: null,
    floor_applied: null,
    confidence: 0,
    confidence_raw: null,
    tier: 'value',
    real_probability: 0,
    implied_probability: 1,
    edge: 0,
    recommended_amount: 0,
    analysis: null,
    risk_factors: null,
    injuries: null,
    key_stats: null,
    early_payout_eligible: false,
    early_payout_threshold: null,
    line_movement_note: null,
    regression_flags: null,
    trap_warning: null,
    status: 'analyzed_no_odds_data',
    is_parlay: false,
    parlay_legs: null,
    game_start_time: m.game_start_time,
    updated_at: now,
    audit_failures: null,
  }));

  // Build a lookup of kelly fractions per pick — caller (cron) passes this to
  // telegram so the message can show "Kelly 10.7%".
  const kellyByKey: Record<string, number> = {};
  for (const p of enrichedSingles) {
    kellyByKey[`${p.pick}|${p.bet_type}`] = p.kelly_fraction;
  }
  for (const par of enrichedParlays) {
    kellyByKey[`${par.pick}|Parlay`] = par.kelly_fraction;
  }

  let insertedCount = 0;
  let updatedCount = 0;
  let supersededEdgeEvaporatedCount = 0;
  let supersededLineMovedCount = 0;
  let filteredByAuditCount = 0;
  let flippedSideIgnoredCount = 0;
  // Accumulator for the supersede list — populated by both the in-loop
  // CAPA-3 line-moved branch (Rail 3) and the post-loop CAPA-2 orphaned
  // pass (Rail 4). Declared up here so Rail 3 can push into it.
  const supersededList: AnalyzeResult['supersededList'] = [];
  const insertedSinglesOut: PickRow[] = [];
  const insertedParlaysOut: PickRow[] = [];
  // Track which espn_event_ids the lock-in flow touched so the supersede
  // pass below can skip them. Events analyzed but not touched get their
  // pending picks marked superseded_edge_evaporated.
  const touchedEventIds = new Set<string>();

  // ── Rail 1: no-odds-data markers — UPSERT (Fix B). ─────────────────────
  // When the same event hits this branch on a later run (DK still late),
  // we UPDATE the existing marker incrementing retry_count and refreshing
  // updated_at. The dedup guard in cron/analyze uses retry_count + age to
  // decide whether to re-attempt. Cap is enforced upstream (retry_count<3).
  //
  // noOddsEvents accumulates metadata (including retries) so the caller
  // (cron/analyze) can build the Fix-C "slate without odds" Telegram alert.
  const noOddsEvents: AnalyzeResult['noOddsEvents'] = [];
  let insertedNoOddsCount = 0;
  if (noOddsDataRows.length > 0) {
    for (const r of noOddsDataRows) {
      if (!r.espn_event_id) {
        // Defensive: shouldn't happen (we only push markers with event_id
        // earlier in the flow), but stay safe — insert and move on.
        const { error: insErr } = await supabase
          .from('picks')
          .insert({ ...r, picks_generated_at: now });
        if (insErr) console.error('[pickGen] no-odds marker insert (no event_id) failed', insErr);
        else insertedNoOddsCount++;
        continue;
      }

      const { data: existing } = await supabase
        .from('picks')
        .select('id, retry_count')
        .eq('espn_event_id', r.espn_event_id)
        .eq('status', 'analyzed_no_odds_data')
        .maybeSingle();

      if (existing) {
        const newRetryCount = (existing.retry_count ?? 0) + 1;
        const { error: updErr } = await supabase
          .from('picks')
          .update({
            retry_count: newRetryCount,
            updated_at: now,
            picks_generated_at: now,
          })
          .eq('id', existing.id);
        if (updErr) console.error('[pickGen] no-odds marker update failed', updErr);
        else {
          insertedNoOddsCount++;
          console.log('[NO_ODDS_MARKER_UPDATED]', {
            pick_id: existing.id,
            espn_event_id: r.espn_event_id,
            retry_count: newRetryCount,
          });
        }
      } else {
        const { error: insErr } = await supabase
          .from('picks')
          .insert({ ...r, picks_generated_at: now });
        if (insErr) console.error('[pickGen] no-odds marker insert failed', insErr);
        else {
          insertedNoOddsCount++;
          console.log('[NO_ODDS_MARKER_CREATED]', { espn_event_id: r.espn_event_id });
        }
      }

      touchedEventIds.add(r.espn_event_id);
      noOddsEvents.push({
        espn_event_id: r.espn_event_id,
        sport: r.sport,
        home_team: r.home_team,
        away_team: r.away_team,
        game_start_time: r.game_start_time ?? null,
      });
    }
  }

  // ── Rail 2: parlays — keep the legacy dedup-by-key behavior, since
  // parlays don't have a stable espn_event_id and lock-in semantics don't
  // apply (server regenerates parlay combinations every run).
  if (parlayRows.length > 0) {
    const { data: existingParlays } = await supabase
      .from('picks')
      .select('id, sport, home_team, away_team, pick, bet_type')
      .eq('status', 'pending')
      .eq('is_parlay', true);
    const parlayKeyOf = (r: { sport: string; home_team: string; away_team: string; pick: string; bet_type: string }) =>
      `${r.sport}|${r.home_team}|${r.away_team}|${r.pick}|${r.bet_type}`;
    const existingParlayMap = new Map<string, string>();
    for (const e of existingParlays ?? []) existingParlayMap.set(parlayKeyOf(e), e.id);
    for (const row of parlayRows) {
      const id = existingParlayMap.get(parlayKeyOf(row));
      if (id) {
        const updateFields: Record<string, unknown> = { ...row };
        delete updateFields.status;
        const { error } = await supabase.from('picks').update(updateFields).eq('id', id);
        if (error) console.error('[pickGen] parlay update failed', error);
        else updatedCount++;
      } else {
        const { data: ins, error } = await supabase
          .from('picks')
          .insert([{ ...row, picks_generated_at: now }])
          .select()
          .single();
        if (error) console.error('[pickGen] parlay insert failed', error);
        else if (ins) {
          insertedCount++;
          insertedParlaysOut.push(ins as PickRow);
        }
      }
    }
  }

  // ── Rail 3: lockable singles ML — applyLockIn per row. ─────────────────
  // Lock-in semantics (CAPA-2 + CAPA-3):
  //   • First analysis of an espn_event_id → INSERT with locked_at=now,
  //     original_real_probability=row.real_probability, original_odds=row.odds_decimal,
  //     reanalysis_count=0, lock_reason='first_analysis'.
  //   • Subsequent analysis SAME SIDE → CAPA-3 anti-chase check FIRST:
  //     if movement_pp_adverse > 0.05 AND edge_anti_chase < 0.02 →
  //     status='superseded_line_moved_against'. Otherwise UPDATE only
  //     odds/edge/consensus/tier/kelly; NEVER touch pick, real_probability,
  //     original_*, locked_at, status. Increment reanalysis_count.
  //   • Subsequent analysis OTHER SIDE → LOG and skip. Locked pick stays.
  //   • status='bet' picks are never modified by lock-in (out of scope).
  type LockAction =
    | { action: 'insert'; row: PickRow }
    | { action: 'update'; existingId: string; row: PickRow }
    | { action: 'skip_flipped'; existingId: string; lockedSide: string; proposedSide: string }
    | { action: 'skip_already_bet'; existingId: string }
    | {
        action: 'superseded_line_moved';
        existingId: string;
        lockedSide: string;
        tier: string | null;
        originalOdds: number;
        currentOdds: number;
        wasNotified: boolean;
      };

  async function applyLockIn(row: PickRow): Promise<LockAction> {
    if (!row.espn_event_id) return { action: 'insert', row };
    const { data: existingPicks } = await supabase
      .from('picks')
      .select('id, pick, tier, real_probability, original_real_probability, original_odds, status, locked_at, reanalysis_count, telegram_notified_at')
      .eq('espn_event_id', row.espn_event_id)
      .eq('bet_type', row.bet_type)
      .eq('is_parlay', false)
      .in('status', ['pending', 'bet']);
    const existing = (existingPicks ?? [])[0];
    if (!existing) return { action: 'insert', row };
    // Protect bet picks — never modified by lock-in.
    if (existing.status === 'bet') {
      return { action: 'skip_already_bet', existingId: existing.id };
    }
    // Same-side path: CAPA-3 anti-chase check first, then CAPA-2 update.
    if (existing.pick === row.pick) {
      const originalOdds = Number(existing.original_odds);
      const originalRealProb = Number(existing.original_real_probability);
      const currentOdds = row.odds_decimal;
      if (
        Number.isFinite(originalOdds) && originalOdds > 1 &&
        Number.isFinite(originalRealProb) &&
        Number.isFinite(currentOdds) && currentOdds > 1
      ) {
        // movement_pp_adverse: how much the implied prob FOR OUR SIDE
        // increased — i.e., book shortened our line, making the bet worse.
        const originalImplied = 1 / originalOdds;
        const currentImplied = 1 / currentOdds;
        const movementPp = currentImplied - originalImplied;
        // edge_anti_chase: edge of the FROZEN opinion against the CURRENT
        // line. If frozen prob was 0.72 and DK now implies 0.67, we still
        // have 5pp edge — fine. If DK shortened to imply 0.75, we have
        // −3pp — superseded.
        const edgeAntiChase = originalRealProb - currentImplied;
        if (movementPp > 0.05 && edgeAntiChase < 0.02) {
          return {
            action: 'superseded_line_moved',
            existingId: existing.id,
            lockedSide: existing.pick,
            tier: (existing.tier as string | null) ?? null,
            originalOdds,
            currentOdds,
            wasNotified: !!existing.telegram_notified_at,
          };
        }
      }
      return { action: 'update', existingId: existing.id, row };
    }
    // Flipped side.
    return {
      action: 'skip_flipped',
      existingId: existing.id,
      lockedSide: existing.pick,
      proposedSide: row.pick,
    };
  }

  for (const row of singleRows) {
    const decision = await applyLockIn(row);
    if (decision.action === 'insert') {
      const insertPayload = {
        ...row,
        picks_generated_at: now,
        locked_at: now,
        original_real_probability: row.real_probability,
        original_odds: row.odds_decimal,
        reanalysis_count: 0,
        lock_reason: 'first_analysis',
      };
      const { data: ins, error } = await supabase
        .from('picks')
        .insert([insertPayload])
        .select()
        .single();
      if (error) {
        console.error('[pickGen] lock-in insert failed', error);
        continue;
      }
      if (ins) {
        insertedCount++;
        insertedSinglesOut.push(ins as PickRow);
        if (row.espn_event_id) touchedEventIds.add(row.espn_event_id);
        if ((ins as PickRow).id) {
          await recordPickFactors(supabase, {
            id: (ins as PickRow).id!,
            sport: row.sport,
            pick: row.pick,
            bet_type: row.bet_type,
            odds_decimal: Number(row.odds_decimal),
            home_team: row.home_team,
            away_team: row.away_team,
            league: row.league,
            confidence: row.confidence,
            tier: row.tier,
            edge: Number(row.edge),
            best_odds_source: row.best_odds_source,
            trap_warning: row.trap_warning,
            regression_flags: row.regression_flags,
            line_movement_note: row.line_movement_note,
            key_stats: row.key_stats as Pick['key_stats'],
          });
        }
      }
    } else if (decision.action === 'update') {
      // Refresh only the volatile fields. Lock-in invariants stay frozen.
      const refreshFields = {
        odds_decimal: row.odds_decimal,
        best_odds: row.best_odds,
        best_odds_source: row.best_odds_source,
        odds_comparison: row.odds_comparison,
        edge: row.edge,
        edge_vs_market: row.edge_vs_market,
        market_consensus_implied: row.market_consensus_implied,
        market_sources_count: row.market_sources_count,
        market_sources: row.market_sources,
        floor_applied: row.floor_applied,
        confidence: row.confidence,
        confidence_raw: row.confidence_raw,
        tier: row.tier,
        recommended_amount: row.recommended_amount,
        lock_reason: 'updated',
        updated_at: now,
      };
      const { error: updErr } = await supabase
        .from('picks')
        .update(refreshFields)
        .eq('id', decision.existingId);
      if (updErr) {
        console.error('[pickGen] lock-in update failed', updErr);
      } else {
        // Two-step read+write to bump reanalysis_count — supabase-js doesn't
        // expose atomic increment and this field is audit-only, not
        // concurrency-critical (the cron runs once at a time per project).
        const { data: cur } = await supabase
          .from('picks')
          .select('reanalysis_count')
          .eq('id', decision.existingId)
          .single();
        await supabase
          .from('picks')
          .update({ reanalysis_count: (cur?.reanalysis_count ?? 0) + 1 })
          .eq('id', decision.existingId);
        updatedCount++;
        if (row.espn_event_id) touchedEventIds.add(row.espn_event_id);
        console.log('[LOCK_UPDATED]', {
          espn_event_id: row.espn_event_id,
          pick: row.pick,
          new_odds: row.odds_decimal,
          new_edge: Number(row.edge.toFixed(4)),
        });
      }
    } else if (decision.action === 'skip_flipped') {
      flippedSideIgnoredCount++;
      if (row.espn_event_id) touchedEventIds.add(row.espn_event_id);
      console.log('[LOCK_FLIPPED_SIDE_IGNORED]', {
        espn_event_id: row.espn_event_id,
        locked_side: decision.lockedSide,
        proposed_side: decision.proposedSide,
        proposed_real_prob: row.real_probability,
      });
    } else if (decision.action === 'superseded_line_moved') {
      // CAPA-3 anti-chase. The DK line has shortened against our locked
      // side and the frozen probability no longer clears 2pp edge against
      // the current implied. We mark the pick superseded so the user
      // doesn't blindly chase the original conviction at worse prices.
      const { error } = await supabase
        .from('picks')
        .update({
          status: 'superseded_line_moved_against',
          lock_reason: 'line_moved_against_in_reanalysis',
          odds_decimal: decision.currentOdds,
          edge: row.edge,
          edge_vs_market: row.edge_vs_market,
          updated_at: now,
        })
        .eq('id', decision.existingId);
      if (error) {
        console.error('[pickGen] supersede_line_moved update failed', error);
      } else {
        // Bump reanalysis_count via two-step read+write (supabase-js has
        // no atomic increment; this field is audit-only).
        const { data: cur } = await supabase
          .from('picks')
          .select('reanalysis_count')
          .eq('id', decision.existingId)
          .single();
        await supabase
          .from('picks')
          .update({ reanalysis_count: (cur?.reanalysis_count ?? 0) + 1 })
          .eq('id', decision.existingId);
        supersededLineMovedCount++;
        supersededList.push({
          pick: decision.lockedSide,
          tier: decision.tier,
          was_notified: decision.wasNotified,
          reason: 'line_moved_against',
          original_odds: decision.originalOdds,
          current_odds: decision.currentOdds,
        });
        if (row.espn_event_id) touchedEventIds.add(row.espn_event_id);
        const movementPp = 1 / decision.currentOdds - 1 / decision.originalOdds;
        console.log('[LOCK_SUPERSEDED_LINE_MOVED]', {
          pick_id: decision.existingId,
          pick: decision.lockedSide,
          espn_event_id: row.espn_event_id,
          original_odds: decision.originalOdds,
          current_odds: decision.currentOdds,
          movement_pp: Number(movementPp.toFixed(4)),
          was_notified: decision.wasNotified,
        });
      }
    } else {
      // skip_already_bet — pick is already a placed bet, untouched.
      if (row.espn_event_id) touchedEventIds.add(row.espn_event_id);
      console.log('[LOCK_SKIPPED_BET_PROTECTED]', {
        espn_event_id: row.espn_event_id,
        pick: row.pick,
      });
    }
  }

  // ── Rail 4: supersede orphaned pending picks ───────────────────────────
  // A game we analyzed this run but didn't touch (no insert, no update, no
  // flip-log) means Claude's edge for that event disappeared. Mark the
  // existing pending pick as superseded_edge_evaporated so the UI hides it
  // and the dedup query doesn't re-show it. Only pending picks — bet picks
  // are protected.
  const analyzedEventIds = new Set(
    games.map((g) => g.espn_event_id).filter((x): x is string => Boolean(x)),
  );
  const orphanedEventIds = Array.from(analyzedEventIds).filter((id) => !touchedEventIds.has(id));
  if (orphanedEventIds.length > 0) {
    // Capture pick + tier + telegram_notified_at BEFORE the update so the
    // cron knows whether each supersede needs a standalone Telegram alert.
    const { data: orphanedPicks } = await supabase
      .from('picks')
      .select('id, pick, tier, espn_event_id, original_real_probability, telegram_notified_at')
      .in('espn_event_id', orphanedEventIds)
      .eq('status', 'pending')
      .eq('is_parlay', false);
    for (const o of orphanedPicks ?? []) {
      const { error } = await supabase
        .from('picks')
        .update({
          status: 'superseded_edge_evaporated',
          lock_reason: 'edge_evaporated_in_reanalysis',
          updated_at: now,
        })
        .eq('id', o.id);
      if (error) {
        console.error('[pickGen] supersede update failed', error);
        continue;
      }
      supersededEdgeEvaporatedCount++;
      supersededList.push({
        pick: o.pick,
        tier: (o.tier as string | null) ?? null,
        was_notified: !!o.telegram_notified_at,
        reason: 'edge_evaporated',
      });
      console.log('[LOCK_SUPERSEDED_EDGE_EVAPORATED]', {
        pick_id: o.id,
        pick: o.pick,
        tier: o.tier,
        was_notified: !!o.telegram_notified_at,
        espn_event_id: o.espn_event_id,
        original_real_prob: o.original_real_probability,
      });
    }
  }

  // ── Rail 5: filtered-by-audit picks (NEW — Auditoría 2) ────────────────
  // Picks that survived all upstream gates but failed the quality audit.
  // Inserted with status='filtered_quality_audit' so they're visible in
  // /tracker for manual review but never auto-sent to Telegram. Dedup by
  // espn_event_id+bet_type: if ANY row already exists for this event+
  // bet_type (any status), skip — historical row is enough.
  if (filteredAuditRows.length > 0) {
    const eventIdsToCheck = filteredAuditRows
      .map((r) => r.espn_event_id)
      .filter((x): x is string => Boolean(x));
    const { data: existingForEvents } = await supabase
      .from('picks')
      .select('espn_event_id, bet_type')
      .in('espn_event_id', eventIdsToCheck.length > 0 ? eventIdsToCheck : ['__none__'])
      .eq('is_parlay', false);
    const seenEventBetType = new Set<string>(
      (existingForEvents ?? []).map((e) => `${e.espn_event_id}|${e.bet_type}`),
    );
    const toInsertFiltered: PickRow[] = [];
    for (const r of filteredAuditRows) {
      const key = `${r.espn_event_id}|${r.bet_type}`;
      if (r.espn_event_id && seenEventBetType.has(key)) {
        console.log('[QUALITY_AUDIT_SKIPPED_DUPLICATE]', {
          espn_event_id: r.espn_event_id,
          bet_type: r.bet_type,
          pick: r.pick,
        });
        continue;
      }
      toInsertFiltered.push(r);
      if (r.espn_event_id) seenEventBetType.add(key); // dedup within batch too
    }
    if (toInsertFiltered.length > 0) {
      const payload = toInsertFiltered.map((r) => ({ ...r, picks_generated_at: now }));
      const { error } = await supabase.from('picks').insert(payload);
      if (error) {
        console.error('[pickGen] filtered_quality_audit insert failed', error);
      } else {
        filteredByAuditCount = toInsertFiltered.length;
      }
    }
  }

  console.log(
    `[pickGen] done in ${Date.now() - t0}ms inserted=${insertedCount} updated=${updatedCount} superseded_edge=${supersededEdgeEvaporatedCount} superseded_line=${supersededLineMovedCount} flipped=${flippedSideIgnoredCount} filtered_audit=${filteredByAuditCount}`,
  );

  return {
    inserted: insertedCount,
    updated: updatedCount,
    insertedPicks: insertedSinglesOut,
    insertedParlays: insertedParlaysOut,
    kellyByKey,
    withEdge: enrichedSingles.length,
    parlayCount: enrichedParlays.length,
    supersededEdgeEvaporated: supersededEdgeEvaporatedCount,
    supersededLineMoved: supersededLineMovedCount,
    flippedSideIgnored: flippedSideIgnoredCount,
    filteredByAudit: filteredByAuditCount,
    supersededList,
    insertedNoOddsCount,
    noOddsEvents,
  };
}
