'use client';
import { useEffect, useState } from 'react';
import { TeamLogo, SportLogo } from './Logo';

interface UpcomingGame {
  espn_event_id: string;
  sport: string;
  game_label: string;
  home_team_abbr?: string;
  away_team_abbr?: string;
  start_time: string;
  has_picks: boolean;
}

interface Props {
  games: UpcomingGame[];
}

function formatTimeMx(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-MX', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Mexico_City',
  });
}

function diffShort(iso: string, now: number): string {
  const t = new Date(iso).getTime();
  const min = Math.round((t - now) / 60_000);
  if (min < 0) return 'ya empezó';
  if (min < 60) return `en ${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `en ${h}h ${m}m` : `en ${h}h`;
}

export default function UpcomingGames({ games }: Props) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  if (games.length === 0) {
    return (
      <div className="bg-card border border-line rounded p-4 text-center text-muted text-xs">
        No hay juegos pendientes hoy
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="text-[10px] text-muted uppercase tracking-wider">
        Próximos juegos · picks llegan 30 min antes
      </div>
      {games.map((g) => {
        const hasLogos = g.away_team_abbr || g.home_team_abbr;
        const [awayName, homeName] = g.game_label.split(/\s+@\s+/);
        const minToStart = Math.round((new Date(g.start_time).getTime() - now) / 60_000);
        const inWindow = minToStart >= 25 && minToStart <= 50;
        const picksDueMin = minToStart - 30;

        return (
          <div key={g.espn_event_id} className="bg-card border border-line rounded p-3 space-y-2">
            {/* Header: logo + big time on left, "en Xm" on right */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <SportLogo sport={g.sport} size={24} />
                <span className="text-xl font-bold">{formatTimeMx(g.start_time)}</span>
              </div>
              <span className="text-xs text-muted">{diffShort(g.start_time, now)}</span>
            </div>

            {/* Matchup row */}
            {hasLogos ? (
              <div className="grid grid-cols-[auto_1fr_auto_1fr_auto] items-center gap-2 text-base">
                <TeamLogo sport={g.sport} abbr={g.away_team_abbr} size={28} className="shrink-0" />
                <span className="font-medium whitespace-normal break-words min-w-0">
                  {awayName ?? ''}
                </span>
                <span className="text-muted text-xs px-0.5 shrink-0">@</span>
                <span className="text-right font-medium whitespace-normal break-words min-w-0">
                  {homeName ?? ''}
                </span>
                <TeamLogo sport={g.sport} abbr={g.home_team_abbr} size={28} className="shrink-0" />
              </div>
            ) : (
              <div className="text-base whitespace-normal break-words">{g.game_label}</div>
            )}

            {/* Status line */}
            <div className="text-sm flex items-center justify-between">
              {g.has_picks ? (
                <span className="text-green">✓ Picks generados</span>
              ) : inWindow ? (
                <span className="text-yellow animate-pulse">⏳ Generando picks…</span>
              ) : picksDueMin > 0 ? (
                <span className="text-muted">
                  Picks llegan en{' '}
                  {Math.floor(picksDueMin / 60) > 0
                    ? `${Math.floor(picksDueMin / 60)}h ${picksDueMin % 60}m`
                    : `${picksDueMin}m`}
                </span>
              ) : (
                <span className="text-muted">Pendiente</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
