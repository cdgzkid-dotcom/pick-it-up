'use client';
import { useMemo, useState } from 'react';
import { TeamLogo, SportLogo } from '@/components/Logo';
import { tierLabel } from '@/lib/units';
import type { Bet, Tier } from '@/lib/types';

type SportFilter = 'all' | 'MLB' | 'NBA' | 'NHL' | 'NFL';
type ResultFilter = 'all' | 'pending' | 'won' | 'lost';
type TierFilter = 'all' | 'lock' | 'strong' | 'value';

interface Props {
  bets: Bet[];
}

export default function BetHistoryTable({ bets }: Props) {
  const [sportF, setSportF] = useState<SportFilter>('all');
  const [resultF, setResultF] = useState<ResultFilter>('all');
  const [tierF, setTierF] = useState<TierFilter>('all');

  const filtered = useMemo(() => {
    const list = bets.filter((b) => {
      if (sportF !== 'all' && b.sport !== sportF) return false;
      if (resultF === 'pending' && b.result !== 'pending') return false;
      if (resultF === 'won' && !(b.result === 'win' || b.result === 'early_payout')) return false;
      if (resultF === 'lost' && b.result !== 'loss') return false;
      if (tierF !== 'all' && b.tier !== tierF) return false;
      return true;
    });
    return [...list].sort((a, b) => {
      const aP = a.result === 'pending' ? 1 : 0;
      const bP = b.result === 'pending' ? 1 : 0;
      if (aP !== bP) return bP - aP;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }, [bets, sportF, resultF, tierF]);

  return (
    <section className="space-y-2">
      <div className="text-[10px] text-muted uppercase tracking-wider">
        Historial completo ({filtered.length}/{bets.length})
      </div>

      <div className="bg-card border border-line rounded p-2 space-y-2">
        <FilterRow
          label="Deporte"
          value={sportF}
          options={[
            ['all', 'Todos'],
            ['MLB', 'MLB'],
            ['NBA', 'NBA'],
            ['NHL', 'NHL'],
            ['NFL', 'NFL'],
          ]}
          onChange={(v) => setSportF(v as SportFilter)}
        />
        <FilterRow
          label="Resultado"
          value={resultF}
          options={[
            ['all', 'Todos'],
            ['pending', '⏳ Pendientes'],
            ['won', '✅ Ganadas'],
            ['lost', '❌ Perdidas'],
          ]}
          onChange={(v) => setResultF(v as ResultFilter)}
        />
        <FilterRow
          label="Tier"
          value={tierF}
          options={[
            ['all', 'Todos'],
            ['lock', '🔒 LOCK'],
            ['strong', '✅ STRONG'],
            ['value', '⚠️ VALUE'],
          ]}
          onChange={(v) => setTierF(v as TierFilter)}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="text-muted text-xs bg-card border border-line rounded p-4 text-center">
          Sin apuestas con esos filtros
        </div>
      ) : (
        <div className="space-y-1.5">
          {filtered.map((b) => (
            <Row key={b.id} bet={b} />
          ))}
        </div>
      )}
    </section>
  );
}

function FilterRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[10px] text-muted uppercase tracking-wider w-16 shrink-0">
        {label}
      </span>
      <div className="flex gap-1 flex-wrap">
        {options.map(([v, l]) => {
          const active = value === v;
          return (
            <button
              key={v}
              onClick={() => onChange(v)}
              className={`px-2 py-1 rounded text-[11px] border transition-colors ${
                active
                  ? 'bg-fg text-bg border-fg'
                  : 'bg-card border-line text-muted hover:text-fg'
              }`}
            >
              {l}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function rowBg(result: string): string {
  if (result === 'pending') return 'bg-yellow/10 border-yellow/30';
  if (result === 'win' || result === 'early_payout') return 'bg-green/10 border-green/30';
  if (result === 'loss') return 'bg-red/10 border-red/30';
  if (result === 'cashout') return 'bg-blue/10 border-blue/30';
  return 'bg-card border-line';
}

function resultBadge(bet: Bet): { text: string; color: string } {
  const pl = Number(bet.payout ?? 0) - Number(bet.amount);
  const r = bet.result;
  if (r === 'pending') return { text: '⏳ Pendiente', color: 'text-yellow' };
  if (r === 'win' || r === 'early_payout')
    return { text: `✅ Win +$${Math.round(pl)}`, color: 'text-green' };
  if (r === 'loss')
    return { text: `❌ Loss -$${Math.round(Math.abs(pl))}`, color: 'text-red' };
  if (r === 'cashout')
    return { text: `💰 Cash Out $${Math.round(Number(bet.payout ?? 0))}`, color: 'text-blue' };
  if (r === 'push') return { text: '↩ Push', color: 'text-muted' };
  return { text: r, color: 'text-muted' };
}

function formatScore(bet: Bet): string | null {
  if (!bet.final_score) return null;
  const parts = String(bet.final_score).split('-');
  if (parts.length === 2 && bet.away_team && bet.home_team) {
    const aw = bet.away_team.split(/\s+/).pop() ?? bet.away_team;
    const hm = bet.home_team.split(/\s+/).pop() ?? bet.home_team;
    return `${aw} ${parts[0]} - ${hm} ${parts[1]}`;
  }
  return bet.final_score;
}

function Row({ bet }: { bet: Bet }) {
  const badge = resultBadge(bet);
  const score = formatScore(bet);
  const date = new Date(bet.created_at).toLocaleDateString('es-MX', {
    month: 'short',
    day: 'numeric',
    timeZone: 'America/Mexico_City',
  });

  return (
    <div className={`px-3 py-2 border rounded text-xs space-y-1.5 ${rowBg(bet.result)}`}>
      <div className="flex items-center gap-2">
        <SportLogo sport={bet.sport} size={18} />
        <span className="text-[10px] text-muted uppercase">{date}</span>
        {bet.tier && (
          <span className="text-[10px] text-muted ml-auto">
            {tierLabel(bet.tier as Tier)}
          </span>
        )}
      </div>

      {(bet.away_team || bet.home_team) && (
        <div className="grid grid-cols-[auto_1fr_auto_1fr_auto] items-center gap-2">
          <TeamLogo sport={bet.sport} abbr={bet.away_team_abbr} size={20} className="shrink-0" />
          <span className="text-[11px] truncate">{bet.away_team ?? ''}</span>
          <span className="text-muted text-[9px] shrink-0">@</span>
          <span className="text-[11px] truncate text-right">{bet.home_team ?? ''}</span>
          <TeamLogo sport={bet.sport} abbr={bet.home_team_abbr} size={20} className="shrink-0" />
        </div>
      )}

      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold break-words">{bet.pick}</div>
          <div className="text-[10px] text-muted">
            {bet.bet_type} · {Number(bet.odds_decimal).toFixed(2)} · ${Math.round(Number(bet.amount))}
          </div>
          {score && (
            <div className="text-[10px] text-muted">Final: {score}</div>
          )}
        </div>
        <div className={`text-right font-bold text-[12px] ${badge.color} shrink-0`}>
          {badge.text}
        </div>
      </div>
    </div>
  );
}
