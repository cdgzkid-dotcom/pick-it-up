// Telegram bot wrapper for Pick It Up notifications.
// Token + chat id come from env. Uses Markdown legacy parse mode (the simpler
// variant — no need to escape every punctuation character like MarkdownV2).

import type { SystemHealthSummary } from '@/lib/healthChecks';

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
  /** Sizing transparency (2026-05-13). When sizing_reason !== null, the
   *  Apostar line shows "$22 (1.7u de 2u — <reason phrase>)" so the user
   *  never has to guess where the stake came from. Null on parlays. */
  theoretical_amount?: number | null;
  sizing_reason?: string | null;
  units_actual?: number | null;
  units_theoretical?: number | null;
  /** Sport needed to phrase the sport_multiplier reason. */
  sport?: string | null;
  trap_warning?: string | null;
  analysis?: string | null;
  is_parlay?: boolean;
  best_odds_source?: string | null;
  /** Per-book ML lines for the comparator line. */
  odds_comparison?: Array<{ source: string; ml: number }>;
  /** Pinnacle integration: when present, render an inline "Mercado: DK X% ·
   *  Pin Y% · BPI Z%" line so the user sees the three independent
   *  probability estimates. Null = Pinnacle didn't contribute. */
  pinnacle_implied?: number | null;
  /** ESPN BPI implied for the picked side. Used jointly with pinnacle_implied
   *  to render the 3-way market line. Null = BPI didn't contribute. */
  bpi_implied?: number | null;
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

const SPORT_EMOJI: Record<string, string> = {
  MLB: '⚾',
  NBA: '🏀',
  NHL: '🏒',
  NFL: '🏈',
  'Liga MX': '⚽',
  'Premier League': '⚽',
  Champions: '⚽',
  Soccer: '⚽',
  UFC: '🥊',
};
const sportEmoji = (sport: string): string => SPORT_EMOJI[sport] ?? '🎯';

function sizingReasonPhrase(
  reason: string | null | undefined,
  sport: string | null | undefined,
): string | null {
  if (!reason) return null;
  switch (reason) {
    case 'kelly_below_ceiling':
      return 'Kelly recomienda menos';
    case 'sport_multiplier':
      return sport ? `Kelly ${sport} recortó por varianza` : 'Kelly recortó por varianza';
    case 'trap':
      return 'Recortado por señal de trampa';
    case 'bankroll_cap':
      return 'Cap 10% del bankroll';
    default:
      return null;
  }
}

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

/** CAPA-2/3 superseded-pick entry. Discriminated by `reason` so the
 * line-moved branch carries the odds for display. */
export type SupersededPickForTg =
  | { pick: string; tier?: string | null; reason: 'edge_evaporated' }
  | {
      pick: string;
      tier?: string | null;
      reason: 'line_moved_against';
      original_odds: number;
      current_odds: number;
    };

interface PicksContext {
  bankrollCurrent?: number;
  record?: { wins: number; losses: number };
  roi?: number;
  /** CAPA-2/3: picks the lock-in flow retired this run. Rendered as a
   * subgrouped warning block before the /picks link. Empty array or
   * undefined → no block.
   */
  supersededPicks?: SupersededPickForTg[];
  /** Auditoría 5: visible system health semaphore. If present, rendered as
   * a coloured line just before the /picks link. The user can decide at
   * read time whether to trust the picks or check /api/health first.
   * Omitted → no indicator (used for unit/test paths). */
  systemHealth?: SystemHealthSummary;
}

/**
 * Render the system-health line shown to the user in every Telegram picks
 * message. Goal: the user must SEE that something is wrong without having
 * to proactively check /api/health. Names of failing checks are surfaced
 * (capped at 2 to avoid bloating the message) so the user knows which area
 * is degraded.
 *
 * Layout always starts with `\n\n` so the indicator sits visually separated
 * from whatever line precedes it (footer bits or supersede block).
 */
