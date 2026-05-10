'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import EdgeBar from './EdgeBar';
import { TeamLogo, SportLogo } from './Logo';
import { tierLabel } from '@/lib/units';
import type { KeyStat, Pick, Tier } from '@/lib/types';

interface Props {
  pick: Pick;
  rank: number;
}

export default function PickCard({ pick, rank }: Props) {
  const [analysisOpen, setAnalysisOpen] = useState(false);
  // (showOdds removed — comparator is now always visible)
  const [, start] = useTransition();
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
  const recommended = Math.max(1, Number(pick.recommended_amount ?? 0));

  const [showForm, setShowForm] = useState(false);
  const [amountStr, setAmountStr] = useState(String(recommended));
  const [submitting, setSubmitting] = useState(false);
  const amountNum = Math.max(0, Number(amountStr) || 0);
  const win = Math.round(amountNum * (odds - 1));

  const confirmar = async () => {
    setErr(null);
    if (amountNum <= 0) {
      setErr('Monto inválido');
      return;
    }
    setSubmitting(true);
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
        espn_event_id: pick.espn_event_id ?? null,
        pick: pick.pick,
        bet_type: pick.bet_type,
        odds_decimal: odds,
        amount: amountNum,
        tier,
      }),
    });
    setSubmitting(false);
    if (!r.ok) {
      if (r.status === 409) {
        setDone('APOSTADO ✓');
        start(() => router.refresh());
        return;
      }
      const j = await r.json().catch(() => null);
      setErr(j?.error ?? `Error (${r.status})`);
      return;
    }
    setDone('APOSTADO ✓');
    setShowForm(false);
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
        className={`bg-card border rounded-lg p-3 flex items-center gap-2 text-sm ${
          isBet ? 'border-green/60' : 'border-line opacity-60'
        }`}
      >
        <span className="text-xs text-muted">#{rank}</span>
        <SportLogo sport={pick.sport} size={24} />
        <span className="flex-1 truncate text-fg">{pick.pick}</span>
        <span className={`text-xs font-bold ${isBet ? 'text-green' : 'text-muted'}`}>
          {done}
        </span>
      </div>
    );
  }

  // Normalize key_stats: support both array of {label,value,flag} and legacy record
  let keyStatsItems: KeyStat[] = [];
  if (Array.isArray(pick.key_stats)) {
    keyStatsItems = pick.key_stats as KeyStat[];
  } else if (pick.key_stats && typeof pick.key_stats === 'object') {
    keyStatsItems = Object.entries(pick.key_stats as Record<string, unknown>).map(([label, value]) => ({
      label,
      value: String(value),
    }));
  }

  return (
    <div className="bg-card border border-line rounded-lg p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-muted text-xs">#{rank}</span>
          <span className={`text-xs font-bold ${pick.trap_warning ? 'text-red' : tierColor}`}>
            {tierLabel(tier, pick.confidence)}
            {pick.trap_warning && ' · TRAMPA DETECTADA'}
          </span>
        </div>
        {pick.early_payout_eligible && (
          <span className="px-1.5 py-0.5 bg-blue/20 text-blue rounded text-[10px] font-bold">
            P.A.
          </span>
        )}
      </div>

      {!pick.is_parlay && (
        <div className="flex items-center gap-2">
          <SportLogo sport={pick.sport} size={24} />
          <span className="text-base font-bold">
            {pick.game_start_time
              ? new Date(pick.game_start_time).toLocaleTimeString('es-MX', {
                  hour: 'numeric',
                  minute: '2-digit',
                  hour12: true,
                  timeZone: 'America/Mexico_City',
                })
              : ''}
          </span>
        </div>
      )}

      {!pick.is_parlay && (pick.home_team_abbr || pick.away_team_abbr || pick.home_team) && (
        <div className="grid grid-cols-[auto_1fr_auto_1fr_auto] items-center gap-2 py-2">
          <TeamLogo
            sport={pick.sport}
            abbr={pick.away_team_abbr}
            size={40}
            className="shrink-0"
          />
          <span className="text-lg leading-tight font-medium whitespace-normal break-words min-w-0">
            {pick.away_team}
          </span>
          <span className="text-muted text-sm px-1 shrink-0">@</span>
          <span className="text-lg leading-tight text-right font-medium whitespace-normal break-words min-w-0">
            {pick.home_team}
          </span>
          <TeamLogo
            sport={pick.sport}
            abbr={pick.home_team_abbr}
            size={40}
            className="shrink-0"
          />
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
          <span className="text-muted text-xs">recomendado </span>
          <span className="font-bold text-green">${recommended}</span>
          {(() => {
            const b = odds - 1;
            if (b <= 0 || !realProb) return null;
            const k = (realProb * b - (1 - realProb)) / b;
            if (k <= 0) return null;
            const half = Math.max(0.01, Math.min(0.1, k / 2));
            return (
              <span className="text-muted text-[10px]"> (Kelly {(half * 100).toFixed(1)}%)</span>
            );
          })()}
        </div>
      </div>

      {pick.trap_warning && (
        <div className="text-[11px] text-red bg-red/10 border border-red/40 rounded px-2 py-1.5 font-bold">
          ⚠️ POSIBLE TRAMPA: {pick.trap_warning}
        </div>
      )}

      {pick.injuries && (
        <div className="text-[11px] text-muted">🏥 {pick.injuries}</div>
      )}

      {pick.line_movement_note && (
        <div className="text-[11px] text-blue bg-blue/10 border border-blue/30 rounded px-2 py-1.5">
          📈 {pick.line_movement_note}
        </div>
      )}

      {pick.regression_flags && pick.regression_flags.toLowerCase() !== 'ninguna' && !pick.regression_flags.toLowerCase().startsWith('ninguna ') && (
        <div className="text-[11px] text-yellow bg-yellow/10 border border-yellow/30 rounded px-2 py-1.5">
          ⚠️ {pick.regression_flags}
        </div>
      )}

      {keyStatsItems.length > 0 && (
        <div className="grid grid-cols-2 gap-1.5">
          {keyStatsItems.slice(0, 6).map((s, i) => {
            const flagColor =
              s.flag === 'green' ? 'text-green' : s.flag === 'yellow' ? 'text-yellow' : s.flag === 'red' ? 'text-red' : 'text-fg';
            return (
              <div
                key={`${s.label}-${i}`}
                className="bg-bg/50 border border-line rounded px-2 py-1.5 text-[10px]"
              >
                <div className="text-muted truncate">{s.label}</div>
                <div className={`font-bold ${flagColor} truncate`}>{s.value}</div>
              </div>
            );
          })}
        </div>
      )}

      {pick.analysis && (
        <details
          className="text-xs"
          onToggle={(e) => setAnalysisOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary className="text-muted cursor-pointer">
            {analysisOpen ? '▼' : '▶'} análisis completo
          </summary>
          <div className="mt-2 space-y-2 pl-3 border-l border-line">
            <p className="text-fg/90 leading-relaxed">{pick.analysis}</p>
            {pick.risk_factors && (
              <p className="text-red/80">
                <span className="text-muted">riesgo: </span>
                {pick.risk_factors}
              </p>
            )}
          </div>
        </details>
      )}

      {pick.odds_comparison && (() => {
        // Support both array shape ([{source, ml}, ...]) and legacy
        // object shape ({ source: ml }) for older picks.
        const list: Array<{ source: string; ml: number }> = Array.isArray(pick.odds_comparison)
          ? (pick.odds_comparison as Array<{ source: string; ml: number }>)
          : Object.entries(pick.odds_comparison as Record<string, number>).map(([source, ml]) => ({
              source,
              ml: Number(ml),
            }));
        if (list.length < 2) return null;
        const sorted = [...list].sort((a, b) => b.ml - a.ml);
        const best = sorted[0];
        return (
          <div className="text-xs bg-bg/40 border border-line rounded px-2 py-1.5 space-y-0.5">
            <div className="text-[10px] text-muted uppercase tracking-wider">
              📍 Comparador
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {sorted.slice(0, 6).map((b) => (
                <span key={b.source} className="text-[11px]">
                  <span className={b.source === best.source ? 'text-green font-bold' : 'text-muted'}>
                    {b.source}
                  </span>
                  <span className="ml-1">{b.ml.toFixed(2)}</span>
                  {b.source === best.source && <span className="ml-0.5">⭐</span>}
                </span>
              ))}
            </div>
          </div>
        );
      })()}

      {err && <div className="text-red text-xs">{err}</div>}

      {!showForm ? (
        <div className="flex gap-2 pt-1">
          <button
            onClick={() => {
              setShowForm(true);
              setAmountStr(String(recommended));
            }}
            className="tap flex-1 py-3 bg-green text-bg rounded font-bold text-sm"
          >
            APOSTAR
          </button>
          <button
            onClick={skip}
            className="tap px-4 py-3 border border-line text-muted rounded font-bold text-sm"
          >
            SKIP
          </button>
        </div>
      ) : (
        <div className="bg-bg/50 border border-line rounded-lg p-3 space-y-3">
          <div>
            <label className="text-[10px] text-muted uppercase tracking-wider">
              Monto a apostar
            </label>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-2xl text-green font-bold">$</span>
              <input
                type="number"
                inputMode="decimal"
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                autoFocus
                className="bg-transparent text-2xl font-bold text-fg outline-none flex-1 min-w-0"
              />
            </div>
            <div className="flex gap-1 mt-2">
              {[recommended, recommended * 2, Math.round(recommended / 2), 100, 200, 500].map((v, i) => (
                <button
                  key={i}
                  onClick={() => setAmountStr(String(v))}
                  className="tap px-2 py-1 border border-line rounded text-[10px] text-muted hover:text-fg"
                >
                  ${v}
                </button>
              ))}
            </div>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-muted">Ganancia potencial</span>
            <span className="text-yellow font-bold">+${win}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-muted">Total a recibir si gana</span>
            <span className="text-fg font-bold">${amountNum + win}</span>
          </div>
          <div className="flex gap-2 pt-1">
            <button
              onClick={confirmar}
              disabled={submitting || amountNum <= 0}
              className="tap flex-1 py-3 bg-green text-bg rounded font-bold text-sm disabled:opacity-50"
            >
              {submitting ? 'APOSTANDO…' : `CONFIRMAR $${amountNum}`}
            </button>
            <button
              onClick={() => {
                setShowForm(false);
                setErr(null);
              }}
              disabled={submitting}
              className="tap px-4 py-3 border border-line text-muted rounded font-bold text-sm"
            >
              CANCELAR
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
