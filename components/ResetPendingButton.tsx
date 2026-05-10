'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function ResetPendingButton({ count }: { count: number }) {
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

  if (count === 0) return null;

  const run = async () => {
    if (running) return;
    const ok = window.confirm(
      `¿Borrar ${count} apuesta${count === 1 ? '' : 's'} pendiente${count === 1 ? '' : 's'}? El bankroll no se modifica.`,
    );
    if (!ok) return;
    setRunning(true);
    setErr(null);
    try {
      const r = await fetch('/api/bets/reset-pending', { method: 'POST' });
      if (!r.ok) {
        setErr(`Error (${r.status})`);
        return;
      }
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-1">
      <button
        onClick={run}
        disabled={running}
        className="tap w-full py-2 border border-red/40 text-xs rounded text-red disabled:opacity-50"
      >
        {running ? 'Borrando…' : `🗑️ Resetear pendientes (${count})`}
      </button>
      {err && <div className="text-red text-xs">{err}</div>}
    </div>
  );
}
