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
  edge_vs_market?: number | null;
  market_sources_count?: number | null;
  recommended_amount?: number | null;
  kelly_fraction?: number | null;
  trap_warning?: string | null;
  analysis?: string | null;
  is_parlay?: boolean;
  best_odds_source?: string | null;
  /** Per-book ML lines for the comparator line. */
  odds_comparison?: Array<{ source: string; ml: number }>;
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
  // Take the first 1-2 COMPLETE sentences. Never cut mid-sentence, never
  // leave an open paren, never end with ', .'
  const stripped = analysis.replace(/[*_]/g, '').replace(/\s+/g, ' ').trim();

  // Walk through and extract complete sentences (ending in . ! ? followed
  // by space or end). Stop after 2 sentences or 280 chars, whichever first.
  const sentences: string[] = [];
  let buf = '';
  let parenDepth = 0;
  for (let i = 0; i < stripped.length; i++) {
    const c = stripped[i];
    buf += c;
    if (c === '(') parenDepth++;
    else if (c === ')') parenDepth = Math.max(0, parenDepth - 1);
    // Sentence terminator only counts when parens are balanced
    if ((c === '.' || c === '!' || c === '?') && parenDepth === 0) {
      // Look ahead — make sure it's not part of a decimal number or abbreviation
      const next = stripped[i + 1];
      if (!next || next === ' ' || i === stripped.length - 1) {
        sentences.push(buf.trim());
        buf = '';
        if (sentences.length >= 2) break;
        if (sentences.join(' ').length >= 280) break;
      }
    }
  }

  if (sentences.length === 0) {
    // No complete sentence found — analysis may be truncated or lack proper
    // punctuation. Remove trailing unclosed parenthetical content so we never
    // return something like "(27-13, ." or end with an open paren.
    let cleaned = stripped;
    let depth = 0;
    let lastUnmatched = -1;
    for (let i = 0; i < cleaned.length; i++) {
      if (cleaned[i] === '(') {
        if (depth === 0) lastUnmatched = i;
        depth++;
      } else if (cleaned[i] === ')') {
        depth = Math.max(0, depth - 1);
        if (depth === 0) lastUnmatched = -1;
      }
    }
    if (lastUnmatched > 0) {
      cleaned = cleaned.slice(0, lastUnmatched).trim();
    }
    // Remove trailing commas, dashes, colons, semicolons, and stray dots
    cleaned = cleaned.replace(/[,\-–—:;\s]+\.?\s*$/, '').trim();
    // Add period if doesn't end with sentence punctuation
    if (cleaned.length > 0 && !/[.!?]$/.test(cleaned)) {
      cleaned += '.';
    }
    return cleaned || stripped;
  }

  return sentences.join(' ');
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
  /** CAPA-2: picks whose edge evaporated in this cron run (status flipped
   * to superseded_edge_evaporated). Rendered as a bulleted warning block
   * before the /picks link so the user sees WHICH picks the system pulled.
   */
  supersededPicks?: Array<{ pick: string; tier?: string | null }>;
}

const TIER_LABEL: Record<string, string> = {
  lock: 'LOCK',
  strong: 'STRONG',
  value: 'VALUE',
  parlay: 'PARLAY',
};

export function formatPicksMessage(
  picks: PickForMessage[],
  parlays: PickForMessage[],
  gameStartTime?: string | null,
  ctx: PicksContext = {},
): string {
  const lines: string[] = [];
  const total = picks.length + parlays.length;

  // ─── HEADER ─────────────────────────────────────────────────────────────
  lines.push(`🎯 *PICK IT UP* — ${total} pick${total === 1 ? '' : 's'} listo${total === 1 ? '' : 's'}`);
  if (ctx.bankrollCurrent != null) {
    lines.push(`💰 Bankroll: $${Math.round(ctx.bankrollCurrent)} MXN`);
  }
  lines.push('');

  // ─── PICKS ──────────────────────────────────────────────────────────────
  picks.forEach((p, i) => {
    const trap = p.trap_warning ? ' · ⚠️ TRAMPA' : '';
    const stake = p.recommended_amount != null ? Math.round(p.recommended_amount) : 0;
    const win = stake > 0 ? Math.round(stake * (p.odds_decimal - 1)) : 0;
    const edgePct = p.edge != null ? `${p.edge >= 0 ? '+' : ''}${(p.edge * 100).toFixed(1)}%` : null;
    const realPct = p.real_probability != null ? `${Math.round(p.real_probability * 100)}%` : null;
    const marketTag =
      p.edge_vs_market != null && p.edge_vs_market > 0 && (p.market_sources_count ?? 0) >= 2
        ? ' vs mercado'
        : '';
    const bookTag = p.best_odds_source ? ` (${p.best_odds_source})` : '';

    lines.push(`*#${i + 1} ${tierBadge(p.tier, p.confidence)}${trap}*`);
    lines.push(`${p.pick} @ ${p.odds_decimal.toFixed(2)}${bookTag}`);
    if (edgePct && realPct) {
      lines.push(`📊 Edge: ${edgePct}${marketTag} · Prob: ${realPct}`);
    } else if (edgePct) {
      lines.push(`📊 Edge: ${edgePct}${marketTag}`);
    }
    if (stake > 0) lines.push(`💰 Apostar: $${stake} → Ganas: $${win}`);
    if (p.odds_comparison && p.odds_comparison.length >= 2) {
      const sorted = [...p.odds_comparison].sort((a, b) => b.ml - a.ml);
      lines.push(`📍 ${sorted.map((b) => `${b.source} ${b.ml.toFixed(2)}`).join(' | ')}`);
    }
    const summary = oneLineSummary(p.analysis);
    if (summary) lines.push(`📋 ${summary}`);
    lines.push('');
  });

  // ─── PARLAYS ────────────────────────────────────────────────────────────
  parlays.forEach((par) => {
    const stake = par.recommended_amount != null ? Math.round(par.recommended_amount) : 0;
    const win = stake > 0 ? Math.round(stake * (par.odds_decimal - 1)) : 0;
    lines.push(`🎯 *Parlay:* ${par.pick} @ ${par.odds_decimal.toFixed(2)}`);
    if (stake > 0) lines.push(`💰 Apostar: $${stake} → Ganas: $${win}`);
    lines.push('');
  });

  // ─── FOOTER ─────────────────────────────────────────────────────────────
  if (gameStartTime) {
    lines.push(`⏰ Juegos a las ${formatTimeMx(gameStartTime)} CDMX`);
  }

  const footerBits: string[] = [];
  if (ctx.bankrollCurrent != null) footerBits.push(`💰 Bankroll: $${Math.round(ctx.bankrollCurrent)}`);
  if (ctx.record) footerBits.push(`📈 Record: ${ctx.record.wins}W-${ctx.record.losses}L`);
  if (ctx.roi != null) footerBits.push(`ROI: ${ctx.roi >= 0 ? '+' : ''}${ctx.roi.toFixed(1)}%`);
  if (footerBits.length > 0) lines.push(footerBits.join(' · '));

  if (ctx.supersededPicks && ctx.supersededPicks.length > 0) {
    lines.push('⚠️ Edge evaporó en reanálisis:');
    for (const s of ctx.supersededPicks) {
      const tag = s.tier ? ` (era ${TIER_LABEL[s.tier] ?? s.tier.toUpperCase()})` : '';
      lines.push(`• ${s.pick}${tag}`);
    }
  }

  lines.push(`🔗 ${APP_URL.replace(/^https?:\/\//, '')}/picks`);

  return lines.join('\n');
}

