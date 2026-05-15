'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

// ── Types (mirrors API response shapes) ────────────────────────────────────

interface DrafteaLeg {
  sport: string;
  league: string | null;
  teams: string;
  selection: string;
  market_type: string;
  line: string | null;
  odds_decimal: number;
  event_time: string | null;
}

interface DrafteaExtractedBet {
  is_draftea_betslip: boolean;
  bet_type: 'SENCILLA' | 'COMBINADA' | 'SISTEMA' | 'SGP' | null;
  total_odds_decimal: number | null;
  wager_mxn: number | null;
  potential_payout_mxn: number | null;
  potential_winnings_mxn: number | null;
  status: 'PENDIENTE' | 'GANADA' | 'PERDIDA' | 'CASHOUT' | 'ANULADA' | null;
  bet_id: string | null;
  placed_at: string | null;
  legs: DrafteaLeg[];
  boost_applied: { type: string | null; description: string | null } | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  extraction_notes: string;
}

interface PickCandidate {
  id: string;
  sport: string;
  game: string;
  home_team: string;
  away_team: string;
  pick: string;
  bet_type: string;
  odds_decimal: number;
  tier: string | null;
  recommended_amount: number;
}

interface LegMatch {
  leg_index: number;
  pick: PickCandidate | null;
  /** screenshot.odds − pick.odds (positive = screenshot better) */
  odds_diff: number | null;
}

interface ExtractResponse {
  extracted: DrafteaExtractedBet;
  matches: LegMatch[];
  math_warning: string | null;
  usage: { tokens_in: number; tokens_out: number; cost_usd: number };
}

// ── Confirm leg (extends extracted leg with match info) ───────────────────