function renderHealthIndicator(h: SystemHealthSummary): string {
  if (h.errors > 0) {
    const details = h.errorNames.slice(0, 2).join(', ');
    return `\n\n🔴 Sistema crítico: ${details}\n⚠️ NO apostar sin verificar.`;
  }
  if (h.warnings > 0) {
    const details = h.warningNames.slice(0, 2).join(', ');
    return `\n\n🟡 Sistema degradado: ${details}`;
  }
  return `\n\n🟢 Sistema OK (${h.ok}/${h.total} checks)`;
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

    const sportTag = p.sport ? `${sportEmoji(p.sport)} ` : '';
    lines.push(`*#${i + 1} ${tierBadge(p.tier, p.confidence)}${trap}*`);
    lines.push(`${sportTag}${p.pick} @ ${p.odds_decimal.toFixed(2)}${bookTag}`);
    if (edgePct && realPct) {
      lines.push(`📊 Edge: ${edgePct}${marketTag} · Prob: ${realPct}`);
    } else if (edgePct) {
      lines.push(`📊 Edge: ${edgePct}${marketTag}`);
    }
    // Pinnacle integration: when Pinnacle's ML contributed, show all
    // three probability sources side-by-side so the user can see the
    // disagreement footprint. DK always present (derived from odds).
    if (p.pinnacle_implied != null && p.odds_decimal > 1.01) {
      const dkPct = (1 / p.odds_decimal) * 100;
      const pinPct = p.pinnacle_implied * 100;
      const bits = [`DK ${dkPct.toFixed(1)}%`, `Pin ${pinPct.toFixed(1)}%`];
      if (p.bpi_implied != null) bits.push(`BPI ${(p.bpi_implied * 100).toFixed(1)}%`);
      lines.push(`📈 Mercado: ${bits.join(' · ')}`);
    }
    if (stake > 0) {
      const phrase = sizingReasonPhrase(p.sizing_reason, p.sport);
      if (phrase && p.units_actual != null && p.units_theoretical != null) {
        lines.push(
          `💰 Apostar: $${stake} (${p.units_actual}u de ${p.units_theoretical}u — ${phrase}) → Ganas: $${win}`,
        );
      } else {
        lines.push(`💰 Apostar: $${stake} → Ganas: $${win}`);
      }
    }
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
    const parlayTag = par.sport ? `${sportEmoji(par.sport)} ` : '';
    lines.push(`🎯 *Parlay:* ${parlayTag}${par.pick} @ ${par.odds_decimal.toFixed(2)}`);
    if (stake > 0) {
      const phrase = sizingReasonPhrase(par.sizing_reason, par.sport);
      if (phrase && par.units_actual != null && par.units_theoretical != null) {
        lines.push(
          `💰 Apostar: $${stake} (${par.units_actual}u de ${par.units_theoretical}u — ${phrase}) → Ganas: $${win}`,
        );
      } else {
        lines.push(`💰 Apostar: $${stake} → Ganas: $${win}`);
      }
    }
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
    lines.push(...renderSupersededBlock(ctx.supersededPicks));
  }

  if (ctx.systemHealth) {
    lines.push(renderHealthIndicator(ctx.systemHealth));
  }

  lines.push(`🔗 ${APP_URL.replace(/^https?:\/\//, '')}/picks`);

  return lines.join('\n');
}

function tierTag(tier?: string | null): string {
  if (!tier) return '';
  return ` (era ${TIER_LABEL[tier] ?? tier.toUpperCase()}`;
}

/**
 * Shared render of the superseded-picks block. Used inline by
 * formatPicksMessage and as the body of formatSupersededOnlyMessage.
 * Subgroups by reason:
 *   "Línea se movió en contra:" lists picks with original→current odds
 *   "Edge evaporó:"             lists picks without odds (irrelevant)
 */
function renderSupersededBlock(items: SupersededPickForTg[]): string[] {
  const lineMoved = items.filter((s): s is Extract<SupersededPickForTg, { reason: 'line_moved_against' }> => s.reason === 'line_moved_against');
  const edgeEvap = items.filter((s) => s.reason === 'edge_evaporated');
  const lines: string[] = ['⚠️ Picks retirados:'];
  if (lineMoved.length > 0) {
    lines.push('Línea se movió en contra:');
    for (const s of lineMoved) {
      const tag = tierTag(s.tier);
      const closer = tag ? `${tag}, ${s.original_odds.toFixed(2)} → ${s.current_odds.toFixed(2)})` : ` (${s.original_odds.toFixed(2)} → ${s.current_odds.toFixed(2)})`;
      lines.push(`• ${s.pick}${closer}`);
    }
  }
  if (edgeEvap.length > 0) {
    lines.push('Edge evaporó:');
    for (const s of edgeEvap) {
      const tag = tierTag(s.tier);
      const closer = tag ? `${tag})` : '';
      lines.push(`• ${s.pick}${closer}`);
    }
  }
  return lines;
}

