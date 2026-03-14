/**
 * MonitorAttackChart — Rolling attack rate over time (AreaChart).
 *
 * Groups predictions into 5-second windows and computes the % that are "attack".
 * Live-updates as new predictions arrive.
 */

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { ShieldAlert } from 'lucide-react';
import type { LivePrediction } from '@/stores/liveStore';

interface Props {
  predictions: LivePrediction[];
}

interface BucketPoint {
  time: string;
  attackRate: number;
  total: number;
}

/** Group predictions into 5-second windows. */
function bucketize(predictions: LivePrediction[]): BucketPoint[] {
  if (predictions.length === 0) return [];

  const windowMs = 5_000;
  const buckets = new Map<number, { attacks: number; total: number }>();

  for (const p of predictions) {
    const ts = new Date(p.timestamp).getTime();
    const key = Math.floor(ts / windowMs) * windowMs;
    const b = buckets.get(key) ?? { attacks: 0, total: 0 };
    b.total++;
    if (p.label === 'attack') b.attacks++;
    buckets.set(key, b);
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([ts, b]) => ({
      time: new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      attackRate: Math.round((b.attacks / b.total) * 100),
      total: b.total,
    }));
}

export default function MonitorAttackChart({ predictions }: Props) {
  const data = bucketize(predictions);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <ShieldAlert size={14} style={{ color: 'var(--n8n-text-muted)' }} />
        <span
          className="text-xs font-semibold uppercase tracking-wider"
          style={{ color: 'var(--n8n-text-muted)' }}
        >
          Attack Rate Over Time
        </span>
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
            Waiting for predictions...
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
            <AreaChart data={data} margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
              <defs>
                <linearGradient id="attackGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#d03050" stopOpacity={0.35} />
                  <stop offset="95%" stopColor="#d03050" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis
                dataKey="time"
                tick={{ fontSize: 9, fill: '#888' }}
                tickLine={false}
                axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
              />
              <YAxis
                tick={{ fontSize: 10, fill: '#888' }}
                tickLine={false}
                axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
                domain={[0, 100]}
                tickFormatter={(v) => `${v}%`}
              />
              <Tooltip
                contentStyle={{
                  background: '#2b2b2b',
                  border: '1px solid #3c3c3c',
                  borderRadius: 8,
                  fontSize: 11,
                  fontFamily: 'JetBrains Mono, monospace',
                  color: '#ececec',
                }}
                formatter={(value?: number) => [`${value ?? 0}%`, 'Attack Rate']}
              />
              <ReferenceLine y={50} stroke="#f0a020" strokeDasharray="4 4" strokeOpacity={0.5} />
              <Area
                type="monotone"
                dataKey="attackRate"
                stroke="#d03050"
                strokeWidth={2}
                fill="url(#attackGrad)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
