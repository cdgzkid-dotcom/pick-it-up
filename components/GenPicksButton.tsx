'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  selectedSports: string[];
}

export default function GenPicksButton({ selectedSports }: Props) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

  const go = async () => {
    setErr(null);
    if (selectedSports.length === 0) {
      setErr('Selecciona al menos un deporte');
      return;
    }
    setLoading(true);
    try {
      const r = await fetch('/api/generate-picks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sports: selectedSports }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        setErr(j?.error ?? `Falló (${r.status})`);
        setLoading(false);
        return;
      }
      router.push('/picks');
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
      setLoading(false);
    }
  };

  return (
    <div>
      <button
        onClick={go}
        disabled={loading}
        className="tap w-full py-4 bg-green text-bg rounded-lg font-bold text-base disabled:opacity-50"
      >
        {loading ? 'ANALIZANDO…' : '🎯 GENERA PICKS'}
      </button>
      {err && <div className="text-red text-xs mt-2 text-center">{err}</div>}
    </div>
  );
}
