// Auto-analyze cron — invoked every 15 minutes by GitHub Actions.
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Logic:
// 1. Read settings (auto_enabled + auto_sports)
// 2. Fetch ESPN games for those sports
// 3. Window: games starting in 25-50 min that don't already have picks generated
// 4. analyzeGames(window) → pickGen helper → insert/update picks → Telegram message
// 5. Run check-results internally → for each newly resolved bet, Telegram + mark
//    result_notified_at so we don't duplicate

import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { fetchGames, fetchInjuriesForSports, fetchEventStatus } from '@/lib/espn';
import { analyzeGames } from '@/lib/pickGen';
import { potentialWin } from '@/lib/units';
import { sendTelegramMessage, formatPicksMessage, formatResultsMessage, formatMonteCarloLines } from '@/lib/telegram';
import { simulateDay } from '@/lib/montecarlo';
import { computeStats } from '@/lib/stats';
import type { Bet, Game } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const WINDOW_MIN_MINUTES = 25;
const WINDOW_MAX_MINUTES = 50;

function withinWindow(startIso: string | undefined): boolean {
  if (!startIso) return false;
  const t = new Date(startIso).getTime();
  if (Number.isNaN(t)) return false;
  const diffMin = (t - Date.now()) / 60_000;
  return diffMin >= WINDOW_MIN_MINUTES && diffMin <= WINDOW_MAX_MINUTES;
}

async function runAnalyzeWindow(): Promise<{ generated: number; eventIds: string[]; message: string | null }> {
  const supabase = supabaseAdmin();

  const { data: settings, error: settingsErr } = await supabase
    .from('settings')
    .select('bankroll_current, unit_percentage, auto_sports, auto_enabled')
    .eq('id', 1)
    .single();
  if (settingsErr || !settings) {
    throw new Error(`settings: ${settingsErr?.message ?? 'missing'}`);
  }
  if (settings.auto_enabled === false) {
    return { generated: 0, eventIds: [], message: 'auto_disabled' };
  }
  const sports: string[] = settings.auto_sports ?? [];
  if (sports.length === 0) return { generated: 0, eventIds: [], message: 'no_sports' };

  const [games, injByTeam] = await Promise.all([
    fetchGames(sports),
    fetchInjuriesForSports(sports),
  ]);
  for (const g of games) {
    const sportInjuries = injByTeam[g.sport] ?? {};
    const homeInj = sportInjuries[g.home_team] ?? [];
    const awayInj = sportInjuries[g.away_team] ?? [];
    const merged = [...awayInj, ...homeInj];
    if (merged.length > 0) g.injuries = merged;
  }

  // AUDIT: per-sport game count
  const bySport: Record<string, number> = {};
  for (const g of games) bySport[g.sport] = (bySport[g.sport] ?? 0) + 1;
  console.log(`[AUDIT][cron] ESPN games found by sport: ${JSON.stringify(bySport)} (total ${games.length})`);

  const inWindow = games.filter((g) => withinWindow(g.start_time));
  console.log(`[AUDIT][cron] in-window games: ${inWindow.length} (filtered out ${games.length - inWindow.length} outside window)`);
  if (inWindow.length === 0) {
    return { generated: 0, eventIds: [], message: 'no_games_in_window' };
  }

  const eventIds = inWindow.map((g) => g.espn_event_id).filter((x): x is string => Boolean(x));

  // Dedup guard: skip events that either already have a pending/bet pick OR
  // were ever notified via Telegram (telegram_notified_at). Once we've sent
  // a notification for a slot, NEVER analyze or notify again — even if the
  // pick was later superseded/skipped manually.
  const { data: blockedPicks } = await supabase
    .from('picks')
    .select('espn_event_id, status, telegram_notified_at')
    .or('status.in.(pending,bet),telegram_notified_at.not.is.null')
    .in('espn_event_id', eventIds);

  const alreadyDone = new Set((blockedPicks ?? []).map((p) => p.espn_event_id));
  const notifiedCount = (blockedPicks ?? []).filter((p) => p.telegram_notified_at).length;
  const fresh: Game[] = inWindow.filter((g) => g.espn_event_id && !alreadyDone.has(g.espn_event_id));

  console.log(
    `[AUDIT][cron] blocked events: ${alreadyDone.size} (of which ${notifiedCount} previously notified), fresh events to analyze: ${fresh.length}`,
  );
  console.log(`[AUDIT][cron] fresh games: ${fresh.map((g) => `${g.sport}/${g.away_team_abbr ?? '?'}@${g.home_team_abbr ?? '?'}`).join(', ')}`);

  if (fresh.length === 0) {
    return { generated: 0, eventIds: [], message: 'all_already_generated' };
  }

  const result = await analyzeGames(fresh, supabase, {
    bankroll: Number(settings.bankroll_current),
    unitPercentage: Number(settings.unit_percentage),
  });

  if (result.insertedPicks.length === 0 && result.insertedParlays.length === 0) {
    return { generated: 0, eventIds, message: 'no_picks_with_edge' };
  }

  const earliestStart = fresh
    .map((g) => g.start_time)
    .filter((s): s is string => Boolean(s))
    .sort()[0];

  // Build context (bankroll + record + ROI) for header/footer of the message
  const { data: allBets } = await supabase.from('bets').select('*');
  const stats = computeStats((allBets as Bet[]) ?? []);
  const ctx = {
    bankrollCurrent: Number(settings.bankroll_current),
    record: { wins: stats.wins, losses: stats.losses },
    roi: stats.roi,
  };

  // Run Monte Carlo on the slate (singles only — parlays already have their
  // probability baked into the legs).
  const mcInput = result.insertedPicks.map((p) => ({
    real_probability: Number(p.real_probability),
    odds_decimal: Number(p.odds_decimal),
    recommended_amount: Number(p.recommended_amount),
  }));
  const mc = simulateDay(mcInput);

  const picksMsg = formatPicksMessage(
    result.insertedPicks.map((p) => ({
      tier: p.tier,
      confidence: p.confidence,
      real_probability: Number(p.real_probability),
      pick: p.pick,
      bet_type: p.bet_type,
      odds_decimal: Number(p.odds_decimal),
      edge: Number(p.edge),
      recommended_amount: Number(p.recommended_amount),
      kelly_fraction: result.kellyByKey[`${p.pick}|${p.bet_type}`] ?? null,
      trap_warning: (p as { trap_warning?: string | null }).trap_warning ?? null,
      analysis: p.analysis,
    })),
    result.insertedParlays.map((p) => ({
      tier: p.tier,
      confidence: p.confidence,
      real_probability: Number(p.real_probability),
      pick: p.pick,
      bet_type: p.bet_type,
      odds_decimal: Number(p.odds_decimal),
      edge: Number(p.edge),
      recommended_amount: Number(p.recommended_amount),
      kelly_fraction: result.kellyByKey[`${p.pick}|Parlay`] ?? null,
      analysis: p.analysis,
      is_parlay: true,
    })),
    earliestStart,
    ctx,
  );

  const text = mcInput.length > 0 ? `${picksMsg}\n\n${formatMonteCarloLines(mc).join('\n')}` : picksMsg;
  const send = await sendTelegramMessage(text);
  if (send.ok) {
    const ids = [...result.insertedPicks, ...result.insertedParlays]
      .map((p) => p.id)
      .filter((x): x is string => Boolean(x));
    if (ids.length > 0) {
      await supabase
        .from('picks')
        .update({ telegram_notified_at: new Date().toISOString() })
        .in('id', ids);
    }
  }

  return {
    generated: result.insertedPicks.length + result.insertedParlays.length,
    eventIds,
    message: 'picks_sent',
  };
}

