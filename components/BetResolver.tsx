'use client';
import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { TeamLogo, SportLogo } from './Logo';
import { tierLabel } from '@/lib/units';
import type { Bet, Tier } from '@/lib/types';

interface Props {
  bet: Bet;
}

interface LiveStatus {
  completed: boolean;
  state: string;
  home_score?: number;
  away_score?: number;
  period?: number;
  display_clock?: string;
  detail?: string;
  short_detail?: string;
}

const POLL_INTERVAL_MS = 30_000;

export default function BetResolver({ bet }: Props) {
  const [showCashout, setShowCashout] = useState(false);
  const [cashoutValue, setCashoutValue] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [isPending, start] = useTransition();
  const [live, setLive] = useState<LiveStatus | null>(null);
  const router = useRouter();

  const amount = Number(bet.amount);
  const odds = Number(bet.odds_decimal);
  const win = Math.round(amount * (odds - 1));

  // Stale bet: game_start_time > 4 hours ago and still pending
  const gameStart = bet.game_start_time ? new Date(bet.game_start_time).getTime() : 0;
  const hoursAgo = gameStart > 0 ? (Date.now() - gameStart) / 3_600_000 : 0;
  const isStale = hoursAgo > 4;

  // Poll live status. Only fetch if we have an espn_event_id and the game is
  // close to starting (within 30 min) or already started.
  useEffect(() => {
    if (!bet.espn_event_id || !bet.sport) return;
    if (gameStart > 0 && gameStart - Date.now() > 30 * 60_000) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const r = await fetch('/api/live-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            events: [
              {
                sport: bet.sport,
                event_id: bet.espn_event_id,
                game_start_time: bet.game_start_time,
              },
            ],
          }),
        });
        if (!r.ok) return;
        const data = (await r.json().catch(() => null)) as { statuses?: Record<string, LiveStatus> } | null;
        const status = data?.statuses?.[bet.espn_event_id as string] ?? null;
        if (cancelled) return;
        setLive(status);
        // Stop polling once game is done — the results checker will resolve it.
        if (status?.completed || status?.state === 'post') return;
      } catch {
        // ignore
      } finally {
        if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS);
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [bet.espn_event_id, bet.sport, bet.game_start_time, gameStart]);

  const liveScore =
    live && (live.home_score != null || live.away_score != null)
      ? { home: live.home_score ?? 0, away: live.away_score ?? 0 }
      : null;
  const isLive = live?.state === 'in';
  const isFinal = live?.completed || live?.state === 'post';
  const statusLabel = live?.short_detail || live?.detail;

  const resolve = async (
    result: 'win' | 'loss' | 'push' | 'cashout' | 'early_payout',
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
      <div className="flex items-center gap-2">
        <SportLogo sport={bet.sport} size={24} />
        <span className="text-base font-bold">
          {bet.game_start_time
            ? new Date(bet.game_start_time).toLocaleTimeString('es-MX', {
                hour: 'numeric',
                minute: '2-digit',
                hour12: true,
                timeZone: 'America/Mexico_City',
              })
            : ''}
        </span>
      </div>

      {(bet.home_team_abbr || bet.away_team_abbr) && (bet.home_team || bet.away_team) && (
        <div className="grid grid-cols-[auto_1fr_auto_1fr_auto] items-center gap-2 pb-2 border-b border-line/40">
          <TeamLogo sport={bet.sport} abbr={bet.away_team_abbr} size={32} className="shrink-0" />
          <span className="text-base font-medium whitespace-normal break-words min-w-0">
            {bet.away_team ?? ''}
          </span>
          <span className="text-muted text-xs px-0.5 shrink-0">@</span>
          <span className="text-base text-right font-medium whitespace-normal break-words min-w-0">
            {bet.home_team ?? ''}
          </span>
          <TeamLogo sport={bet.sport} abbr={bet.home_team_abbr} size={32} className="shrink-0" />
        </div>
      )}

      {liveScore && (
        <div
          className={`flex items-center justify-between gap-2 px-2 py-2 rounded border ${
            isLive
              ? 'bg-green/10 border-green/40'
              : isFinal
                ? 'bg-line/30 border-line'
                : 'bg-blue/10 border-blue/40'
          }`}
        >
          <div className="flex items-center gap-2 text-base font-bold">
            <span className="text-muted text-[10px] uppercase">
              {bet.away_team_abbr?.toUpperCase() ?? 'AWAY'}
            </span>
            <span
              className={
                liveScore.away > liveScore.home ? 'text-green' : 'text-fg'
              }
            >
              {liveScore.away}
            </span>
            <span className="text-muted text-xs">—</span>
            <span
              className={
                liveScore.home > liveScore.away ? 'text-green' : 'text-fg'
              }
            >
              {liveScore.home}
            </span>
            <span className="text-muted text-[10px] uppercase">
              {bet.home_team_abbr?.toUpperCase() ?? 'HOME'}
            </span>
          </div>
          <div className="text-right">
            {isLive && (
              <span className="inline-block w-2 h-2 rounded-full bg-red animate-pulse mr-1 align-middle" />
            )}
            <span
              className={`text-[11px] font-bold ${
                isLive ? 'text-green' : isFinal ? 'text-muted' : 'text-blue'
              }`}
            >
              {isFinal ? 'FINAL' : (statusLabel ?? (isLive ? 'EN VIVO' : 'PRÓXIMO'))}
            </span>
          </div>
        </div>
      )}
      <div className="flex justify-between items-start gap-2">
        <div className="min-w-0">
          {bet.tier && (
            <div className="text-[10px] text-muted">{tierLabel(bet.tier as Tier)}</div>
          )}
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

      {isStale && (
        <div className="text-[11px] text-yellow bg-yellow/10 border border-yellow/40 rounded px-2 py-1.5 font-bold">
          ⚠️ Juego terminó — marca el resultado
        </div>
      )}

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
        <div className="grid grid-cols-5 gap-1">
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
            onClick={() => resolve('push')}
            disabled={isPending}
            className="tap py-2 bg-blue/20 text-blue border border-blue/40 rounded text-[10px] font-bold"
          >
            PUSH
          </button>
          <button
            onClick={() => setShowCashout(true)}
            disabled={isPending}
            className="tap py-2 bg-yellow/20 text-yellow border border-yellow/40 rounded text-[10px] font-bold"
          >
            CASH$
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
