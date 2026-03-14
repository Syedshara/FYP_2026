/**
 * MonitorLatencyChart — Latency histogram (BarChart).
 *
 * Buckets predictions by inference_latency_ms into configurable bins,
 * renders as a vertical bar chart.
 */

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import { Timer } from 'lucide-react';
import type { LivePrediction } from '@/stores/liveStore';

interface Props {
  predictions: LivePrediction[];
}

interface Bucket {
  range: string;
  count: number;
  color: string;
}

const BINS: Array<{ label: string; min: number; max: number; color: string }> = [
  { label: '0–20ms',   min: 0,   max: 20,  color: '#18a058' },
  { label: '20–50ms',  min: 20,  max: 50,  color: '#4ade80' },
  { label: '50–100ms', min: 50,  max: 100, color: '#f0a020' },
  { label: '100–200ms', min: 100, max: 200, color: '#fb923c' },
  { label: '200ms+',   min: 200, max: Infinity, color: '#d03050' },
];

export default function MonitorLatencyChart({ predictions }: Props) {
  const data: Bucket[] = BINS.map((bin) => ({
    range: bin.label,
    count: predictions.filter((p) => {
      const lat = p.inference_latency_ms ?? 0;
      return lat >= bin.min && lat < bin.max;
    }).length,
    color: bin.color,
  }));

  const hasData = predictions.some((p) => p.inference_latency_ms != null);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Timer size={14} style={{ color: 'var(--n8n-text-muted)' }} />
        <span
          className="text-xs font-semibold uppercase tracking-wider"
          style={{ color: 'var(--n8n-text-muted)' }}
        >
          Latency Distribution
        </span>
      </div>

      {!hasData ? (
        <div
          className="flex items-center justify-center h-[200px] rounded-lg"
          style={{
            background: 'var(--n8n-canvas-bg)',
            border: '1px solid var(--n8n-card-border)',
          }}
        >
          <span className="text-xs" style={{ color: 'var(--n8n-text-muted)' }}>
            Waiting for latency data...
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
            <BarChart data={data} margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis
                dataKey="range"
                tick={{ fontSize: 9, fill: '#888' }}
                tickLine={false}
                axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
              />
              <YAxis
                tick={{ fontSize: 10, fill: '#888' }}
                tickLine={false}
                axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
                allowDecimals={false}
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
                formatter={(value?: number) => [`${value ?? 0}`, 'Predictions']}
              />
              <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                {data.map((entry, i) => (
                  <Cell key={i} fill={entry.color} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
