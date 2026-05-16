/**
 * Claude Vision extraction for Draftea bet slips.
 *
 * Sends a base64-encoded image to claude-sonnet-4-6 and parses the
 * structured JSON response. The caller is responsible for logging
 * ai_usage_log (fire-and-forget in the API route).
 */

import Anthropic from '@anthropic-ai/sdk';

// ── Types ──────────────────────────────────────────────────────────────────

export interface DrafteaLeg {
  sport: string;                  // canonical: 'MLB', 'NBA', 'NHL', 'NFL', 'Fútbol', 'Liga MX', 'UFC', …
  league: string | null;          // 'Liga MX', 'Champions League', …
  teams: string;                  // 'América vs Chivas'
  selection: string;              // 'América gana', 'Más de 2.5 goles', …
  market_type: string;            // 'ganador', 'handicap', 'total', 'jugador_props'
  line: string | null;            // '-1.5', 'Más 2.5', null for ML
  odds_decimal: number;           // ALWAYS decimal European (e.g. 1.85)
  event_time: string | null;      // ISO 8601 when available
}

export interface DrafteaExtractedBet {
  is_draftea_betslip: boolean;
  bet_type: 'SENCILLA' | 'COMBINADA' | 'SISTEMA' | 'SGP' | null;
  total_odds_decimal: number | null;
  wager_mxn: number | null;
  potential_payout_mxn: number | null;    // wager + winnings (full payout)
  potential_winnings_mxn: number | null;  // net profit only
  status: 'PENDIENTE' | 'GANADA' | 'PERDIDA' | 'CASHOUT' | 'ANULADA' | null;
  bet_id: string | null;                  // Draftea ticket reference code
  placed_at: string | null;              // ISO 8601
  legs: DrafteaLeg[];
  boost_applied: { type: string | null; description: string | null } | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  extraction_notes: string;
}

export interface ExtractionResult {
  extracted: DrafteaExtractedBet;
  usage: { tokens_in: number; tokens_out: number; cost_usd: number };
}

// ── Vision system prompt ────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Eres un extractor de datos de tickets de apuestas de DRAFTEA (sportsbook mexicana). Analiza la imagen y devuelve ÚNICAMENTE un objeto JSON válido, sin markdown ni explicaciones adicionales.

REGLAS CRÍTICAS:
- DRAFTEA usa momios DECIMALES europeos (1.85, 2.50, 3.10). Si ves 1.85 junto a un pick, ese es el momio decimal. NUNCA conviertas a americano.
- Los montos están en MXN (pesos mexicanos) salvo indicación contraria.
- Si la imagen es de otra sportsbook (Caliente, Codere, Strendus, Betway, Winpot, Playdoit), devuelve is_draftea_betslip: false.
- Si la imagen no es un ticket de apuestas, devuelve is_draftea_betslip: false.
- Extrae TODOS los legs/selecciones aunque sean muchos.
- Para combinadas (parlays), extrae el momio total Y los momios individuales de cada leg.
- potential_payout_mxn = importe total que recibirías (incluye la apuesta). potential_winnings_mxn = solo la ganancia neta.
- VALORES CANÓNICOS para sport: usa SIEMPRE "MLB" (no "Béisbol"), "NBA", "NHL", "NFL", "Fútbol", "Liga MX", "Premier League", "UFC". Si el ticket muestra "Béisbol" → usa "MLB". Si muestra "Baloncesto" → usa "NBA". Si muestra "Hockey" → usa "NHL".
- VALORES CANÓNICOS para market_type: usa SIEMPRE "ML" para apuestas de ganador directo/moneyline (no "Moneyline", no "Moneyline (PA – Para Ganar)", no "ganador"). Usa "Spread" para handicap/run-line. Usa "Total" para over/under. Usa "Props" para props de jugador.

FORMATO JSON EXACTO:
{
  "is_draftea_betslip": boolean,
  "bet_type": "SENCILLA"|"COMBINADA"|"SISTEMA"|"SGP"|null,
  "total_odds_decimal": number|null,
  "wager_mxn": number|null,
  "potential_payout_mxn": number|null,
  "potential_winnings_mxn": number|null,
  "status": "PENDIENTE"|"GANADA"|"PERDIDA"|"CASHOUT"|"ANULADA"|null,
  "bet_id": string|null,
  "placed_at": string|null,
  "legs": [
    {
      "sport": string,
      "league": string|null,
      "teams": string,
      "selection": string,
      "market_type": string,
      "line": string|null,
      "odds_decimal": number,
      "event_time": string|null
    }
  ],
  "boost_applied": {"type": string|null, "description": string|null}|null,
  "confidence": "HIGH"|"MEDIUM"|"LOW",
  "extraction_notes": string
}

confidence: HIGH si todo es legible, MEDIUM si hay partes borrosas pero los datos críticos son claros, LOW si la imagen está muy borrosa o incompleta.`;

// ── Extraction function ─────────────────────────────────────────────────────

export async function extractDrafteaBet(
  imageBase64: string,
  mediaType: string = 'image/jpeg',
): Promise<ExtractionResult> {
  const client = new Anthropic();

  const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
  type MediaType = (typeof validTypes)[number];
  const safeMediaType: MediaType = validTypes.includes(mediaType as MediaType)
    ? (mediaType as MediaType)
    : 'image/jpeg';

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 800,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: safeMediaType,
              data: imageBase64,
            },
          },
          {
            type: 'text',
            text: 'Extrae los datos de este ticket. Devuelve solo el JSON, sin markdown.',
          },
        ],
      },
    ],
  });

  const raw = response.content[0]?.type === 'text' ? response.content[0].text.trim() : '';

  // Strip any accidental markdown code fence
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  let extracted: DrafteaExtractedBet;
  try {
    extracted = JSON.parse(cleaned) as DrafteaExtractedBet;
  } catch (e) {
    // Claude returned non-JSON — treat as unrecognized image
    console.error('[vision-extract-bet] JSON parse failed. Raw:', raw.slice(0, 300));
    extracted = {
      is_draftea_betslip: false,
      bet_type: null,
      total_odds_decimal: null,
      wager_mxn: null,
      potential_payout_mxn: null,
      potential_winnings_mxn: null,
      status: null,
      bet_id: null,
      placed_at: null,
      legs: [],
      boost_applied: null,
      confidence: 'LOW',
      extraction_notes: `JSON parse failed: ${String(e).slice(0, 100)}`,
    };
  }

  // Ensure legs is always an array
  if (!Array.isArray(extracted.legs)) extracted.legs = [];

  // Clamp odds to a sane range (1.01–200) to catch hallucinations
  extracted.legs = extracted.legs.map((leg) => ({
    ...leg,
    odds_decimal:
      typeof leg.odds_decimal === 'number' &&
      leg.odds_decimal >= 1.01 &&
      leg.odds_decimal <= 200
        ? leg.odds_decimal
        : 1.0,
  }));

  // Token cost: claude-sonnet-4-6 → $3/M input, $15/M output
  const tokens_in = response.usage.input_tokens;
  const tokens_out = response.usage.output_tokens;
  const cost_usd = (tokens_in * 3 + tokens_out * 15) / 1_000_000;

  return { extracted, usage: { tokens_in, tokens_out, cost_usd } };
}
