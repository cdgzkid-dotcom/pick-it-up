'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { SportLogo } from './Logo';

interface SportOption {
  value: string;
  label: string;
  hasGames: boolean;
  iconSrc?: string;
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
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced save — 400ms after the last interaction fires a single fetch.
  // Eliminates out-of-order race conditions when the user toggles multiple
  // sports quickly: intermediate states are discarded, only the final state
  // reaches the server. setSaving(true) is called immediately so the
  // "Guardando..." indicator appears on the first click, not after the delay.
  const scheduleSave = (newSports: string[], newEnabled: boolean) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSaving(true);
    setErr(null);
    saveTimerRef.current = setTimeout(async () => {
      try {
        const r = await fetch('/api/settings', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ auto_sports: newSports, auto_enabled: newEnabled }),
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
    }, 400);
  };

  return (
    <div className="space-y-2 bg-card border border-line rounded p-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-muted uppercase tracking-wider">
          Auto-análisis cada 15 min
          {saving && <span className="text-muted/60 normal-case"> · Guardando...</span>}
        </span>
        <button
          onClick={() => {
            const next = !autoOn;
            setAutoOn(next);
            scheduleSave(selected, next);
          }}
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
                scheduleSave(next, autoOn);
              }}
              className={`tap inline-flex items-center justify-center gap-1.5 text-[10px] py-1.5 rounded border ${
                on
                  ? 'border-green/60 bg-green/10 text-green'
                  : 'border-line text-muted'
              } ${!o.hasGames ? 'opacity-50' : ''}`}
            >
              <SportLogo sport={o.value} size={20} className={!o.hasGames ? 'opacity-50' : ''} />
              <span>{o.label}</span>
              {o.hasGames && <span className="text-[8px]">●</span>}
            </button>
          );
        })}
      </div>
      {err && <div className="text-red text-[10px]">{err}</div>}
    </div>
  );
}
