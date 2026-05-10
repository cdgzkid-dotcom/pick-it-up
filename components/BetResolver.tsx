'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { TeamLogo } from './Logo';
import { tierLabel } from '@/lib/units';
import type { Bet, Tier } from '@/lib/types';

interface Props {
  bet: Bet;
}

export default function BetResolver({ bet }: Props) {
  const [showCashout, setShowCashout] = useState(false);
  const [cashoutValue, setCashoutValue] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [isPending, start] = useTransition();
  const router = useRouter();

  const amount = Number(bet.amount);
  const odds = Number(bet.odds_decimal);
  const win = Math.round(amount * (odds - 1));

  const resolve = async (
    result: 'win' | 'loss' | 'cashout' | 'early_payout',
    cashout_amount?: number,
  ) => {
    setErr(null);
    const r = await fetch(`/api/bets/${bet.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result, cashout_amount }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => null);
      setErr(j?.error ?? 'Falló');
      return;
    }
    start(() => router.refresh());
  };

  const submitCashout = () => {
    const v = Number(cashoutValue);
    if (!Number.isFinite(v) || v <= 0) {
      setErr('Monto inválido');
      return;
    }
    resolve('cashout', v);
  };

  return (
    <div className="bg-card border border-line rounded-lg p-3 space-y-2">
      {(bet.home_team_abbr || bet.away_team_abbr) && (bet.home_team || bet.away_team) && (
        <div className="grid grid-cols-[auto_1fr_auto_1fr_auto] items-center gap-2 pb-1 border-b border-line/40">
          <TeamLogo sport={bet.sport} abbr={bet.away_team_abbr} size={24} className="shrink-0" />
          <span className="text-[11px] truncate">{bet.away_team ?? ''}</span>
          <span className="text-muted text-[10px] px-0.5">@</span>
          <span className="text-[11px] truncate text-right">{bet.home_team ?? ''}</span>
          <TeamLogo sport={bet.sport} abbr={bet.home_team_abbr} size={24} className="shrink-0" />
        </div>
      )}
      <div className="flex justify-between items-start gap-2">
        <div className="min-w-0">
          <div className="text-[10px] text-muted">
            {bet.sport}
            {bet.tier ? ` · ${tierLabel(bet.tier as Tier)}` : ''}
          </div>
          <div className="font-bold text-sm">{bet.pick}</div>
        </div>
        <div className="text-right text-xs shrink-0">
          <div>
            <span className="text-muted">$</span>
            <span className="text-green font-bold">{amount}</span>
            <span className="text-muted"> @ </span>
            <span className="text-blue">{odds.toFixed(2)}</span>
          </div>
          <div className="text-yellow">+${win}</div>
        </div>
      </div>

      {showCashout ? (
        <div className="flex gap-2">
          <input
            type="number"
            inputMode="decimal"
            placeholder="cash out $"
            value={cashoutValue}
            onChange={(e) => setCashoutValue(e.target.value)}
            className="flex-1 bg-bg border border-line rounded px-2 py-2 text-sm"
            autoFocus
          />
          <button
            onClick={submitCashout}
            disabled={isPending}
            className="tap px-3 bg-yellow text-bg rounded font-bold text-xs"
          >
            OK
          </button>
          <button
            onClick={() => setShowCashout(false)}
            className="tap px-3 border border-line rounded text-xs text-muted"
          >
            X
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-1">
          <button
            onClick={() => resolve('win')}
            disabled={isPending}
            className="tap py-2 bg-green/20 text-green border border-green/40 rounded text-xs font-bold"
          >
            WIN
          </button>
          <button
            onClick={() => resolve('loss')}
            disabled={isPending}
            className="tap py-2 bg-red/20 text-red border border-red/40 rounded text-xs font-bold"
          >
            LOSS
          </button>
          <button
            onClick={() => setShowCashout(true)}
            disabled={isPending}
            className="tap py-2 bg-yellow/20 text-yellow border border-yellow/40 rounded text-[10px] font-bold"
          >
            CASH OUT
          </button>
          <button
            onClick={() => resolve('early_payout')}
            disabled={isPending}
            className="tap py-2 bg-blue/20 text-blue border border-blue/40 rounded text-[10px] font-bold"
          >
            P.A.
          </button>
        </div>
      )}

      {err && <div className="text-red text-xs">{err}</div>}
    </div>
  );
}