/**
 * Pick Digest message. Sent when the cron analyzed at least one game but
 * produced ZERO actionable picks (all categories below trigger). Replaces
 * the older single-purpose "no DK odds" alert with a unified summary that
 * covers all paths to "no pick":
 *   • Sin edge contra DK  — Claude analyzed but edge < EDGE_THRESHOLD (2%)
 *   • Filtrado por calidad — passed gate but failed Auditoría 2
 *   • Sin edge (playoff)   — analyzed_no_edge marker
 *   • Sin DK odds          — analyzed_no_odds_data marker
 *
 * Surfaces per-game numbers (Claude prob vs DK implied vs edge) so the
 * user can SEE the math the system did, killing the "silent system"
 * anxiety that motivated this whole digest.
 *
 * Anti-spam (2h window) is enforced by the caller via system_notifications
 * with kind='pick_digest'.
 */
export interface PickDigestData {
  analyzedCount: number;
  /** Picks where edge < EDGE_THRESHOLD. Most common "no pick" reason on a
   *  normal slate where market and Claude agree. */
  edgeBelow: Array<{
    sport: string;
    home_team: string;
    away_team: string;
    picked_team: string;
    claude_prob: number; // 0-1
    dk_implied: number; // 0-1
    edge: number; // claude_prob - dk_implied, may be small but positive
  }>;
  /** Picks that survived all upstream filters but failed Auditoría 2. */
  auditFiltered: Array<{
    sport: string;
    home_team: string;
    away_team: string;
    pick: string;
    tier: string;
    failures: string[];
  }>;
  /** Playoff games Claude analyzed but found no edge on either side. */
  playoffNoEdge: Array<{
    sport: string;
    home_team: string;
    away_team: string;
    game_start_time: string | null;
  }>;
  /** Games where Claude's probability for BOTH sides was below DK's implied
   *  probability — market was more bullish than Claude on every option. */
  noPositiveEdge: Array<{
    sport: string;
    home_team: string;
    away_team: string;
    home_prob: number; // 0-1, Claude
    away_prob: number; // 0-1, Claude
    home_dk_implied: number; // 0-1
    away_dk_implied: number; // 0-1
  }>;
  /** Games where DK never published moneylines in time. */
  noOdds: Array<{
    sport: string;
    home_team: string;
    away_team: string;
    game_start_time: string | null;
  }>;
}

const PER_CATEGORY_LIMIT = 5;

function formatStartTimeMx(iso: string | null): string {
  if (!iso) return 'TBD';
  return new Date(iso).toLocaleTimeString('es-MX', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Mexico_City',
  });
}

