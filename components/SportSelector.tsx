'use client';
import { useState } from 'react';
import Toggle, { ToggleOption } from './Toggle';
import GenPicksButton from './GenPicksButton';

interface Props {
  options: ToggleOption[];
  initial: string[];
  hasPendingPicks?: boolean;
}

export default function SportSelector({ options, initial, hasPendingPicks }: Props) {
  const [selected, setSelected] = useState<string[]>(initial);
  const enabled = options.filter((o) => !o.disabled).length;
  const withGames = options.filter((o) => o.today).map((o) => o.value);

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] text-muted uppercase tracking-wider">
          Deportes ({selected.length}/{enabled} con juegos hoy)
        </span>
        {withGames.length > 0 && selected.length !== withGames.length && (
          <button
            onClick={() => setSelected(withGames)}
            className="text-[10px] text-green uppercase tracking-wider tap"
          >
            todos
          </button>
        )}
      </div>
      <Toggle options={options} value={selected} onChange={setSelected} />
      <GenPicksButton selectedSports={selected} hasPendingPicks={hasPendingPicks} />
    </div>
  );
}
