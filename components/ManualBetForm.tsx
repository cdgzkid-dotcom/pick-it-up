'use client';
import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { SportLogo } from './Logo';

interface PendingPick {
  id: string;
  sport: string;
  game: string;
  home_team: string;
  away_team: string;
  home_team_abbr: string | null;
  away_team_abbr: string | null;
  espn_event_id: string | null;
  pick: string;
  bet_type: string;
  odds_decimal: number;
  tier: string | null;
  recommended_amount: number;
}

const SPORTS = ['MLB', 'NBA', 'NHL', 'NFL', 'Liga MX', 'Premier League', 'Champions', 'UFC', 'Otro'];

// Heuristic auto-detection of bet_type from pick text
function detectBetType(text: string): string {
  const t = text.trim();
  if (/^(over|under)\b/i.test(t)) return 'Total';
  if (/[+-]\d+(\.\d+)?\b/.test(t)) return 'Spread';
  if (/\bml\b/i.test(t) || /^[A-Z][A-Za-z\s\-.0-9]+$/.test(t)) return 'ML';
  return 'ML';
}

// Heuristic sport guess from team name keywords. Best-effort only.
const SPORT_HINTS: Record<string, string[]> = {
  MLB: ['cubs', 'yankees', 'rangers', 'mets', 'astros', 'dodgers', 'red sox', 'phillies', 'braves', 'marlins', 'rays', 'orioles', 'royals', 'pirates', 'diamondbacks', 'guardians', 'tigers', 'mariners', 'angels', 'twins', 'rockies', 'nationals', 'reds', 'brewers', 'cardinals', 'padres', 'blue jays', 'athletics', 'giants', 'white sox'],
  NBA: ['lakers', 'celtics', 'warriors', 'knicks', '76ers', 'nuggets', 'bucks', 'heat', 'spurs', 'mavericks', 'suns', 'thunder', 'cavaliers', 'pistons', 'pelicans', 'wolves', 'timberwolves', 'magic', 'hornets', 'pacers', 'raptors', 'nets', 'kings', 'jazz'],
  NHL: ['canadiens', 'oilers', 'leafs', 'maple leafs', 'rangers', 'bruins', 'islanders', 'penguins', 'sabres', 'flyers', 'capitals', 'devils', 'panthers', 'lightning', 'red wings', 'predators', 'avalanche', 'stars', 'wild', 'flames', 'jets', 'canucks', 'sharks', 'ducks', 'kings', 'knights', 'kraken', 'hurricanes', 'blue jackets', 'senators', 'blackhawks'],
  NFL: ['chiefs', 'eagles', 'cowboys', 'patriots', 'packers', '49ers', 'bills', 'bengals', 'ravens', 'dolphins', 'jets', 'steelers', 'browns', 'titans', 'jaguars', 'colts', 'texans', 'broncos', 'raiders', 'chargers', 'lions', 'vikings', 'bears', 'commanders', 'giants', 'rams', 'seahawks', 'cardinals', 'saints', 'falcons', 'buccaneers', 'panthers'],
};
function detectSport(text: string, fallback = 'MLB'): string {
  const t = text.toLowerCase();
  for (const [sport, keywords] of Object.entries(SPORT_HINTS)) {
    if (keywords.some((k) => t.includes(k))) return sport;
  }
  return fallback;
}

