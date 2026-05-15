/**
 * POST /api/telegram/webhook
 *
 * Receives Telegram updates for the Pick It Up bot.
 * Returns HTTP 200 to Telegram immediately (< 200 ms) and runs all
 * heavy work — image download, Claude Vision, Supabase writes — inside
 * waitUntil() so Vercel keeps the function alive past the response.
 *
 * Supported flows:
 *   • message.photo  → sends "Analizando…", then edits that message
 *                      with the ticket preview + [✅ Confirmar] [❌ Cancelar].
 *   • callback_query → confirm stores the bet via /api/bets/from-image/confirm;
 *                      cancel deletes the pending session.
 *   • any other msg  → friendly prompt asking for a screenshot.
 */

import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { supabaseAdmin } from '@/lib/supabase';
import { extractDrafteaBet } from '@/lib/vision-extract-bet';
import { matchExtractedBetToPicks } from '@/lib/bet-matching';
import type { LegMatch } from '@/lib/bet-matching';
import type { DrafteaExtractedBet } from '@/lib/vision-extract-bet';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://pick-it-up.vercel.app';

// ── Minimal Telegram update types ──────────────────────────────────────────

interface TelegramPhotoSize {
  file_id: string;
  file_size?: number;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  photo?: TelegramPhotoSize[];
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  message?: { chat: { id: number }; message_id: number };
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

// ── Telegram API helpers ────────────────────────────────────────────────────

function token(): string {
  return process.env.TELEGRAM_BOT_TOKEN ?? '';
}

async function tgPost(method: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`https://api.telegram.org/bot${token()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Sends a message and returns the Telegram message_id (needed to edit it later). */
async function tgSendWithId(
  chatId: number,
  text: string,
  replyMarkup?: object,
): Promise<number | null> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  try {
    const r = await tgPost('sendMessage', body);
    if (!r.ok) return null;
    const data = (await r.json()) as { result?: { message_id?: number } };
    return data.result?.message_id ?? null;
  } catch (e) {
    console.error('[tg-webhook] sendMessage failed', e);
    return null;
  }
}

async function tgEdit(
  chatId: number,
  messageId: number,
  text: string,
  replyMarkup?: object,
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'Markdown',
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await tgPost('editMessageText', body).catch((e) =>
    console.error('[tg-webhook] editMessageText failed', e),
  );
}

async function tgAnswer(callbackQueryId: string, text?: string): Promise<void> {
  await tgPost('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  }).catch((e) => console.error('[tg-webhook] answerCallbackQuery failed', e));
}

async function tgGetFileUrl(fileId: string): Promise<string | null> {
  const t = token();
  if (!t) return null;
  const r = await fetch(
    `https://api.telegram.org/bot${t}/getFile?file_id=${encodeURIComponent(fileId)}`,
  );
  if (!r.ok) return null;
  const data = (await r.json()) as { result?: { file_path?: string } };
  const filePath = data.result?.file_path;
  if (!filePath) return null;
  return `https://api.telegram.org/file/bot${t}/${filePath}`;
}

// ── Message formatter ───────────────────────────────────────────────────────

function formatPreview(
  extracted: DrafteaExtractedBet,
  matches: LegMatch[],
  mathWarning: string | null,
): string {
  const lines: string[] = [];

  lines.push('📸 *Ticket Draftea detectado*');
  lines.push('');

  const confLabel =
    extracted.confidence === 'HIGH' ? '✅ alta' :
    extracted.confidence === 'MEDIUM' ? '⚠️ media' : '⚠️ baja';

  lines.push(`🎲 *${extracted.bet_type ?? 'Apuesta'}* · Confianza: ${confLabel}`);
  if (extracted.wager_mxn) lines.push(`💰 Apuesta: $${extracted.wager_mxn} MXN`);
  if (extracted.total_odds_decimal) lines.push(`📈 Momios: ${extracted.total_odds_decimal.toFixed(2)}x`);
  if (extracted.potential_payout_mxn) lines.push(`💵 Pago potencial: $${extracted.potential_payout_mxn} MXN`);
  if (extracted.status) lines.push(`🔖 Status: ${extracted.status}`);
  if (extracted.bet_id) lines.push(`🆔 ID: ${extracted.bet_id}`);
  lines.push('');

  lines.push('*Selecciones:*');
  extracted.legs.forEach((leg, idx) => {
    const match = matches.find((m) => m.leg_index === idx);
    const icon = match?.pick ? '✅' : '❓';
    const matchLabel = match?.pick
      ? ` ← ${match.pick.pick}`
      : ' _(sin match en picks pendientes)_';
    lines.push(`${icon} *${leg.selection}* @ ${leg.odds_decimal.toFixed(2)}${matchLabel}`);
    lines.push(`   ${leg.teams}`);
  });

  if (mathWarning) {
    lines.push('');
    lines.push(`⚠️ ${mathWarning}`);
  }

  lines.push('');
  lines.push('¿Registro esta apuesta?');
  return lines.join('\n');
}

