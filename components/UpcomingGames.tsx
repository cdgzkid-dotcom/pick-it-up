'use client';
import { useEffect, useState } from 'react';

interface UpcomingGame {
  espn_event_id: string;
  sport: string;
  game_label: string;
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

  // Group by hour bucket
  const byHour = new Map<string, UpcomingGame[]>();
  for (const g of games) {
    const key = formatTimeMx(g.start_time);
    if (!byHour.has(key)) byHour.set(key, []);
    byHour.get(key)!.push(g);
  }

  return (
    <div className="space-y-2">
      <div className="text-[10px] text-muted uppercase tracking-wider">
        Próximos juegos · picks llegan 30 min antes
      </div>
      {Array.from(byHour.entries()).map(([time, gs]) => {
        const earliest = gs.map((g) => g.start_time).sort()[0];
        const minToStart = Math.round((new Date(earliest).getTime() - now) / 60_000);
        const allPicked = gs.every((g) => g.has_picks);
        const picksDueMin = minToStart - 30;
        const inWindow = minToStart >= 25 && minToStart <= 50;
        return (
          <div key={time} className="bg-card border border-line rounded p-3">
            <div className="flex items-baseline justify-between mb-1.5">
              <div className="text-sm font-bold">{time}</div>
              <div className="text-[10px] text-muted">{diffShort(earliest, now)}</div>
            </div>
            <div className="space-y-0.5">
              {gs.map((g) => (
                <div key={g.espn_event_id} className="flex items-center gap-2 text-[11px]">
                  <span className="text-muted w-12">{g.sport}</span>
                  <span className="flex-1 truncate">{g.game_label}</span>
                  {g.has_picks && <span className="text-green text-[10px]">✓ pick</span>}
                </div>
              ))}
            </div>
            <div className="mt-2 text-[10px]">
              {allPicked ? (
                <span className="text-green">✓ Picks generados</span>
              ) : inWindow ? (
                <span className="text-yellow animate-pulse">⏳ Generando picks…</span>
              ) : picksDueMin > 0 ? (
                <span className="text-muted">
                  Picks llegan en {Math.floor(picksDueMin / 60) > 0
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
