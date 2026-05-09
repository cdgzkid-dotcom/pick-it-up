interface Props {
  realProb: number;
  impliedProb: number;
}

export default function EdgeBar({ realProb, impliedProb }: Props) {
  const realPct = Math.max(0, Math.min(100, realProb * 100));
  const impliedPct = Math.max(0, Math.min(100, impliedProb * 100));
  const edge = (realProb - impliedProb) * 100;
  const positive = edge > 0;

  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-[10px] text-muted uppercase tracking-wider">
        <span>real {realPct.toFixed(0)}%</span>
        <span className={positive ? 'text-green' : 'text-red'}>
          edge {positive ? '+' : ''}
          {edge.toFixed(1)}%
        </span>
        <span>casa {impliedPct.toFixed(0)}%</span>
      </div>
      <div className="relative h-2 rounded-sm bg-line overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 bg-green/80"
          style={{ width: `${realPct}%` }}
        />
        <div
          className="absolute inset-y-0 w-[2px] bg-yellow"
          style={{ left: `${impliedPct}%` }}
          title="probabilidad implícita (casa)"
        />
      </div>
    </div>
  );
}
