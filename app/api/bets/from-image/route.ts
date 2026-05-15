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
import { matchExtractedBetToPicks } from '@/lib/bet-matching';
import type { PickCandidate, LegMatch } from '@/lib/bet-matching';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Re-export for any UI imports that reference these types from this path
export type { PickCandidate, LegMatch };

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

  // 7. Match legs to pending picks + math validation
  const { matches, math_warning } = await matchExtractedBetToPicks(extracted);

  return NextResponse.json({ extracted, matches, math_warning, usage });
}
