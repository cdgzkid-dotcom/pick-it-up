import Image from 'next/image';

const TEAM_LOGO_SPORT: Record<string, string> = {
  NBA: 'nba',
  NFL: 'nfl',
  MLB: 'mlb',
  NHL: 'nhl',
};

const SPORT_LEAGUE_LOGO: Record<string, string> = {
  NBA: 'https://a.espncdn.com/i/teamlogos/leagues/500/nba.png',
  NFL: 'https://a.espncdn.com/i/teamlogos/leagues/500/nfl.png',
  MLB: 'https://a.espncdn.com/i/teamlogos/leagues/500/mlb.png',
  NHL: 'https://a.espncdn.com/i/teamlogos/leagues/500/nhl.png',
  UFC: 'https://a.espncdn.com/i/teamlogos/leagues/500/ufc.png',
};

export function teamLogoUrl(sport: string, abbr?: string | null): string | null {
  const sportPath = TEAM_LOGO_SPORT[sport];
  if (!sportPath || !abbr) return null;
  return `https://a.espncdn.com/i/teamlogos/${sportPath}/500/${abbr.toLowerCase()}.png`;
}

export function sportLeagueLogoUrl(sport: string): string | null {
  return SPORT_LEAGUE_LOGO[sport] ?? null;
}

interface TeamLogoProps {
  sport: string;
  abbr?: string | null;
  size?: number;
  className?: string;
  alt?: string;
}

export function TeamLogo({ sport, abbr, size = 32, className = '', alt }: TeamLogoProps) {
  const url = teamLogoUrl(sport, abbr);
  if (!url) {
    return (
      <span
        className={`inline-flex items-center justify-center rounded bg-line text-[8px] text-muted ${className}`}
        style={{ width: size, height: size }}
      >
        {abbr?.toUpperCase().slice(0, 3) ?? '·'}
      </span>
    );
  }
  return (
    <Image
      src={url}
      alt={alt ?? abbr ?? 'team'}
      width={size}
      height={size}
      className={className}
      unoptimized
    />
  );
}

interface SportLogoProps {
  sport: string;
  size?: number;
  className?: string;
}

export function SportLogo({ sport, size = 20, className = '' }: SportLogoProps) {
  const url = sportLeagueLogoUrl(sport);
  if (!url) return null;
  return (
    <Image
      src={url}
      alt={sport}
      width={size}
      height={size}
      className={className}
      unoptimized
    />
  );
}
