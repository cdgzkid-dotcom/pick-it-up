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

const TIER_NAME: Record<string, string> = {
  lock: 'LOCK',
  strong: 'STRONG',
  value: 'VALUE',
  parlay: 'PARLAY',
};

function tierBadge(tier?: string | null, confidence?: number | null): string {
  if (!tier) return '';
  const e = TIER_EMOJI[tier] ?? '';
  const name = TIER_NAME[tier] ?? tier.toUpperCase();
  const conf = confidence != null ? ` ${Math.round(confidence)}%` : '';
  return `${e} ${name}${conf}`.trim();
}

function oneLineSummary(analysis?: string | null): string {
  if (!analysis) return '';
  // Take the first sentence; remove markdown chars; cap at 200 to avoid wraps
  const first = analysis.split(/[\n\.]/).map((s) => s.trim()).find((s) => s.length > 0);
  if (!first) return '';
  const clean = first.replace(/[*_]/g, '');
  return clean.length > 200 ? clean.slice(0, 197) + '…' : clean;
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

interface PicksContext {
  bankrollCurrent?: number;
  record?: { wins: number; losses: number };
  roi?: number;
}

export function formatPicksMessage(
  picks: PickForMessage[],
  parlays: PickForMessage[],
  gameStartTime?: string | null,
  ctx: PicksContext = {},
): string {
  const lines: string[] = [];
  const total = picks.length + parlays.length;

  // ─── HEADER ─────────────────────────────────────────────────────────────
  lines.push(`*PICK IT UP* — ${total} pick${total === 1 ? '' : 's'} listo${total === 1 ? '' : 's'}`);
  if (ctx.bankrollCurrent != null) {
    lines.push(`Bankroll: $${Math.round(ctx.bankrollCurrent)} MXN`);
  }
  lines.push('');

  // ─── PICKS ──────────────────────────────────────────────────────────────
  picks.forEach((p, i) => {
    const trap = p.trap_warning ? ' · TRAMPA' : '';
    const stake = p.recommended_amount != null ? Math.round(p.recommended_amount) : 0;
    const win = stake > 0 ? Math.round(stake * (p.odds_decimal - 1)) : 0;
    const edgePct = p.edge != null ? `${p.edge >= 0 ? '+' : ''}${(p.edge * 100).toFixed(1)}%` : null;
    const realPct = p.real_probability != null ? `${Math.round(p.real_probability * 100)}%` : null;

    lines.push(`*#${i + 1} ${tierBadge(p.tier, p.confidence)}${trap}*`);
    lines.push(`${p.pick} @ ${p.odds_decimal.toFixed(2)}`);
    if (edgePct && realPct) lines.push(`Edge: ${edgePct} · Prob: ${realPct}`);
    if (stake > 0) lines.push(`Apostar: $${stake} → Ganas: $${win}`);
    const summary = oneLineSummary(p.analysis);
    if (summary) lines.push(summary);
    lines.push('');
  });

  // ─── PARLAYS ────────────────────────────────────────────────────────────
  parlays.forEach((par) => {
    const stake = par.recommended_amount != null ? Math.round(par.recommended_amount) : 0;
    const win = stake > 0 ? Math.round(stake * (par.odds_decimal - 1)) : 0;
    lines.push(`*Parlay:* ${par.pick} @ ${par.odds_decimal.toFixed(2)}`);
    if (stake > 0) lines.push(`Apostar: $${stake} → Ganas: $${win}`);
    lines.push('');
  });

  // ─── FOOTER ─────────────────────────────────────────────────────────────
  if (gameStartTime) {
    lines.push(`Juegos a las ${formatTimeMx(gameStartTime)} CDMX`);
  }

  const footerBits: string[] = [];
  if (ctx.bankrollCurrent != null) footerBits.push(`Bankroll: $${Math.round(ctx.bankrollCurrent)}`);
  if (ctx.record) footerBits.push(`Record: ${ctx.record.wins}W-${ctx.record.losses}L`);
  if (ctx.roi != null) footerBits.push(`ROI: ${ctx.roi >= 0 ? '+' : ''}${ctx.roi.toFixed(1)}%`);
  if (footerBits.length > 0) lines.push(footerBits.join(' · '));

  lines.push(`${APP_URL.replace(/^https?:\/\//, '')}/picks`);

  return lines.join('\n');
}

interface MCSummary {
  profit_probability: number;
  expected_value: number;
  worst_case_5p: number;
  best_case_95p: number;
}

export function formatMonteCarloLines(mc: MCSummary): string[] {
  const profitPct = Math.round(mc.profit_probability * 100);
  const ev = mc.expected_value >= 0 ? `+$${Math.round(mc.expected_value)}` : `-$${Math.abs(Math.round(mc.expected_value))}`;
  // Compact 2-line format: probability + expected value, then range
  return [
    `Simulación 10K: ${profitPct}% prob profit · Esperada ${ev}`,
    `Rango: ${mc.worst_case_5p < 0 ? '-' : '+'}$${Math.abs(Math.round(mc.worst_case_5p))} a +$${Math.round(mc.best_case_95p)}`,
  ];
}

interface ResolutionForMessage {
  pick: string;
  result: 'win' | 'loss';
  pl: number;
  is_parlay?: boolean;
}

interface ResultsContext {
  bankrollCurrent?: number;
  bankrollBefore?: number;
  todayPl?: number;
  record?: { wins: number; losses: number };
  roi?: number;
}

export function formatResultsMessage(
  resolutions: ResolutionForMessage[],
  ctx: ResultsContext = {},
): string {
  const lines: string[] = [];
  lines.push('*RESULTADOS*');
  lines.push('');

  for (const r of resolutions) {
    const emoji = r.is_parlay ? '🎯' : r.result === 'win' ? '✅' : '❌';
    const verb = r.result === 'win' ? 'Ganaste' : 'Perdiste';
    const sign = r.pl >= 0 ? '+' : '-';
    lines.push(`${emoji} ${r.pick} → ${verb} ${sign}$${Math.abs(Math.round(r.pl))}`);
  }
  lines.push('');

  if (ctx.todayPl != null) {
    lines.push(`Hoy: ${ctx.todayPl >= 0 ? '+' : '-'}$${Math.abs(Math.round(ctx.todayPl))}`);
  }
  if (ctx.bankrollCurrent != null) {
    const before = ctx.bankrollBefore != null ? ` (era $${Math.round(ctx.bankrollBefore)})` : '';
    lines.push(`Bankroll: $${Math.round(ctx.bankrollCurrent)}${before}`);
  }
  if (ctx.record && ctx.roi != null) {
    lines.push(`Record: ${ctx.record.wins}W-${ctx.record.losses}L · ROI: ${ctx.roi >= 0 ? '+' : ''}${ctx.roi.toFixed(1)}%`);
  }

  return lines.join('\n');
}
