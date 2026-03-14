/**
 * MonitorAttackBreakdown — Attack type distribution pie chart.
 *
 * Counts occurrences of each attack_type from predictions labelled "attack",
 * renders as a Recharts PieChart with a legend.
 */

import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { PieChartIcon } from 'lucide-react';
import type { LivePrediction } from '@/stores/liveStore';

interface Props {
  predictions: LivePrediction[];
}

interface Slice {
  name: string;
  count: number;
}

const PALETTE = [
  '#d03050', // red
  '#f0a020', // amber
  '#a78bfa', // purple
  '#38bdf8', // cyan
  '#18a058', // green
  '#f472b6', // pink
  '#fb923c', // orange
  '#4ade80', // lime
];

export default function MonitorAttackBreakdown({ predictions }: Props) {
  const attacks = predictions.filter((p) => p.label === 'attack');
  const countMap = new Map<string, number>();

  for (const a of attacks) {
    // Skip predictions with no identified attack type
    if (a.attack_type == null || a.attack_type === 'unknown') continue;
    countMap.set(a.attack_type, (countMap.get(a.attack_type) ?? 0) + 1);
  }

  const data: Slice[] = Array.from(countMap.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <PieChartIcon size={14} style={{ color: 'var(--n8n-text-muted)' }} />
        <span
          className="text-xs font-semibold uppercase tracking-wider"
          style={{ color: 'var(--n8n-text-muted)' }}
        >
          Attack Types
        </span>
        {attacks.length > 0 && data.length === 0 ? (
          <span className="text-xs font-mono ml-auto" style={{ color: 'var(--n8n-text-muted)' }}>
            all unknown
          </span>
        ) : attacks.length > 0 && (
          <span
            className="text-xs font-mono ml-auto"
            style={{ color: 'var(--n8n-text-muted)' }}
          >
            {attacks.length} attacks
          </span>
        )}
      </div>

      {data.length === 0 ? (
        <div
          className="flex items-center justify-center h-[200px] rounded-lg"
          style={{
            background: 'var(--n8n-canvas-bg)',
            border: '1px solid var(--n8n-card-border)',
          }}
        >
          <span className="text-xs" style={{ color: 'var(--n8n-text-muted)' }}>
            {attacks.length === 0 ? 'No attacks recorded' : 'No named attack types recorded'}
          </span>
        </div>
      ) : (
        <div
          className="rounded-lg p-3"
          style={{
            background: 'var(--n8n-canvas-bg)',
            border: '1px solid var(--n8n-card-border)',
          }}
        >
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie
                data={data}
                dataKey="count"
                nameKey="name"
                cx="50%"
                cy="50%"
                outerRadius={70}
                innerRadius={35}
                strokeWidth={1}
                stroke="rgba(0,0,0,0.3)"
              >
                {data.map((_, i) => (
                  <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  background: '#2b2b2b',
                  border: '1px solid #3c3c3c',
                  borderRadius: 8,
                  fontSize: 11,
                  fontFamily: 'JetBrains Mono, monospace',
                  color: '#ececec',
                }}
                formatter={(value?: number, name?: string) => [`${value ?? 0}`, name ?? '']}
              />
              <Legend
                wrapperStyle={{
                  fontSize: 10,
                  fontFamily: 'JetBrains Mono, monospace',
                }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