export default function ManualBetForm() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'list' | 'manual'>('list');
  const [pending, setPending] = useState<PendingPick[]>([]);
  const [loadingList, setLoadingList] = useState(false);

  // Quick-bet from pending pick
  const [selectedPick, setSelectedPick] = useState<PendingPick | null>(null);
  const [amount, setAmount] = useState('');

  // Manual entry
  const [manualPick, setManualPick] = useState('');
  const [manualOdds, setManualOdds] = useState('');
  const [manualAmount, setManualAmount] = useState('');
  const [manualSport, setManualSport] = useState('MLB');

  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [, start] = useTransition();
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    setLoadingList(true);
    fetch('/api/pending-picks')
      .then((r) => r.json())
      .then((d) => setPending(d.picks ?? []))
      .catch(() => setPending([]))
      .finally(() => setLoadingList(false));
  }, [open]);

  const confirmFromPick = async () => {
    if (!selectedPick) return;
    setErr(null);
    const a = Number(amount);
    if (!Number.isFinite(a) || a <= 0) {
      setErr('Monto inválido');
      return;
    }
    setSubmitting(true);
    const r = await fetch('/api/bets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pick_id: selectedPick.id,
        sport: selectedPick.sport,
        game: selectedPick.game,
        home_team: selectedPick.home_team,
        away_team: selectedPick.away_team,
        home_team_abbr: selectedPick.home_team_abbr,
        away_team_abbr: selectedPick.away_team_abbr,
        espn_event_id: selectedPick.espn_event_id,
        pick: selectedPick.pick,
        bet_type: selectedPick.bet_type,
        odds_decimal: Number(selectedPick.odds_decimal),
        amount: a,
        tier: selectedPick.tier,
      }),
    });
    setSubmitting(false);
    if (!r.ok) {
      const j = await r.json().catch(() => null);
      setErr(r.status === 409 ? 'Ya apostaste a este pick' : j?.error ?? 'Falló');
      return;
    }
    setOpen(false);
    setSelectedPick(null);
    setAmount('');
    start(() => router.refresh());
  };

  const submitManual = async () => {
    setErr(null);
    const o = Number(manualOdds);
    const a = Number(manualAmount);
    if (!manualPick.trim()) {
      setErr('Falta el pick (ej: Cubs ML, Over 8.5, Lakers -2.5)');
      return;
    }
    if (!Number.isFinite(o) || o <= 1) {
      setErr('Momio inválido (decimal > 1.00)');
      return;
    }
    if (!Number.isFinite(a) || a <= 0) {
      setErr('Monto inválido');
      return;
    }
    const sportGuess = detectSport(manualPick, manualSport);
    const betType = detectBetType(manualPick);
    setSubmitting(true);
    const r = await fetch('/api/bets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sport: sportGuess,
        game: manualPick, // best-effort, since user didn't type a full matchup
        pick: manualPick,
        bet_type: betType,
        odds_decimal: o,
        amount: a,
      }),
    });
    setSubmitting(false);
    if (!r.ok) {
      const j = await r.json().catch(() => null);
      setErr(j?.error ?? 'Falló');
      return;
    }
    setManualPick('');
    setManualOdds('');
    setManualAmount('');
    setOpen(false);
    start(() => router.refresh());
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="tap w-full py-3 border border-line rounded text-xs text-muted"
      >
        + Agregar apuesta manual
      </button>
    );
  }

  // STEP 2: monto para un pick pendiente
  if (selectedPick) {
    const win = Math.round(Number(amount || 0) * (selectedPick.odds_decimal - 1));
    return (
      <div className="bg-card border border-line rounded-lg p-3 space-y-2">
        <div className="flex items-baseline justify-between">
          <div className="text-[10px] text-muted uppercase tracking-wider">
            Confirmar apuesta
          </div>
          <button onClick={() => setSelectedPick(null)} className="text-[10px] text-muted">
            ← volver
          </button>
        </div>
        <div className="text-sm font-bold">{selectedPick.pick}</div>
        <div className="text-xs text-muted">{selectedPick.game}</div>
        <div className="text-xs">
          Momio: <span className="text-blue font-bold">{Number(selectedPick.odds_decimal).toFixed(2)}</span>
        </div>
        <div>
          <label className="text-[10px] text-muted uppercase tracking-wider">Monto</label>
          <input
            type="number"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            autoFocus
            className="w-full bg-bg border border-line rounded px-2 py-2 text-base mt-1"
          />
        </div>
        <div className="text-xs text-muted">
          Ganancia: <span className="text-yellow font-bold">+${win}</span>
        </div>
        {err && <div className="text-red text-xs">{err}</div>}
        <div className="flex gap-2">
          <button
            onClick={confirmFromPick}
            disabled={submitting}
            className="tap flex-1 py-2 bg-green text-bg rounded font-bold text-xs"
          >
            {submitting ? 'GUARDANDO…' : `CONFIRMAR $${Math.round(Number(amount) || 0)}`}
          </button>
          <button
            onClick={() => setOpen(false)}
            className="tap px-3 border border-line rounded text-xs text-muted"
          >
            Cancelar
          </button>
        </div>
      </div>
    );
  }

  // STEP 1: lista de pending picks + opción a manual
  return (
    <div className="bg-card border border-line rounded-lg p-3 space-y-2">
      <div className="flex items-baseline justify-between">
        <div className="text-[10px] text-muted uppercase tracking-wider">
          {mode === 'list' ? 'Picks del día sin apuesta' : 'Apuesta personalizada'}
        </div>
        <button onClick={() => setOpen(false)} className="text-[10px] text-muted">
          cerrar
        </button>
      </div>

      {mode === 'list' && (
        <>
          {loadingList ? (
            <div className="text-xs text-muted text-center py-3">Cargando…</div>
          ) : pending.length === 0 ? (
            <div className="text-xs text-muted text-center py-3">
              No hay picks pendientes del sistema.
            </div>
          ) : (
            <div className="space-y-1 max-h-72 overflow-auto">
              {pending.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    setSelectedPick(p);
                    setAmount(String(Math.max(1, Math.round(Number(p.recommended_amount) || 0))));
                    setErr(null);
                  }}
                  className="tap w-full text-left bg-bg border border-line rounded p-2 hover:border-green/60"
                >
                  <div className="flex items-center gap-2">
                    <SportLogo sport={p.sport} size={16} />
                    <span className="text-xs text-muted">{p.sport}</span>
                    <span className="text-xs flex-1 truncate">{p.pick}</span>
                    <span className="text-xs text-blue font-bold">
                      @ {Number(p.odds_decimal).toFixed(2)}
                    </span>
                  </div>
                  <div className="text-[10px] text-muted truncate mt-0.5">{p.game}</div>
                </button>
              ))}
            </div>
          )}
          <button
            onClick={() => {
              setMode('manual');
              setErr(null);
            }}
            className="tap w-full py-2 text-xs text-muted border border-line rounded"
          >
            No veo mi apuesta · entrar manualmente
          </button>
        </>
      )}

      {mode === 'manual' && (
        <>
          <input
            placeholder="Pick (ej: Cubs ML, Over 8.5, Lakers -2.5)"
            value={manualPick}
            onChange={(e) => setManualPick(e.target.value)}
            className="w-full bg-bg border border-line rounded px-2 py-2 text-sm"
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              type="number"
              inputMode="decimal"
              placeholder="momio (1.85)"
              value={manualOdds}
              onChange={(e) => setManualOdds(e.target.value)}
              className="bg-bg border border-line rounded px-2 py-2 text-sm"
            />
            <input
              type="number"
              inputMode="decimal"
              placeholder="monto $"
              value={manualAmount}
              onChange={(e) => setManualAmount(e.target.value)}
              className="bg-bg border border-line rounded px-2 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-[10px] text-muted">Deporte (auto-detectado)</label>
            <select
              value={manualSport}
              onChange={(e) => setManualSport(e.target.value)}
              className="w-full bg-bg border border-line rounded px-2 py-1.5 text-xs mt-0.5"
            >
              {SPORTS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="text-[10px] text-muted">
            Auto-detect: {manualPick ? `${detectSport(manualPick, manualSport)} · ${detectBetType(manualPick)}` : '—'}
          </div>
          {err && <div className="text-red text-xs">{err}</div>}
          <div className="flex gap-2">
            <button
              onClick={submitManual}
              disabled={submitting}
              className="tap flex-1 py-2 bg-green text-bg rounded font-bold text-xs"
            >
              GUARDAR
            </button>
            <button
              onClick={() => {
                setMode('list');
                setErr(null);
              }}
              className="tap px-3 border border-line rounded text-xs text-muted"
            >
              ← lista
            </button>
          </div>
        </>
      )}
    </div>
  );
}
