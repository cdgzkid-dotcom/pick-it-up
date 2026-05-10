import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase';
import { callClaudeJson } from '@/lib/claude';
import { PICK_GENERATION_SYSTEM, buildPickGenerationUserPrompt } from '@/lib/prompts';
import { fetchGames } from '@/lib/espn';
import { adjustedEdgeScore, edgeOf, impliedProbability } from '@/lib/edge';
import {
  recommendedAmount,
  tierForOdds,
  tierFromConfidence,
  unitSize,
} from '@/lib/units';
import type { Game, Tier } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_GAMES_PER_REQUEST = 8;

const RequestSchema = z.object({
  sports: z.array(z.string()).min(1),
});

function competitiveness(g: Game): number {
  const h = g.odds.moneyline?.home;
  if (!h || !Number.isFinite(h)) return Number.POSITIVE_INFINITY;
  return Math.abs(0.5 - 1 / h);
}

function selectTopGames(games: Game[], requestedSports: string[], max: number): Game[] {
  const bySport: Record<string, Game[]> = {};
  for (const g of games) (bySport[g.sport] ??= []).push(g);
  for (const s of Object.keys(bySport)) {
    bySport[s].sort((a, b) => competitiveness(a) - competitiveness(b));
  }
  const order = requestedSports.filter((s) => (bySport[s]?.length ?? 0) > 0);
  const result: Game[] = [];
  while (result.length < max && order.some((s) => bySport[s].length > 0)) {
    for (const s of order) {
      if (result.length >= max) break;
      const next = bySport[s].shift();
      if (next) result.push(next);
    }
  }
  return result;
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

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Bad request', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const t0 = Date.now();
  console.log(`[generate-picks] start sports=${parsed.data.sports.join(',')}`);

  let games: Game[];
  try {
    games = await fetchGames(parsed.data.sports);
  } catch (err) {
    console.error('[generate-picks] ESPN fetch failed', err);
    return NextResponse.json(
      { error: 'No se pudo conectar con ESPN', detail: (err as Error).message },
      { status: 502 },
    );
  }
  console.log(`[generate-picks] ESPN fetched ${games.length} games in ${Date.now() - t0}ms`);

  if (games.length === 0) {
    return NextResponse.json({
      analyzed: 0,
      total_available: 0,
      with_edge: 0,
      inserted: 0,
      updated: 0,
      message: 'No hay juegos con momios disponibles en los deportes seleccionados',
    });
  }

  const totalAvailable = games.length;
  const games_to_analyze = selectTopGames(games, parsed.data.sports, MAX_GAMES_PER_REQUEST);
  console.log(
    `[generate-picks] analyzing ${games_to_analyze.length} of ${totalAvailable}`,
  );

  const supabase = supabaseAdmin();
  const { data: settingsRow, error: settingsErr } = await supabase
    .from('settings')
    .select('bankroll_current, unit_percentage')
    .eq('id', 1)
    .single();
  if (settingsErr) {
    return NextResponse.json({ error: 'Settings missing', detail: settingsErr.message }, { status: 500 });
  }
  const bankroll = Number(settingsRow.bankroll_current);
  const unitPct = Number(settingsRow.unit_percentage);
  const unit = unitSize(bankroll, unitPct);

  let raw: z.infer<typeof ClaudeResponseSchema>;
  const tClaude = Date.now();
  try {
    const claudeOutput = await callClaudeJson(
      PICK_GENERATION_SYSTEM,
      buildPickGenerationUserPrompt(games_to_analyze),
    );
    console.log(`[generate-picks] Claude responded in ${Date.now() - tClaude}ms`);
    const validated = ClaudeResponseSchema.safeParse(claudeOutput);
    if (!validated.success) {
      console.error('[generate-picks] Claude JSON malformed', validated.error.flatten());
      return NextResponse.json(
        {
          error: 'Claude returned malformed JSON',
          detail: validated.error.flatten(),
          claude_output: claudeOutput,
        },
        { status: 502 },
      );
    }
    raw = validated.data;
  } catch (err) {
    console.error('[generate-picks] Claude request failed', err);
    return NextResponse.json(
      { error: 'Claude request failed', detail: (err as Error).message },
      { status: 502 },
    );
  }

  // Build lookup tables from analyzed games for abbr/event_id fallback
  const gameByMatchup = new Map<string, Game>();
  const teamAbbrByName = new Map<string, string>();
  for (const g of games_to_analyze) {
    gameByMatchup.set(`${g.home_team.toLowerCase()}|${g.away_team.toLowerCase()}`, g);
    if (g.home_team_abbr) teamAbbrByName.set(g.home_team.toLowerCase(), g.home_team_abbr);
    if (g.away_team_abbr) teamAbbrByName.set(g.away_team.toLowerCase(), g.away_team_abbr);
  }

  const enrichedSingles = raw.picks
    .map((p) => {
      const odds = p.odds_decimal;
      const implied = impliedProbability(odds);
      const e = edgeOf(p.real_probability, odds);
      const tier: Tier = p.tier ?? tierFromConfidence(p.confidence);
      const adjustedTier = tierForOdds(tier, odds);
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
        implied_probability: implied,
        edge: e,
        tier: adjustedTier,
        recommended_amount: recommended,
        _score: score,
      };
    })
    .filter((p) => p.edge > 0)
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

  const singleRows = enrichedSingles.map((p) => ({
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
    status: 'pending',
    is_parlay: false,
    parlay_legs: null,
    updated_at: now,
  }));

  const parlayRows = enrichedParlays.map((par) => ({
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
    status: 'pending',
    is_parlay: true,
    parlay_legs: par.parlay_legs,
    updated_at: now,
  }));

  const allRows = [...singleRows, ...parlayRows];

  let insertedCount = 0;
  let updatedCount = 0;

  if (allRows.length > 0) {
    // Look up existing pending picks (don't touch bet/skipped)
    const { data: existing } = await supabase
      .from('picks')
      .select('id, sport, home_team, away_team, pick, bet_type')
      .eq('status', 'pending');

    const keyOf = (r: { sport: string; home_team: string; away_team: string; pick: string; bet_type: string }) =>
      `${r.sport}|${r.home_team}|${r.away_team}|${r.pick}|${r.bet_type}`;

    const existingMap = new Map<string, string>();
    for (const e of existing ?? []) existingMap.set(keyOf(e), e.id);

    const toInsert: typeof allRows = [];
    const toUpdate: { id: string; row: (typeof allRows)[number] }[] = [];

    for (const row of allRows) {
      const id = existingMap.get(keyOf(row));
      if (id) toUpdate.push({ id, row });
      else toInsert.push(row);
    }

    if (toInsert.length > 0) {
      const { error: insErr } = await supabase.from('picks').insert(toInsert);
      if (insErr) {
        console.error('[generate-picks] insert failed', insErr);
        return NextResponse.json(
          { error: 'DB insert failed', detail: insErr.message },
          { status: 500 },
        );
      }
      insertedCount = toInsert.length;
    }

    for (const u of toUpdate) {
      const { id, row } = u;
      const updateFields: Record<string, unknown> = { ...row };
      delete updateFields.status;
      const { error: updErr } = await supabase.from('picks').update(updateFields).eq('id', id);
      if (updErr) {
        console.error('[generate-picks] update failed', updErr);
      } else {
        updatedCount++;
      }
    }
  }

  console.log(
    `[generate-picks] done in ${Date.now() - t0}ms inserted=${insertedCount} updated=${updatedCount}`,
  );

  return NextResponse.json({
    analyzed: games_to_analyze.length,
    total_available: totalAvailable,
    with_edge: enrichedSingles.length,
    parlays: enrichedParlays.length,
    inserted: insertedCount,
    updated: updatedCount,
    timestamp: now,
  });
}
