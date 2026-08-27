import type { Bet } from './types';
import { NBA_TEAMS, WNBA_TEAMS } from './teams';

export type LiveBetStatus = 'winning' | 'losing' | 'push' | 'unknown';

/**
 * Team-side resolver for pick text ("Detroit Tigers ML", "Lakers -5.5",
 * "Red Sox +1.5", "DET ML", parlay legs joined with " + ").
 *
 * Matching is done on whole-word tokens over normalized text (lowercase,
 * accents stripped, punctuation → space) so short ESPN abbreviations can
 * never match inside a longer word (`ne` ⊄ "minnesota", `la` ⊄
 * "philadelphia", `car` ⊄ "cardinals").
 *
 * Priority: full name > nickname (name suffixes + known aliases) > city
 * (name prefixes) > abbreviation. Within a level the longest matching phrase
 * wins ("Red Sox" beats "Sox"; "New Orleans" beats "New"). If both sides tie
 * at the first level with any hit, or nothing hits at all, returns null —
 * never guesses.
 */
export function pickedSide(
  pickText: string,
  homeAbbr?: string | null,
  awayAbbr?: string | null,
  homeName?: string | null,
  awayName?: string | null,
): 'home' | 'away' | null {
  const haystack = ` ${normalizeText(pickText)} `;
  if (haystack.trim().length === 0) return null;

  const home = buildSideCandidates(homeName, homeAbbr);
  const away = buildSideCandidates(awayName, awayAbbr);

  for (let level = 0; level < home.length; level++) {
    // Full name and abbreviation are exact identities: a hit is a hit, word
    // count must not break ties ("Detroit Tigers" vs "New York Yankees").
    // Nickname/city levels use longest-phrase-wins ("Red Sox" > "Sox").
    const exact = level === LEVEL_FULL_NAME || level === LEVEL_ABBR;
    const h = bestPhraseLength(haystack, home[level], exact);
    const a = bestPhraseLength(haystack, away[level], exact);
    if (h === 0 && a === 0) continue;
    if (h > a) return 'home';
    if (a > h) return 'away';
    // Tie at the first level with a hit: ambiguous (e.g. "Sox ML" with
    // Red Sox vs White Sox, "New York ML" with Yankees vs Mets). Never guess.
    console.warn('[pickedSide] ambiguous match', { pick: pickText, level, homeAbbr, awayAbbr, homeName, awayName });
    return null;
  }

  console.warn('[pickedSide] no match', { pick: pickText, homeAbbr, awayAbbr, homeName, awayName });
  return null;
}

/** lowercase, strip diacritics, collapse anything non-alphanumeric to a single space. */
function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const LEVEL_FULL_NAME = 0;
const LEVEL_ABBR = 3;

/**
 * Longest phrase (in words) from `phrases` that appears as whole words in
 * `haystack`; 0 if none. With `exact`, any hit scores 1 (presence only).
 */
function bestPhraseLength(haystack: string, phrases: string[], exact = false): number {
  let best = 0;
  for (const phrase of phrases) {
    if (!phrase) continue;
    if (haystack.includes(` ${phrase} `)) {
      const len = exact ? 1 : phrase.split(' ').length;
      if (len > best) best = len;
    }
  }
  return best;
}

/**
 * Candidate phrases per priority level for one side:
 *   [0] full name
 *   [1] nickname: 2-word and 1-word suffixes of the name + aliases from lib/teams
 *   [2] city: every proper prefix of the name
 *   [3] abbreviation (whole token only)
 */
function buildSideCandidates(name?: string | null, abbr?: string | null): string[][] {
  const words = name ? normalizeText(name).split(' ').filter(Boolean) : [];
  const full = words.length > 0 ? [words.join(' ')] : [];

  const nickname: string[] = [];
  if (words.length >= 3) nickname.push(words.slice(-2).join(' '));
  if (words.length >= 2) nickname.push(words[words.length - 1]);
  if (words.length > 0) {
    const fullName = words.join(' ');
    for (const team of [...NBA_TEAMS, ...WNBA_TEAMS]) {
      if (normalizeText(team.name) !== fullName) continue;
      for (const alias of team.aliases) {
        const n = normalizeText(alias);
        if (n && n !== fullName && !nickname.includes(n)) nickname.push(n);
      }
    }
  }

  const city: string[] = [];
  for (let i = words.length - 1; i >= 1; i--) city.push(words.slice(0, i).join(' '));

  const abbrs = abbr ? [normalizeText(abbr)].filter(Boolean) : [];

  return [full, nickname, city, abbrs];
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
