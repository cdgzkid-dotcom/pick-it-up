'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface SportOption {
  value: string;
  label: string;
  hasGames: boolean;
}

interface Props {
  options: SportOption[];
  initial: string[];
  enabled: boolean;
}

export default function AutoSportsSettings({ options, initial, enabled }: Props) {
  const [selected, setSelected] = useState<string[]>(initial);
  const [autoOn, setAutoOn] = useState(enabled);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

  const save = async (overrides: { auto_sports?: string[]; auto_enabled?: boolean } = {}) => {
    setSaving(true);
    setErr(null);
    try {
      const r = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auto_sports: overrides.auto_sports ?? selected,
          auto_enabled: overrides.auto_enabled ?? autoOn,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        setErr(j?.error ?? `Error (${r.status})`);
        return;
      }
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2 bg-card border border-line rounded p-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-muted uppercase tracking-wider">
          Auto-análisis cada 15 min
        </span>
        <button
          onClick={() => {
            const next = !autoOn;
            setAutoOn(next);
            save({ auto_enabled: next });
          }}
          disabled={saving}
          className={`tap text-[10px] uppercase tracking-wider px-2 py-1 rounded border ${
            autoOn ? 'border-green text-green' : 'border-line text-muted'
          }`}
        >
          {autoOn ? 'ON' : 'OFF'}
        </button>
      </div>
      <div className="grid grid-cols-3 gap-1">
        {options.map((o) => {
          const on = selected.includes(o.value);
          return (
            <button
              key={o.value}
              onClick={() => {
                const next = on ? selected.filter((v) => v !== o.value) : [...selected, o.value];
                setSelected(next);
                save({ auto_sports: next });
              }}
              disabled={saving}
              className={`tap text-[10px] py-1.5 rounded border ${
                on
                  ? 'border-green/60 bg-green/10 text-green'
                  : 'border-line text-muted'
              } ${!o.hasGames ? 'opacity-50' : ''}`}
            >
              {o.label}
              {o.hasGames && <span className="ml-1 text-[8px]">●</span>}
            </button>
          );
        })}
      </div>
      {err && <div className="text-red text-[10px]">{err}</div>}
    </div>
  );
}
