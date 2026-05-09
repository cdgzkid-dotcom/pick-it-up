'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

const SPORTS = ['NBA', 'NFL', 'MLB', 'Fútbol', 'NHL', 'Tennis', 'UFC', 'Boxing', 'Otro'];
const TYPES = ['ML', 'Spread', 'O-U', 'Prop', 'Parlay'];

export default function ManualBetForm() {
  const [open, setOpen] = useState(false);
  const [sport, setSport] = useState('NBA');
  const [game, setGame] = useState('');
  const [pick, setPick] = useState('');
  const [betType, setBetType] = useState('ML');
  const [odds, setOdds] = useState('');
  const [amount, setAmount] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [isPending, start] = useTransition();
  const router = useRouter();

  const submit = async () => {
    setErr(null);
    const o = Number(odds);
    const a = Number(amount);
    if (!game || !pick) {
      setErr('Falta juego o pick');
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
    const r = await fetch('/api/bets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sport,
        game,
        pick,
        bet_type: betType,
        odds_decimal: o,
        amount: a,
      }),
    });
    if (!r.ok) {
      setErr('Falló');
      return;
    }
    setGame('');
    setPick('');
    setOdds('');
    setAmount('');
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

  return (
    <div className="bg-card border border-line rounded-lg p-3 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <select
          value={sport}
          onChange={(e) => setSport(e.target.value)}
          className="bg-bg border border-line rounded px-2 py-2 text-xs"
        >
          {SPORTS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={betType}
          onChange={(e) => setBetType(e.target.value)}
          className="bg-bg border border-line rounded px-2 py-2 text-xs"
        >
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      <input
        placeholder="Juego (ej: Lakers @ Thunder)"
        value={game}
        onChange={(e) => setGame(e.target.value)}
        className="w-full bg-bg border border-line rounded px-2 py-2 text-xs"
      />
      <input
        placeholder="Pick (ej: Thunder ML)"
        value={pick}
        onChange={(e) => setPick(e.target.value)}
        className="w-full bg-bg border border-line rounded px-2 py-2 text-xs"
      />
      <div className="grid grid-cols-2 gap-2">
        <input
          type="number"
          inputMode="decimal"
          placeholder="momio (1.85)"
          value={odds}
          onChange={(e) => setOdds(e.target.value)}
          className="bg-bg border border-line rounded px-2 py-2 text-xs"
        />
        <input
          type="number"
          inputMode="decimal"
          placeholder="monto $"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="bg-bg border border-line rounded px-2 py-2 text-xs"
        />
      </div>
      {err && <div className="text-red text-xs">{err}</div>}
      <div className="flex gap-2">
        <button
          onClick={submit}
          disabled={isPending}
          className="tap flex-1 py-2 bg-green text-bg rounded font-bold text-xs"
        >
          GUARDAR
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
