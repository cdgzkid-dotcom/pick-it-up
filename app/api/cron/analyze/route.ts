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
import { fetchGames, fetchInjuriesForSports, fetchEventStatus, fetchEspnClosingLine } from '@/lib/espn';
import { analyzeGames } from '@/lib/pickGen';
import { potentialWin } from '@/lib/units';
import {
  sendTelegramMessage,
  formatPicksMessage,
  formatResultsMessage,
  formatMonteCarloLines,
  formatSupersededOnlyMessage,
  formatPickDigestMessage,
} from '@/lib/telegram';
import type { SupersededPickForTg, PickDigestData } from '@/lib/telegram';
import { simulateDay } from '@/lib/montecarlo';
import { computeStats } from '@/lib/stats';
import { updateFactorPerformance } from '@/lib/learning';
import { runHealthChecks, buildHealthSummary } from '@/lib/healthChecks';
import type { SystemHealthSummary } from '@/lib/healthChecks';
import type { Bet, Game } from '@/lib/types';

/**
 * Compute the system-health summary used as a visible indicator in every
 * Telegram picks message (Auditoría 5). Bounded by a 5s timeout so a slow
 * health check (ESPN BPI lag, Anthropic, etc.) NEVER blocks the user from
 * receiving picks — if we time out, we still surface a yellow indicator
 * saying so, which is more honest than dropping the indicator silently.
 *
 * Side note: runHealthChecks itself uses 5-10s per-check timeouts, but
 * waiting for all 13 worst-cases would push past the cron's maxDuration.
 */
