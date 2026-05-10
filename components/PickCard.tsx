'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import EdgeBar from './EdgeBar';
import { TeamLogo, SportLogo } from './Logo';
import { tierLabel } from '@/lib/units';
import type { Pick, Tier } from '@/lib/types';

interface Props {
  pick: Pick;
  rank: number;
}

export default function PickCard({ pick, rank }: Props) {
  const [open, setOpen] = useState(false);
  const [showOdds, setShowOdds] = useState(false);
  const [isPending, start] = useTransition();
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const initialDone =
    pick.status === 'bet' ? 'APOSTADO ✓' : pick.status === 'skipped' ? 'SKIPPED' : null;
  const [done, setDone] = useState<string | null>(initialDone);

  const tier = (pick.tier ?? 'value') as Tier;
  const tierColor =
    tier === 'lock'
      ? 'text-blue'
      : tier === 'strong'
      ? 'text-green'
      : tier === 'value'
      ? 'text-yellow'
      : 'text-orange';

  const realProb = Number(pick.real_probability ?? 0);
  const impliedProb = Number(pick.implied_probability ?? 1 / Number(pick.odds_decimal));
  const odds = Number(pick.odds_decimal);
  const amount = Number(pick.recommended_amount ?? 0);
  const win = Math.round(amount * (odds - 1));

  const apuesta = async () => {
    setErr(null);
    const r = await fetch('/api/bets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pick_id: pick.id,
        sport: pick.sport,
        game: pick.game,
        home_team: pick.home_team,
        away_team: pick.away_team,
        home_team_abbr: pick.home_team_abbr ?? null,
        away_team_abbr: pick.away_team_abbr ?? null,
        pick: pick.pick,
        bet_type: pick.bet_type,
        odds_decimal: odds,
        amount,
        tier,
      }),
    });
    if (!r.ok) {
      if (r.status === 409) {
        setDone('APOSTADO ✓');
        start(() => router.refresh());
        return;
      }
      const j = await r.json().catch(() => null);
      setErr(j?.error ?? 'Error al apostar');
      return;
    }
    setDone('APOSTADO ✓');
    start(() => router.refresh());
  };

  const skip = async () => {
    const r = await fetch(`/api/picks/${pick.id}/skip`, { method: 'POST' });
    if (!r.ok) {
      setErr('Error al skip');
      return;
    }
    setDone('SKIPPED');
    start(() => router.refresh());
  };

  if (done) {
    const isBet = done.includes('APOSTADO');
    return (
      <div
        className={`bg-card border rounded-lg p-3 flex items-center gap-3 text-sm ${
          isBet ? 'border-green/40 text-green' : 'border-line text-muted opacity-60'
        }`}
      >
        <span className="text-xs text-muted">#{rank}</span>
        <span className="px-1.5 py-0.5 bg-line rounded text-[10px] text-muted">{pick.sport}</span>
        <span className="flex-1 truncate">{pick.pick}</span>
        <span className="text-xs font-bold">{done}</span>
      </div>
    );
  }

  return (
    <div className="bg-card border border-line rounded-lg p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-muted text-xs">#{rank}</span>
          <SportLogo sport={pick.sport} size={18} />
          <span className="px-1.5 py-0.5 bg-line rounded text-[10px] text-muted">
            {pick.sport}
          </span>
          <span className={`text-xs font-bold ${tierColor}`}>
            {tierLabel(tier, pick.confidence)}
          </span>
        </div>
        {pick.early_payout_eligible && (
          <span className="px-1.5 py-0.5 bg-blue/20 text-blue rounded text-[10px] font-bold">
            P.A.
          </span>
        )}
      </div>

      {!pick.is_parlay && (pick.home_team_abbr || pick.away_team_abbr || pick.home_team) && (
        <div className="flex items-center gap-3 py-1">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <TeamLogo sport={pick.sport} abbr={pick.away_team_abbr} size={32} />
            <span className="text-xs truncate">{pick.away_team}</span>
          </div>
          <span className="text-muted text-[10px]">@</span>
          <div className="flex items-center gap-2 flex-1 min-w-0 justify-end">
            <span className="text-xs truncate text-right">{pick.home_team}</span>
            <TeamLogo sport={pick.sport} abbr={pick.home_team_abbr} size={32} />
          </div>
        </div>
      )}

      <div>
        {pick.is_parlay && (
          <div className="text-[11px] text-muted uppercase tracking-wider">{pick.game}</div>
        )}
        <div className="text-base font-bold mt-0.5">{pick.pick}</div>
        {pick.pick_detail && (
          <div className="text-xs text-muted mt-0.5">{pick.pick_detail}</div>
        )}
      </div>

      <EdgeBar realProb={realProb} impliedProb={impliedProb} />

      <div className="flex items-center justify-between text-sm">
        <div>
          <span className="text-muted text-xs">momio </span>
          <span className="font-bold text-blue">{odds.toFixed(2)}</span>
        </div>
        <div className="text-right">
          <span className="text-muted text-xs">apostar </span>
          <span className="font-bold text-green">${amount}</span>
          <span className="text-muted text-xs"> · ganas </span>
          <span className="font-bold text-yellow">${win}</span>
        </div>
      </div>

      {pick.injuries && (
        <div className="text-[11px] text-muted">🏥 {pick.injuries}</div>
      )}

      <details className="text-xs" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary className="text-muted cursor-pointer">
          {open ? '▼' : '▶'} análisis
        </summary>
        <div className="mt-2 space-y-2 pl-3 border-l border-line">
          {pick.analysis && <p className="text-fg/90">{pick.analysis}</p>}
          {pick.risk_factors && (
            <p className="text-red/80">
              <span className="text-muted">riesgo: </span>
              {pick.risk_factors}
            </p>
          )}
          {pick.key_stats && Object.keys(pick.key_stats).length > 0 && (
            <div className="text-muted">
              {Object.entries(pick.key_stats).map(([k, v]) => (
                <div key={k}>
                  <span className="text-muted">{k}: </span>
                  <span className="text-fg">{String(v)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </details>

      {pick.odds_comparison && Object.keys(pick.odds_comparison).length > 0 && (
        <details
          className="text-xs"
          onToggle={(e) => setShowOdds((e.target as HTMLDetailsElement).open)}
        >
          <summary className="text-muted cursor-pointer">
            {showOdds ? '▼' : '▶'} comparador momios
          </summary>
          <div className="mt-2 grid grid-cols-2 gap-1 pl-3 border-l border-line">
            {Object.entries(pick.odds_comparison).map(([source, val]) => (
              <div key={source} className="flex justify-between">
                <span className="text-muted">{source}</span>
                <span className="text-fg">{Number(val).toFixed(2)}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      {err && <div className="text-red text-xs">{err}</div>}

      <div className="flex gap-2 pt-1">
        <button
          onClick={apuesta}
          disabled={isPending}
          className="tap flex-1 py-3 bg-green text-bg rounded font-bold text-sm"
        >
          APOSTAR ${amount}
        </button>
        <button
          onClick={skip}
          disabled={isPending}
          className="tap px-4 py-3 border border-line text-muted rounded font-bold text-sm"
        >
          SKIP
        </button>
      </div>
    </div>
  );
}
