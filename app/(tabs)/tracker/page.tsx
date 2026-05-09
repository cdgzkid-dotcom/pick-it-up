import { supabaseAdmin } from '@/lib/supabase';
import BetResolver from '@/components/BetResolver';
import ManualBetForm from '@/components/ManualBetForm';
import type { Bet } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function TrackerPage() {
  const supabase = supabaseAdmin();
  const { data, error } = await supabase
    .from('bets')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    return <div className="text-red text-sm">Error: {error.message}</div>;
  }

  const bets = (data as Bet[]) ?? [];
  const pending = bets.filter((b) => b.result === 'pending');
  const settled = bets.filter((b) => b.result !== 'pending');

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-bold">TRACKER</h1>
      </header>

      <section className="space-y-2">
        <div className="text-[10px] text-muted uppercase tracking-wider">
          Pendientes ({pending.length})
        </div>
        {pending.length === 0 ? (
          <div className="text-muted text-xs bg-card border border-line rounded p-4 text-center">
            Sin apuestas activas
          </div>
        ) : (
          <div className="space-y-2">
            {pending.map((b) => (
              <BetResolver key={b.id} bet={b} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <div className="text-[10px] text-muted uppercase tracking-wider">
          Agregar manual
        </div>
        <ManualBetForm />
      </section>

      <section className="space-y-2">
        <div className="text-[10px] text-muted uppercase tracking-wider">
          Historial ({settled.length})
        </div>
        {settled.length === 0 ? (
          <div className="text-muted text-xs bg-card border border-line rounded p-4 text-center">
            Vacío
          </div>
        ) : (
          <div className="space-y-1">
            {settled.map((b) => (
              <HistoryRow key={b.id} bet={b} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function HistoryRow({ bet }: { bet: Bet }) {
  const won = bet.result === 'win' || bet.result === 'early_payout';
  const lost = bet.result === 'loss';
  const cashout = bet.result === 'cashout';
  const color = won ? 'text-green' : lost ? 'text-red' : 'text-yellow';
  const symbol = won ? '✓' : lost ? '✕' : cashout ? '$' : '?';
  const pl = Number(bet.payout ?? 0) - Number(bet.amount);

  return (
    <div className="flex items-center gap-3 px-3 py-2 bg-card border border-line rounded text-xs">
      <span className={`text-base ${color}`}>{symbol}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate">{bet.pick}</div>
        <div className="text-[10px] text-muted">
          {bet.sport} · {bet.bet_type} · {Number(bet.odds_decimal).toFixed(2)}
        </div>
      </div>
      <div className={`text-right font-bold ${pl >= 0 ? 'text-green' : 'text-red'}`}>
        {pl >= 0 ? '+' : ''}${Math.round(pl)}
      </div>
    </div>
  );
}
