'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function ForceCheckResultsButton() {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

  const go = async () => {
    setLoading(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await fetch('/api/check-results', { method: 'POST' });
      const j = (await r.json().catch(() => null)) as {
        checked?: number;
        resolved?: number;
        notified?: number;
        error?: string;
      } | null;
      if (!r.ok) {
        setErr(j?.error ?? `Error (${r.status})`);
        return;
      }
      const checked = j?.checked ?? 0;
      const resolved = j?.resolved ?? 0;
      const notified = j?.notified ?? 0;
      if (resolved === 0 && checked === 0) {
        setMsg('No hay apuestas pendientes');
      } else if (resolved === 0) {
        setMsg(`${checked} apuestas revisadas, ninguna lista todavía`);
      } else {
        setMsg(`${resolved} resueltas · ${notified} notificadas por Telegram`);
      }
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
        className="tap w-full py-2 border border-blue/40 bg-blue/5 text-xs rounded text-blue disabled:opacity-50"
      >
        {loading ? 'Revisando resultados…' : '🔄 Forzar check-results'}
      </button>
      {err && <div className="text-red text-[10px]">{err}</div>}
      {msg && <div className="text-green text-[10px]">{msg}</div>}
    </div>
  );
}
