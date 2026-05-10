// Telegram bot wrapper for Pick It Up notifications.
// Token + chat id come from env. Uses Markdown legacy parse mode (the simpler
// variant — no need to escape every punctuation character like MarkdownV2).

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://pick-it-up.vercel.app';

interface SendOptions {
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML' | null;
  disableLinkPreview?: boolean;
}

export async function sendTelegramMessage(
  text: string,
  opts: SendOptions = {},
): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('[telegram] env vars missing — skipping send');
    return { ok: false, error: 'env_missing' };
  }

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    disable_web_page_preview: opts.disableLinkPreview ?? true,
  };
  if (opts.parseMode !== null) body.parse_mode = opts.parseMode ?? 'Markdown';

  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error(`[telegram] send failed (${r.status}): ${detail}`);
      return { ok: false, error: `http_${r.status}` };
    }
    return { ok: true };
  } catch (e) {
    console.error('[telegram] send threw', e);
    return { ok: false, error: (e as Error).message };
  }
}

interface PickForMessage {
  tier?: string | null;
  confidence?: number | null;
  real_probability?: number | null;
  pick: string;
  bet_type: string;
  odds_decimal: number;
  edge?: number | null;
  recommended_amount?: number | null;
  kelly_fraction?: number | null;
  trap_warning?: string | null;
  analysis?: string | null;
  is_parlay?: boolean;
}

const TIER_EMOJI: Record<string, string> = {
  lock: '🔒',
  strong: '✅',
  value: '⚠️',
  parlay: '🎯',
};

function tierLabelShort(tier?: string | null): string {
  if (!tier) return '';
  const e = TIER_EMOJI[tier] ?? '';
  return `${e} ${tier.toUpperCase()}`;
}

function oneLineSummary(analysis?: string | null): string {
  if (!analysis) return '';
  const first = analysis.split(/[\n\.]/).map((s) => s.trim()).find((s) => s.length > 0);
  if (!first) return '';
  return first.length > 110 ? first.slice(0, 107) + '…' : first;
}

function formatTimeMx(iso?: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('es-MX', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Mexico_City',
  });
}

export function formatPicksMessage(
  picks: PickForMessage[],
  parlays: PickForMessage[],
  gameStartTime?: string | null,
): string {
  const lines: string[] = [];
  const total = picks.length + parlays.length;
  lines.push(`🎯 *PICK IT UP* — ${total} pick${total === 1 ? '' : 's'} listo${total === 1 ? '' : 's'}`);
  lines.push('');

  picks.forEach((p, i) => {
    const conf = p.confidence != null ? ` ${Math.round(p.confidence)}%` : '';
    const realProb =
      p.real_probability != null
        ? ` · Prob ganar: ${Math.round(p.real_probability * 100)}%`
        : '';
    const edge = p.edge != null ? ` · Edge: ${p.edge >= 0 ? '+' : ''}${(p.edge * 100).toFixed(1)}%` : '';
    const stake = p.recommended_amount != null ? Math.round(p.recommended_amount) : 0;
    const win = stake > 0 ? Math.round(stake * (p.odds_decimal - 1)) : 0;
    const kelly = p.kelly_fraction != null ? ` (Kelly ${(p.kelly_fraction * 100).toFixed(1)}%)` : '';
    const trapInline = p.trap_warning ? ' · ⚠️ TRAMPA DETECTADA' : '';
    lines.push(`${i + 1}. ${tierLabelShort(p.tier)}${conf}${realProb}${trapInline} · *${p.pick}*`);
    lines.push(`   📊 Momio: ${p.odds_decimal.toFixed(2)}${edge}`);
    if (stake > 0) lines.push(`   💰 Meter: $${stake}${kelly} → Ganas: $${win}`);
    if (p.trap_warning) lines.push(`   ⚠️ ${p.trap_warning}`);
    const summary = oneLineSummary(p.analysis);
    if (summary) lines.push(`   📋 ${summary}`);
    lines.push('');
  });

  parlays.forEach((par) => {
    const stake = par.recommended_amount != null ? Math.round(par.recommended_amount) : 0;
    const win = stake > 0 ? Math.round(stake * (par.odds_decimal - 1)) : 0;
    const kelly = par.kelly_fraction != null ? ` (Kelly ${(par.kelly_fraction * 100).toFixed(1)}%)` : '';
    lines.push(`🎯 *PARLAY*: ${par.pick} @ ${par.odds_decimal.toFixed(2)}`);
    if (stake > 0) lines.push(`   💰 Meter: $${stake}${kelly} → Ganas: $${win}`);
    lines.push('');
  });

  if (gameStartTime) {
    lines.push(`⏰ Juego empieza a las ${formatTimeMx(gameStartTime)}`);
  }
  lines.push(`🔗 ${APP_URL}/picks`);
  return lines.join('\n');
}

interface MCSummary {
  profit_probability: number;
  expected_value: number;
  worst_case_5p: number;
  best_case_95p: number;
}

export function formatMonteCarloLines(mc: MCSummary): string[] {
  const lines: string[] = [];
  lines.push('📊 *Simulación 10K escenarios*');
  lines.push(`✅ Prob de profit: ${Math.round(mc.profit_probability * 100)}%`);
  lines.push(`💰 Ganancia esperada: ${mc.expected_value >= 0 ? '+' : ''}$${Math.round(mc.expected_value)}`);
  lines.push(`📉 Peor caso (5%): $${Math.round(mc.worst_case_5p)}`);
  lines.push(`📈 Mejor caso (95%): +$${Math.round(mc.best_case_95p)}`);
  return lines;
}

interface ResolutionForMessage {
  pick: string;
  result: 'win' | 'loss';
  pl: number;
  is_parlay?: boolean;
}

interface ResultsContext {
  bankrollCurrent?: number;
  todayPl?: number;
  record?: { wins: number; losses: number };
  roi?: number;
}

export function formatResultsMessage(
  resolutions: ResolutionForMessage[],
  ctx: ResultsContext = {},
): string {
  const lines: string[] = [];
  lines.push('📊 *RESULTADOS*');
  lines.push('');
  for (const r of resolutions) {
    const emoji = r.is_parlay ? '🎯' : r.result === 'win' ? '✅' : '❌';
    const verb = r.result === 'win' ? 'GANÓ' : 'PERDIÓ';
    const sign = r.pl >= 0 ? '+' : '-';
    lines.push(`${emoji} ${r.pick} — ${verb} ${sign}$${Math.abs(Math.round(r.pl))}`);
  }
  lines.push('');
  if (ctx.bankrollCurrent != null) {
    const todayLine =
      ctx.todayPl != null
        ? ` (${ctx.todayPl >= 0 ? '+' : ''}$${Math.round(ctx.todayPl)} hoy)`
        : '';
    lines.push(`💰 Bankroll: $${Math.round(ctx.bankrollCurrent)}${todayLine}`);
  }
  if (ctx.record && ctx.roi != null) {
    lines.push(
      `📈 Record: ${ctx.record.wins}W-${ctx.record.losses}L · ROI: ${ctx.roi >= 0 ? '+' : ''}${ctx.roi.toFixed(1)}%`,
    );
  }
  return lines.join('\n');
}