interface ConfirmLeg extends DrafteaLeg {
  matched_pick_id: string | null;
  odds_changed: boolean;
  original_odds: number | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sportEmoji(sport: string): string {
  const s = sport.toLowerCase();
  if (s.includes('fútbol') || s.includes('futbol') || s.includes('soccer')) return '⚽';
  if (s.includes('nba') || s.includes('basket')) return '🏀';
  if (s.includes('nfl') || s.includes('football')) return '🏈';
  if (s.includes('mlb') || s.includes('béisbol') || s.includes('beisbol')) return '⚾';
  if (s.includes('nhl') || s.includes('hockey')) return '🏒';
  if (s.includes('ufc') || s.includes('mma') || s.includes('box')) return '🥊';
  if (s.includes('tenis') || s.includes('tennis')) return '🎾';
  if (s.includes('golf')) return '⛳';
  if (s.includes('formula') || s.includes('f1')) return '🏎️';
  return '🎯';
}

function statusColor(s: string | null): string {
  switch (s) {
    case 'GANADA': return 'text-green';
    case 'PERDIDA': return 'text-red';
    case 'CASHOUT': return 'text-yellow';
    case 'ANULADA': return 'text-blue';
    default: return 'text-muted';
  }
}

function fmtOdds(n: number | null | undefined): string {
  if (!n) return '—';
  return n.toFixed(2);
}

function fmtMXN(n: number | null | undefined): string {
  if (n == null) return '—';
  return `$${n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function confidenceBadge(c: string) {
  if (c === 'HIGH') return <span className="text-green text-[10px]">● Confianza ALTA</span>;
  if (c === 'MEDIUM') return <span className="text-yellow text-[10px]">● Confianza MEDIA — revisa bien</span>;
  return <span className="text-red text-[10px]">● Confianza BAJA — verifica los datos</span>;
}

// ── Main component ─────────────────────────────────────────────────────────

type Phase = 'idle' | 'uploading' | 'preview' | 'confirming' | 'done' | 'error';

export default function DrafteaBetFromImage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [extractResponse, setExtractResponse] = useState<ExtractResponse | null>(null);
  // Confirm legs are the extracted legs with match info merged in
  const [confirmLegs, setConfirmLegs] = useState<ConfirmLeg[]>([]);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);
  const [, start] = useTransition();
  const router = useRouter();

  // Build confirm legs from extract response
  function buildConfirmLegs(resp: ExtractResponse): ConfirmLeg[] {
    return resp.extracted.legs.map((leg, idx) => {
      const m = resp.matches.find((x) => x.leg_index === idx);
      const matchedPick = m?.pick ?? null;
      const oddsChanged =
        matchedPick !== null &&
        m?.odds_diff !== null &&
        Math.abs(m!.odds_diff!) >= 0.005;
      return {
        ...leg,
        matched_pick_id: matchedPick?.id ?? null,
        odds_changed: oddsChanged,
        original_odds: matchedPick ? Number(matchedPick.odds_decimal) : null,
      };
    });
  }

  // ── Upload handler ────────────────────────────────────────────────────

  async function handleFile(file: File) {
    setPhase('uploading');
    setErrorMsg(null);

    const fd = new FormData();
    fd.append('image', file);

    try {
      const res = await fetch('/api/bets/from-image', { method: 'POST', body: fd });
      const json = await res.json();

      if (!res.ok) {
        setErrorMsg(json.error ?? `Error ${res.status}`);
        setPhase('error');
        return;
      }

      const resp = json as ExtractResponse;
      setExtractResponse(resp);
      setConfirmLegs(buildConfirmLegs(resp));
      setPhase('preview');
    } catch (e) {
      setErrorMsg(`Error de red: ${String(e)}`);
      setPhase('error');
    }
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    // Reset so same file can be re-selected
    e.target.value = '';
  }

  // ── Confirm handler ───────────────────────────────────────────────────

  async function handleConfirm() {
    if (!extractResponse) return;
    setPhase('confirming');

    const { extracted, usage } = extractResponse;

    const body = {
      bet_type: extracted.bet_type,
      total_odds_decimal: extracted.total_odds_decimal ?? 1,
      wager_mxn: extracted.wager_mxn ?? 0,
      potential_payout_mxn: extracted.potential_payout_mxn,
      potential_winnings_mxn: extracted.potential_winnings_mxn,
      status_draftea: extracted.status,
      bet_id_draftea: extracted.bet_id,
      placed_at: extracted.placed_at,
      legs: confirmLegs,
      usage_tokens_in: usage.tokens_in,
      usage_tokens_out: usage.tokens_out,
      usage_cost_usd: usage.cost_usd,
      confidence: extracted.confidence,
    };

    try {
      const res = await fetch('/api/bets/from-image/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();

      if (!res.ok) {
        setErrorMsg(json.error ?? `Error ${res.status}`);
        setPhase('error');
        return;
      }

      const oddsCount = (json.odds_updated as Array<unknown>)?.length ?? 0;
      const isHistorical = json.historical as boolean;

      setDoneMsg(
        isHistorical
          ? `✅ Apuesta ${extracted.status?.toLowerCase()} registrada en historial.${oddsCount ? ` ${oddsCount} momio(s) actualizado(s).` : ''} ${json.message ?? ''}`
          : `✅ Apuesta registrada.${oddsCount ? ` ${oddsCount} momio(s) actualizado(s) al valor real.` : ''}`,
      );
      setPhase('done');
      setTimeout(() => {
        start(() => router.refresh());
        setPhase('idle');
        setExtractResponse(null);
        setConfirmLegs([]);
        setDoneMsg(null);
      }, 3000);
    } catch (e) {
      setErrorMsg(`Error de red: ${String(e)}`);
      setPhase('error');
    }
  }

  // ── Render: idle ──────────────────────────────────────────────────────

  if (phase === 'idle') {
    return (
      <div className="bg-card border border-line rounded-lg p-4 space-y-3">
        <div className="text-[10px] text-muted uppercase tracking-wider">
          Registrar vía screenshot
        </div>
        <div className="text-xs text-fg leading-relaxed">
          📸 ¿Acabas de apostar en DRAFTEA? Sube el screenshot del ticket y lo
          registramos automáticamente, ajustando los momios si cambiaron.
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={onFileChange}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          className="tap w-full py-3 bg-blue/10 border border-blue/40 rounded text-sm font-bold text-blue hover:bg-blue/20 active:bg-blue/30"
        >
          📤 Subir screenshot de ticket DRAFTEA
        </button>
      </div>
    );
  }

  // ── Render: uploading ─────────────────────────────────────────────────

  if (phase === 'uploading') {
    return (
      <div className="bg-card border border-line rounded-lg p-6 text-center space-y-3">
        <div className="text-2xl animate-pulse">🔍</div>
        <div className="text-xs text-muted">Analizando imagen con Claude…</div>
        <div className="text-[10px] text-muted">Extrayendo picks, momios y monto</div>
      </div>
    );
  }

  // ── Render: error ─────────────────────────────────────────────────────

  if (phase === 'error') {
    return (
      <div className="bg-card border border-red/40 rounded-lg p-4 space-y-3">
        <div className="text-red text-sm font-bold">Error al procesar imagen</div>
        <div className="text-xs text-muted leading-relaxed">{errorMsg}</div>
        <button
          onClick={() => {
            setPhase('idle');
            setErrorMsg(null);
          }}
          className="tap w-full py-2 border border-line rounded text-xs text-muted"
        >
          Intentar de nuevo
        </button>
      </div>
    );
  }

  // ── Render: done ──────────────────────────────────────────────────────

  if (phase === 'done') {
    return (
      <div className="bg-card border border-green/40 rounded-lg p-4">
        <div className="text-xs text-fg leading-relaxed">{doneMsg}</div>
        <div className="text-[10px] text-muted mt-2">Actualizando tracker…</div>
      </div>
    );
  }

  // ── Render: confirming ────────────────────────────────────────────────

  if (phase === 'confirming') {
    return (
      <div className="bg-card border border-line rounded-lg p-6 text-center space-y-3">
        <div className="text-2xl animate-pulse">💾</div>
        <div className="text-xs text-muted">Guardando apuesta…</div>
      </div>
    );
  }

  // ── Render: preview (the main modal) ──────────────────────────────────

  const resp = extractResponse!;
  const { extracted } = resp;
  const isSettled = extracted.status && extracted.status !== 'PENDIENTE';
  const isParlay = (extracted.legs.length > 1) || extracted.bet_type === 'COMBINADA';

  return (
    <div className="fixed inset-0 bg-black/85 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="w-full sm:max-w-md bg-card border border-line rounded-t-2xl sm:rounded-xl flex flex-col max-h-[92vh]">

        {/* ── Header ── */}
        <div className="px-4 pt-4 pb-3 border-b border-line shrink-0">
          <div className="flex items-center justify-between">
            <div className="text-sm font-bold">📸 Ticket DRAFTEA detectado</div>
            <button
              onClick={() => {
                setPhase('idle');
                setExtractResponse(null);
                setConfirmLegs([]);
              }}
              className="text-muted text-lg leading-none px-1"
            >
              ✕
            </button>
          </div>
          <div className="mt-1">{confidenceBadge(extracted.confidence)}</div>
        </div>

        {/* ── Scrollable body ── */}
        <div className="overflow-y-auto flex-1 px-4 py-3 space-y-4">

          {/* Math warning */}
          {resp.math_warning && (
            <div className="bg-red/10 border border-red/30 rounded px-3 py-2 text-[11px] text-red leading-snug">
              ⚠️ {resp.math_warning}
            </div>
          )}

          {/* Historical settled ticket notice */}
          {isSettled && (
            <div className="bg-yellow/10 border border-yellow/30 rounded px-3 py-2 text-[11px] text-yellow leading-snug">
              Esta apuesta ya está <span className={`font-bold ${statusColor(extracted.status)}`}>{extracted.status?.toLowerCase()}</span>. Se registrará en tu historial pero tu bankroll no se modificará automáticamente.
            </div>
          )}

          {/* Ticket summary */}
          <div className="bg-bg border border-line rounded-lg p-3 space-y-1.5">
            <div className="flex justify-between items-center">
              <span className="text-[10px] text-muted uppercase tracking-wider">
                {isParlay ? `COMBINADA · ${extracted.legs.length} picks` : (extracted.bet_type ?? 'SENCILLA')}
              </span>
              <span className={`text-[11px] font-bold ${statusColor(extracted.status)}`}>
                {extracted.status ?? '—'}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <div>
                <span className="text-muted">Apostado: </span>
                <span className="font-bold">{fmtMXN(extracted.wager_mxn)}</span>
              </div>
              <div>
                <span className="text-muted">Momio: </span>
                <span className="font-bold text-blue">{fmtOdds(extracted.total_odds_decimal)}</span>
              </div>
              <div>
                <span className="text-muted">Pago total: </span>
                <span className="font-bold text-green">{fmtMXN(extracted.potential_payout_mxn)}</span>
              </div>
              <div>
                <span className="text-muted">Ganancia: </span>
                <span className="font-bold text-green">{fmtMXN(extracted.potential_winnings_mxn)}</span>
              </div>
            </div>
            {extracted.bet_id && (
              <div className="text-[10px] text-muted">ID: {extracted.bet_id}</div>
            )}
            {extracted.boost_applied?.type && (
              <div className="text-[10px] text-yellow">🎁 {extracted.boost_applied.description ?? extracted.boost_applied.type}</div>
            )}
          </div>

          {/* ── Legs ── */}
          <div className="space-y-2">
            <div className="text-[10px] text-muted uppercase tracking-wider">
              Selecciones ({extracted.legs.length})
            </div>

            {confirmLegs.map((leg, idx) => {
              const oddsChanged = leg.odds_changed && leg.original_odds !== null;
              const oddsWorse = oddsChanged && leg.odds_decimal < leg.original_odds!;
              const oddsBetter = oddsChanged && leg.odds_decimal > leg.original_odds!;
              const hasMatch = !!leg.matched_pick_id;

              return (
                <div
                  key={idx}
                  className={`rounded-lg border px-3 py-2.5 space-y-1.5 ${
                    oddsChanged ? 'border-yellow/50 bg-yellow/5' : 'border-line bg-bg'
                  }`}
                >
                  {/* Sport + league */}
                  <div className="flex items-center gap-1.5 text-[10px] text-muted">
                    <span>{sportEmoji(leg.sport)}</span>
                    <span className="uppercase">{leg.sport}</span>
                    {leg.league && <span>· {leg.league}</span>}
                  </div>

                  {/* Teams */}
                  <div className="text-xs text-fg font-medium leading-snug">{leg.teams}</div>

                  {/* Selection */}
                  <div className="text-xs text-fg">
                    {leg.selection}
                    {leg.line && <span className="text-muted"> ({leg.line})</span>}
                  </div>

                  {/* Odds + match status row */}
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-bold text-blue">{fmtOdds(leg.odds_decimal)}</div>
                    <div className="text-[10px]">
                      {!hasMatch && (
                        <span className="text-muted">🆕 Sin pick previo</span>
                      )}
                      {hasMatch && !oddsChanged && (
                        <span className="text-green">✓ Momio coincide</span>
                      )}
                      {hasMatch && oddsChanged && (
                        <span className={oddsWorse ? 'text-red' : 'text-yellow'}>
                          ⚠️ Momio cambió
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Odds diff detail */}
                  {hasMatch && oddsChanged && (
                    <div className="bg-yellow/10 border border-yellow/30 rounded px-2 py-1.5 text-[10px] leading-snug space-y-0.5">
                      <div className="flex justify-between">
                        <span className="text-muted">Pick original:</span>
                        <span className="line-through text-muted">{fmtOdds(leg.original_odds)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className={oddsWorse ? 'text-red' : 'text-green'}>Apuesta real:</span>
                        <span className={`font-bold ${oddsWorse ? 'text-red' : 'text-green'}`}>
                          {fmtOdds(leg.odds_decimal)} ← se usará este
                        </span>
                      </div>
                      <div className="text-muted pt-0.5">
                        {oddsWorse
                          ? 'El momio bajó. ROI calculado con el valor real.'
                          : oddsBetter
                          ? 'El momio subió. ¡Mejor de lo esperado!'
                          : ''}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Extraction notes if confidence not HIGH */}
          {extracted.confidence !== 'HIGH' && extracted.extraction_notes && (
            <div className="text-[10px] text-muted border border-line rounded px-2 py-1.5 leading-snug">
              Nota de extracción: {extracted.extraction_notes}
            </div>
          )}
        </div>

        {/* ── Action buttons (fixed bottom) ── */}
        <div className="px-4 pb-6 pt-3 border-t border-line space-y-2 shrink-0">
          <button
            onClick={handleConfirm}
            className="tap w-full py-3 bg-green text-bg rounded-lg font-bold text-sm"
          >
            ✅ Confirmar y registrar
          </button>

          {/* "Edit before saving" → opens ManualBetForm with pre-filled context */}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => {
                // Drop to idle with data cleared — user uses ManualBetForm below
                setPhase('idle');
                setExtractResponse(null);
                setConfirmLegs([]);
              }}
              className="tap py-2 border border-line rounded text-xs text-muted"
            >
              ✏️ Ingresar manual
            </button>
            <button
              onClick={() => {
                setPhase('idle');
                setExtractResponse(null);
                setConfirmLegs([]);
              }}
              className="tap py-2 border border-line rounded text-xs text-muted"
            >
              ❌ Cancelar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
