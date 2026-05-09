'use client';

interface Props {
  options: { value: string; label: string; star?: boolean; today?: boolean }[];
  value: string[];
  onChange: (next: string[]) => void;
}

export default function Toggle({ options, value, onChange }: Props) {
  const set = new Set(value);
  const toggle = (v: string) => {
    if (set.has(v)) onChange(value.filter((x) => x !== v));
    else onChange([...value, v]);
  };
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => {
        const active = set.has(o.value);
        return (
          <button
            key={o.value}
            onClick={() => toggle(o.value)}
            className={`tap px-3 py-2 rounded-md border text-xs tracking-wider transition-colors ${
              active
                ? 'border-green text-green bg-green/10'
                : 'border-line text-muted bg-card'
            }`}
          >
            {o.star && <span className="mr-1">⭐</span>}
            <span className={o.today ? 'font-bold' : ''}>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
