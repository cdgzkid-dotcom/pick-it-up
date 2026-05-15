/**
 * POST /api/bets/from-image
 *
 * Accepts a FormData body with an 'image' field (File).
 * Extracts the bet slip data with Claude Vision and matches legs
 * to existing pending picks. Returns a preview for user confirmation.
 * Does NOT insert anything — the confirm endpoint does that.
 */

import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { extractDrafteaBet } from '@/lib/vision-extract-bet';
import type { DrafteaLeg } from '@/lib/vision-extract-bet';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── Shared types (re-exported for UI imports) ──────────────────────────────

export interface PickCandidate {
  id: string;
  sport: string;
  game: string;
  home_team: string;
  away_team: string;
  pick: string;
  bet_type: string;
  odds_decimal: number;
  tier: string | null;
  recommended_amount: number;
}

export interface LegMatch {
  leg_index: number;
  pick: PickCandidate | null;
  /** screenshot.odds_decimal − pick.odds_decimal. Positive = screenshot better. */
  odds_diff: number | null;
}

// ── Fuzzy team-name matching ───────────────────────────────────────────────

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')  // strip accents
    .replace(/[^a-z0-9]/g, '');       // keep only alphanumeric
}

function legsMatch(leg: DrafteaLeg, pick: PickCandidate): boolean {
  // Split "América vs Chivas" → ["america", "chivas"]
  const legTeams = leg.teams
    .split(/\s+(?:vs\.?|@|contra)\s+/i)
    .map(norm)
    .filter((t) => t.length >= 3);

  const pickHome = norm(pick.home_team);
  const pickAway = norm(pick.away_team);

  for (const lt of legTeams) {
    if (
      pickHome.includes(lt) || lt.includes(pickHome) ||
      pickAway.includes(lt) || lt.includes(pickAway)
    ) {
      return true;
    }
  }
  return false;
}

// ── Handler ────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  // 1. Parse FormData
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Se esperaba FormData con campo "image"' }, { status: 400 });
  }

  const file = formData.get('image') as File | null;
  if (!file) {
    return NextResponse.json({ error: 'Campo "image" requerido' }, { status: 400 });
  }

  // 2. Validate type and size
  const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  if (!allowed.includes(file.type)) {
    return NextResponse.json(
      { error: 'Tipo de imagen no soportado. Usa JPG, PNG o WebP.' },
      { status: 415 },
    );
  }
  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json(
      { error: 'Imagen demasiado grande (máximo 10 MB).' },
      { status: 413 },
    );
  }

  // 3. Convert to base64
  const arrayBuffer = await file.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');
  const mediaType = file.type === 'image/jpg' ? 'image/jpeg' : file.type;

  // 4. Extract with Claude Vision
  let result: Awaited<ReturnType<typeof extractDrafteaBet>>;
  try {
    result = await extractDrafteaBet(base64, mediaType);
  } catch (e) {
    console.error('[from-image] extractDrafteaBet threw', e);
    return NextResponse.json(
      { error: 'Error al analizar la imagen con Claude. Intenta con otra foto.' },
      { status: 500 },
    );
  }

  const { extracted, usage } = result;

  // 5. Log usage (fire-and-forget — table might not exist on first deploy)
  const supabase = supabaseAdmin();
  void (async () => {
    try {
      await supabase.from('ai_usage_log').insert({
        task_type: 'vision_extract_bet',
        model: 'claude-sonnet-4-6',
        tokens_in: usage.tokens_in,
        tokens_out: usage.tokens_out,
        cost_usd: usage.cost_usd,
        success: extracted.is_draftea_betslip,
        confidence_level: extracted.confidence,
        metadata: {
          bet_type: extracted.bet_type,
          legs_count: extracted.legs.length,
          status: extracted.status,
        },
      });
    } catch (e) {
      console.warn('[from-image] ai_usage_log insert failed', e);
    }
  })();

  // 6. If not a Draftea ticket, return 422 immediately
  if (!extracted.is_draftea_betslip) {
    return NextResponse.json(
      {
        error:
          extracted.extraction_notes ||
          'No reconozco esto como un ticket de DRAFTEA. ¿Quizás es de Caliente u otra app?',
        extracted,
      },
      { status: 422 },
    );
  }

  // 7. Match legs to pending picks (last 7 days)
  const { data: pendingPicks } = await supabase
    .from('picks')
    .select('id, sport, game, home_team, away_team, pick, bet_type, odds_decimal, tier, recommended_amount')
    .eq('status', 'pending')
    .gt('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .order('created_at', { ascending: false });

  const picks = (pendingPicks ?? []) as PickCandidate[];

  const matches: LegMatch[] = extracted.legs.map((leg, idx) => {
    const match = picks.find((p) => legsMatch(leg, p)) ?? null;
    const oddsScreenshot = leg.odds_decimal;
    const oddsPick = match ? Number(match.odds_decimal) : null;
    return {
      leg_index: idx,
      pick: match,
      odds_diff:
        oddsPick !== null
          ? Math.round((oddsScreenshot - oddsPick) * 100) / 100
          : null,
    };
  });

  // 8. Validate math (payout ≈ wager × total_odds, 2% tolerance)
  let math_warning: string | null = null;
  const { wager_mxn, total_odds_decimal, potential_payout_mxn } = extracted;
  if (wager_mxn && total_odds_decimal && potential_payout_mxn) {
    const expected = wager_mxn * total_odds_decimal;
    const deviation = Math.abs(potential_payout_mxn - expected) / expected;
    if (deviation > 0.02) {
      math_warning =
        `Los números no cuadran exactamente: ` +
        `$${wager_mxn} × ${total_odds_decimal} = $${expected.toFixed(2)} ` +
        `pero el ticket muestra $${potential_payout_mxn}. Verifica antes de confirmar.`;
    }
  }

  return NextResponse.json({ extracted, matches, math_warning, usage });
}
