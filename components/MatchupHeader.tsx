import { SportLogo } from './Logo';

function formatTimeMx(iso?: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('es-MX', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Mexico_City',
  });
}

interface Props {
  sport: string;
  startTime?: string | null;
  size?: number;
  className?: string;
}

/**
 * League + time header line that sits above the matchup row in
 * PickCard / BetResolver / HistoryRow / UpcomingGames.
 *
 *   [logo 24] MLB · 2:10 PM CDMX
 */
export default function MatchupHeader({
  sport,
  startTime,
  size = 24,
  className = '',
}: Props) {
  const time = formatTimeMx(startTime);
  return (
    <div className={`flex items-center gap-2 text-[11px] text-muted ${className}`}>
      <SportLogo sport={sport} size={size} />
      <span className="font-bold text-fg uppercase tracking-wider">{sport}</span>
      {time && (
        <>
          <span className="text-muted">·</span>
          <span>{time} CDMX</span>
        </>
      )}
    </div>
  );
}
