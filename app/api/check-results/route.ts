import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { systemDisabledResponse } from '@/lib/systemState';
import { fetchEventStatus, fetchEspnClosingLine } from '@/lib/espn';
import { potentialWin } from '@/lib/units';
import { applyResult as applyEloResult } from '@/lib/elo';
import { updateFactorPerformance } from '@/lib/learning';
import { sendTelegramMessage, formatResultsMessage } from '@/lib/telegram';
import { computeStats } from '@/lib/stats';
import { pickedSide } from '@/lib/betEval';
import type { Bet } from '@/lib/types';

type ToNotify = {
  bet_id: string;
  pick: string;
  result: 'win' | 'loss';
  pl: number;
  payout: number;
  is_parlay: boolean;
  final_score?: string | null;
  home_team?: string | null;
  away_team?: string | null;
};

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface Resolution {
  bet_id: string;
  pick: string;
  game: string;
  result: 'win' | 'loss';
  payout: number;
  pl: number;
  amount: number;
  home_score: number;
  away_score: number;
  home_team?: string | null;
  away_team?: string | null;
  is_parlay: boolean;
  was_already_notified: boolean;
}

// Line extraction from the pick text. The old regex grabbed the FIRST number
// in the string, so "76ers -5.5" parsed as line=76. Rules now:
//   spread → a signed number token bounded by whitespace ("76ers -5.5" → -5.5,
//            "Lakers +3" → 3). Sign is mandatory, so "76ers" alone never matches.
//   total  → number right after Over/Under ("Over 8.5" → 8.5, "Under 44.5" → 44.5),
//            falling back to a trailing number ("Padres o7.5"-style text won't
//            match either and falls through to the DB column).
// Returns null when the text carries no line ("St. Louis Cardinals ML").
const SPREAD_LINE_RE = /(?:^|\s)([+-]\d+(?:\.\d+)?)(?=\s|$|\))/;
const TOTAL_OU_LINE_RE = /\b(?:over|under)\s*([+-]?\d+(?:\.\d+)?)/i;
const TRAILING_LINE_RE = /(?:^|\s)([+-]?\d+(?:\.\d+)?)\s*$/;

