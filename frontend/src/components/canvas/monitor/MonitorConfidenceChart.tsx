/**
 * MonitorConfidenceChart — Confidence + score trend line over time.
 *
 * Shows individual prediction confidence and score as a time-series line chart.
 * Renders the last N predictions chronologically.
 */

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { TrendingUp } from 'lucide-react';
import type { LivePrediction } from '@/stores/liveStore';

interface Props {
  predictions: LivePrediction[];
}

interface ChartPoint {
  idx: number;
  time: string;
  confidence: number;
  score: number;
  label: string;
}

export default function MonitorConfidenceChart({ predictions }: Props) {
  const data: ChartPoint[] = predictions.map((p, i) => ({
    idx: i + 1,
    time: new Date(p.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    confidence: Math.round(p.confidence * 1000) / 10,
    score: Math.round(p.score * 1000) / 10,
    label: p.label,
  }));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <TrendingUp size={14} style={{ color: 'var(--n8n-text-muted)' }} />
        <span
          className="text-xs font-semibold uppercase tracking-wider"
          style={{ color: 'var(--n8n-text-muted)' }}
        >
          Confidence &amp; Score Trend
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
            <LineChart data={data} margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis
                dataKey="idx"
                tick={{ fontSize: 9, fill: '#888' }}
                tickLine={false}
                axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
                label={{ value: 'Prediction #', position: 'insideBottom', offset: -2, fontSize: 9, fill: '#888' }}
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
                labelFormatter={(v) => `#${v}`}
                formatter={(value?: number, name?: string) => [`${value ?? 0}%`, name ?? '']}
              />
              <Legend wrapperStyle={{ fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }} />
              <Line
                type="monotone"
                dataKey="confidence"
                name="Confidence"
                stroke="#18a058"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
              <Line
                type="monotone"
                dataKey="score"
                name="Score"
                stroke="#f0a020"
                strokeWidth={1.5}
                dot={false}
                strokeDasharray="4 2"
                activeDot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