export function formatPickDigestMessage(
  data: PickDigestData,
  ctx: { systemHealth?: SystemHealthSummary } = {},
): string {
  const lines: string[] = [];
  lines.push('🚫 *NO APOSTAR · 0 picks recomendados*');
  lines.push('─────────────────────');
  lines.push(`${data.analyzedCount} juego(s) analizados · 0 picks pasaron filtros`);

  // Order: most-relevant-to-user first.
  // 1) ❌ Sin edge contra DK
  if (data.edgeBelow.length > 0) {
    lines.push('');
    lines.push(`❌ *Sin edge contra DK* (${data.edgeBelow.length}):`);
    for (const g of data.edgeBelow.slice(0, PER_CATEGORY_LIMIT)) {
      const claudePct = (g.claude_prob * 100).toFixed(1);
      const dkPct = (g.dk_implied * 100).toFixed(1);
      const edgePct = (g.edge * 100).toFixed(1);
      const sign = g.edge >= 0 ? '+' : '';
      lines.push(`• ${sportEmoji(g.sport)} ${g.away_team} @ ${g.home_team}`);
      lines.push(`   Pick ${g.picked_team}: Claude ${claudePct}% · DK ${dkPct}% · edge ${sign}${edgePct}%`);
    }
    if (data.edgeBelow.length > PER_CATEGORY_LIMIT) {
      lines.push(`   ...y ${data.edgeBelow.length - PER_CATEGORY_LIMIT} más`);
    }
  }

  // 2) ⚠️ Filtrado por calidad
  if (data.auditFiltered.length > 0) {
    lines.push('');
    lines.push(`⚠️ *Filtrado por calidad* (${data.auditFiltered.length}):`);
    for (const g of data.auditFiltered.slice(0, PER_CATEGORY_LIMIT)) {
      const tier = (g.tier || 'value').toUpperCase();
      const failures = g.failures.slice(0, 2).join(', ');
      lines.push(`• ${sportEmoji(g.sport)} ${g.pick} (${tier})`);
      lines.push(`   ${failures}${g.failures.length > 2 ? '...' : ''}`);
    }
    if (data.auditFiltered.length > PER_CATEGORY_LIMIT) {
      lines.push(`   ...y ${data.auditFiltered.length - PER_CATEGORY_LIMIT} más`);
    }
  }

  // 3) ⛔ Sin edge en playoff
  if (data.playoffNoEdge.length > 0) {
    lines.push('');
    lines.push(`⛔ *Sin edge en playoff* (${data.playoffNoEdge.length}):`);
    for (const g of data.playoffNoEdge.slice(0, PER_CATEGORY_LIMIT)) {
      lines.push(`• ${sportEmoji(g.sport)} ${g.away_team} @ ${g.home_team} (${formatStartTimeMx(g.game_start_time)})`);
    }
    if (data.playoffNoEdge.length > PER_CATEGORY_LIMIT) {
      lines.push(`   ...y ${data.playoffNoEdge.length - PER_CATEGORY_LIMIT} más`);
    }
  }

  // 4) 📉 Mercado más bullish que Claude (edge ≤ 0 en ambos lados)
  if (data.noPositiveEdge.length > 0) {
    lines.push('');
    lines.push(`📉 *Mercado más bullish que Claude* (${data.noPositiveEdge.length}):`);
    for (const g of data.noPositiveEdge.slice(0, PER_CATEGORY_LIMIT)) {
      const homeClaudePct = (g.home_prob * 100).toFixed(1);
      const awayClaudePct = (g.away_prob * 100).toFixed(1);
      const homeDkPct = (g.home_dk_implied * 100).toFixed(1);
      const awayDkPct = (g.away_dk_implied * 100).toFixed(1);
      lines.push(`• ${sportEmoji(g.sport)} ${g.away_team} @ ${g.home_team}`);
      lines.push(`   ${g.away_team}: Claude ${awayClaudePct}% · DK ${awayDkPct}%`);
      lines.push(`   ${g.home_team}: Claude ${homeClaudePct}% · DK ${homeDkPct}%`);
    }
    if (data.noPositiveEdge.length > PER_CATEGORY_LIMIT) {
      lines.push(`   ...y ${data.noPositiveEdge.length - PER_CATEGORY_LIMIT} más`);
    }
  }

  // 5) 🚫 Sin DK odds
  if (data.noOdds.length > 0) {
    lines.push('');
    lines.push(`🚫 *Sin DK odds* (${data.noOdds.length}):`);
    for (const g of data.noOdds.slice(0, PER_CATEGORY_LIMIT)) {
      lines.push(`• ${sportEmoji(g.sport)} ${g.away_team} @ ${g.home_team} (${formatStartTimeMx(g.game_start_time)})`);
    }
    if (data.noOdds.length > PER_CATEGORY_LIMIT) {
      lines.push(`   ...y ${data.noOdds.length - PER_CATEGORY_LIMIT} más`);
    }
    lines.push('Reintento automático cada 10 min hasta 3 veces.');
  }

  lines.push('');
  lines.push('⚠️ *NO apostar estos juegos.* Sistema analizó pero sin edge suficiente vs mercado.');

  if (ctx.systemHealth) {
    lines.push(renderHealthIndicator(ctx.systemHealth));
  }

  lines.push('');
  lines.push(`🔗 ${APP_URL.replace(/^https?:\/\//, '')}/picks`);

  return lines.join('\n');
}

/**
 * Standalone message for the case where the cron run produced ZERO new
 * picks and ZERO updates but DID supersede at least one previously-notified
 * pick. Without this message the user could place a bet on a pick they saw
 * in Telegram minutes ago, unaware the system pulled it. Filtering of
 * already-notified picks happens upstream — this helper just renders.
 *
 * Subgroups by reason (line_moved_against vs edge_evaporated) so the user
 * understands WHY the pick was pulled.
 */
export function formatSupersededOnlyMessage(
  superseded: SupersededPickForTg[],
  ctx: { bankrollCurrent?: number; systemHealth?: SystemHealthSummary } = {},
): string {
  const lines: string[] = [];
  lines.push('⚠️ *PICKS RETIRADOS*');
  lines.push('');
  lines.push(...renderSupersededBlock(superseded));
  lines.push('');
  lines.push('No apostar a estos picks — el sistema cambió de opinión basado en datos más frescos.');
  if (ctx.bankrollCurrent != null) {
    lines.push('');
    lines.push(`💰 Bankroll: $${Math.round(ctx.bankrollCurrent)}`);
  }
  if (ctx.systemHealth) {
    lines.push(renderHealthIndicator(ctx.systemHealth));
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
