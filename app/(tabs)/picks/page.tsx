import { supabaseAdmin } from '@/lib/supabase';
import PickCard from '@/components/PickCard';
import type { Pick, Tier } from '@/lib/types';

export const dynamic = 'force-dynamic';

const TIER_ORDER: Record<Tier, number> = {
  lock: 0,
  strong: 1,
  value: 2,
  parlay: 3,
};

function tierRank(p: Pick): number {
  return p.tier ? TIER_ORDER[p.tier] : TIER_ORDER.value + 0.5;
}

function byTierThenConfidence(a: Pick, b: Pick): number {
  const t = tierRank(a) - tierRank(b);
  if (t !== 0) return t;
  const ca = a.confidence ?? 0;
  const cb = b.confidence ?? 0;
  if (cb !== ca) return cb - ca;
  return (b.edge ?? 0) - (a.edge ?? 0);
}

function formatTime(iso?: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('es-MX', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Mexico_City',
  });
}

function minutesUntil(iso: string): number {
  return Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
}

export default async function PicksPage() {
  const supabase = supabaseAdmin();

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from('picks')
    .select('*')
    .gte('updated_at', since)
    .in('status', ['pending', 'bet'])
    .order('edge', { ascending: false });

  if (error) {
    return <div className="text-red text-sm">Error cargando picks: {error.message}</div>;
  }

  const picks = (data as Pick[]) ?? [];

  const latest = picks.reduce<string | null>((acc, p) => {
    const t = p.updated_at ?? p.created_at;
    if (!t) return acc;
    if (!acc || new Date(t).getTime() > new Date(acc).getTime()) return t;
    return acc;
  }, null);

  const parlays = picks.filter((p) => p.is_parlay).sort(byTierThenConfidence);
  const singles = picks.filter((p) => !p.is_parlay);

  // Group singles by start_time bucket. Picks without start_time go into "Sin horario".
  // Past start time → "Picks anteriores".
  const now = Date.now();
  const buckets = new Map<string, { startTime: string | null; picks: Pick[] }>();
  const past: Pick[] = [];
  const noTime: Pick[] = [];

  for (const p of singles) {
    if (!p.game_start_time) {
      noTime.push(p);
      continue;
    }
    const t = new Date(p.game_start_time).getTime();
    if (t < now - 30 * 60_000) {
      past.push(p);
      continue;
    }
    const key = p.game_start_time;
    if (!buckets.has(key)) buckets.set(key, { startTime: key, picks: [] });
    buckets.get(key)!.picks.push(p);
  }

  const bucketList = Array.from(buckets.values())
    .map((b) => ({ ...b, picks: b.picks.sort(byTierThenConfidence) }))
    .sort((a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? ''));

  if (picks.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold">PICKS</h1>
        <div className="bg-card border border-line rounded-lg p-8 text-center">
          <div className="text-4xl mb-2">🎯</div>
          <div className="text-muted text-sm">No hay picks recientes</div>
          <div className="text-muted text-xs mt-1">
            Los picks llegan automáticamente 30 min antes de cada juego
          </div>
        </div>
      </div>
    );
  }

  let rankCounter = 0;

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-bold">PICKS</h1>
          {latest && (
            <div className="text-[10px] text-muted mt-0.5">
              Último análisis {formatTime(latest)}
            </div>
          )}
        </div>
        <span className="text-xs text-muted">
          {singles.length} singles
          {parlays.length > 0 ? ` · ${parlays.length} parlays` : ''}
        </span>
      </header>

      {bucketList.map((bucket) => {
        const minLeft = bucket.startTime ? minutesUntil(bucket.startTime) : 0;
        const urgent = minLeft <= 60 && minLeft > 0;
        const live = minLeft <= 0;
        return (
          <section key={bucket.startTime} className="space-y-2">
            <div className="flex items-baseline justify-between">
              <div className="text-sm font-bold">
                {formatTime(bucket.startTime)}
              </div>
              {urgent && (
                <span className="text-[10px] text-red bg-red/10 border border-red/40 px-2 py-0.5 rounded uppercase tracking-wider animate-pulse">
                  🔴 Apuesta ahora — juego en {minLeft}m
                </span>
              )}
              {live && (
                <span className="text-[10px] text-yellow bg-yellow/10 border border-yellow/40 px-2 py-0.5 rounded uppercase tracking-wider">
                  En vivo
                </span>
              )}
            </div>
            <div className="space-y-2">
              {bucket.picks.map((p) => {
                rankCounter++;
                return <PickCard key={p.id} pick={p} rank={rankCounter} />;
              })}
            </div>
          </section>
        );
      })}

      {parlays.length > 0 && (
        <section className="space-y-2 pt-2">
          <div className="text-[10px] text-muted uppercase tracking-wider">
            Parlays sugeridos
          </div>
          {parlays.map((p) => {
            rankCounter++;
            return <PickCard key={p.id} pick={p} rank={rankCounter} />;
          })}
        </section>
      )}

      {noTime.length > 0 && (
        <section className="space-y-2 pt-2">
          <div className="text-[10px] text-muted uppercase tracking-wider">
            Sin horario
          </div>
          {noTime.sort(byTierThenConfidence).map((p) => {
            rankCounter++;
            return <PickCard key={p.id} pick={p} rank={rankCounter} />;
          })}
        </section>
      )}

      {past.length > 0 && (
        <section className="space-y-2 pt-4 border-t border-line">
          <div className="text-[10px] text-muted uppercase tracking-wider">
            Picks anteriores ({past.length})
          </div>
          <div className="opacity-60 space-y-2">
            {past.sort(byTierThenConfidence).map((p) => {
              rankCounter++;
              return <PickCard key={p.id} pick={p} rank={rankCounter} />;
            })}
          </div>
        </section>
      )}
    </div>
  );
}
