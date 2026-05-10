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

// Regular-season window: 20-45 min before game start. Cron every 10 min
// gives multiple chances to catch each game. We want the FRESHEST data
// (lineups, odds) — not 2.5 hours early when everything can still change.
const WINDOW_MIN_MINUTES = 20;
const WINDOW_MAX_MINUTES = 45;
// Playoffs: same freshness principle — 20-60 min before, never earlier.
// The dedup guard prevents re-analyzing the same event.
const PLAYOFF_WINDOW_MIN_MINUTES = 20;
const PLAYOFF_WINDOW_MAX_MINUTES = 60;

/**
 * Date-based heuristic for whether `sport` is currently in postseason.
 * Avoids relying on ESPN's `season.type` field (not always exposed by
 * scoreboard endpoint consistently across sports).
 */
function isPlayoffSeason(sport: string, date: Date = new Date()): boolean {
  const m = date.getUTCMonth() + 1; // 1..12
  const d = date.getUTCDate();
  if (sport === 'NBA' || sport === 'NHL') {
    if (m === 4 && d >= 15) return true;
    if (m === 5 || m === 6) return true;
    return false;
  }
  if (sport === 'MLB') {
    if (m === 10) return true;
    if (m === 11 && d <= 15) return true;
    return false;
  }
  if (sport === 'NFL') {
    if (m === 1 && d >= 5) return true;
    if (m === 2 && d <= 15) return true;
    return false;
  }
  return false;
}

