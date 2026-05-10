'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  sports: string[];
}

export default function AnalyzeNowButton({ sports }: Props) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

  const go = async () => {
    if (sports.length === 0) {
      setErr('Activa al menos un deporte arriba');
      return;
    }
    const ok = window.confirm(
      '⚠️ Análisis con data parcial — los picks pueden cambiar antes del juego (lineup, momios, lesiones). ¿Forzar análisis ahora?',
    );
    if (!ok) return;
    setLoading(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await fetch('/api/generate-picks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sports }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        setErr(j?.error ?? `Error (${r.status})`);
        return;
      }
      const total = (j?.with_edge ?? 0) + (j?.parlays ?? 0);
      setMsg(`${total} picks generados`);
      router.push('/picks');
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-1">
      <button
        onClick={go}
        disabled={loading}
        className="tap w-full py-2 border border-yellow/40 bg-yellow/5 text-xs rounded text-yellow disabled:opacity-50"
      >
        {loading ? 'Analizando…' : '⚠️ Analizar ahora (data parcial)'}
      </button>
      {err && <div className="text-red text-[10px]">{err}</div>}
      {msg && <div className="text-green text-[10px]">{msg}</div>}
    </div>
  );
}
