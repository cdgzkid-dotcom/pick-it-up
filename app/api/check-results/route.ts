import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { fetchEventStatus } from '@/lib/espn';
import { potentialWin } from '@/lib/units';
import { applyResult as applyEloResult } from '@/lib/elo';
import { updateFactorPerformance } from '@/lib/learning';
import type { Bet } from '@/lib/types';

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

function pickedSide(
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

export async function POST() {
  const supabase = supabaseAdmin();
  const { data: pendingBets, error } = await supabase
    .from('bets')
    .select('*')
    .eq('result', 'pending')
    .not('espn_event_id', 'is', null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const bets = (pendingBets as Bet[]) ?? [];
  if (bets.length === 0) {
    return NextResponse.json({ checked: 0, resolved: 0, resolutions: [] });
  }

  const resolutions: Resolution[] = [];

  for (const bet of bets) {
    if (!bet.espn_event_id) continue;
    const betType = String(bet.bet_type).toLowerCase();
    const isML = betType === 'ml' || betType === 'moneyline';
    const isSpread = betType === 'spread' || betType === 'runline' || betType === 'run line';
    const isTotal = betType === 'total' || betType === 'over' || betType === 'under' || betType.startsWith('o/u');
    if (!isML && !isSpread && !isTotal) continue; // skip props/parlays/etc

    const status = await fetchEventStatus(bet.sport, bet.espn_event_id);
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
      if (homeScore === awayScore) continue; // tie / OT etc — manual
      won = (side === 'home' && homeScore > awayScore) || (side === 'away' && awayScore > homeScore);
    } else if (isSpread) {
      // Parse "Cubs -1.5" or "Cubs +2.5" — pull the signed number
      const lineMatch = bet.pick.match(/([+-]?\d+(\.\d+)?)/);
      const line = lineMatch ? parseFloat(lineMatch[1]) : (bet.spread_line != null ? Number(bet.spread_line) : NaN);
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
      const lineMatch = bet.pick.match(/(\d+(\.\d+)?)/);
      const line = lineMatch ? parseFloat(lineMatch[0]) : (bet.total_line != null ? Number(bet.total_line) : NaN);
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
      const { data: settings } = await supabase.from('settings').select('bankroll_current').eq('id', 1).single();
      const newBankroll = Number(settings?.bankroll_current ?? 0) + amount; // refund stake
      const finalScorePush = `${status.away_score}-${status.home_score}`;
      await supabase
        .from('bets')
        .update({ result: 'push', payout: amount, final_score: finalScorePush })
        .eq('id', bet.id);
      await supabase.from('settings').update({ bankroll_current: newBankroll }).eq('id', 1);
      await supabase.from('bankroll_log').insert([{ type: 'push', amount, balance_after: newBankroll, note: `[Auto] PUSH ${bet.pick} (${finalScorePush})` }]);
      continue;
    }

    if (won === null) continue;

    const amount = Number(bet.amount);
    const odds = Number(bet.odds_decimal);
    const payout = won ? amount + potentialWin(amount, odds) : 0;

    // Apply: update bets, settings, bankroll_log
    const { data: settings } = await supabase
      .from('settings')
      .select('bankroll_current')
      .eq('id', 1)
      .single();
    const newBankroll = Number(settings?.bankroll_current ?? 0) + payout;

    // CLV: odds_at_close = the moneyline at the moment we observed completion.
    // For ML, we approximate with the post-game decimal odds we have on hand
    // (no live moneyline once a game ends — Vegas pulls the line). Better
    // sources would be an opening line snapshot vs closing snapshot, but
    // ESPN doesn't expose that, so we record the at-bet odds vs the
    // last-known odds we tracked. CLV stays accurate when odds_at_bet was
    // captured pre-game and odds_at_close is updated on game start instead
    // of completion — that's the next iteration.
    const oddsAtBet = bet.odds_at_bet != null ? Number(bet.odds_at_bet) : Number(bet.odds_decimal);
    const oddsAtClose = Number(bet.odds_decimal); // best-effort
    const clv = oddsAtBet - oddsAtClose;

    // Save final score for display in tracker history + Telegram message.
    // Format: "away-home" (e.g., "Royals 5 - Tigers 2" rendered from this).
    const finalScore = `${status.away_score}-${status.home_score}`;

    await supabase
      .from('bets')
      .update({
        result: won ? 'win' : 'loss',
        payout,
        odds_at_close: oddsAtClose,
        clv,
        final_score: finalScore,
      })
      .eq('id', bet.id);

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

  return NextResponse.json({
    checked: bets.length,
    resolved: resolutions.length,
    resolutions,
  });
}
