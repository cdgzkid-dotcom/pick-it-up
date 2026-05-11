'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  initial: number;
  unitPercentage: number;
}

export default function BankrollEditor({ initial, unitPercentage }: Props) {
  const [value, setValue] = useState(String(initial));
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [, start] = useTransition();
  const router = useRouter();

  const numeric = Number(value);
  const unit = Math.round((numeric * unitPercentage) / 100);

  const save = async () => {
    setErr(null);
    if (!Number.isFinite(numeric) || numeric < 0) {
      setErr('Número inválido');
      return;
    }
    const r = await fetch('/api/bankroll', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bankroll_current: numeric }),
    });
    if (!r.ok) {
      setErr('Falló la actualización');
      return;
    }
    setEditing(false);
    start(() => router.refresh());
  };

  return (
    <div
      className="bg-card border border-line rounded-lg p-4 tap"
      onClick={() => !editing && setEditing(true)}
    >
      <div className="text-[10px] text-muted uppercase tracking-wider">Bankroll</div>
      {editing ? (
        <div className="mt-1 space-y-2" onClick={(e) => e.stopPropagation()}>
          <div className="text-[10px] text-yellow bg-yellow/10 border border-yellow/30 rounded px-2 py-1.5 leading-snug">
            ⚠️ Solo editar para depósitos o retiros en Draftea. Las apuestas
            se descuentan automáticamente.
          </div>
          <div className="flex items-center gap-2">
            <span className="text-2xl text-green">$</span>
            <input
              type="number"
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
              className="bg-transparent text-3xl font-bold text-green outline-none w-32"
            />
            <button
              onClick={(e) => {
                e.stopPropagation();
                save();
              }}
              className="ml-auto px-3 py-2 bg-green text-bg rounded font-bold text-xs"
            >
              OK
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setEditing(false);
                setValue(String(initial));
              }}
              className="px-3 py-2 border border-line rounded text-xs text-muted"
            >
              X
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-3xl font-bold text-green">${initial.toLocaleString()}</span>
          <span className="text-xs text-muted">tap para editar</span>
        </div>
      )}
      <div className="mt-2 text-xs text-muted">
        unit ({unitPercentage}%) = <span className="text-fg">${unit}</span>
      </div>
      {err && <div className="text-red text-xs mt-1">{err}</div>}
    </div>
  );
}