// ── Confirm payload builder ─────────────────────────────────────────────────

/** Returns null for any string that is not a parseable date — prevents
 *  Postgres from receiving non-timestamptz values like "0h 48m". */
function safeIso(t: string | null): string | null {
  if (!t) return null;
  return isNaN(new Date(t).getTime()) ? null : t;
}

function buildConfirmPayload(extracted: DrafteaExtractedBet, matches: LegMatch[]) {
  return {
    bet_type: extracted.bet_type,
    total_odds_decimal: extracted.total_odds_decimal ?? 1,
    wager_mxn: extracted.wager_mxn ?? 0,
    potential_payout_mxn: extracted.potential_payout_mxn,
    potential_winnings_mxn: extracted.potential_winnings_mxn,
    status_draftea: extracted.status,
    bet_id_draftea: extracted.bet_id,
    placed_at: extracted.placed_at,
    legs: extracted.legs.map((leg, idx) => {
      const match = matches.find((m) => m.leg_index === idx);
      const pickOdds = match?.pick ? Number(match.pick.odds_decimal) : null;
      const oddsChanged =
        pickOdds !== null && Math.abs(leg.odds_decimal - pickOdds) > 0.005;
      return {
        sport: leg.sport,
        league: leg.league,
        teams: leg.teams,
        selection: leg.selection,
        market_type: leg.market_type,
        line: leg.line,
        odds_decimal: leg.odds_decimal,
        event_time: safeIso(leg.event_time),
        matched_pick_id: match?.pick?.id ?? null,
        odds_changed: oddsChanged,
        original_odds: pickOdds,
      };
    }),
  };
}

// ── Inline keyboard ─────────────────────────────────────────────────────────

function confirmKeyboard(sessionId: string) {
  return {
    inline_keyboard: [[
      { text: '✅ Confirmar y registrar', callback_data: `confirm:${sessionId}` },
      { text: '❌ Cancelar', callback_data: `cancel:${sessionId}` },
    ]],
  };
}

// ── Background handlers ─────────────────────────────────────────────────────

