// Shared pick generation logic — used by /api/generate-picks (manual) and
// /api/cron/analyze (automatic). Takes pre-fetched ESPN games and returns
// inserted/updated counts plus the picks themselves (so callers can notify).

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { callClaudeJson } from './claude';
import { PICK_GENERATION_SYSTEM, buildPickGenerationUserPrompt } from './prompts';
import { adjustedEdgeScore, edgeOf, impliedProbability } from './edge';
import { recommendedAmount, tierForOdds, tierFromConfidence } from './units';
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
  status: string;
  is_parlay: boolean;
  parlay_legs: unknown;
  game_start_time: string | null;
  updated_at: string;
}

export async function analyzeGames(
  games: Game[],
  supabase: SupabaseClient,
  opts: AnalyzeOpts,
): Promise<AnalyzeResult> {
  const unit = opts.bankroll * (opts.unitPercentage / 100);

  const batches = chunk(games, BATCH_SIZE);
  const t0 = Date.now();
  console.log(`[pickGen] launching ${batches.length} batches for ${games.length} games`);

  const batchResults = await Promise.all(
    batches.map(async (b, i) => {
      const tStart = Date.now();
      try {
        const claudeOutput = await callClaudeJson(
          PICK_GENERATION_SYSTEM,
          buildPickGenerationUserPrompt(b),
          { retry: false, maxTokens: 4096 },
        );
        const validated = ClaudeResponseSchema.safeParse(claudeOutput);
        if (!validated.success) {
          console.error(`[pickGen] batch ${i} validation failed`, validated.error.flatten());
          return { picks: [], parlays: [] };
        }
        console.log(
          `[pickGen] batch ${i} (${b.length} games) ${Date.now() - tStart}ms — ${validated.data.picks.length} picks ${validated.data.parlays.length} parlays`,
        );
        return { picks: validated.data.picks, parlays: validated.data.parlays };
      } catch (err) {
        console.error(`[pickGen] batch ${i} failed`, err);
        return { picks: [], parlays: [] };
      }
    }),
  );

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

  const enrichedSingles = raw.picks
    .map((p) => {
      const odds = p.odds_decimal;
      const implied = impliedProbability(odds);
      const e = edgeOf(p.real_probability, odds);
      // Recompute tier server-side from confidence — never trust Claude's tier
      const baseTier: Tier = tierFromConfidence(p.confidence);
      // tierForOdds demotes one tier when odds < 1.40
      const adjustedTier = tierForOdds(baseTier, odds);
      const recommended = recommendedAmount(adjustedTier, unit, odds);
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
        recommended_amount: recommended,
        _score: score,
      };
    })
    // Server-side filters (don't trust Claude's self-policing):
    //   - edge must be positive
    //   - confidence >= 55 (anything below is no-bet territory)
    //   - if odds < 1.40 (momio culero) require edge ≥ 5% — otherwise the
    //     payout doesn't compensate the variance
    .filter((p) => p.edge > 0)
    .filter((p) => p.confidence >= 55)
    .filter((p) => !(p.odds_decimal < 1.4 && p.edge < 0.05))
    .sort((a, b) => b._score - a._score);

  const enrichedParlays = raw.parlays.map((par) => {
    const odds = par.combined_odds;
    const implied = par.implied_probability ?? impliedProbability(odds);
    const realProb = par.combined_probability;
    const e = par.edge ?? realProb - implied;
    const conf = par.confidence ?? Math.round(realProb * 100);
    return {
      pick: par.legs.map((l) => l.pick).join(' + '),
      pick_detail: par.legs.map((l) => `${l.game}: ${l.pick}`).join(' | '),
      odds_decimal: odds,
      real_probability: realProb,
      implied_probability: implied,
      edge: e,
      confidence: conf,
      tier: 'parlay' as Tier,
      recommended_amount: recommendedAmount('parlay', unit, odds),
      analysis: par.analysis ?? null,
      parlay_legs: par.legs,
    };
  });

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
    status: 'pending',
    is_parlay: true,
    parlay_legs: par.parlay_legs,
    game_start_time: null,
    updated_at: now,
  }));

  const allRows: PickRow[] = [...singleRows, ...parlayRows];

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
    withEdge: enrichedSingles.length,
    parlayCount: enrichedParlays.length,
  };
}
