'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  selectedSports: string[];
}

const TIMEOUT_MS = 65_000;

export default function GenPicksButton({ selectedSports }: Props) {
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState<string>('');
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

  const go = async () => {
    setErr(null);
    if (selectedSports.length === 0) {
      setErr('Selecciona al menos un deporte');
      return;
    }
    setLoading(true);
    setPhase('Buscando juegos en ESPN…');

    const ac = new AbortController();
    const tHint = setTimeout(() => setPhase('Claude analizando hasta 6 juegos…'), 1500);
    const tAbort = setTimeout(() => ac.abort(), TIMEOUT_MS);

    try {
      const r = await fetch('/api/generate-picks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sports: selectedSports }),
        signal: ac.signal,
      });
      clearTimeout(tHint);
      clearTimeout(tAbort);

      if (!r.ok) {
        const j = await r.json().catch(() => null);
        const msg =
          r.status === 504
            ? 'Tardó demasiado. Intenta con menos deportes o vuelve a intentar.'
            : j?.error ?? `Falló (${r.status})`;
        setErr(msg);
        setLoading(false);
        setPhase('');
        return;
      }

      const data = await r.json().catch(() => null);
      if (data && data.inserted === 0) {
        setErr(
          data.message ??
            'No se encontraron picks con edge positivo en los juegos analizados.',
        );
        setLoading(false);
        setPhase('');
        return;
      }

      setPhase('Listo — abriendo picks…');
      router.push('/picks');
      router.refresh();
    } catch (e) {
      clearTimeout(tHint);
      clearTimeout(tAbort);
      const name = (e as Error).name;
      if (name === 'AbortError') {
        setErr('Tardó más de 65s. Intenta con menos deportes seleccionados.');
      } else {
        setErr(`Error de red: ${(e as Error).message}`);
      }
      setLoading(false);
      setPhase('');
    }
  };

  return (
    <div>
      <button
        onClick={go}
        disabled={loading}
        className="tap w-full py-4 bg-green text-bg rounded-lg font-bold text-base disabled:opacity-50 disabled:bg-green/60"
      >
        {loading ? 'ANALIZANDO…' : '🎯 GENERA PICKS'}
      </button>
      {loading && phase && (
        <div className="text-[11px] text-muted mt-2 text-center animate-pulse">
          {phase}
        </div>
      )}
      {err && (
        <div className="text-red text-xs mt-2 text-center bg-red/10 border border-red/30 rounded px-2 py-2">
          {err}
        </div>
      )}
    </div>
  );
}
