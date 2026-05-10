'use client';
import { useState } from 'react';
import { kellyAmount } from '@/lib/units';

interface Props {
  bankroll: number;
}

export default function BoostEvaluator({ bankroll }: Props) {
  const [open, setOpen] = useState(false);
  const [desc, setDesc] = useState('');
  const [normalStr, setNormalStr] = useState('');
  const [boostStr, setBoostStr] = useState('');

  const normal = Number(normalStr);
  const boost = Number(boostStr);
  const valid = Number.isFinite(normal) && normal > 1 && Number.isFinite(boost) && boost > 1;

  let result: null | {
    sharpProb: number;
    evNormal: number;
    evBoost: number;
    isPlus: boolean;
    kellyAmt: number;
    kellyPct: number;
  } = null;

  if (valid) {
    // Treat the normal price as fair (zero-edge baseline). Sharp prob =
    // 1 / momio_normal. Boost EV = prob*(boost-1) - (1-prob).
    const sharpProb = 1 / normal;
    const evNormal = sharpProb * (normal - 1) - (1 - sharpProb); // ≈ 0
    const evBoost = sharpProb * (boost - 1) - (1 - sharpProb);
    const k = kellyAmount(bankroll, sharpProb, boost);
    result = {
      sharpProb,
      evNormal,
      evBoost,
      isPlus: evBoost > 0,
      kellyAmt: k.amount,
      kellyPct: k.fraction,
    };
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="tap w-full py-2 text-xs text-muted border border-line rounded hover:text-fg"
      >
        📊 Evaluar boost de Draftea
      </button>
    );
  }

  return (
    <div className="bg-card border border-line rounded-lg p-3 space-y-2">
      <div className="flex items-baseline justify-between">
        <div className="text-[10px] text-muted uppercase tracking-wider">📊 Evaluar boost</div>
        <button onClick={() => setOpen(false)} className="text-[10px] text-muted">
          cerrar
        </button>
      </div>
      <input
        placeholder="Descripción (ej: Cubs ML boosted)"
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        className="w-full bg-bg border border-line rounded px-2 py-2 text-xs"
      />
      <div className="grid grid-cols-2 gap-2">
        <input
          type="number"
          inputMode="decimal"
          placeholder="Momio normal (1.77)"
          value={normalStr}
          onChange={(e) => setNormalStr(e.target.value)}
          className="bg-bg border border-line rounded px-2 py-2 text-xs"
        />
        <input
          type="number"
          inputMode="decimal"
          placeholder="Momio con boost (2.50)"
          value={boostStr}
          onChange={(e) => setBoostStr(e.target.value)}
          className="bg-bg border border-line rounded px-2 py-2 text-xs"
        />
      </div>
      {result && (
        <div
          className={`mt-1 rounded p-3 space-y-1 text-xs border ${
            result.isPlus ? 'border-green/40 bg-green/10' : 'border-red/40 bg-red/10'
          }`}
        >
          <div className={`font-bold ${result.isPlus ? 'text-green' : 'text-red'}`}>
            {result.isPlus ? '✅ BOOST TIENE +EV' : '❌ BOOST NO TIENE +EV'}
          </div>
          <div className="text-muted">
            Prob justa: {(result.sharpProb * 100).toFixed(1)}% (= 1/{normal.toFixed(2)})
          </div>
          <div className="text-muted">
            EV sin boost: {(result.evNormal * 100).toFixed(1)}%
          </div>
          <div className={result.isPlus ? 'text-green' : 'text-red'}>
            EV con boost: {result.evBoost >= 0 ? '+' : ''}
            {(result.evBoost * 100).toFixed(1)}%
          </div>
          {result.isPlus && result.kellyAmt > 0 && (
            <div className="pt-1 border-t border-line/40">
              💰 Apostar: <span className="text-green font-bold">${result.kellyAmt}</span> (Kelly{' '}
              {(result.kellyPct * 100).toFixed(1)}%)
            </div>
          )}
        </div>
      )}
    </div>
  );
}
