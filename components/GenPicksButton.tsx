'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  selectedSports: string[];
  hasPendingPicks?: boolean;
}

const TIMEOUT_MS = 58_000;

const PHASES = [
  { ms: 0, text: 'Buscando juegos del día…' },
  { ms: 800, text: 'Jalando momios…' },
  { ms: 1800, text: 'Descargando lesiones…' },
  { ms: 3000, text: 'Claude analizando juegos…' },
  { ms: 25000, text: 'Calculando edge…' },
];

export default function GenPicksButton({ selectedSports, hasPendingPicks }: Props) {
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState('');
  const [success, setSuccess] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();
  const phaseTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    return () => phaseTimers.current.forEach((t) => clearTimeout(t));
  }, []);

  const go = async () => {
    setErr(null);
    setSuccess(null);
    if (selectedSports.length === 0) {
      setErr('Selecciona al menos un deporte');
      return;
    }
    setLoading(true);

    // Schedule progressive phase texts
    phaseTimers.current.forEach((t) => clearTimeout(t));
    phaseTimers.current = PHASES.map((p) =>
      setTimeout(() => setPhase(p.text), p.ms),
    );

    const ac = new AbortController();
    const tAbort = setTimeout(() => ac.abort(), TIMEOUT_MS);

    try {
      const r = await fetch('/api/generate-picks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sports: selectedSports }),
        signal: ac.signal,
      });
      clearTimeout(tAbort);
      phaseTimers.current.forEach((t) => clearTimeout(t));

      if (!r.ok) {
        const j = await r.json().catch(() => null);
        const msg =
          r.status === 504
            ? 'Tardó demasiado. Intenta con menos deportes seleccionados.'
            : j?.error ?? `Error (${r.status})`;
        setErr(msg);
        setLoading(false);
        setPhase('');
        return;
      }

      const data = await r.json().catch(() => null);
      const total = (data?.with_edge ?? 0) + (data?.parlays ?? 0);
      setPhase(`Listo — ${total} pick${total === 1 ? '' : 's'} con edge positivo`);
      setSuccess(
        `${data?.with_edge ?? 0} picks${data?.parlays ? ` + ${data.parlays} parlays` : ''} · analizados ${data?.analyzed ?? 0} de ${data?.total_available ?? 0}`,
      );
      router.push('/picks');
      router.refresh();
    } catch (e) {
      clearTimeout(tAbort);
      phaseTimers.current.forEach((t) => clearTimeout(t));
      const name = (e as Error).name;
      if (name === 'AbortError') {
        setErr('Error: intenta con menos deportes seleccionados.');
      } else {
        setErr(`Error de red: ${(e as Error).message}`);
      }
      setLoading(false);
      setPhase('');
    }
  };

  const label = hasPendingPicks ? '🔄 Actualizar análisis' : '🎯 Generar picks';

  return (
    <div>
      <button
        onClick={go}
        disabled={loading}
        className="tap w-full py-4 bg-green text-bg rounded-lg font-bold text-base disabled:opacity-60"
      >
        {loading ? 'ANALIZANDO…' : label}
      </button>
      {loading && phase && (
        <div className="text-[11px] text-muted mt-2 text-center animate-pulse">
          {phase}
        </div>
      )}
      {success && !loading && (
        <div className="text-[11px] text-green mt-2 text-center">{success}</div>
      )}
      {err && (
        <div className="text-red text-xs mt-2 text-center bg-red/10 border border-red/30 rounded px-2 py-2">
          {err}
        </div>
      )}
    </div>
  );
}
