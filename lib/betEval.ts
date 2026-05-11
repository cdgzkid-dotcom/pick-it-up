import type { Bet } from './types';

export type LiveBetStatus = 'winning' | 'losing' | 'push' | 'unknown';

export function pickedSide(
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

export function evaluateBetLive(
  bet: Pick<
    Bet,
    | 'bet_type'
    | 'pick'
    | 'home_team'
    | 'away_team'
    | 'home_team_abbr'
    | 'away_team_abbr'
    | 'spread_line'
    | 'total_line'
    | 'bet_direction'
  >,
  homeScore: number,
  awayScore: number,
): LiveBetStatus {
  const betType = String(bet.bet_type).toLowerCase();
  const isML = betType === 'ml' || betType === 'moneyline';
  const isSpread = betType === 'spread' || betType === 'runline' || betType === 'run line';
  const isTotal =
    betType === 'total' || betType === 'over' || betType === 'under' || betType.startsWith('o/u');

  if (isML) {
    const side = pickedSide(
      bet.pick,
      bet.home_team_abbr,
      bet.away_team_abbr,
      bet.home_team,
      bet.away_team,
    );
    if (!side) return 'unknown';
    if (homeScore === awayScore) return 'push';
    const winning =
      (side === 'home' && homeScore > awayScore) ||
      (side === 'away' && awayScore > homeScore);
    return winning ? 'winning' : 'losing';
  }

  if (isSpread) {
    const lineMatch = bet.pick.match(/([+-]?\d+(\.\d+)?)/);
    const line = lineMatch
      ? parseFloat(lineMatch[1])
      : bet.spread_line != null
        ? Number(bet.spread_line)
        : NaN;
    if (!Number.isFinite(line)) return 'unknown';
    const side = pickedSide(
      bet.pick,
      bet.home_team_abbr,
      bet.away_team_abbr,
      bet.home_team,
      bet.away_team,
    );
    if (!side) return 'unknown';
    const adjusted =
      side === 'home' ? homeScore + line - awayScore : awayScore + line - homeScore;
    if (adjusted === 0) return 'push';
    return adjusted > 0 ? 'winning' : 'losing';
  }

  if (isTotal) {
    const lineMatch = bet.pick.match(/(\d+(\.\d+)?)/);
    const line = lineMatch
      ? parseFloat(lineMatch[0])
      : bet.total_line != null
        ? Number(bet.total_line)
        : NaN;
    if (!Number.isFinite(line)) return 'unknown';
    const isOver = /\bover\b/i.test(bet.pick) || bet.bet_direction === 'over';
    const isUnder = /\bunder\b/i.test(bet.pick) || bet.bet_direction === 'under';
    if (!isOver && !isUnder) return 'unknown';
    const total = homeScore + awayScore;
    if (total === line) return 'push';
    const winning = isOver ? total > line : total < line;
    return winning ? 'winning' : 'losing';
  }

  return 'unknown';
}
