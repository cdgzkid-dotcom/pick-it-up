import { supabaseAdmin } from '@/lib/supabase';
import PickCard from '@/components/PickCard';
import type { Pick } from '@/lib/types';

export const dynamic = 'force-dynamic';

function formatTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('es-MX', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
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

  // Compute latest analysis time for header
  const latest = picks.reduce<string | null>((acc, p) => {
    const t = p.updated_at ?? p.created_at;
    if (!t) return acc;
    if (!acc || new Date(t).getTime() > new Date(acc).getTime()) return t;
    return acc;
  }, null);

  // Sort: bet at top, then pending by edge desc, parlays after
  const bet = picks.filter((p) => p.status === 'bet');
  const pendingSingles = picks.filter((p) => p.status === 'pending' && !p.is_parlay);
  const pendingParlays = picks.filter((p) => p.status === 'pending' && p.is_parlay);

  if (picks.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold">PICKS</h1>
        <div className="bg-card border border-line rounded-lg p-8 text-center">
          <div className="text-4xl mb-2">🎯</div>
          <div className="text-muted text-sm">No hay picks recientes</div>
          <div className="text-muted text-xs mt-1">
            Ve a Home y toca &quot;Generar picks&quot;
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-bold">PICKS</h1>
          {latest && (
            <div className="text-[10px] text-muted mt-0.5">
              Análisis de {formatTime(latest)}
            </div>
          )}
        </div>
        <span className="text-xs text-muted">
          {pendingSingles.length + pendingParlays.length} pendientes
          {bet.length > 0 ? ` · ${bet.length} apostados` : ''}
        </span>
      </header>

      {bet.length > 0 && (
        <section className="space-y-2">
          <div className="text-[10px] text-muted uppercase tracking-wider">
            Apostados hoy
          </div>
          {bet.map((p, i) => (
            <PickCard key={p.id} pick={p} rank={i + 1} />
          ))}
        </section>
      )}

      {pendingSingles.length > 0 && (
        <>
          <div className="bg-card border border-line rounded p-3 text-xs text-muted">
            Rankeados por edge ajustado · momios decimal · cross-sport
          </div>
          <div className="space-y-3">
            {pendingSingles.map((p, i) => (
              <PickCard key={p.id} pick={p} rank={i + 1} />
            ))}
          </div>
        </>
      )}

      {pendingParlays.length > 0 && (
        <section className="space-y-3 pt-2">
          <div className="text-[10px] text-muted uppercase tracking-wider">
            Parlays sugeridos
          </div>
          {pendingParlays.map((p, i) => (
            <PickCard key={p.id} pick={p} rank={pendingSingles.length + i + 1} />
          ))}
        </section>
      )}
    </div>
  );
}
