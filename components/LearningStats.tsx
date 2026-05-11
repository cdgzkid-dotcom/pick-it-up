import { supabaseAdmin } from '@/lib/supabase';

interface FactorRow {
  factor_name: string;
  factor_value: string | null;
  sport: string | null;
  total_picks: number;
  wins: number;
  losses: number;
  total_profit: number;
  win_rate: number;
  last_updated: string;
}

interface WeightRow {
  sport: string;
  factor_name: string;
  weight: number;
  sample_size: number;
  last_calibrated: string;
}

export default async function LearningStats() {
  const supabase = supabaseAdmin();

  const [factorsRes, weightsRes] = await Promise.all([
    supabase
      .from('factor_performance')
      .select('*')
      .gte('total_picks', 5)
      .order('total_picks', { ascending: false }),
    supabase
      .from('system_weights')
      .select('*')
      .order('last_calibrated', { ascending: false }),
  ]);

  const factors = (factorsRes.data as FactorRow[]) ?? [];
  const weights = (weightsRes.data as WeightRow[]) ?? [];
  const enough = factors.filter((f) => f.total_picks >= 20);

  const lastCal = weights[0]?.last_calibrated;
  const lastCalText = lastCal
    ? new Date(lastCal).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' })
    : null;

  if (enough.length === 0) {
    return (
      <section className="space-y-2">
        <div className="text-[10px] text-muted uppercase tracking-wider">
          🧠 Aprendizaje del sistema
        </div>
        <div className="bg-card border border-line rounded p-4 text-xs text-muted text-center">
          Necesita más data — el sistema aprende después de 50+ apuestas resueltas.
          {factors.length > 0 && (
            <div className="text-[10px] mt-2">
              Factores en seguimiento: {factors.length} · con muestra ≥20: {enough.length}
            </div>
          )}
        </div>
      </section>
    );
  }

  const sortedByWR = [...enough].sort((a, b) => Number(b.win_rate) - Number(a.win_rate));
  const top5 = sortedByWR.slice(0, 5);
  const bottom5 = sortedByWR.slice(-5).reverse();

  // Group weights by sport for display
  const bySport: Record<string, WeightRow[]> = {};
  for (const w of weights) {
    if (!bySport[w.sport]) bySport[w.sport] = [];
    bySport[w.sport].push(w);
  }

  return (
    <section className="space-y-3">
      <div className="text-[10px] text-muted uppercase tracking-wider">
        🧠 Aprendizaje del sistema
      </div>

      <div className="bg-card border border-line rounded p-3 space-y-1">
        <div className="text-[11px] text-fg">
          El sistema se recalibra automáticamente cada lunes.
        </div>
        {lastCalText && (
          <div className="text-[10px] text-muted">
            Última calibración: {lastCalText}
          </div>
        )}
      </div>

      <div>
        <div className="text-[10px] text-muted uppercase tracking-wider mb-2">
          Top 5 factores rentables
        </div>
        <div className="bg-card border border-line rounded overflow-hidden">
          <div className="grid grid-cols-[1fr_auto_auto] gap-3 px-3 py-2 border-b border-line text-[10px] text-muted">
            <span>factor</span>
            <span>WR</span>
            <span>n</span>
          </div>
          {top5.map((f, i) => (
            <div
              key={`top-${i}`}
              className="grid grid-cols-[1fr_auto_auto] gap-3 px-3 py-2 border-b border-line/50 last:border-b-0 text-xs"
            >
              <span className="truncate">
                <span className="text-green">✓</span> {f.factor_name}
                {f.factor_value && f.factor_value !== 'true' ? `=${f.factor_value}` : ''}
                <span className="text-muted ml-1 text-[10px]">{f.sport}</span>
              </span>
              <span className="text-green font-bold">
                {Math.round(Number(f.win_rate) * 100)}%
              </span>
              <span className="text-muted">{f.total_picks}</span>
            </div>
          ))}
        </div>
      </div>

      {bottom5.length > 0 && bottom5[0].win_rate < sortedByWR[0].win_rate && (
        <div>
          <div className="text-[10px] text-muted uppercase tracking-wider mb-2">
            Bottom 5 factores
          </div>
          <div className="bg-card border border-line rounded overflow-hidden">
            <div className="grid grid-cols-[1fr_auto_auto] gap-3 px-3 py-2 border-b border-line text-[10px] text-muted">
              <span>factor</span>
              <span>WR</span>
              <span>n</span>
            </div>
            {bottom5.map((f, i) => (
              <div
                key={`bot-${i}`}
                className="grid grid-cols-[1fr_auto_auto] gap-3 px-3 py-2 border-b border-line/50 last:border-b-0 text-xs"
              >
                <span className="truncate">
                  <span className="text-red">✗</span> {f.factor_name}
                  {f.factor_value && f.factor_value !== 'true' ? `=${f.factor_value}` : ''}
                  <span className="text-muted ml-1 text-[10px]">{f.sport}</span>
                </span>
                <span className="text-red font-bold">
                  {Math.round(Number(f.win_rate) * 100)}%
                </span>
                <span className="text-muted">{f.total_picks}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {Object.keys(bySport).length > 0 && (
        <div>
          <div className="text-[10px] text-muted uppercase tracking-wider mb-2">
            Pesos actuales
          </div>
          {Object.entries(bySport).map(([sport, list]) => (
            <div key={sport} className="bg-card border border-line rounded overflow-hidden mb-2">
              <div className="px-3 py-2 border-b border-line text-[11px] font-bold text-fg">
                {sport}
              </div>
              <div className="grid grid-cols-[1fr_auto_auto] gap-3 px-3 py-2 border-b border-line text-[10px] text-muted">
                <span>factor</span>
                <span>peso</span>
                <span>n</span>
              </div>
              {list.slice(0, 8).map((w, i) => {
                const color =
                  Number(w.weight) >= 1.5
                    ? 'text-green'
                    : Number(w.weight) <= 0.5
                      ? 'text-red'
                      : 'text-fg';
                return (
                  <div
                    key={`${sport}-${i}`}
                    className="grid grid-cols-[1fr_auto_auto] gap-3 px-3 py-1.5 border-b border-line/50 last:border-b-0 text-xs"
                  >
                    <span className="truncate">{w.factor_name}</span>
                    <span className={`${color} font-bold`}>{Number(w.weight).toFixed(1)}</span>
                    <span className="text-muted">{w.sample_size}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
