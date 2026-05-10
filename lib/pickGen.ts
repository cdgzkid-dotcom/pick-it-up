// Shared pick generation logic — used by /api/generate-picks (manual) and
// /api/cron/analyze (automatic). Takes pre-fetched ESPN games and returns
// inserted/updated counts plus the picks themselves (so callers can notify).

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { callClaudeJson } from './claude';
import { PICK_GENERATION_SYSTEM, buildPickGenerationUserPrompt } from './prompts';
import { adjustedEdgeScore, edgeOf, impliedProbability } from './edge';
import { kellyAmount, tierForOdds, tierFromConfidence } from './units';
import { getRatingsForGames } from './elo';
import { fetchGameWeather, isDome } from './weather';
import { buildMlbGameContext } from './mlbStats';
import { buildNhlGameContext } from './nhlStats';
import { buildNbaGameContext } from './nbaStats';
import { fetchMultiOdds, findOddsForGame, bestMoneylineByBook, sharpAnalysis } from './oddsApi';
import type { Game, Tier } from './types';

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

const ClaudeResponseSchema = z.object({
  analyzed_count: z.coerce.number().int().optional(),
  discarded_count: z.coerce.number().int().optional(),
  picks: z.array(ClaudePickSchema).default([]),
  parlays: z.array(ClaudeParlaySchema).optional().default([]),
});

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
}

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
  confidence: number;
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
  // Pull live stats from sport-specific APIs (MLB Stats, NHL API, NBA stats)
  // PLUS multi-book odds from The Odds API. Each fetch has its own try/catch
  // so a single API outage degrades to ESPN-only data, never breaks the run.
  const today = new Date().toISOString().slice(0, 10);
  const oddsBySport: Record<string, Awaited<ReturnType<typeof fetchMultiOdds>>> = {};
  const sportsInPlay = Array.from(new Set(enriched.map((g) => g.sport)));
  await Promise.all(
    sportsInPlay.map(async (s) => {
      try {
        oddsBySport[s] = await fetchMultiOdds(s);
      } catch (e) {
        console.warn(`[pickGen] odds fetch ${s} failed`, e);
      }
    }),
  );

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

      // Multi-book odds (Odds API). Best-line per side + Pinnacle sharp
      // analysis included for Claude.
      const events = oddsBySport[g.sport];
      if (events) {
        const rows = findOddsForGame(events, g.home_team, g.away_team);
        if (rows.length > 0) {
          g.multi_odds = rows.map((r) => ({
            source: r.source,
            home_ml: r.home_ml,
            away_ml: r.away_ml,
            spread: r.spread,
            total: r.total,
          }));
          const best = bestMoneylineByBook(rows);
          (g.real_data as Record<string, unknown>).best_ml = best;
          const sharp = sharpAnalysis(rows);
          if (sharp) {
            (g.real_data as Record<string, unknown>).sharp = sharp;
            console.log(
              `[DATA][SHARP] ${g.game_label} pinnacle=${sharp.pinnacle_home_ml}/${sharp.pinnacle_away_ml} best_edge_home=${sharp.best_home?.edge_vs_sharp?.toFixed(3) ?? '∅'} (${sharp.best_home?.book ?? '?'}) best_edge_away=${sharp.best_away?.edge_vs_sharp?.toFixed(3) ?? '∅'} (${sharp.best_away?.book ?? '?'})`,
            );
          } else {
            console.log(`[DATA][SHARP] ${g.game_label} no Pinnacle in ${rows.length} books — fallback to consensus`);
          }
          console.log(
            `[DATA][ODDS] ${g.game_label} ${rows.length} books, best home=${best.home?.decimal} (${best.home?.source}) best away=${best.away?.decimal} (${best.away?.source})`,
          );
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
            buildPickGenerationUserPrompt(b),
            { retry: false, maxTokens: 4096 },
          );
          const validated = ClaudeResponseSchema.safeParse(claudeOutput);
          if (!validated.success) {
            console.error(`[AUDIT][batch ${i}] VALIDATION FAILED`, JSON.stringify(validated.error.flatten()));
            console.error(`[AUDIT][batch ${i}] raw output sample:`, JSON.stringify(claudeOutput).slice(0, 1500));
            return { picks: [], parlays: [], dropped: b.length, idx: i, ms: Date.now() - tStart };
          }
          // AUDIT: log every pick Claude returned for this batch with raw fields
          console.log(
            `[AUDIT][batch ${i}] input games=${b.length} (${b.map((g) => `${g.away_team_abbr ?? '?'}@${g.home_team_abbr ?? '?'}`).join(',')}) → claude returned ${validated.data.picks.length} picks ${validated.data.parlays.length} parlays in ${Date.now() - tStart}ms`,
          );
          for (const p of validated.data.picks) {
            console.log(
              `[AUDIT][batch ${i}] pick raw: ${p.pick} (${p.sport}) tier=${p.tier ?? '∅'} conf=${p.confidence} real=${(p.real_probability * 100).toFixed(1)}% odds=${p.odds_decimal} claude_edge=${p.edge ?? '∅'} trap=${p.trap_warning ? 'YES' : 'no'}`,
            );
          }
          for (const par of validated.data.parlays) {
            console.log(
              `[AUDIT][batch ${i}] parlay raw: ${par.legs.map((l) => l.pick).join('+')} odds=${par.combined_odds} prob=${(par.combined_probability * 100).toFixed(1)}% conf=${par.confidence ?? '∅'}`,
            );
          }
          return { picks: validated.data.picks, parlays: validated.data.parlays, dropped: 0, idx: i, ms: Date.now() - tStart };
        } catch (err) {
          console.error(`[pickGen] batch ${i} failed`, err);
          return { picks: [], parlays: [], dropped: b.length, idx: i, ms: Date.now() - tStart };
        }
      })(),
      new Promise<{ picks: never[]; parlays: never[]; dropped: number; idx: number; ms: number; timedOut: true }>((resolve) =>
        setTimeout(() => resolve({ picks: [], parlays: [], dropped: b.length, idx: i, ms: PER_BATCH_TIMEOUT_MS, timedOut: true }), PER_BATCH_TIMEOUT_MS),
      ),
    ]),
  );

  const settled = await Promise.allSettled(batchPromises);
  const batchResults = settled.map((s) => (s.status === 'fulfilled' ? s.value : { picks: [], parlays: [], dropped: 0, idx: -1, ms: 0 }));

  const totalDropped = batchResults.reduce((acc, r) => acc + ('dropped' in r ? r.dropped : 0), 0);
  const timedOutBatches = batchResults.filter((r) => 'timedOut' in r && r.timedOut).map((r) => r.idx);
  if (totalDropped > 0) {
    console.warn(`[pickGen] dropped ${totalDropped} games — timed-out batches: [${timedOutBatches.join(',')}]`);
  }

  const raw = {
    picks: batchResults.flatMap((r) => r.picks),
    parlays: batchResults.flatMap((r) => r.parlays),
  };

  const gameByMatchup = new Map<string, Game>();
  const teamAbbrByName = new Map<string, string>();
  for (const g of games) {
    gameByMatchup.set(`${g.home_team.toLowerCase()}|${g.away_team.toLowerCase()}`, g);
    if (g.home_team_abbr) teamAbbrByName.set(g.home_team.toLowerCase(), g.home_team_abbr);
    if (g.away_team_abbr) teamAbbrByName.set(g.away_team.toLowerCase(), g.away_team_abbr);
  }

  console.log(
    `[AUDIT] total raw from claude: ${raw.picks.length} picks + ${raw.parlays.length} parlays (across ${batches.length} batches)`,
  );

  const mapped = raw.picks.map((p) => {
    const odds = p.odds_decimal;
    const implied = impliedProbability(odds);
    const e = edgeOf(p.real_probability, odds);
    const baseTier: Tier = tierFromConfidence(p.confidence);
    const adjustedTier = tierForOdds(baseTier, odds);
    const hasTrap = !!p.trap_warning;
    const k = kellyAmount(opts.bankroll, p.real_probability, odds, { conservative: hasTrap });
    const score = adjustedEdgeScore(p.real_probability, odds);
    const homeAbbr =
      p.home_team_abbr?.toLowerCase() ??
      teamAbbrByName.get(p.home_team.toLowerCase()) ??
      null;
    const awayAbbr =
      p.away_team_abbr?.toLowerCase() ??
      teamAbbrByName.get(p.away_team.toLowerCase()) ??
      null;
    const matchedGame = gameByMatchup.get(
      `${p.home_team.toLowerCase()}|${p.away_team.toLowerCase()}`,
    );
    return {
      ...p,
      home_team_abbr: homeAbbr,
      away_team_abbr: awayAbbr,
      espn_event_id: matchedGame?.espn_event_id ?? null,
      game_start_time: matchedGame?.start_time ?? null,
      implied_probability: implied,
      edge: e,
      tier: adjustedTier,
      recommended_amount: k.amount,
      kelly_fraction: k.fraction,
      _score: score,
    };
  });

  // AUDIT: per-pick filter result (which filter rejected it, if any)
  const reasons: Record<string, number> = {
    pass: 0,
    fail_edge: 0,
    fail_confidence: 0,
    fail_kelly_zero: 0,
    fail_culero_low_edge: 0,
  };
  const enrichedSingles = mapped
    .filter((p) => {
      const reasons_for_this: string[] = [];
      if (!(p.edge > 0)) reasons_for_this.push('edge<=0');
      if (!(p.confidence >= 55)) reasons_for_this.push(`conf<55 (${p.confidence})`);
      if (!(p.recommended_amount > 0)) reasons_for_this.push('kelly=0');
      if (p.odds_decimal < 1.4 && p.edge < 0.05) reasons_for_this.push(`culero (odds=${p.odds_decimal} edge=${(p.edge * 100).toFixed(1)}%)`);
      if (reasons_for_this.length > 0) {
        console.log(
          `[AUDIT] DISCARD ${p.pick} (${p.sport}) — reasons: ${reasons_for_this.join('; ')} | conf=${p.confidence} odds=${p.odds_decimal} real=${(p.real_probability * 100).toFixed(1)}% computed_edge=${(p.edge * 100).toFixed(2)}% kelly=$${p.recommended_amount}`,
        );
        if (!(p.edge > 0)) reasons.fail_edge++;
        else if (!(p.confidence >= 55)) reasons.fail_confidence++;
        else if (!(p.recommended_amount > 0)) reasons.fail_kelly_zero++;
        else reasons.fail_culero_low_edge++;
        return false;
      }
      console.log(
        `[AUDIT] KEEP ${p.pick} (${p.sport}) — tier=${p.tier} conf=${p.confidence} odds=${p.odds_decimal} edge=${(p.edge * 100).toFixed(2)}% kelly=$${p.recommended_amount} (${(p.kelly_fraction * 100).toFixed(1)}%)`,
      );
      reasons.pass++;
      return true;
    })
    .sort((a, b) => b._score - a._score);

  console.log(`[AUDIT] filter summary: ${JSON.stringify(reasons)}`);

  const enrichedParlays = raw.parlays.map((par) => {
    const odds = par.combined_odds;
    const implied = par.implied_probability ?? impliedProbability(odds);
    const realProb = par.combined_probability;
    const e = par.edge ?? realProb - implied;
    const conf = par.confidence ?? Math.round(realProb * 100);
    // Parlays use half-Kelly too — typically smaller than singles because
    // the combined probability is lower.
    const k = kellyAmount(opts.bankroll, realProb, odds);
    return {
      pick: par.legs.map((l) => l.pick).join(' + '),
      pick_detail: par.legs.map((l) => `${l.game}: ${l.pick}`).join(' | '),
      odds_decimal: odds,
      real_probability: realProb,
      implied_probability: implied,
      edge: e,
      confidence: conf,
      tier: 'parlay' as Tier,
      recommended_amount: k.amount,
      kelly_fraction: k.fraction,
      analysis: par.analysis ?? null,
      parlay_legs: par.legs,
    };
  }).filter((par) => par.recommended_amount > 0 && par.edge > 0);

  const now = new Date().toISOString();

  const singleRows: PickRow[] = enrichedSingles.map((p) => ({
    sport: p.sport,
    league: p.league ?? null,
    game: `${p.away_team} @ ${p.home_team}`,
    home_team: p.home_team,
    away_team: p.away_team,
    home_team_abbr: p.home_team_abbr,
    away_team_abbr: p.away_team_abbr,
    espn_event_id: p.espn_event_id,
    pick: p.pick,
    pick_detail: p.pick_detail ?? null,
    bet_type: p.bet_type,
    odds_decimal: p.odds_decimal,
    best_odds: p.odds_decimal,
    best_odds_source: null,
    odds_comparison: null,
    confidence: p.confidence,
    tier: p.tier,
    real_probability: p.real_probability,
    implied_probability: p.implied_probability,
    edge: p.edge,
    recommended_amount: p.recommended_amount,
    analysis: p.analysis ?? null,
    risk_factors: p.risk_factors ?? null,
    injuries: p.injuries ?? null,
    key_stats: p.key_stats ?? null,
    early_payout_eligible: p.early_payout_eligible ?? false,
    early_payout_threshold: p.early_payout_threshold ?? null,
    line_movement_note: p.line_movement_note ?? null,
    regression_flags: p.regression_flags ?? null,
    trap_warning: p.trap_warning ?? null,
    status: 'pending',
    is_parlay: false,
    parlay_legs: null,
    game_start_time: p.game_start_time,
    updated_at: now,
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
    confidence: par.confidence,
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
    parlay_legs: par.parlay_legs,
    game_start_time: null,
    updated_at: now,
  }));

  const allRows: PickRow[] = [...singleRows, ...parlayRows];

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
  const insertedSinglesOut: PickRow[] = [];
  const insertedParlaysOut: PickRow[] = [];

  if (allRows.length > 0) {
    const { data: existing } = await supabase
      .from('picks')
      .select('id, sport, home_team, away_team, pick, bet_type')
      .eq('status', 'pending');

    const keyOf = (r: { sport: string; home_team: string; away_team: string; pick: string; bet_type: string }) =>
      `${r.sport}|${r.home_team}|${r.away_team}|${r.pick}|${r.bet_type}`;

    const existingMap = new Map<string, string>();
    for (const e of existing ?? []) existingMap.set(keyOf(e), e.id);

    const toInsert: PickRow[] = [];
    const toUpdate: { id: string; row: PickRow }[] = [];

    for (const row of allRows) {
      const id = existingMap.get(keyOf(row));
      if (id) toUpdate.push({ id, row });
      else toInsert.push(row);
    }

    if (toInsert.length > 0) {
      const insertPayload = toInsert.map((r) => ({ ...r, picks_generated_at: now }));
      const { data: insertedRows, error: insErr } = await supabase
        .from('picks')
        .insert(insertPayload)
        .select();
      if (insErr) {
        console.error('[pickGen] insert failed', insErr);
        throw new Error(`DB insert failed: ${insErr.message}`);
      }
      insertedCount = toInsert.length;
      for (const r of (insertedRows ?? []) as PickRow[]) {
        if (r.is_parlay) insertedParlaysOut.push(r);
        else insertedSinglesOut.push(r);
      }
    }

    for (const u of toUpdate) {
      const { id, row } = u;
      const updateFields: Record<string, unknown> = { ...row };
      delete updateFields.status;
      const { error: updErr } = await supabase.from('picks').update(updateFields).eq('id', id);
      if (updErr) console.error('[pickGen] update failed', updErr);
      else updatedCount++;
    }
  }

  console.log(
    `[pickGen] done in ${Date.now() - t0}ms inserted=${insertedCount} updated=${updatedCount}`,
  );

  return {
    inserted: insertedCount,
    updated: updatedCount,
    insertedPicks: insertedSinglesOut,
    insertedParlays: insertedParlaysOut,
    kellyByKey,
    withEdge: enrichedSingles.length,
    parlayCount: enrichedParlays.length,
  };
}
