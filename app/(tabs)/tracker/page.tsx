import { supabaseAdmin } from '@/lib/supabase';
import BetResolver from '@/components/BetResolver';
import ManualBetForm from '@/components/ManualBetForm';
import DrafteaBetFromImage from '@/components/DrafteaBetFromImage';
import ResetPendingButton from '@/components/ResetPendingButton';
import ForceCheckResultsButton from '@/components/ForceCheckResultsButton';
import ResultsRefresher from '@/components/ResultsRefresher';
import { TeamLogo, SportLogo } from '@/components/Logo';
import { tierLabel } from '@/lib/units';
import type { Bet, Tier } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

function dateLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86_400_000);
  const betDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (betDay.getTime() === today.getTime()) return 'HOY';
  if (betDay.getTime() === yesterday.getTime()) return 'AYER';
  return d.toLocaleDateString('es-MX', {
    month: 'short',
    day: 'numeric',
    timeZone: 'America/Mexico_City',
  });
}

function groupByDate<T extends { created_at: string }>(items: T[]): Array<{ label: string; items: T[] }> {
  const map = new Map<string, T[]>();
  const order: string[] = [];
  for (const item of items) {
    const label = dateLabel(item.created_at);
    if (!map.has(label)) {
      map.set(label, []);
      order.push(label);
    }
    map.get(label)!.push(item);
  }
  return order.map((label) => ({ label, items: map.get(label)! }));
}

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

  const pendingGroups = groupByDate(pending);
  const settledGroups = groupByDate(settled);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-bold">TRACKER</h1>
      </header>

      {/* Auto-check on mount */}
      <ResultsRefresher />
      {/* Manual button */}
      <ResultsRefresher manual />

      <section className="space-y-2">
        <div className="text-[10px] text-muted uppercase tracking-wider">
          Pendientes ({pending.length})
        </div>
        {pending.length === 0 ? (
          <div className="text-muted text-xs bg-card border border-line rounded p-4 text-center">
            Sin apuestas activas
          </div>
        ) : (
          pendingGroups.map((group) => (
            <div key={group.label} className="space-y-2">
              <div className="text-[10px] text-muted font-bold uppercase tracking-wider pt-1">
                {group.label}
              </div>
              {group.items.map((b) => (
                <BetResolver key={b.id} bet={b} />
              ))}
            </div>
          ))
        )}
        <ResetPendingButton count={pending.length} />
        <ForceCheckResultsButton />
      </section>

      <section className="space-y-2">
        <div className="text-[10px] text-muted uppercase tracking-wider">
          Registrar apuesta
        </div>
        <DrafteaBetFromImage />
        <div className="flex items-center gap-2 py-1">
          <div className="flex-1 h-px bg-line" />
          <span className="text-[10px] text-muted">o ingresa manualmente</span>
          <div className="flex-1 h-px bg-line" />
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
          settledGroups.map((group) => (
            <div key={group.label} className="space-y-1">
              <div className="text-[10px] text-muted font-bold uppercase tracking-wider pt-2">
                {group.label}
              </div>
              {group.items.map((b) => (
                <HistoryRow key={b.id} bet={b} />
              ))}
            </div>
          ))
        )}
      </section>
    </div>
  );
}

function HistoryRow({ bet }: { bet: Bet }) {
  const won = bet.result === 'win' || bet.result === 'early_payout';
  const lost = bet.result === 'loss';
  const cashout = bet.result === 'cashout';
  const push = bet.result === 'push';
  const color = won ? 'text-green' : lost ? 'text-red' : push ? 'text-blue' : 'text-yellow';
  const symbol = won ? '✓' : lost ? '✕' : push ? '↩' : cashout ? '$' : '?';
  const pl = Number(bet.payout ?? 0) - Number(bet.amount);

  return (
    <div className="px-3 py-2 bg-card border border-line rounded text-xs space-y-1">
      <div className="flex items-center gap-2">
        <SportLogo sport={bet.sport} size={24} />
        <span className="text-sm font-bold">
          {bet.game_start_time
            ? new Date(bet.game_start_time).toLocaleString('es-MX', {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                hour12: true,
                timeZone: 'America/Mexico_City',
              })
            : ''}
        </span>
      </div>
      {(bet.home_team_abbr || bet.away_team_abbr) && (bet.home_team || bet.away_team) && (
        <div className="grid grid-cols-[auto_1fr_auto_1fr_auto] items-center gap-2 text-sm">
          <TeamLogo sport={bet.sport} abbr={bet.away_team_abbr} size={28} className="shrink-0" />
          <span className="whitespace-normal break-words min-w-0">{bet.away_team ?? ''}</span>
          <span className="text-muted text-[10px] shrink-0">@</span>
          <span className="text-right whitespace-normal break-words min-w-0">{bet.home_team ?? ''}</span>
          <TeamLogo sport={bet.sport} abbr={bet.home_team_abbr} size={28} className="shrink-0" />
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className={`text-base ${color} w-4 shrink-0`}>{symbol}</span>
        <div className="min-w-0 flex-1">
          <div className="break-words">{bet.pick}</div>
          <div className="text-[10px] text-muted">
            {bet.bet_type} · {Number(bet.odds_decimal).toFixed(2)}
            {bet.tier ? ` · ${tierLabel(bet.tier as Tier)}` : ''}
            {push ? ' · PUSH' : ''}
          </div>
          {bet.final_score && (
            <div className="text-[10px] text-muted">
              Marcador:{' '}
              {(() => {
                const parts = String(bet.final_score).split('-');
                if (parts.length === 2 && bet.away_team && bet.home_team) {
                  const aw = bet.away_team.split(/\s+/).pop() ?? bet.away_team;
                  const hm = bet.home_team.split(/\s+/).pop() ?? bet.home_team;
                  return `${aw} ${parts[0]} - ${hm} ${parts[1]}`;
                }
                return bet.final_score;
              })()}
            </div>
          )}
        </div>
        <div className={`text-right font-bold ${pl > 0 ? 'text-green' : pl < 0 ? 'text-red' : 'text-blue'}`}>
          {pl > 0 ? '+' : pl === 0 ? '' : ''}${Math.round(pl)}
        </div>
      </div>
    </div>
  );
}
