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
import type { Tier } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const RequestSchema = z.object({
  sports: z.array(z.string()).min(1),
});

const ClaudeLegSchema = z.object({
  pick: z.string(),
  odds_decimal: z.coerce.number(),
});

const ClaudePickSchema = z.object({
  sport: z.string(),
  league: z.string().optional().nullable(),
  game: z.string(),
  home_team: z.string(),
  away_team: z.string(),
  home_team_abbr: z.string().optional().nullable(),
  away_team_abbr: z.string().optional().nullable(),
  pick: z.string(),
  pick_detail: z.string().optional().nullable(),
  bet_type: z.string(),
  odds_decimal: z.coerce.number(),
  best_odds: z.coerce.number().optional().nullable(),
  best_odds_source: z.string().optional().nullable(),
  odds_comparison: z.record(z.string(), z.coerce.number()).optional().nullable(),
  confidence: z.coerce.number().int().min(0).max(100),
  tier: z.enum(['lock', 'strong', 'value', 'parlay']).optional().nullable(),
  real_probability: z.coerce.number().min(0).max(1),
  analysis: z.string().optional().nullable(),
  risk_factors: z.string().optional().nullable(),
  injuries: z.string().optional().nullable(),
  key_stats: z.record(z.string(), z.unknown()).optional().nullable(),
  early_payout_eligible: z.coerce.boolean().optional(),
  early_payout_threshold: z.string().optional().nullable(),
  is_parlay: z.coerce.boolean().optional(),
});

const ClaudeParlaySchema = z.object({
  pick: z.string(),
  bet_type: z.string().default('Parlay'),
  odds_decimal: z.coerce.number(),
  real_probability: z.coerce.number().min(0).max(1),
  confidence: z.coerce.number().int().min(0).max(100).optional(),
  analysis: z.string().optional().nullable(),
  parlay_legs: z.array(ClaudeLegSchema),
});

const ClaudeResponseSchema = z.object({
  summary: z
    .object({
      analyzed: z.coerce.number().int().optional(),
      with_edge: z.coerce.number().int().optional(),
      discarded: z.coerce.number().int().optional(),
    })
    .optional(),
  picks: z.array(ClaudePickSchema).default([]),
  parlays_sugeridos: z.array(ClaudeParlaySchema).optional().default([]),
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

  const games = await fetchGames(parsed.data.sports);
  if (games.length === 0) {
    return NextResponse.json({
      summary: { analyzed: 0, with_edge: 0, discarded: 0 },
      inserted: 0,
      picks: [],
      message: 'No hay juegos con momios disponibles en los deportes seleccionados',
    });
  }

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
  try {
    const claudeOutput = await callClaudeJson(
      PICK_GENERATION_SYSTEM,
      buildPickGenerationUserPrompt(games),
    );
    const validated = ClaudeResponseSchema.safeParse(claudeOutput);
    if (!validated.success) {
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
    return NextResponse.json(
      { error: 'Claude request failed', detail: (err as Error).message },
      { status: 502 },
    );
  }

  const teamAbbrByName = new Map<string, string>();
  for (const g of games) {
    if (g.home_team_abbr) teamAbbrByName.set(g.home_team.toLowerCase(), g.home_team_abbr);
    if (g.away_team_abbr) teamAbbrByName.set(g.away_team.toLowerCase(), g.away_team_abbr);
  }
  const lookupAbbr = (name: string) => teamAbbrByName.get(name.toLowerCase()) ?? null;

  const enriched = raw.picks
    .map((p) => {
      const implied = impliedProbability(p.odds_decimal);
      const e = edgeOf(p.real_probability, p.odds_decimal);
      const tier: Tier =
        p.tier ?? tierFromConfidence(p.confidence);
      const adjustedTier = tierForOdds(tier, p.odds_decimal);
      const recommended = recommendedAmount(adjustedTier, unit, p.odds_decimal);
      const score = adjustedEdgeScore(p.real_probability, p.odds_decimal);
      const homeAbbr = (p.home_team_abbr ?? lookupAbbr(p.home_team))?.toLowerCase() ?? null;
      const awayAbbr = (p.away_team_abbr ?? lookupAbbr(p.away_team))?.toLowerCase() ?? null;
      return {
        ...p,
        home_team_abbr: homeAbbr,
        away_team_abbr: awayAbbr,
        implied_probability: implied,
        edge: e,
        tier: adjustedTier,
        recommended_amount: recommended,
        _score: score,
      };
    })
    .filter((p) => p.edge > 0)
    .sort((a, b) => b._score - a._score);

  const enrichedParlays = raw.parlays_sugeridos.map((par) => {
    const implied = impliedProbability(par.odds_decimal);
    const e = par.real_probability - implied;
    const conf = par.confidence ?? 50;
    return {
      ...par,
      implied_probability: implied,
      edge: e,
      confidence: conf,
      recommended_amount: recommendedAmount('parlay', unit, par.odds_decimal),
    };
  });

  const rowsToInsert = [
    ...enriched.map((p) => ({
      sport: p.sport,
      league: p.league ?? null,
      game: p.game,
      home_team: p.home_team,
      away_team: p.away_team,
      home_team_abbr: p.home_team_abbr,
      away_team_abbr: p.away_team_abbr,
      pick: p.pick,
      pick_detail: p.pick_detail ?? null,
      bet_type: p.bet_type,
      odds_decimal: p.odds_decimal,
      best_odds: p.best_odds ?? p.odds_decimal,
      best_odds_source: p.best_odds_source ?? null,
      odds_comparison: p.odds_comparison ?? null,
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
    })),
    ...enrichedParlays.map((par) => ({
      sport: 'Parlay',
      league: null,
      game: par.pick,
      home_team: '',
      away_team: '',
      home_team_abbr: null,
      away_team_abbr: null,
      pick: par.pick,
      pick_detail: null,
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
      analysis: par.analysis ?? null,
      risk_factors: null,
      injuries: null,
      key_stats: null,
      early_payout_eligible: false,
      early_payout_threshold: null,
      status: 'pending',
      is_parlay: true,
      parlay_legs: par.parlay_legs,
    })),
  ];

  let inserted: unknown[] = [];
  if (rowsToInsert.length > 0) {
    const { data, error } = await supabase
      .from('picks')
      .insert(rowsToInsert)
      .select();
    if (error) {
      return NextResponse.json(
        { error: 'DB insert failed', detail: error.message },
        { status: 500 },
      );
    }
    inserted = data ?? [];
  }

  return NextResponse.json({
    summary: {
      analyzed: raw.summary?.analyzed ?? games.length,
      with_edge: enriched.length,
      discarded: (raw.summary?.discarded ?? Math.max(0, games.length - enriched.length)),
      parlays: enrichedParlays.length,
    },
    inserted: inserted.length,
    picks: inserted,
  });
}
