'use client';
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip } from 'recharts';

interface Point {
  x: string;
  y: number;
}

interface Props {
  data: Point[];
}

export default function StatsChart({ data }: Props) {
  return (
    <div className="bg-card border border-line rounded-lg p-3 h-56">
      <div className="text-[10px] text-muted uppercase tracking-wider mb-2">
        Bankroll
      </div>
      <ResponsiveContainer width="100%" height="85%">
        <LineChart data={data}>
          <XAxis dataKey="x" stroke="#7a7a86" fontSize={10} />
          <YAxis stroke="#7a7a86" fontSize={10} />
          <Tooltip
            contentStyle={{
              background: '#10101a',
              border: '1px solid #1a1a23',
              borderRadius: 4,
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 12,
            }}
          />
          <Line
            type="monotone"
            dataKey="y"
            stroke="#00ff87"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
