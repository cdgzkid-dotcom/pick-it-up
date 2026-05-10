import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { fetchEventStatus } from '@/lib/espn';
import { potentialWin } from '@/lib/units';
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
  home_score: number;
  away_score: number;
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
    if (bet.bet_type !== 'ML') continue; // auto-resolve only ML for now

    const status = await fetchEventStatus(bet.sport, bet.espn_event_id);
    if (!status || !status.completed) continue;
    if (status.home_score == null || status.away_score == null) continue;

    const side = pickedSide(
      bet.pick,
      bet.home_team_abbr,
      bet.away_team_abbr,
      bet.home_team,
      bet.away_team,
    );
    if (!side) continue; // can't determine, leave for manual

    const homeWon = status.home_score > status.away_score;
    const awayWon = status.away_score > status.home_score;
    const tied = status.home_score === status.away_score;
    if (tied) continue; // push or extra time, leave manual

    const won = (side === 'home' && homeWon) || (side === 'away' && awayWon);

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

    await supabase
      .from('bets')
      .update({ result: won ? 'win' : 'loss', payout })
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

    resolutions.push({
      bet_id: bet.id,
      pick: bet.pick,
      game: bet.game,
      result: won ? 'win' : 'loss',
      payout,
      pl: payout - amount,
      home_score: status.home_score,
      away_score: status.away_score,
    });
  }

  return NextResponse.json({
    checked: bets.length,
    resolved: resolutions.length,
    resolutions,
  });
}
