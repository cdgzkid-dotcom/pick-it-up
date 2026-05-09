import { supabaseAdmin } from '@/lib/supabase';
import StatsChart from '@/components/StatsChart';
import { computeStats, groupBy } from '@/lib/stats';
import type { Bet, BankrollLog } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function StatsPage() {
  const supabase = supabaseAdmin();
  const [betsRes, logRes] = await Promise.all([
    supabase.from('bets').select('*').order('created_at', { ascending: true }),
    supabase
      .from('bankroll_log')
      .select('*')
      .order('created_at', { ascending: true }),
  ]);

  const bets = (betsRes.data as Bet[]) ?? [];
  const logs = (logRes.data as BankrollLog[]) ?? [];
  const stats = computeStats(bets);

  const chartData = logs.map((l) => ({
    x: new Date(l.created_at).toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit' }),
    y: Number(l.balance_after),
  }));

  const settled = bets.filter((b) => b.result !== 'pending');
  const bySport = groupBy(settled, (b) => b.sport);
  const byType = groupBy(settled, (b) => b.bet_type);
  const byTier = groupBy(settled, (b) => b.tier ?? 'unknown');

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

      <BreakdownTable title="Por deporte" data={bySport} />
      <BreakdownTable title="Por tipo" data={byType} />
      <BreakdownTable title="Por tier (AI accuracy)" data={byTier} />
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

function BreakdownTable({
  title,
  data,
}: {
  title: string;
  data: Record<string, Bet[]>;
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
            <span className="truncate">{r.k}</span>
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
