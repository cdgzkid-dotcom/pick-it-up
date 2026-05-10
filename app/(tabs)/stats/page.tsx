import { supabaseAdmin } from '@/lib/supabase';
import StatsChart from '@/components/StatsChart';
import WeeklyChart from '@/components/WeeklyChart';
import { SportLogo } from '@/components/Logo';
import {
  computeStats,
  groupBy,
  computeClv,
  computeWeeklyWinRate,
  computeKellyVsFixed,
} from '@/lib/stats';
import type { Bet, BankrollLog, Settings } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface EloRow {
  sport: string;
  team: string;
  abbreviation?: string | null;
  elo: number;
  games_played: number;
  last_updated: string;
}

export default async function StatsPage() {
  const supabase = supabaseAdmin();
  const [betsRes, logRes, settingsRes, eloRes] = await Promise.all([
    supabase.from('bets').select('*').order('created_at', { ascending: true }),
    supabase.from('bankroll_log').select('*').order('created_at', { ascending: true }),
    supabase.from('settings').select('*').eq('id', 1).single(),
    supabase.from('elo_ratings').select('*').order('elo', { ascending: false }),
  ]);

  const bets = (betsRes.data as Bet[]) ?? [];
  const logs = (logRes.data as BankrollLog[]) ?? [];
  const settings = settingsRes.data as Settings | null;
  const elo = (eloRes.data as EloRow[]) ?? [];

  const stats = computeStats(bets);
  const clv = computeClv(bets);
  const weekly = computeWeeklyWinRate(bets);
  const kvsf = computeKellyVsFixed(
    bets,
    Number(settings?.bankroll_current ?? 0),
    Number(settings?.unit_percentage ?? 5),
  );

  const chartData = logs.map((l) => ({
    x: new Date(l.created_at).toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit' }),
    y: Number(l.balance_after),
  }));

  const settled = bets.filter((b) => b.result !== 'pending');
  const bySport = groupBy(settled, (b) => b.sport);
  const byType = groupBy(settled, (b) => b.bet_type);
  const byTier = groupBy(settled, (b) => b.tier ?? 'unknown');

  const eloBySport = groupBy(elo, (e) => e.sport);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-bold">STATS</h1>
      </header>

      {chartData.length > 0 && <StatsChart data={chartData} />}

      <div className="grid grid-cols-2 gap-2">
        <KPI label="ROI" value={`${stats.roi.toFixed(1)}%`} good={stats.roi >= 0} />
        <KPI
          label="Win Rate"
          value={`${stats.win_rate.toFixed(0)}%`}
          good={stats.win_rate >= 53}
        />
        <KPI label="P/L" value={`${stats.pl >= 0 ? '+' : ''}$${Math.round(stats.pl)}`} good={stats.pl >= 0} />
        <KPI label="Apostado" value={`$${Math.round(stats.total_staked)}`} />
        <KPI
          label="Racha actual"
          value={
            stats.current_streak.type
              ? `${stats.current_streak.n}${stats.current_streak.type}`
              : '—'
          }
          good={stats.current_streak.type === 'W'}
        />
        <KPI label="Mejor racha W" value={String(stats.longest_win_streak)} />
      </div>

      {/* CLV — Closing Line Value */}
      <section className="space-y-2">
        <div className="text-[10px] text-muted uppercase tracking-wider">
          CLV (Closing Line Value)
        </div>
        {clv.overall.count === 0 ? (
          <div className="bg-card border border-line rounded p-4 text-xs text-muted text-center">
            Sin datos de CLV todavía. Aparecerá cuando se resuelvan apuestas con momio
            registrado al apostar y al cierre.
          </div>
        ) : (
          <>
            <div className="bg-card border border-line rounded p-3">
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-muted">CLV promedio</span>
                <span
                  className={`text-2xl font-bold ${clv.overall.average >= 0 ? 'text-green' : 'text-red'}`}
                >
                  {clv.overall.average >= 0 ? '+' : ''}
                  {clv.overall.average.toFixed(3)}
                </span>
              </div>
              <div className="text-[11px] text-muted mt-1">
                {clv.overall.average >= 0
                  ? '✓ Le ganas a la línea de cierre — sistema rentable a largo plazo'
                  : '✗ Las líneas se mueven en tu contra — el mercado recalibra contra ti'}
              </div>
              <div className="text-[10px] text-muted mt-2">
                {clv.overall.positive_count} apuestas con CLV+ ·{' '}
                {clv.overall.negative_count} con CLV- (n={clv.overall.count})
              </div>
            </div>
            {Object.keys(clv.bySport).length > 1 && (
              <div className="bg-card border border-line rounded overflow-hidden">
                <div className="grid grid-cols-[1fr_auto_auto] gap-3 px-3 py-2 border-b border-line text-[10px] text-muted">
                  <span>deporte</span>
                  <span>CLV avg</span>
                  <span>n</span>
                </div>
                {Object.entries(clv.bySport).map(([sport, s]) => (
                  <div
                    key={sport}
                    className="grid grid-cols-[1fr_auto_auto] gap-3 px-3 py-2 border-b border-line/50 last:border-b-0 text-xs"
                  >
                    <span>{sport}</span>
                    <span className={s.average >= 0 ? 'text-green' : 'text-red'}>
                      {s.average >= 0 ? '+' : ''}
                      {s.average.toFixed(3)}
                    </span>
                    <span className="text-muted">{s.count}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>

      {/* Kelly vs Fixed Units */}
      <section className="space-y-2">
        <div className="text-[10px] text-muted uppercase tracking-wider">
          Kelly vs unidades fijas
        </div>
        {kvsf.kelly_staked === 0 ? (
          <div className="bg-card border border-line rounded p-4 text-xs text-muted text-center">
            Sin apuestas resueltas todavía
          </div>
        ) : (
          <div className="bg-card border border-line rounded">
            <div className="grid grid-cols-3 gap-2 p-3">
              <Mini
                label="ROI Kelly"
                value={`${kvsf.kelly_roi >= 0 ? '+' : ''}${kvsf.kelly_roi.toFixed(1)}%`}
                color={kvsf.kelly_roi >= 0 ? 'green' : 'red'}
              />
              <Mini
                label="ROI flat"
                value={`${kvsf.fixed_roi >= 0 ? '+' : ''}${kvsf.fixed_roi.toFixed(1)}%`}
                color={kvsf.fixed_roi >= 0 ? 'green' : 'red'}
              />
              <Mini
                label="Diferencia"
                value={`${kvsf.kelly_roi - kvsf.fixed_roi >= 0 ? '+' : ''}${(kvsf.kelly_roi - kvsf.fixed_roi).toFixed(1)}%`}
                color={kvsf.kelly_roi >= kvsf.fixed_roi ? 'green' : 'red'}
              />
            </div>
            <div className="px-3 pb-3 text-[10px] text-muted leading-relaxed">
              Kelly: ${Math.round(kvsf.kelly_staked)} staked → P/L $
              {kvsf.kelly_pl >= 0 ? '+' : ''}
              {Math.round(kvsf.kelly_pl)}. Hipotético flat (2u/1.5u/1u/0.5u sobre
              bankroll actual ${Math.round(kvsf.reference_bankroll)}): $
              {Math.round(kvsf.fixed_staked)} staked → $
              {kvsf.fixed_pl >= 0 ? '+' : ''}
              {Math.round(kvsf.fixed_pl)}.
            </div>
          </div>
        )}
      </section>

      {/* Weekly Win Rate */}
      {weekly.length > 0 && (
        <section className="space-y-2">
          <div className="text-[10px] text-muted uppercase tracking-wider">
            Performance semanal (línea = breakeven 52.4%)
          </div>
          <WeeklyChart data={weekly} />
        </section>
      )}

      <BreakdownTable title="Por deporte" data={bySport} showLogos />
      <BreakdownTable title="Por tipo" data={byType} />
      <BreakdownTable title="Por tier (AI accuracy)" data={byTier} />

      {/* ELO Rankings */}
      {Object.keys(eloBySport).length > 0 && (
        <section className="space-y-2">
          <div className="text-[10px] text-muted uppercase tracking-wider">
            ELO Rankings
          </div>
          {Object.entries(eloBySport).map(([sport, list]) => (
            <div key={sport} className="bg-card border border-line rounded overflow-hidden">
              <div className="px-3 py-2 border-b border-line text-[11px] font-bold text-fg">
                {sport}
              </div>
              <div className="grid grid-cols-[auto_1fr_auto_auto] gap-2 px-3 py-2 border-b border-line text-[10px] text-muted">
                <span>#</span>
                <span>equipo</span>
                <span>ELO</span>
                <span>jug</span>
              </div>
              {list.slice(0, 10).map((e, i) => (
                <div
                  key={e.team}
                  className="grid grid-cols-[auto_1fr_auto_auto] gap-2 px-3 py-1.5 border-b border-line/50 last:border-b-0 text-xs"
                >
                  <span className="text-muted">{i + 1}</span>
                  <span className="truncate">{e.team}</span>
                  <span className={Number(e.elo) >= 1500 ? 'text-green' : 'text-red'}>
                    {Math.round(Number(e.elo))}
                  </span>
                  <span className="text-muted">{e.games_played}</span>
                </div>
              ))}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function KPI({
  label,
  value,
  good,
}: {
  label: string;
  value: string;
  good?: boolean;
}) {
  const c = good === true ? 'text-green' : good === false ? 'text-red' : 'text-fg';
  return (
    <div className="bg-card border border-line rounded p-3">
      <div className="text-[10px] text-muted uppercase tracking-wider">{label}</div>
      <div className={`text-lg font-bold mt-0.5 ${c}`}>{value}</div>
    </div>
  );
}

function Mini({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: 'green' | 'red';
}) {
  return (
    <div className="text-center">
      <div className="text-[9px] text-muted uppercase tracking-wider">{label}</div>
      <div className={`text-base font-bold mt-0.5 ${color === 'green' ? 'text-green' : 'text-red'}`}>
        {value}
      </div>
    </div>
  );
}

function BreakdownTable({
  title,
  data,
  showLogos = false,
}: {
  title: string;
  data: Record<string, Bet[]>;
  showLogos?: boolean;
}) {
  const rows = Object.entries(data).map(([k, bets]) => {
    const wins = bets.filter((b) => b.result === 'win' || b.result === 'early_payout').length;
    const losses = bets.filter((b) => b.result === 'loss').length;
    const total = wins + losses;
    const wr = total > 0 ? (wins / total) * 100 : 0;
    const pl = bets.reduce(
      (s, b) => s + (Number(b.payout ?? 0) - Number(b.amount)),
      0,
    );
    return { k, wins, losses, wr, pl, n: bets.length };
  });

  if (rows.length === 0) return null;
  rows.sort((a, b) => b.n - a.n);

  return (
    <section>
      <div className="text-[10px] text-muted uppercase tracking-wider mb-2">{title}</div>
      <div className="bg-card border border-line rounded overflow-hidden">
        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-3 py-2 border-b border-line text-[10px] text-muted">
          <span>cat.</span>
          <span>W-L</span>
          <span>WR</span>
          <span>P/L</span>
        </div>
        {rows.map((r) => (
          <div
            key={r.k}
            className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-3 py-2 border-b border-line/50 last:border-b-0 text-xs"
          >
            <span className="truncate flex items-center gap-2">
              {showLogos && <SportLogo sport={r.k} size={16} />}
              {r.k}
            </span>
            <span>
              {r.wins}-{r.losses}
            </span>
            <span>{r.wr.toFixed(0)}%</span>
            <span className={r.pl >= 0 ? 'text-green' : 'text-red'}>
              {r.pl >= 0 ? '+' : ''}${Math.round(r.pl)}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
