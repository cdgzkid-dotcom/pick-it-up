import { supabaseAdmin } from '@/lib/supabase';
import type { DrafteaExtractedBet, DrafteaLeg } from '@/lib/vision-extract-bet';

export interface PickCandidate {
  id: string;
  sport: string;
  game: string;
  home_team: string;
  away_team: string;
  pick: string;
  bet_type: string;
  odds_decimal: number;
  tier: string | null;
  recommended_amount: number;
}

export interface LegMatch {
  leg_index: number;
  pick: PickCandidate | null;
  /** screenshot.odds_decimal − pick.odds_decimal. Positive = screenshot better. */
  odds_diff: number | null;
}

export interface MatchResult {
  matches: LegMatch[];
  math_warning: string | null;
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function legsMatch(leg: DrafteaLeg, pick: PickCandidate): boolean {
  const legTeams = leg.teams
    .split(/\s+(?:vs\.?|@|contra)\s+/i)
    .map(norm)
    .filter((t) => t.length >= 3);

  const pickHome = norm(pick.home_team);
  const pickAway = norm(pick.away_team);

  for (const lt of legTeams) {
    if (
      pickHome.includes(lt) || lt.includes(pickHome) ||
      pickAway.includes(lt) || lt.includes(pickAway)
    ) return true;
  }
  return false;
}

export async function matchExtractedBetToPicks(
  extracted: DrafteaExtractedBet,
): Promise<MatchResult> {
  const supabase = supabaseAdmin();
  const { data: pendingPicks } = await supabase
    .from('picks')
    .select('id, sport, game, home_team, away_team, pick, bet_type, odds_decimal, tier, recommended_amount')
    .eq('status', 'pending')
    .gt('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .order('created_at', { ascending: false });

  const picks = (pendingPicks ?? []) as PickCandidate[];

  const matches: LegMatch[] = extracted.legs.map((leg, idx) => {
    const match = picks.find((p) => legsMatch(leg, p)) ?? null;
    const oddsScreenshot = leg.odds_decimal;
    const oddsPick = match ? Number(match.odds_decimal) : null;
    return {
      leg_index: idx,
      pick: match,
      odds_diff:
        oddsPick !== null
          ? Math.round((oddsScreenshot - oddsPick) * 100) / 100
          : null,
    };
  });

  let math_warning: string | null = null;
  const { wager_mxn, total_odds_decimal, potential_payout_mxn } = extracted;
  if (wager_mxn && total_odds_decimal && potential_payout_mxn) {
    const expected = wager_mxn * total_odds_decimal;
    const deviation = Math.abs(potential_payout_mxn - expected) / expected;
    if (deviation > 0.02) {
      math_warning =
        `Los números no cuadran exactamente: ` +
        `$${wager_mxn} × ${total_odds_decimal} = $${expected.toFixed(2)} ` +
        `pero el ticket muestra $${potential_payout_mxn}. Verifica antes de confirmar.`;
    }
  }

  return { matches, math_warning };
}
