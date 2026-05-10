'use client';
import Image from 'next/image';

export interface ToggleOption {
  value: string;
  label: string;
  star?: boolean;
  today?: boolean;
  disabled?: boolean;
  iconSrc?: string;
}

interface Props {
  options: ToggleOption[];
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
        const disabled = !!o.disabled;

        let cls: string;
        if (disabled) {
          cls = 'border-line/40 text-muted/40 bg-card/40 cursor-not-allowed';
        } else if (active) {
          cls = 'border-green bg-green text-bg font-bold shadow-[0_0_0_1px_rgb(var(--green))]';
        } else {
          cls = 'border-line text-fg bg-card active:bg-line';
        }

        return (
          <button
            key={o.value}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() => !disabled && toggle(o.value)}
            className={`tap inline-flex items-center gap-1.5 px-3 py-2 rounded-md border text-xs tracking-wider transition-colors ${cls}`}
          >
            {o.iconSrc && (
              <Image
                src={o.iconSrc}
                alt=""
                width={20}
                height={20}
                unoptimized
                className={disabled ? 'opacity-40' : ''}
              />
            )}
            {o.star && <span>⭐</span>}
            <span>{o.label}</span>
            {o.today && !disabled && !active && (
              <span className="ml-0.5 inline-block w-1.5 h-1.5 rounded-full bg-green align-middle" />
            )}
          </button>
        );
      })}
    </div>
  );
}