/**
 * Standalone message for the case where the cron run produced ZERO new
 * picks and ZERO updates but DID supersede at least one previously-notified
 * pick. Without this message the user could place a bet on a pick they saw
 * in Telegram minutes ago, unaware the system pulled it. Filtering of
 * already-notified picks happens upstream — this helper just renders.
 */
export function formatSupersededOnlyMessage(
  superseded: Array<{ pick: string; tier?: string | null }>,
  ctx: { bankrollCurrent?: number } = {},
): string {
  const lines: string[] = [];
  lines.push('⚠️ *PICKS RETIRADOS* — el edge se evaporó en reanálisis');
  lines.push('');
  for (const s of superseded) {
    const tag = s.tier ? ` (era ${TIER_LABEL[s.tier] ?? s.tier.toUpperCase()})` : '';
    lines.push(`❌ ${s.pick}${tag}`);
  }
  lines.push('');
  lines.push('No apostar a estos picks — el sistema cambió de opinión basado en datos más frescos.');
  if (ctx.bankrollCurrent != null) {
    lines.push('');
    lines.push(`💰 Bankroll: $${Math.round(ctx.bankrollCurrent)}`);
  }
  lines.push(`🔗 ${APP_URL.replace(/^https?:\/\//, '')}/picks`);
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
  return [
    `📊 Simulación 10K: ${profitPct}% prob profit · Esperada ${ev}`,
    `Rango: ${mc.worst_case_5p < 0 ? '-' : '+'}$${Math.abs(Math.round(mc.worst_case_5p))} a +$${Math.round(mc.best_case_95p)}`,
  ];
}

interface ResolutionForMessage {
  pick: string;
  result: 'win' | 'loss';
  pl: number;
  is_parlay?: boolean;
  final_score?: string | null;
  home_team?: string | null;
  away_team?: string | null;
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
  lines.push('📊 *RESULTADOS*');
  lines.push('');

  for (const r of resolutions) {
    const emoji = r.is_parlay ? '🎯' : r.result === 'win' ? '✅' : '❌';
    const verb = r.result === 'win' ? 'Ganaste' : 'Perdiste';
    const sign = r.pl >= 0 ? '+' : '-';
    lines.push(`${emoji} ${r.pick} → ${verb} ${sign}$${Math.abs(Math.round(r.pl))}`);
    // Final score line: "Marcador: Away 5 - Home 2"
    if (r.final_score && r.away_team && r.home_team) {
      const parts = r.final_score.split('-');
      if (parts.length === 2) {
        const awayShort = r.away_team.split(/\s+/).pop() ?? r.away_team;
        const homeShort = r.home_team.split(/\s+/).pop() ?? r.home_team;
        lines.push(`   Marcador: ${awayShort} ${parts[0]} - ${homeShort} ${parts[1]}`);
      }
    } else if (r.final_score) {
      lines.push(`   Marcador: ${r.final_score}`);
    }
  }
  lines.push('');

  if (ctx.todayPl != null) {
    lines.push(`💰 Hoy: ${ctx.todayPl >= 0 ? '+' : '-'}$${Math.abs(Math.round(ctx.todayPl))}`);
  }
  if (ctx.bankrollCurrent != null) {
    const before = ctx.bankrollBefore != null ? ` (era $${Math.round(ctx.bankrollBefore)})` : '';
    lines.push(`💰 Bankroll: $${Math.round(ctx.bankrollCurrent)}${before}`);
  }
  if (ctx.record && ctx.roi != null) {
    lines.push(`📈 Record: ${ctx.record.wins}W-${ctx.record.losses}L · ROI: ${ctx.roi >= 0 ? '+' : ''}${ctx.roi.toFixed(1)}%`);
  }

  return lines.join('\n');
}
