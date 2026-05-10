'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

const RATE_LIMIT_KEY = 'pick-it-up:last-check-results';
const MIN_INTERVAL_MS = 60_000;

interface Resolution {
  bet_id: string;
  pick: string;
  result: 'win' | 'loss';
  pl: number;
  home_score: number;
  away_score: number;
}

export default function ResultsRefresher({ manual = false }: { manual?: boolean }) {
  const [running, setRunning] = useState(false);
  const [resolutions, setResolutions] = useState<Resolution[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

  const run = async (force = false) => {
    if (running) return;
    if (!force) {
      const last = Number(localStorage.getItem(RATE_LIMIT_KEY) ?? 0);
      if (Date.now() - last < MIN_INTERVAL_MS) return;
    }
    setRunning(true);
    setErr(null);
    try {
      const r = await fetch('/api/check-results', { method: 'POST' });
      if (!r.ok) {
        setErr(`Error (${r.status})`);
        setRunning(false);
        return;
      }
      const data = await r.json().catch(() => null);
      localStorage.setItem(RATE_LIMIT_KEY, String(Date.now()));
      if (data?.resolutions?.length > 0) {
        setResolutions(data.resolutions);
        router.refresh();
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  // Auto-run on mount
  useEffect(() => {
    if (!manual) run(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (manual) {
    return (
      <button
        onClick={() => run(true)}
        disabled={running}
        className="tap w-full py-2 border border-line text-xs rounded text-muted disabled:opacity-50"
      >
        {running ? 'Revisando…' : '🔄 Actualizar resultados'}
      </button>
    );
  }

  if (resolutions.length === 0 && !err) return null;

  return (
    <div className="space-y-1">
      {resolutions.map((r) => (
        <div
          key={r.bet_id}
          className={`text-xs px-3 py-2 rounded border ${
            r.result === 'win'
              ? 'bg-green/10 border-green/40 text-green'
              : 'bg-red/10 border-red/40 text-red'
          }`}
        >
          {r.result === 'win' ? '🎉 GANÓ' : '💀 PERDIÓ'} · {r.pick} ·{' '}
          {r.pl >= 0 ? '+' : ''}${Math.round(r.pl)}
        </div>
      ))}
      {err && <div className="text-red text-xs">{err}</div>}
    </div>
  );
}