function parsePickLine(pick: string, kind: 'spread' | 'total'): number | null {
  const text = String(pick ?? '').trim();
  if (!text) return null;
  const m = kind === 'spread'
    ? text.match(SPREAD_LINE_RE)
    : (text.match(TOTAL_OU_LINE_RE) ?? text.match(TRAILING_LINE_RE));
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

function authOk(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (expected && req.headers.get('authorization') === `Bearer ${expected}`) {
    return true;
  }

  // The dashboard invokes this endpoint directly from the browser. Same-origin
  // validation preserves that flow, but is weaker than CRON_SECRET authentication:
  // it relies on browser-controlled Origin/Referer headers and should not protect
  // privileged callers outside this UI use case.
  const requestUrl = new URL(req.url);
  const origin = req.headers.get('origin');
  if (origin) {
    try {
      return new URL(origin).origin === requestUrl.origin;
    } catch {
      return false;
    }
  }

  const referer = req.headers.get('referer');
  if (referer) {
    try {
      return new URL(referer).origin === requestUrl.origin;
    } catch {
      return false;
    }
  }

  return false;
}

export async function POST(req: Request) {
  if (!authOk(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const disabled = await systemDisabledResponse('check-results');
  if (disabled) return disabled;

  const supabase = supabaseAdmin();
  const { data: pendingBets, error } = await supabase
    .from('bets')
    .select('*')
    .eq('result', 'pending')
    .not('espn_event_id', 'is', null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Don't early-return on bets.length === 0 — we still want the retroactive
  // Telegram catch-up block below to flush any previously resolved-but-not-
  // notified bets (e.g. when the cron resolved them but the send failed).
  const bets = (pendingBets as Bet[]) ?? [];

  const resolutions: Resolution[] = [];
  let pushed = 0;

  for (const bet of bets) {
    if (!bet.espn_event_id) continue;
    const betType = String(bet.bet_type).toLowerCase();
    const isML = betType === 'ml' || betType === 'moneyline';
    const isSpread = betType === 'spread' || betType === 'runline' || betType === 'run line';
    const isTotal = betType === 'total' || betType === 'over' || betType === 'under' || betType.startsWith('o/u');
    if (!isML && !isSpread && !isTotal) continue; // skip props/parlays/etc

    const status = await fetchEventStatus(bet.sport, bet.espn_event_id, bet.game_start_time);
    if (!status || !status.completed) continue;
    if (status.home_score == null || status.away_score == null) continue;

    let won: boolean | null = null;
    let isPush = false;
    const homeScore = status.home_score;
    const awayScore = status.away_score;
    const total = homeScore + awayScore;

    if (isML) {
      const side = pickedSide(bet.pick, bet.home_team_abbr, bet.away_team_abbr, bet.home_team, bet.away_team);
      if (!side) continue;
      if (homeScore === awayScore) {
        // Final tie (NFL regular season can end tied). A moneyline on a tied
        // game is a push — stake refunded, no profit — same as a spread push.
        // Previously this was `continue`, which left the bet pending forever.
        isPush = true;
      } else {
        won = (side === 'home' && homeScore > awayScore) || (side === 'away' && awayScore > homeScore);
      }
    } else if (isSpread) {
      // Parse "Cubs -1.5" / "76ers -5.5" — signed number token, not the first
      // digits in the string. Falls back to bets.spread_line.
      const parsed = parsePickLine(bet.pick, 'spread');
      const line = parsed ?? (bet.spread_line != null ? Number(bet.spread_line) : NaN);
      if (!Number.isFinite(line)) continue;
      const side = pickedSide(bet.pick, bet.home_team_abbr, bet.away_team_abbr, bet.home_team, bet.away_team);
      if (!side) continue;
      // Margin for the picked side after adding their line. They cover if margin > 0.
      const adjusted = side === 'home' ? homeScore + line - awayScore : awayScore + line - homeScore;
      if (adjusted === 0) {
        isPush = true;
      } else {
        won = adjusted > 0;
      }
    } else if (isTotal) {
      const parsed = parsePickLine(bet.pick, 'total');
      const line = parsed ?? (bet.total_line != null ? Number(bet.total_line) : NaN);
      if (!Number.isFinite(line)) continue;
      const isOver = /\bover\b/i.test(bet.pick) || (bet.bet_direction === 'over');
      const isUnder = /\bunder\b/i.test(bet.pick) || (bet.bet_direction === 'under');
      if (!isOver && !isUnder) continue;
      if (total === line) {
        isPush = true;
      } else {
        won = isOver ? total > line : total < line;
      }
    }

    if (isPush) {
      const amount = Number(bet.amount);
      const finalScorePush = `${status.away_score}-${status.home_score}`;
      // Atomic resolve. Idempotent — if already resolved by another path
      // (cron, manual), skipped:true is returned and we move on.
      const { error: rpcErr } = await supabase.rpc('resolve_bet_atomic', {
        p_bet_id: bet.id,
        p_result: 'push',
        p_payout: amount,
        p_credit: amount,  // stake refund
        p_cashout_amount: null,
        p_final_score: finalScorePush,
        p_odds_at_close: null,
        p_clv: null,
        p_note: `[Auto] PUSH ${bet.pick} (${finalScorePush})`,
      });
      if (rpcErr) {
        console.error('[check-results] push rpc failed', { bet_id: bet.id, err: rpcErr.message });
      } else {
        pushed += 1;
      }
      continue;
    }

    if (won === null) continue;

    const amount = Number(bet.amount);
    const odds = Number(bet.odds_decimal);
    const payout = won ? amount + potentialWin(amount, odds) : 0;

    // CLV (Closing Line Value) — convention: implied probability difference.
    //
    //   clv = (1/odds_at_close) - (1/odds_at_bet)
    //
    // Positive clv means the implied prob at close was higher than at bet
    // time — the line shortened in our favor, i.e. the market moved
    // toward our side (sharp confirmation of edge).
    //
    // odds_at_close: fetched fresh from ESPN core API at resolution time.
    // The pre-2026-05-12 version read picks.odds_decimal which goes stale
    // when status='bet' (applyLockIn skips updates), producing clv=0 for
    // every bet. Now we use ESPN's close.moneyLine.decimal which persists
    // post-game. ML only for now.
    //
    // No real closing line (spread/total, ESPN fetch failed, or no odds in
    // the payload) → bets.odds_at_close and bets.clv stay NULL. The previous
    // version persisted odds_at_bet as the close and clv=0, which is
    // indistinguishable from a real "market didn't move" reading and
    // poisoned CLV aggregates. There is no clv_source column in the schema,
    // so provenance is only logged.
    const oddsAtBet = bet.odds_at_bet != null ? Number(bet.odds_at_bet) : Number(bet.odds_decimal);
    let oddsAtClose: number | null = null;
    let clv: number | null = null;
    let clvSource = 'fallback_not_ml';
    if (isML && bet.espn_event_id) {
      const side = pickedSide(
        bet.pick,
        bet.home_team_abbr,
        bet.away_team_abbr,
        bet.home_team,
        bet.away_team,
      );
      try {
        const closing = await fetchEspnClosingLine(bet.sport, bet.espn_event_id);
        if (closing && side) {
          const close = side === 'home' ? closing.home_close_decimal : closing.away_close_decimal;
          if (close && close > 1.01) {
            oddsAtClose = close;
            clvSource = 'espn_close';
          }
        }
      } catch (e) {
        console.warn('[CLV_COMPUTED] fetch error', { bet_id: bet.id, err: (e as Error).message });
      }
    }
    if (oddsAtClose !== null && Number.isFinite(oddsAtBet) && oddsAtBet > 1) {
      clv = (1 / oddsAtClose) - (1 / oddsAtBet);
      console.log('[CLV_COMPUTED]', {
        bet_id: bet.id,
        pick_id: bet.pick_id,
        odds_at_bet: oddsAtBet,
        odds_at_close: oddsAtClose,
        clv: Number(clv.toFixed(4)),
        source: clvSource,
      });
    } else {
      if (clvSource === 'fallback_not_ml' && isML) clvSource = 'fallback_no_data';
      console.warn('[CLV_COMPUTED] no closing line — leaving odds_at_close/clv NULL', {
        bet_id: bet.id,
        pick_id: bet.pick_id,
        odds_at_bet: oddsAtBet,
        source: clvSource,
      });
    }

    // Save final score for display in tracker history + Telegram message.
    // Format: "away-home" (e.g., "Royals 5 - Tigers 2" rendered from this).
    const finalScore = `${status.away_score}-${status.home_score}`;

    // Atomic resolve: UPDATE bets + UPDATE bankroll + INSERT log, with
    // idempotency guard inside the RPC. If cron already resolved this bet
    // (this route + cron/analyze runResultsCheck both run), skipped:true
    // returns and the bankroll isn't double-credited.
    const { data: rpcData, error: rpcErr } = await supabase.rpc('resolve_bet_atomic', {
      p_bet_id: bet.id,
      p_result: won ? 'win' : 'loss',
      p_payout: payout,
      p_credit: payout, // 0 for loss, full payout for win
      p_cashout_amount: null,
      p_final_score: finalScore,
      p_odds_at_close: oddsAtClose, // null → RPC coalesce keeps the column NULL
      p_clv: clv,                   // null → same
      p_note: `[Auto] ${won ? 'WIN' : 'LOSS'} ${bet.pick} (${status.away_score}-${status.home_score})`,
    });
    if (rpcErr) {
      console.error('[check-results] resolve rpc failed', { bet_id: bet.id, err: rpcErr.message });
      continue;
    }
    // Already resolved by the cron → ELO/learning applied there; don't double count.
    if ((rpcData as { skipped?: boolean } | null)?.skipped) continue;

    // Update ELO ratings for both teams based on actual game result.
    if (bet.home_team && bet.away_team) {
      try {
        await applyEloResult(
          supabase,
          bet.sport,
          bet.home_team,
          bet.away_team,
          status.home_score,
          status.away_score,
        );
      } catch (e) {
        console.error('[check-results] ELO update failed', e);
      }
    }

    // Learning: update per-factor performance now that this bet has a final
    // result. recordPickFactors was called at pick-generation time, so the
    // factor snapshot is already in pick_factors keyed by pick_id.
    await updateFactorPerformance(supabase, {
      ...bet,
      result: won ? 'win' : 'loss',
      payout,
    });

    resolutions.push({
      bet_id: bet.id,
      pick: bet.pick,
      game: bet.game,
      result: won ? 'win' : 'loss',
      payout,
      pl: payout - amount,
      amount,
      home_score: status.home_score,
      away_score: status.away_score,
      home_team: bet.home_team,
      away_team: bet.away_team,
      is_parlay: (bet.bet_type as string) === 'Parlay',
      was_already_notified: false,
    });
  }

  // ── Telegram notification (manual button + retroactive catch-up) ─────────
  // formatResultsMessage handles win/loss only — push/cashout/early_payout
  // aren't part of the daily results template, so we filter them out.
  const toNotify: ToNotify[] = resolutions.map((r) => ({
    bet_id: r.bet_id,
    pick: r.pick,
    result: r.result,
    pl: r.pl,
    payout: r.payout,
    is_parlay: r.is_parlay,
    final_score: `${r.away_score}-${r.home_score}`,
    home_team: r.home_team,
    away_team: r.away_team,
  }));

  // Also catch up any previously resolved bets that never made it to Telegram
  // (e.g., resolved manually before the notification path existed).
  const { data: unnotified, error: unnotifiedErr } = await supabase
    .from('bets')
    .select('*')
    .in('result', ['win', 'loss'])
    .is('result_notified_at', null);
  if (unnotifiedErr) {
    // Non-fatal: we still notify what we resolved in this run.
    console.error('[check-results] unnotified fetch failed', unnotifiedErr.message);
  }
  for (const b of (unnotified as Bet[]) ?? []) {
    if (toNotify.some((r) => r.bet_id === b.id)) continue;
    const amount = Number(b.amount);
    const payout = Number(b.payout ?? 0);
    toNotify.push({
      bet_id: b.id,
      pick: b.pick,
      result: b.result === 'win' ? 'win' : 'loss',
      pl: payout - amount,
      payout,
      is_parlay: (b.bet_type as string) === 'Parlay',
      final_score: b.final_score ?? null,
      home_team: b.home_team,
      away_team: b.away_team,
    });
  }

  let notified = 0;
  if (toNotify.length > 0) {
    const { data: settings, error: settingsErr } = await supabase
      .from('settings')
      .select('bankroll_current')
      .eq('id', 1)
      .single();
    if (settingsErr) {
      console.error('[check-results] settings fetch failed', settingsErr.message);
    }
    const { data: allBets, error: allBetsErr } = await supabase
      .from('bets')
      .select('*')
      .order('created_at', { ascending: false });
    if (allBetsErr) {
      console.error('[check-results] bets fetch for stats failed', allBetsErr.message);
    }
    const stats = computeStats((allBets as Bet[]) ?? []);
    const todayPl = toNotify.reduce((s, r) => s + r.pl, 0);
    const bankrollNow = Number(settings?.bankroll_current ?? 0);
    // The stake was already debited from the bankroll when the bet was placed,
    // so the only movement at resolution time is the credited payout. Mirrors
    // cron/analyze runResultsCheck (bankrollNow − Σpayout), not now − P/L.
    const creditsApplied = toNotify.reduce((s, r) => s + r.payout, 0);
    const bankrollBefore = bankrollNow - creditsApplied;
    const text = formatResultsMessage(toNotify, {
      bankrollCurrent: bankrollNow,
      bankrollBefore,
      todayPl,
      record: { wins: stats.wins, losses: stats.losses },
      roi: stats.roi,
    });
    const send = await sendTelegramMessage(text);
    if (send.ok) {
      const ids = toNotify.map((r) => r.bet_id);
      const { error: markErr } = await supabase
        .from('bets')
        .update({ result_notified_at: new Date().toISOString() })
        .in('id', ids);
      if (markErr) {
        // Message went out but the flag didn't stick — next run will re-send.
        // Surface it rather than silently reporting notified=N.
        console.error('[check-results] result_notified_at update failed', markErr.message);
      } else {
        notified = toNotify.length;
      }
    } else {
      // Send failed → leave result_notified_at NULL so the next run retries.
      console.error('[check-results] telegram send failed', send.error);
    }
  }

  return NextResponse.json({
    checked: bets.length,
    resolved: resolutions.length,
    pushed,
    notified,
    resolutions,
  });
}