interface ResolutionForTg {
  bet_id: string;
  pick: string;
  result: 'win' | 'loss';
  pl: number;
  is_parlay: boolean;
}

async function runResultsCheck(): Promise<{ resolved: number; notified: number }> {
  const supabase = supabaseAdmin();

  const { data: pendingBets, error } = await supabase
    .from('bets')
    .select('*')
    .eq('result', 'pending')
    .not('espn_event_id', 'is', null);
  if (error) throw new Error(`bets fetch: ${error.message}`);
  const bets = (pendingBets as Bet[]) ?? [];

  const newlyResolved: ResolutionForTg[] = [];

  for (const bet of bets) {
    if (!bet.espn_event_id) continue;
    if (bet.bet_type !== 'ML') continue;

    const status = await fetchEventStatus(bet.sport, bet.espn_event_id);
    if (!status || !status.completed) continue;
    if (status.home_score == null || status.away_score == null) continue;

    const homeWon = status.home_score > status.away_score;
    const awayWon = status.away_score > status.home_score;
    if (status.home_score === status.away_score) continue;

    const p = bet.pick.toLowerCase();
    const checkAbbr = (a?: string | null) => a && p.includes(a.toLowerCase());
    let side: 'home' | 'away' | null = null;
    if (checkAbbr(bet.home_team_abbr)) side = 'home';
    else if (checkAbbr(bet.away_team_abbr)) side = 'away';
    if (!side) {
      const lastWord = (s?: string | null) => {
        if (!s) return null;
        const w = s.toLowerCase().split(/\s+/).filter(Boolean);
        return w.length > 0 ? w[w.length - 1] : null;
      };
      const hw = lastWord(bet.home_team);
      const aw = lastWord(bet.away_team);
      if (hw && hw.length >= 4 && p.includes(hw)) side = 'home';
      else if (aw && aw.length >= 4 && p.includes(aw)) side = 'away';
    }
    if (!side) continue;

    const won = (side === 'home' && homeWon) || (side === 'away' && awayWon);
    const amount = Number(bet.amount);
    const odds = Number(bet.odds_decimal);
    const payout = won ? amount + potentialWin(amount, odds) : 0;

    const { data: settings } = await supabase
      .from('settings')
      .select('bankroll_current')
      .eq('id', 1)
      .single();
    const newBankroll = Number(settings?.bankroll_current ?? 0) + payout;

    await supabase
      .from('bets')
      .update({
        result: won ? 'win' : 'loss',
        payout,
        result_notified_at: null,
      })
      .eq('id', bet.id);

    if (payout > 0) {
      await supabase.from('settings').update({ bankroll_current: newBankroll }).eq('id', 1);
    }

    await supabase.from('bankroll_log').insert([
      {
        type: won ? 'win' : 'loss',
        amount: payout,
        balance_after: newBankroll,
        note: `[Auto] ${won ? 'WIN' : 'LOSS'} ${bet.pick} (${status.away_score}-${status.home_score})`,
      },
    ]);

    newlyResolved.push({
      bet_id: bet.id,
      pick: bet.pick,
      result: won ? 'win' : 'loss',
      pl: payout - amount,
      is_parlay: (bet.bet_type as string) === 'Parlay',
    });
  }

  // Also pick up resolved bets that weren't notified yet (e.g. resolved manually)
  const { data: unnotifiedBets } = await supabase
    .from('bets')
    .select('*')
    .in('result', ['win', 'loss'])
    .is('result_notified_at', null);

  const allToNotify: ResolutionForTg[] = [...newlyResolved];
  for (const b of (unnotifiedBets as Bet[]) ?? []) {
    if (newlyResolved.some((r) => r.bet_id === b.id)) continue;
    const amount = Number(b.amount);
    const payout = Number(b.payout ?? 0);
    allToNotify.push({
      bet_id: b.id,
      pick: b.pick,
      result: b.result === 'win' ? 'win' : 'loss',
      pl: payout - amount,
      is_parlay: b.bet_type === 'Parlay',
    });
  }

  if (allToNotify.length === 0) {
    return { resolved: newlyResolved.length, notified: 0 };
  }

  const { data: settings } = await supabase
    .from('settings')
    .select('bankroll_current')
    .eq('id', 1)
    .single();
  const { data: allBets } = await supabase
    .from('bets')
    .select('*')
    .order('created_at', { ascending: false });
  const stats = computeStats((allBets as Bet[]) ?? []);
  const todayPl = allToNotify.reduce((s, r) => s + r.pl, 0);

  const bankrollNow = Number(settings?.bankroll_current ?? 0);
  const bankrollBefore = bankrollNow - todayPl;
  const text = formatResultsMessage(allToNotify, {
    bankrollCurrent: bankrollNow,
    bankrollBefore,
    todayPl,
    record: { wins: stats.wins, losses: stats.losses },
    roi: stats.roi,
  });

  const send = await sendTelegramMessage(text);
  if (send.ok) {
    const ids = allToNotify.map((r) => r.bet_id);
    await supabase
      .from('bets')
      .update({ result_notified_at: new Date().toISOString() })
      .in('id', ids);
  }

  return { resolved: newlyResolved.length, notified: allToNotify.length };
}

function authOk(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const header = req.headers.get('authorization') ?? '';
  return header === `Bearer ${expected}`;
}

async function handle(req: Request) {
  if (!authOk(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const t0 = Date.now();
  const errors: Record<string, string> = {};
  let analyze: Awaited<ReturnType<typeof runAnalyzeWindow>> | null = null;
  let results: Awaited<ReturnType<typeof runResultsCheck>> | null = null;

  try {
    analyze = await runAnalyzeWindow();
  } catch (e) {
    errors.analyze = (e as Error).message;
    console.error('[cron/analyze] analyze failed', e);
  }

  try {
    results = await runResultsCheck();
  } catch (e) {
    errors.results = (e as Error).message;
    console.error('[cron/analyze] results failed', e);
  }

  return NextResponse.json({
    ok: Object.keys(errors).length === 0,
    duration_ms: Date.now() - t0,
    analyze,
    results,
    errors: Object.keys(errors).length > 0 ? errors : undefined,
  });
}

export async function POST(req: Request) {
  return handle(req);
}

// Allow GET too — Vercel native cron uses GET, GH Actions can use either.
export async function GET(req: Request) {
  return handle(req);
}
