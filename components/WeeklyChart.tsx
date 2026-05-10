'use client';
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, ReferenceLine } from 'recharts';

interface Point {
  week: string;
  win_rate: number;
  bets: number;
}

export default function WeeklyChart({ data }: { data: Point[] }) {
  return (
    <div className="bg-card border border-line rounded-lg p-3 h-56">
      <div className="text-[10px] text-muted uppercase tracking-wider mb-2">
        Win Rate semanal
      </div>
      <ResponsiveContainer width="100%" height="85%">
        <BarChart data={data}>
          <XAxis dataKey="week" stroke="rgb(var(--muted))" fontSize={10} />
          <YAxis
            stroke="rgb(var(--muted))"
            fontSize={10}
            domain={[0, 100]}
            tickFormatter={(v) => `${v}%`}
          />
          <Tooltip
            contentStyle={{
              background: 'rgb(var(--card))',
              border: '1px solid rgb(var(--line))',
              borderRadius: 4,
              color: 'rgb(var(--fg))',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 12,
            }}
            formatter={(v, name) =>
              name === 'win_rate' ? [`${Number(v).toFixed(0)}%`, 'Win rate'] : [String(v), String(name)]
            }
          />
          <ReferenceLine y={52.4} stroke="rgb(var(--muted))" strokeDasharray="2 2" />
          <Bar dataKey="win_rate" fill="rgb(var(--green))" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
