import { supabaseAdmin } from '@/lib/supabase';
import PickCard from '@/components/PickCard';
import type { Pick } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function PicksPage() {
  const supabase = supabaseAdmin();

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from('picks')
    .select('*')
    .gte('created_at', since)
    .in('status', ['pending', 'bet'])
    .order('edge', { ascending: false });

  if (error) {
    return (
      <div className="text-red text-sm">
        Error cargando picks: {error.message}
      </div>
    );
  }

  const picks = (data as Pick[]) ?? [];
  const pendingSingles = picks.filter((p) => !p.is_parlay && p.status === 'pending');
  const pendingParlays = picks.filter((p) => p.is_parlay && p.status === 'pending');
  const alreadyBet = picks.filter((p) => p.status === 'bet');

  if (picks.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold">PICKS</h1>
        <div className="bg-card border border-line rounded-lg p-8 text-center">
          <div className="text-4xl mb-2">🎯</div>
          <div className="text-muted text-sm">No hay picks recientes</div>
          <div className="text-muted text-xs mt-1">
            Ve a Home y toca &quot;GENERA PICKS&quot;
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-bold">PICKS</h1>
        <span className="text-xs text-muted">
          {pendingSingles.length + pendingParlays.length} pendientes
          {alreadyBet.length > 0 ? ` · ${alreadyBet.length} apostados` : ''}
        </span>
      </header>

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

      {alreadyBet.length > 0 && (
        <section className="space-y-2 pt-4">
          <div className="text-[10px] text-muted uppercase tracking-wider">
            Ya apostados ({alreadyBet.length})
          </div>
          <div className="space-y-2">
            {alreadyBet.map((p, i) => (
              <PickCard key={p.id} pick={p} rank={i + 1} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