function withinWindow(sport: string, startIso: string | undefined): boolean {
  if (!startIso) return false;
  const t = new Date(startIso).getTime();
  if (Number.isNaN(t)) return false;
  const diffMin = (t - Date.now()) / 60_000;
  const playoff = isPlayoffSeason(sport);
  const min = playoff ? PLAYOFF_WINDOW_MIN_MINUTES : WINDOW_MIN_MINUTES;
  const max = playoff ? PLAYOFF_WINDOW_MAX_MINUTES : WINDOW_MAX_MINUTES;
  return diffMin >= min && diffMin <= max;
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

  const inWindow = games.filter((g) => withinWindow(g.sport, g.start_time));
  const playoffsInWindow = inWindow.filter((g) => isPlayoffSeason(g.sport));
  console.log(`[AUDIT][cron] in-window games: ${inWindow.length} (filtered out ${games.length - inWindow.length} outside window) · playoffs in window: ${playoffsInWindow.length}`);
  if (inWindow.length === 0) {
    return { generated: 0, eventIds: [], message: 'no_games_in_window' };
  }

  const eventIds = inWindow.map((g) => g.espn_event_id).filter((x): x is string => Boolean(x));

  // Dedup guard: skip events that either already have a pending/bet pick,
  // were ever notified via Telegram (telegram_notified_at), OR were marked
  // as 'analyzed_no_edge' (for playoff games we already looked at but
  // Claude found no edge — don't re-burn Claude tokens on the same game).
  const { data: blockedPicks } = await supabase
    .from('picks')
    .select('espn_event_id, status, telegram_notified_at')
    .or('status.in.(pending,bet,analyzed_no_edge),telegram_notified_at.not.is.null')
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

  // Cap how many games we analyze per cron run so we stay under Vercel's
  // 60s maxDuration. With real-data enrichment (MLB/NHL/Odds/ELO/weather)
  // + Anthropic concurrency limit ~5 parallel Claude calls + Sonnet 4.6
  // ~25-40s per batch, we need a tight cap. 6 games = 3 batches = wall
  // ~30-40s total (ESPN+enrichment ~10s, Claude wall ~25s, DB ~3s).
  // Games we skip will reappear in subsequent cron runs every 10 min.
  const MAX_FRESH_GAMES = 3;
  let toAnalyze: Game[] = fresh;
  if (fresh.length > MAX_FRESH_GAMES) {
    const scored = fresh.map((g) => {
      const startMs = g.start_time ? new Date(g.start_time).getTime() : Number.POSITIVE_INFINITY;
      const minToStart = (startMs - Date.now()) / 60_000;
      const playoffBonus = isPlayoffSeason(g.sport) ? -1000 : 0; // negative pushes to front
      return { g, score: playoffBonus + minToStart };
    });
    scored.sort((a, b) => a.score - b.score);
    toAnalyze = scored.slice(0, MAX_FRESH_GAMES).map((s) => s.g);
    console.log(`[AUDIT][cron] capping ${fresh.length} → ${MAX_FRESH_GAMES} (playoffs first, then closest to start)`);
  }

  const result = await analyzeGames(toAnalyze, supabase, {
    bankroll: Number(settings.bankroll_current),
    unitPercentage: Number(settings.unit_percentage),
  });

  // Identify playoff games that were analyzed but produced no pick. We mark
  // them with a 'analyzed_no_edge' row so the dedup guard skips them next
  // cron run (no point burning Claude tokens twice on the same playoff
  // game with no edge), and we surface them via Telegram so the user knows
  // the system DID look at the game.
  const eventIdsWithPicks = new Set(
    result.insertedPicks.map((p) => p.espn_event_id).filter((x): x is string => Boolean(x)),
  );
  const playoffsAnalyzedNoEdge = toAnalyze.filter(
    (g) => isPlayoffSeason(g.sport) && g.espn_event_id && !eventIdsWithPicks.has(g.espn_event_id),
  );

  if (playoffsAnalyzedNoEdge.length > 0) {
    // Insert marker rows so dedup blocks future re-analysis
    const markers = playoffsAnalyzedNoEdge.map((g) => ({
      sport: g.sport,
      league: g.league ?? null,
      game: `${g.away_team} @ ${g.home_team}`,
      home_team: g.home_team,
      away_team: g.away_team,
      home_team_abbr: g.home_team_abbr ?? null,
      away_team_abbr: g.away_team_abbr ?? null,
      espn_event_id: g.espn_event_id!,
      pick: '—',
      bet_type: 'ML',
      odds_decimal: 1,
      confidence: 0,
      real_probability: 0,
      implied_probability: 0,
      edge: 0,
      recommended_amount: 0,
      tier: 'value',
      status: 'analyzed_no_edge',
      is_parlay: false,
      game_start_time: g.start_time ?? null,
      picks_generated_at: new Date().toISOString(),
    }));
    const { error: markerErr } = await supabase.from('picks').insert(markers);
    if (markerErr) console.error('[cron] no_edge markers insert failed', markerErr);

    // Send playoff "analyzed without edge" notification
    const lines: string[] = ['*Playoffs analizados sin edge*', ''];
    for (const g of playoffsAnalyzedNoEdge) {
      lines.push(`• ${g.sport}: ${g.away_team} @ ${g.home_team}`);
      lines.push(`  Sistema analizó, no encontró edge para apostar.`);
    }
    await sendTelegramMessage(lines.join('\n'));
  }

  if (result.insertedPicks.length === 0 && result.insertedParlays.length === 0) {
    return {
      generated: 0,
      eventIds,
      message: playoffsAnalyzedNoEdge.length > 0 ? 'playoff_no_edge_notified' : 'no_picks_with_edge',
    };
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
      edge_vs_sharp: (p as { edge_vs_sharp?: number | null }).edge_vs_sharp ?? null,
      recommended_amount: Number(p.recommended_amount),
      kelly_fraction: result.kellyByKey[`${p.pick}|${p.bet_type}`] ?? null,
      trap_warning: (p as { trap_warning?: string | null }).trap_warning ?? null,
      best_odds_source: p.best_odds_source ?? null,
      odds_comparison: (p.odds_comparison as Array<{ source: string; ml: number }> | null) ?? undefined,
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

function cronPickedSide(
  pickText: string,
  homeAbbr?: string | null,
  awayAbbr?: string | null,
  homeName?: string | null,
  awayName?: string | null,
): 'home' | 'away' | null {
  const p = pickText.toLowerCase();
  const checkAbbr = (a?: string | null) => a && p.includes(a.toLowerCase());
  if (checkAbbr(homeAbbr)) return 'home';
  if (checkAbbr(awayAbbr)) return 'away';
  const lastWord = (s?: string | null) => {
    if (!s) return null;
    const w = s.toLowerCase().split(/\s+/).filter(Boolean);
    return w.length > 0 ? w[w.length - 1] : null;
  };
  const hw = lastWord(homeName);
  const aw = lastWord(awayName);
  if (hw && hw.length >= 4 && p.includes(hw)) return 'home';
  if (aw && aw.length >= 4 && p.includes(aw)) return 'away';
  return null;
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
    const betType = String(bet.bet_type).toLowerCase();
    const isML = betType === 'ml' || betType === 'moneyline';
    const isSpread = betType === 'spread' || betType === 'runline' || betType === 'run line';
    const isTotal = betType === 'total' || betType === 'over' || betType === 'under' || betType.startsWith('o/u');
    if (!isML && !isSpread && !isTotal) continue;

    const status = await fetchEventStatus(bet.sport, bet.espn_event_id);
    if (!status || !status.completed) continue;
    if (status.home_score == null || status.away_score == null) continue;

    const homeScore = status.home_score;
    const awayScore = status.away_score;
    let won: boolean | null = null;
    let isPush = false;

    if (isML) {
      if (homeScore === awayScore) continue;
      const side = cronPickedSide(bet.pick, bet.home_team_abbr, bet.away_team_abbr, bet.home_team, bet.away_team);
      if (!side) continue;
      won = (side === 'home' && homeScore > awayScore) || (side === 'away' && awayScore > homeScore);
    } else if (isSpread) {
      const lineMatch = bet.pick.match(/([+-]?\d+(\.\d+)?)/);
      const line = lineMatch ? parseFloat(lineMatch[1]) : NaN;
      if (!Number.isFinite(line)) continue;
      const side = cronPickedSide(bet.pick, bet.home_team_abbr, bet.away_team_abbr, bet.home_team, bet.away_team);
      if (!side) continue;
      const adjusted = side === 'home' ? homeScore + line - awayScore : awayScore + line - homeScore;
      if (adjusted === 0) isPush = true;
      else won = adjusted > 0;
    } else if (isTotal) {
      const lineMatch = bet.pick.match(/(\d+(\.\d+)?)/);
      const line = lineMatch ? parseFloat(lineMatch[0]) : NaN;
      if (!Number.isFinite(line)) continue;
      const isOver = /\bover\b/i.test(bet.pick);
      const isUnder = /\bunder\b/i.test(bet.pick);
      if (!isOver && !isUnder) continue;
      const total = homeScore + awayScore;
      if (total === line) isPush = true;
      else won = isOver ? total > line : total < line;
    }

    const amount = Number(bet.amount);
    const odds = Number(bet.odds_decimal);

    if (isPush) {
      const { data: settings } = await supabase.from('settings').select('bankroll_current').eq('id', 1).single();
      const newBankroll = Number(settings?.bankroll_current ?? 0) + amount;
      await supabase.from('bets').update({ result: 'push', payout: amount, result_notified_at: null }).eq('id', bet.id);
      await supabase.from('settings').update({ bankroll_current: newBankroll }).eq('id', 1);
      await supabase.from('bankroll_log').insert([{ type: 'push', amount, balance_after: newBankroll, note: `[Auto] PUSH ${bet.pick} (${status.away_score}-${status.home_score})` }]);
      continue;
    }

    if (won === null) continue;

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
