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
 *   • callback_query → confirm atomically consumes the session (DELETE …
 *                      RETURNING) and stores the bet via
 *                      /api/bets/from-image/confirm; cancel deletes it.
 *   • /start, /help  → usage text.  /status → bankroll + pending bets.
 *   • any other msg  → friendly prompt asking for a screenshot.
 *
 * Every update_id is recorded in data_cache (insert-only, 24 h TTL) so a
 * Telegram retry of an already-accepted update is acked and ignored.
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
  try {
    const r = await tgPost('editMessageText', body);
    if (r.ok) return;
    // Most common failure: Markdown parse error from an unescaped `_`/`*` in
    // dynamic text (error messages, team names). Retry as plain text so the
    // user never gets stuck on "Analizando…".
    const detail = await r.text().catch(() => '');
    console.error('[tg-webhook] editMessageText failed', r.status, detail);
    delete body.parse_mode;
    await tgPost('editMessageText', body);
  } catch (e) {
    console.error('[tg-webhook] editMessageText failed', e);
  }
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
  if (extracted.potential_winnings_mxn) lines.push(`💵 Ganancia: $${extracted.potential_winnings_mxn} MXN`);
  if (extracted.potential_payout_mxn) lines.push(`💰 Pago total: $${extracted.potential_payout_mxn} MXN`);
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
        const { error: usageErr } = await supabaseAdmin().from('ai_usage_log').insert({
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
        if (usageErr) console.warn('[tg-webhook] ai_usage_log insert failed', usageErr);
      } catch (e) {
        console.warn('[tg-webhook] ai_usage_log insert threw', e);
      }
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

  // 4. Match legs to pending picks (queries picks — may throw on DB error)
  let matches: LegMatch[];
  let mathWarning: string | null;
  try {
    const m = await matchExtractedBetToPicks(extracted);
    matches = m.matches;
    mathWarning = m.math_warning;
  } catch (e) {
    console.error('[tg-webhook] matchExtractedBetToPicks failed', e);
    await finish('⚠️ Error interno al buscar picks pendientes. Intenta de nuevo en unos segundos.');
    return;
  }

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
  const previewText = formatPreview(extracted, matches, mathWarning);
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
    const { error: cancelErr } = await supabase
      .from('telegram_sessions')
      .delete()
      .eq('id', sessionId);
    if (cancelErr) {
      console.error('[tg-webhook] session cancel delete failed', cancelErr);
      await tgAnswer(cq.id, '⚠️ Error interno al cancelar');
      await tgEdit(chatId, messageId, '⚠️ Error interno al cancelar. Intenta de nuevo.');
      return;
    }
    await tgAnswer(cq.id, 'Cancelado');
    await tgEdit(chatId, messageId, '❌ *Registro cancelado.*');
    return;
  }

  if (action === 'confirm') {
    // Atomically CONSUME the session: DELETE … RETURNING. Exactly one caller
    // gets the row back; a double-click (or a concurrent retry) sees zero rows
    // and bails out, so the bet can never be placed twice from one preview.
    const { data: consumed, error: consumeErr } = await supabase
      .from('telegram_sessions')
      .delete()
      .eq('id', sessionId)
      .select('payload');

    if (consumeErr) {
      console.error('[tg-webhook] session consume failed', consumeErr);
      await tgAnswer(cq.id, '⚠️ Error interno');
      await tgEdit(
        chatId,
        messageId,
        '⚠️ Error interno al leer la sesión. Intenta confirmar de nuevo en unos segundos.',
      );
      return;
    }

    const session = consumed?.[0] as { payload: unknown } | undefined;
    if (!session) {
      // Already consumed by a previous click (its own result will land on
      // this message), or expired/cleaned up. Only a toast — no edit, so we
      // never clobber the in-flight result of the first click.
      await tgAnswer(cq.id, 'Ya procesado o sesión expirada');
      return;
    }

    // Internal call to the confirm endpoint. It has no auth of its own (only
    // the kill-switch gate), so no token is needed; if Vercel Deployment
    // Protection is enabled, forward the automation bypass secret.
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    if (bypass) headers['x-vercel-protection-bypass'] = bypass;

    let confirmRes: Response;
    try {
      confirmRes = await fetch(`${APP_URL}/api/bets/from-image/confirm`, {
        method: 'POST',
        headers,
        body: JSON.stringify(session.payload),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[tg-webhook] confirm fetch failed', e);
      await tgAnswer(cq.id, '❌ Error al registrar');
      await tgEdit(
        chatId,
        messageId,
        `❌ *No se pudo registrar:* error de red al llamar al servidor (${msg}).\n\nNo pude confirmar si quedó registrada. Revisa con /status antes de reenviar el screenshot.`,
      );
      return;
    }

    let confirmBody: {
      ok?: boolean;
      error?: string;
      bet_id?: string;
      bankroll_current?: number | null;
      historical?: boolean;
    } = {};
    try {
      confirmBody = (await confirmRes.json()) as typeof confirmBody;
    } catch (e) {
      console.error('[tg-webhook] confirm response not JSON', confirmRes.status, e);
    }

    if (!confirmRes.ok) {
      const errMsg = confirmBody.error ?? `Error desconocido (HTTP ${confirmRes.status})`;
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

// ── Text commands ───────────────────────────────────────────────────────────

const HELP_TEXT =
  '👋 *Pick It Up bot*\n\n' +
  'Mándame un *screenshot de tu ticket de Draftea* y lo leo con Claude Vision: ' +
  'te muestro un resumen y con un botón lo registro como apuesta (y descuento el bankroll si está pendiente).\n\n' +
  'Comandos:\n' +
  '• /status — bankroll actual y apuestas pendientes\n' +
  '• /help — este mensaje\n\n' +
  `Web: ${APP_URL}/tracker`;

async function handleStatus(chatId: number): Promise<void> {
  const supabase = supabaseAdmin();

  const [settingsRes, pendingRes] = await Promise.all([
    supabase.from('settings').select('bankroll_current').eq('id', 1).maybeSingle(),
    supabase.from('bets').select('id', { count: 'exact', head: true }).eq('result', 'pending'),
  ]);

  if (settingsRes.error || pendingRes.error) {
    console.error('[tg-webhook] /status query failed', settingsRes.error ?? pendingRes.error);
    await tgSendWithId(chatId, '⚠️ No pude leer el estado ahora mismo. Intenta en unos segundos.');
    return;
  }

  const bankroll = settingsRes.data?.bankroll_current;
  const bankrollLine =
    bankroll != null ? `💰 Bankroll: $${Math.round(Number(bankroll))} MXN` : '💰 Bankroll: _sin configurar_';
  const pendingCount = pendingRes.count ?? 0;

  await tgSendWithId(
    chatId,
    `📊 *Estado*\n${bankrollLine}\n⏳ Apuestas pendientes: ${pendingCount}`,
  );
}

async function handleText(chatId: number, text: string): Promise<void> {
  // "/status@PickItUpBot arg" → "/status"
  const command = text.trim().split(/\s+/)[0]?.split('@')[0]?.toLowerCase() ?? '';

  switch (command) {
    case '/start':
    case '/help':
      await tgSendWithId(chatId, HELP_TEXT);
      return;
    case '/status':
      await handleStatus(chatId);
      return;
    default:
      await tgSendWithId(
        chatId,
        'Mándame un screenshot de tu ticket de Draftea para registrarlo automáticamente. 📸\n\n/help para más info.',
      );
  }
}

// ── update_id dedup ─────────────────────────────────────────────────────────

/**
 * Telegram retries an update until it gets a 200. Since we ack in < 200 ms
 * but the heavy work (Claude Vision, bankroll debit) runs in waitUntil, a
 * retry would re-run everything. Insert-only (no upsert) on data_cache:
 * a 23505 unique violation means this update was already accepted.
 * Any other failure is logged and the update is processed anyway — the
 * dedup guard must never take the bot down.
 */
async function isDuplicateUpdate(updateId: number): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin().from('data_cache').insert({
      cache_key: `tg:update:${updateId}`,
      data: { seen: true },
      expires_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    });
    if (!error) return false;
    if (error.code === '23505') return true;
    console.warn('[tg-webhook] update dedup insert failed — processing anyway', error);
    return false;
  } catch (e) {
    console.warn('[tg-webhook] update dedup threw — processing anyway', e);
    return false;
  }
}

// ── Main handler ────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (
    webhookSecret &&
    req.headers.get('x-telegram-bot-api-secret-token') !== webhookSecret
  ) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!webhookSecret) {
    console.warn('[webhook] TELEGRAM_WEBHOOK_SECRET not set — accepting unauthenticated updates');
  }

  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const ok = () => NextResponse.json({ ok: true });
  const ignoredChat = () =>
    NextResponse.json({ ok: true, ignored: 'chat_not_allowed' });
  const allowedChatId = Number(process.env.TELEGRAM_CHAT_ID);

  // ── Chat gate (both update kinds) ─────────────────────────────────────────
  const chatId = update.callback_query
    ? update.callback_query.message?.chat.id
    : update.message?.chat.id;
  if (chatId === undefined) return ok(); // nothing we handle (edited msg, etc.)
  if (chatId !== allowedChatId) return ignoredChat();

  // ── update_id dedup (after secret + chat validation) ──────────────────────
  if (typeof update.update_id === 'number' && (await isDuplicateUpdate(update.update_id))) {
    return NextResponse.json({ ok: true, ignored: 'duplicate' });
  }

  // Background work must never reject silently: a rejected promise inside
  // waitUntil is invisible to the user. The handlers report to Telegram
  // themselves; this is the last-resort log.
  const background = (label: string, p: Promise<void>) =>
    waitUntil(p.catch((e) => console.error(`[tg-webhook] ${label} crashed`, e)));

  // ── Callback query (button press) ────────────────────────────────────────
  if (update.callback_query) {
    background('handleCallback', handleCallback(update.callback_query));
    return ok();
  }

  // ── Message ───────────────────────────────────────────────────────────────
  const message = update.message;
  if (!message) return ok();

  if (!message.photo || message.photo.length === 0) {
    background('handleText', handleText(chatId, message.text ?? ''));
    return ok();
  }

  // Highest resolution = last element in the array
  const bestPhoto = message.photo[message.photo.length - 1];
  background('handlePhoto', handlePhoto(chatId, bestPhoto.file_id));
  return ok();
}