async function computeSystemHealthBounded(timeoutMs = 5000): Promise<SystemHealthSummary> {
  const timeoutFallback: SystemHealthSummary = {
    status: 'warning',
    errors: 0,
    warnings: 1,
    errorNames: [],
    warningNames: ['health_check_timeout'],
    total: 13,
    ok: 12,
  };
  return Promise.race<SystemHealthSummary>([
    runHealthChecks().then(buildHealthSummary),
    new Promise<SystemHealthSummary>((resolve) =>
      setTimeout(() => resolve(timeoutFallback), timeoutMs),
    ),
  ]);
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Regular-season window: 15-60 min before game start. Cron every 10 min
// gives multiple chances to catch each game. We want the FRESHEST data
// (lineups, odds) — not 2.5 hours early when everything can still change.
//
// Fix A (no-odds silence): bumped from 20-45 to 15-60 after diagnosing that
// DK publishes MLB moneylines typically T-30..T-60 min. The old 20-45
// window left us catching DK on the FIRST attempt sometimes — if DK was
// 5 min late the marker stuck and we never retried. 15-60 means we have
// up to 4-5 cron firings per game to land an attempt where DK is ready.
const WINDOW_MIN_MINUTES = 15;
const WINDOW_MAX_MINUTES = 60;
// Playoffs: same widened window for consistency (the late-publishing problem
// affects playoffs too). Was 20-60, now 15-60.
const PLAYOFF_WINDOW_MIN_MINUTES = 15;
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
  //
  // Fix B (no-odds retry): analyzed_no_odds_data markers are NO LONGER a
  // permanent block. If the marker is older than 20 min (measured from
  // updated_at, fallback created_at) AND retry_count<3, we DO re-analyze.
  // This covers DK publishing odds 30-60 min after our first attempt.
  const { data: blockedPicks } = await supabase
    .from('picks')
    .select('espn_event_id, status, telegram_notified_at, created_at, updated_at, retry_count')
    .or('status.in.(pending,bet,analyzed_no_edge,analyzed_no_odds_data),telegram_notified_at.not.is.null')
    .in('espn_event_id', eventIds);

  const alreadyDone = new Set(
    (blockedPicks ?? [])
      .filter((p) => {
        // pending / bet / analyzed_no_edge: ALWAYS block (active picks, or
        // Claude already decided no edge — won't change on retry).
        if (p.status === 'pending' || p.status === 'bet' || p.status === 'analyzed_no_edge') {
          return true;
        }
        // telegram_notified_at not null: ALWAYS block. The pick was shown to
        // the user; we never want to re-bet or re-evaluate it silently.
        if (p.telegram_notified_at) return true;

        // analyzed_no_odds_data: allow retry if cool-off elapsed AND we
        // haven't hit the retry ceiling. updated_at preferred over
        // created_at so each retry resets the cool-off clock.
        if (p.status === 'analyzed_no_odds_data') {
          const lastAttempt = p.updated_at ?? p.created_at;
          const ageMin = (Date.now() - new Date(lastAttempt).getTime()) / 60000;
          const retryCount = p.retry_count ?? 0;
          if (ageMin > 20 && retryCount < 3) {
            console.log('[NO_ODDS_RETRY_ELIGIBLE]', {
              espn_event_id: p.espn_event_id,
              age_min: Math.round(ageMin),
              retry_count: retryCount,
            });
            return false; // not blocked — let it through
          }
        }

        // Default conservative behavior — block.
        return true;
      })
      .map((p) => p.espn_event_id),
  );
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

  if (result.insertedPicks.length === 0 && result.insertedParlays.length === 0 && result.updated === 0) {
    // No new picks, no updates. But if we superseded picks that the user
    // already saw in Telegram, we MUST notify — otherwise they might bet on
    // something the system just pulled. Filter to picks that had a non-null
    // telegram_notified_at before the supersede UPDATE (captured upstream).
    // Pass the full discriminated entry so the message subgroups by reason.
    const supersededNotifiable = result.supersededList
      .filter((s) => s.was_notified)
      .map((s): SupersededPickForTg =>
        s.reason === 'line_moved_against'
          ? {
              pick: s.pick,
              tier: s.tier,
              reason: 'line_moved_against',
              original_odds: s.original_odds,
              current_odds: s.current_odds,
            }
          : { pick: s.pick, tier: s.tier, reason: 'edge_evaporated' },
      );
    if (supersededNotifiable.length > 0) {
      // Auditoría 5: compute system health UNA vez aquí — este es uno de los
      // dos caminos de notificación (el otro es el formatPicksMessage abajo).
      const systemHealth = await computeSystemHealthBounded();
      const text = formatSupersededOnlyMessage(
        supersededNotifiable,
        { bankrollCurrent: Number(settings.bankroll_current), systemHealth },
      );
      await sendTelegramMessage(text);
      return {
        generated: 0,
        eventIds,
        message: 'superseded_only_notified',
      };
    }

    // Pick Digest — replaces the older single-purpose "no DK odds" alert
    // with a unified summary of WHY the cron didn't produce any picks.
    // Surfaces the categories so the user can see the system DID analyze
    // and DID compute, killing the "silent system = broken system" anxiety.
    //
    // Anti-spam: same 2h sliding window via system_notifications, but now
    // keyed by kind='pick_digest'. Legacy kind='no_odds_alert' rows
    // (none in DB today) stay as historical and are ignored by this query.
    const digestData: PickDigestData = {
      analyzedCount: toAnalyze.length,
      edgeBelow: result.edgeBelowEvents.map((e) => ({
        sport: e.sport,
        home_team: e.home_team,
        away_team: e.away_team,
        picked_team: e.picked_team,
        claude_prob: e.claude_prob,
        dk_implied: e.dk_implied,
        edge: e.edge,
      })),
      auditFiltered: result.auditFilteredEvents.map((e) => ({
        sport: e.sport,
        home_team: e.home_team,
        away_team: e.away_team,
        pick: e.pick,
        tier: e.tier,
        failures: e.failures,
      })),
      playoffNoEdge: playoffsAnalyzedNoEdge.map((g) => ({
        sport: g.sport,
        home_team: g.home_team,
        away_team: g.away_team,
        game_start_time: g.start_time ?? null,
      })),
      noPositiveEdge: result.noPositiveEdgeEvents.map((e) => ({
        sport: e.sport,
        home_team: e.home_team,
        away_team: e.away_team,
        home_prob: e.home_prob,
        away_prob: e.away_prob,
        home_dk_implied: e.home_dk_implied,
        away_dk_implied: e.away_dk_implied,
      })),
      noOdds: result.noOddsEvents.map((e) => ({
        sport: e.sport,
        home_team: e.home_team,
        away_team: e.away_team,
        game_start_time: e.game_start_time,
      })),
    };
    const hasDigestContent =
      digestData.edgeBelow.length +
        digestData.auditFiltered.length +
        digestData.playoffNoEdge.length +
        digestData.noPositiveEdge.length +
        digestData.noOdds.length >
      0;

    if (hasDigestContent && digestData.analyzedCount > 0) {
      const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const { data: recentNotif } = await supabase
        .from('system_notifications')
        .select('sent_at')
        .eq('kind', 'pick_digest')
        .gte('sent_at', cutoff)
        .order('sent_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (recentNotif) {
        console.log('[PICK_DIGEST_SUPPRESSED]', {
          last_sent: recentNotif.sent_at,
          reason: 'within_2h_window',
        });
      } else {
        const systemHealth = await computeSystemHealthBounded();
        const text = formatPickDigestMessage(digestData, { systemHealth });
        const sent = await sendTelegramMessage(text);
        if (sent.ok) {
          await supabase.from('system_notifications').insert({
            kind: 'pick_digest',
            payload: {
              kind_version: 1,
              analyzed_count: digestData.analyzedCount,
              by_category: {
                edge_below: digestData.edgeBelow.length,
                audit_filtered: digestData.auditFiltered.length,
                playoff_no_edge: digestData.playoffNoEdge.length,
                no_positive_edge: digestData.noPositiveEdge.length,
                no_odds: digestData.noOdds.length,
              },
              sent_for_run_at: new Date().toISOString(),
            },
          });
          console.log('[PICK_DIGEST_SENT]', {
            analyzed: digestData.analyzedCount,
            categories: {
              edge_below: digestData.edgeBelow.length,
              audit_filtered: digestData.auditFiltered.length,
              playoff_no_edge: digestData.playoffNoEdge.length,
              no_positive_edge: digestData.noPositiveEdge.length,
              no_odds: digestData.noOdds.length,
            },
          });
        } else {
          console.error('[PICK_DIGEST_FAILED]', sent);
        }
      }
    }

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
  // Auditoría 5: visible system-health indicator. Bounded by 5s so a stuck
  // health check never blocks the user from receiving picks.
  const systemHealth = await computeSystemHealthBounded();
  const ctx = {
    bankrollCurrent: Number(settings.bankroll_current),
    record: { wins: stats.wins, losses: stats.losses },
    roi: stats.roi,
    // Only render supersede block inside the normal picks message when at
    // least one of the superseded picks was previously notified — otherwise
    // the user doesn't know what we're warning about. Discriminated by
    // reason so the message subgroups (line_moved_against carries odds).
    supersededPicks: result.supersededList
      .filter((s) => s.was_notified)
      .map((s): SupersededPickForTg =>
        s.reason === 'line_moved_against'
          ? {
              pick: s.pick,
              tier: s.tier,
              reason: 'line_moved_against',
              original_odds: s.original_odds,
              current_odds: s.current_odds,
            }
          : { pick: s.pick, tier: s.tier, reason: 'edge_evaporated' },
      ),
    systemHealth,
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
      edge_vs_market: (p as { edge_vs_market?: number | null }).edge_vs_market ?? null,
      market_sources_count: (p as { market_sources_count?: number | null }).market_sources_count ?? null,
      recommended_amount: Number(p.recommended_amount),
      kelly_fraction: result.kellyByKey[`${p.pick}|${p.bet_type}`] ?? null,
      trap_warning: (p as { trap_warning?: string | null }).trap_warning ?? null,
      best_odds_source: p.best_odds_source ?? null,
      odds_comparison: (p.odds_comparison as Array<{ source: string; ml: number }> | null) ?? undefined,
      analysis: p.analysis,
      // Pinnacle (2026-05-12): only render the inline market line when
      // Pinnacle actually contributed; bpi_implied is not yet persisted in
      // PickRow so the line renders as "DK X% · Pin Y%" for now.
      pinnacle_implied:
        (p as { pinnacle_implied?: number | null }).pinnacle_implied ?? null,
      // Sizing transparency (2026-05-13).
      theoretical_amount: (p as { theoretical_amount?: number | null }).theoretical_amount ?? null,
      sizing_reason: (p as { sizing_reason?: string | null }).sizing_reason ?? null,
      units_actual: (p as { units_actual?: number | null }).units_actual ?? null,
      units_theoretical: (p as { units_theoretical?: number | null }).units_theoretical ?? null,
      sport: p.sport ?? null,
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
  final_score?: string | null;
  home_team?: string | null;
  away_team?: string | null;
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

    const status = await fetchEventStatus(bet.sport, bet.espn_event_id, bet.game_start_time);
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
      // Atomic resolve via RPC. Idempotent — if PATCH /api/bets/:id (manual)
      // already resolved this bet, RPC returns skipped:true and we skip.
      const { error: rpcErr } = await supabase.rpc('resolve_bet_atomic', {
        p_bet_id: bet.id,
        p_result: 'push',
        p_payout: amount,
        p_credit: amount,  // refund stake
        p_cashout_amount: null,
        p_final_score: `${status.away_score}-${status.home_score}`,
        p_odds_at_close: null,
        p_clv: null,
        p_note: `[Auto] PUSH ${bet.pick} (${status.away_score}-${status.home_score})`,
      });
      if (rpcErr) console.error('[cron resolve push] rpc failed', rpcErr.message);
      continue;
    }

    if (won === null) continue;

    const payout = won ? amount + potentialWin(amount, odds) : 0;

    // CLV computation (ML only). Previously this path skipped CLV entirely
    // and the older /api/check-results path read stale picks.odds_decimal —
    // both yielded clv=0 or NULL universally. Now we fetch the true ESPN
    // close.moneyLine.decimal for the side of the bet and persist it.
    //
    // Spread/total out of scope for now: too many mapping branches between
    // pick text and ESPN field shape. They keep odds_at_close=NULL until a
    // future commit extends coverage.
    let oddsAtClose: number | null = null;
    let clvValue: number | null = null;
    if (isML) {
      const side = cronPickedSide(
        bet.pick,
        bet.home_team_abbr,
        bet.away_team_abbr,
        bet.home_team,
        bet.away_team,
      );
      const oddsAtBet = Number(bet.odds_at_bet ?? bet.odds_decimal);
      try {
        const closing = await fetchEspnClosingLine(bet.sport, bet.espn_event_id);
        let source = 'fallback_no_data';
        if (closing && side) {
          const close = side === 'home' ? closing.home_close_decimal : closing.away_close_decimal;
          if (close && close > 1.01) {
            oddsAtClose = close;
            source = 'espn_close';
          }
        }
        if (oddsAtClose == null) oddsAtClose = oddsAtBet;
        clvValue = Number(((1 / oddsAtClose) - (1 / oddsAtBet)).toFixed(6));
        console.log('[CLV_COMPUTED]', {
          bet_id: bet.id,
          pick: bet.pick,
          side,
          odds_at_bet: oddsAtBet,
          odds_at_close: oddsAtClose,
          clv: clvValue,
          source,
        });
      } catch (e) {
        console.warn('[CLV_COMPUTED] fetch error', { bet_id: bet.id, err: (e as Error).message });
        oddsAtClose = oddsAtBet;
        clvValue = 0;
      }
    }

    const finalScore = `${status.away_score}-${status.home_score}`;
    // Atomic resolve via RPC. UPDATE bets + UPDATE bankroll + INSERT log
    // all inside the PL/pgSQL function. Idempotent: if PATCH /api/bets/:id
    // or check-results route already resolved this bet, the RPC returns
    // {skipped:true} and we skip without double-crediting bankroll.
    const { error: rpcErr } = await supabase.rpc('resolve_bet_atomic', {
      p_bet_id: bet.id,
      p_result: won ? 'win' : 'loss',
      p_payout: payout,
      p_credit: payout,
      p_cashout_amount: null,
      p_final_score: finalScore,
      p_odds_at_close: oddsAtClose,
      p_clv: clvValue,
      p_note: `[Auto] ${won ? 'WIN' : 'LOSS'} ${bet.pick} (${status.away_score}-${status.home_score})`,
    });
    if (rpcErr) {
      console.error('[cron resolve] rpc failed', { bet_id: bet.id, err: rpcErr.message });
      continue;
    }

    // Learning: roll this bet's outcome into per-factor performance.
    await updateFactorPerformance(supabase, {
      ...bet,
      result: won ? 'win' : 'loss',
      payout,
    });

    newlyResolved.push({
      bet_id: bet.id,
      pick: bet.pick,
      result: won ? 'win' : 'loss',
      pl: payout - amount,
      is_parlay: (bet.bet_type as string) === 'Parlay',
      final_score: finalScore,
      home_team: bet.home_team,
      away_team: bet.away_team,
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
      final_score: b.final_score ?? null,
      home_team: b.home_team,
      away_team: b.away_team,
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

/**
 * Cleanup orphaned picks: status='bet' but no matching row in the `bets` table
 * AND no espn_event_id. These are leftovers from failed bet flows. After 24h we
 * mark them 'skipped' so they stop appearing in the UI.
 */
async function cleanupOrphanedPicks(): Promise<number> {
  const supabase = supabaseAdmin();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Find picks with status='bet', no espn_event_id, older than 24h
  const { data: candidates } = await supabase
    .from('picks')
    .select('id, pick, espn_event_id')
    .eq('status', 'bet')
    .is('espn_event_id', null)
    .lt('created_at', cutoff);

  if (!candidates || candidates.length === 0) return 0;

  // Double-check: ensure none of these have a matching bet in the bets table
  const pickTexts = candidates.map((c) => c.pick);
  const { data: realBets } = await supabase
    .from('bets')
    .select('pick')
    .in('pick', pickTexts);
  const realBetPicks = new Set((realBets ?? []).map((b) => b.pick));

  const orphanIds = candidates
    .filter((c) => !realBetPicks.has(c.pick))
    .map((c) => c.id);

  if (orphanIds.length === 0) return 0;

  const { error } = await supabase
    .from('picks')
    .update({ status: 'skipped' })
    .in('id', orphanIds);

  if (error) {
    console.error('[cron] orphan cleanup failed', error);
    return 0;
  }

  console.log(`[cron] cleaned ${orphanIds.length} orphaned picks`);
  return orphanIds.length;
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
  let orphansCleaned = 0;

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

  try {
    orphansCleaned = await cleanupOrphanedPicks();
  } catch (e) {
    console.error('[cron/analyze] orphan cleanup failed', e);
  }

  // Heartbeat log: write one row to cron_runs per invocation so the health
  // endpoint can verify the cron is actually firing every 10 min. Failure
  // here MUST NOT block the response — it's audit telemetry, not behavior.
  try {
    await supabaseAdmin().from('cron_runs').insert({
      workflow: 'analyze',
      duration_ms: Date.now() - t0,
      generated_picks: analyze?.generated ?? 0,
      errors: Object.keys(errors).length > 0 ? errors : null,
    });
  } catch (e) {
    console.error('[cron_runs insert failed]', e);
  }

  return NextResponse.json({
    ok: Object.keys(errors).length === 0,
    duration_ms: Date.now() - t0,
    analyze,
    results,
    orphans_cleaned: orphansCleaned,
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
