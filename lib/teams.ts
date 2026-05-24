interface TeamEntry {
  name: string;
  abbr: string;
  aliases: string[];
}

export const NBA_TEAMS: TeamEntry[] = [
  { name: 'Atlanta Hawks', abbr: 'ATL', aliases: ['Hawks'] },
  { name: 'Boston Celtics', abbr: 'BOS', aliases: ['Celtics'] },
  { name: 'Brooklyn Nets', abbr: 'BKN', aliases: ['Nets'] },
  { name: 'Charlotte Hornets', abbr: 'CHA', aliases: ['Hornets'] },
  { name: 'Chicago Bulls', abbr: 'CHI', aliases: ['Bulls'] },
  { name: 'Cleveland Cavaliers', abbr: 'CLE', aliases: ['Cavaliers', 'Cavs'] },
  { name: 'Dallas Mavericks', abbr: 'DAL', aliases: ['Mavericks', 'Mavs'] },
  { name: 'Denver Nuggets', abbr: 'DEN', aliases: ['Nuggets'] },
  { name: 'Detroit Pistons', abbr: 'DET', aliases: ['Pistons'] },
  { name: 'Golden State Warriors', abbr: 'GSW', aliases: ['Warriors', 'GS Warriors'] },
  { name: 'Houston Rockets', abbr: 'HOU', aliases: ['Rockets'] },
  { name: 'Indiana Pacers', abbr: 'IND', aliases: ['Pacers'] },
  { name: 'Los Angeles Clippers', abbr: 'LAC', aliases: ['Clippers', 'LA Clippers'] },
  { name: 'Los Angeles Lakers', abbr: 'LAL', aliases: ['Lakers', 'LA Lakers'] },
  { name: 'Memphis Grizzlies', abbr: 'MEM', aliases: ['Grizzlies'] },
  { name: 'Miami Heat', abbr: 'MIA', aliases: ['Heat'] },
  { name: 'Milwaukee Bucks', abbr: 'MIL', aliases: ['Bucks'] },
  { name: 'Minnesota Timberwolves', abbr: 'MIN', aliases: ['Timberwolves', 'Wolves'] },
  { name: 'New Orleans Pelicans', abbr: 'NOP', aliases: ['Pelicans'] },
  { name: 'New York Knicks', abbr: 'NYK', aliases: ['Knicks'] },
  { name: 'Oklahoma City Thunder', abbr: 'OKC', aliases: ['Thunder'] },
  { name: 'Orlando Magic', abbr: 'ORL', aliases: ['Magic'] },
  { name: 'Philadelphia 76ers', abbr: 'PHI', aliases: ['76ers', 'Sixers'] },
  { name: 'Phoenix Suns', abbr: 'PHX', aliases: ['Suns'] },
  { name: 'Portland Trail Blazers', abbr: 'POR', aliases: ['Trail Blazers', 'Blazers'] },
  { name: 'Sacramento Kings', abbr: 'SAC', aliases: ['Kings'] },
  { name: 'San Antonio Spurs', abbr: 'SAS', aliases: ['Spurs'] },
  { name: 'Toronto Raptors', abbr: 'TOR', aliases: ['Raptors'] },
  { name: 'Utah Jazz', abbr: 'UTA', aliases: ['Jazz'] },
  { name: 'Washington Wizards', abbr: 'WAS', aliases: ['Wizards'] },
];

export const WNBA_TEAMS: TeamEntry[] = [
  { name: 'Atlanta Dream', abbr: 'ATL', aliases: ['Dream'] },
  { name: 'Chicago Sky', abbr: 'CHI', aliases: ['Sky'] },
  { name: 'Connecticut Sun', abbr: 'CON', aliases: ['Sun'] },
  { name: 'Dallas Wings', abbr: 'DAL', aliases: ['Wings'] },
  { name: 'Golden State Valkyries', abbr: 'GS', aliases: ['Valkyries'] },
  { name: 'Indiana Fever', abbr: 'IND', aliases: ['Fever'] },
  { name: 'Las Vegas Aces', abbr: 'LV', aliases: ['Aces'] },
  { name: 'Los Angeles Sparks', abbr: 'LA', aliases: ['Sparks', 'LA Sparks'] },
  { name: 'Minnesota Lynx', abbr: 'MIN', aliases: ['Lynx'] },
  { name: 'New York Liberty', abbr: 'NY', aliases: ['Liberty'] },
  { name: 'Phoenix Mercury', abbr: 'PHX', aliases: ['Mercury'] },
  { name: 'Portland Fire', abbr: 'POR', aliases: ['Fire'] },
  { name: 'Seattle Storm', abbr: 'SEA', aliases: ['Storm'] },
  { name: 'Toronto Tempo', abbr: 'TOR', aliases: ['Tempo'] },
  { name: 'Washington Mystics', abbr: 'WSH', aliases: ['Mystics'] },
];

function matchesTeam(query: string, team: TeamEntry): boolean {
  const q = query.toLowerCase();
  if (team.name.toLowerCase().includes(q)) return true;
  if (team.abbr.toLowerCase() === q) return true;
  return team.aliases.some((a) => a.toLowerCase().includes(q) || q.includes(a.toLowerCase()));
}

export function resolveLeagueByTeamName(name: string): 'NBA' | 'WNBA' | null {
  const nba = NBA_TEAMS.some((t) => matchesTeam(name, t));
  const wnba = WNBA_TEAMS.some((t) => matchesTeam(name, t));
  if (nba && wnba) return null;
  if (nba) return 'NBA';
  if (wnba) return 'WNBA';
  return null;
}