async function handlePhoto(chatId: number, fileId: string): Promise<void> {
  // Send "Analizando…" and capture message_id so we can edit it later
  const processingMsgId = await tgSendWithId(chatId, '🔍 Analizando tu ticket con Claude Vision…');

  // Edits the "Analizando…" message (or sends a new one if that failed)
  const finish = (text: string, keyboard?: object) =>
    processingMsgId
      ? tgEdit(chatId, processingMsgId, text, keyboard)
      : tgSendWithId(chatId, text, keyboard).then(() => undefined);

  // 1. Get download URL from Telegram
  const fileUrl = await tgGetFileUrl(fileId);
  if (!fileUrl) {
    await finish('⚠️ No pude acceder al archivo. Intenta enviarlo de nuevo.');
    return;
  }

  // 2. Download image
  let imageBuffer: Buffer;
  try {
    const imgRes = await fetch(fileUrl);
    if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`);
    imageBuffer = Buffer.from(await imgRes.arrayBuffer());
  } catch (e) {
    console.error('[tg-webhook] image download failed', e);
    await finish('⚠️ No pude descargar la imagen. Intenta de nuevo.');
    return;
  }

  // 3. Extract with Claude Vision
  let extracted: DrafteaExtractedBet;
  try {
    const base64 = imageBuffer.toString('base64');
    const result = await extractDrafteaBet(base64, 'image/jpeg');
    extracted = result.extracted;

    // Log usage (fire-and-forget)
    void (async () => {
      try {
        await supabaseAdmin().from('ai_usage_log').insert({
          task_type: 'vision_extract_bet_tg',
          model: 'claude-sonnet-4-6',
          tokens_in: result.usage.tokens_in,
          tokens_out: result.usage.tokens_out,
          cost_usd: result.usage.cost_usd,
          success: extracted.is_draftea_betslip,
          confidence_level: extracted.confidence,
          metadata: {
            bet_type: extracted.bet_type,
            legs_count: extracted.legs.length,
            status: extracted.status,
            source: 'telegram',
          },
        });
      } catch { /* non-critical */ }
    })();
  } catch (e) {
    console.error('[tg-webhook] extractDrafteaBet failed', e);
    await finish('⚠️ Error al analizar la imagen con Claude. Intenta con otra foto.');
    return;
  }

  if (!extracted.is_draftea_betslip) {
    const reason =
      extracted.extraction_notes ||
      'No parece ser un ticket de Draftea. ¿Es de Caliente u otra app?';
    await finish(`❓ *No reconocí este ticket.*\n\n${reason}\n\nIntenta con una foto más clara.`);
    return;
  }

  // Guard: confirm endpoint requires wager_mxn > 0 and total_odds_decimal > 1
  if (!extracted.wager_mxn || !extracted.total_odds_decimal) {
    await finish(
      `📸 Ticket detectado pero con datos incompletos.\n\nNo pude leer el monto o los momios. Usa la web: ${APP_URL}/tracker`,
    );
    return;
  }

  // 4. Match legs to pending picks
  const { matches, math_warning } = await matchExtractedBetToPicks(extracted);

  // 5. Store confirm payload in Supabase
  const confirmPayload = buildConfirmPayload(extracted, matches);
  const { data: session, error: sessionErr } = await supabaseAdmin()
    .from('telegram_sessions')
    .insert({ chat_id: chatId, payload: confirmPayload })
    .select('id')
    .single();

  if (sessionErr || !session) {
    console.error('[tg-webhook] session insert failed', sessionErr);
    await finish('⚠️ Error interno. Intenta de nuevo en unos segundos.');
    return;
  }

  // 6. Edit "Analizando…" → preview + buttons
  const previewText = formatPreview(extracted, matches, math_warning);
  await finish(previewText, confirmKeyboard(session.id as string));
}

async function handleCallback(cq: TelegramCallbackQuery): Promise<void> {
  const chatId = cq.message?.chat.id;
  const messageId = cq.message?.message_id;
  const cbData = cq.data ?? '';

  if (!chatId || !messageId) {
    await tgAnswer(cq.id);
    return;
  }

  const colonIdx = cbData.indexOf(':');
  const action = cbData.slice(0, colonIdx);
  const sessionId = cbData.slice(colonIdx + 1);

  const supabase = supabaseAdmin();

  if (action === 'cancel') {
    await supabase.from('telegram_sessions').delete().eq('id', sessionId);
    await tgAnswer(cq.id, 'Cancelado');
    await tgEdit(chatId, messageId, '❌ *Registro cancelado.*');
    return;
  }

  if (action === 'confirm') {
    const { data: session } = await supabase
      .from('telegram_sessions')
      .select('payload')
      .eq('id', sessionId)
      .single();

    if (!session) {
      await tgAnswer(cq.id, 'Sesión expirada o ya usada');
      await tgEdit(
        chatId,
        messageId,
        '⚠️ Esta confirmación ya expiró o fue usada. Manda el screenshot de nuevo.',
      );
      return;
    }

    // Delete immediately to prevent double-submit
    await supabase.from('telegram_sessions').delete().eq('id', sessionId);

    const confirmRes = await fetch(`${APP_URL}/api/bets/from-image/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(session.payload),
    });

    const confirmBody = (await confirmRes.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      bet_id?: string;
      bankroll_current?: number | null;
      historical?: boolean;
    };

    if (!confirmRes.ok) {
      const errMsg = confirmBody.error ?? 'Error desconocido';
      await tgAnswer(cq.id, '❌ Error al registrar');
      await tgEdit(chatId, messageId, `❌ *No se pudo registrar:*\n${errMsg}`);
      return;
    }

    const bankrollLine = confirmBody.bankroll_current
      ? `\n💰 Bankroll: $${Math.round(confirmBody.bankroll_current)} MXN`
      : '';
    const historicalNote = confirmBody.historical
      ? '\n📚 _Apuesta ya liquidada — registrada en historial._'
      : '';

    await tgAnswer(cq.id, '✅ Registrado');
    await tgEdit(
      chatId,
      messageId,
      `✅ *Apuesta registrada*${bankrollLine}${historicalNote}`,
    );
    return;
  }

  await tgAnswer(cq.id);
}

// ── Main handler ────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const ok = () => NextResponse.json({ ok: true });

  // ── Callback query (button press) ────────────────────────────────────────
  if (update.callback_query) {
    waitUntil(handleCallback(update.callback_query));
    return ok();
  }

  // ── Message ───────────────────────────────────────────────────────────────
  const message = update.message;
  if (!message) return ok();

  const chatId = message.chat.id;

  if (!message.photo || message.photo.length === 0) {
    waitUntil(
      tgSendWithId(
        chatId,
        'Mándame un screenshot de tu ticket de Draftea para registrarlo automáticamente. 📸',
      ),
    );
    return ok();
  }

  // Highest resolution = last element in the array
  const bestPhoto = message.photo[message.photo.length - 1];
  waitUntil(handlePhoto(chatId, bestPhoto.file_id));
  return ok();
}
