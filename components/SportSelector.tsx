'use client';
import { useState } from 'react';
import Toggle from './Toggle';
import GenPicksButton from './GenPicksButton';

interface Props {
  options: { value: string; label: string; star?: boolean; today?: boolean }[];
  initial: string[];
}

export default function SportSelector({ options, initial }: Props) {
  const [selected, setSelected] = useState<string[]>(initial);
  return (
    <div className="space-y-3">
      <div className="text-[10px] text-muted uppercase tracking-wider">Deportes</div>
      <Toggle options={options} value={selected} onChange={setSelected} />
      <GenPicksButton selectedSports={selected} />
    </div>
  );
}
