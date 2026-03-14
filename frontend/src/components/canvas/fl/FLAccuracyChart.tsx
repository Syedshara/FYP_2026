/**
 * FLAccuracyChart — Round-by-round accuracy and loss chart using Recharts.
 *
 * Reads live round results from liveStore (populated via WebSocket).
 * Also fetches historical rounds via REST on mount.
 */

import { useEffect, useState } from 'react';
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
import { useLiveStore } from '@/stores/liveStore';
import { flApi } from '@/api/fl';

interface ChartPoint {
  round: number;
  accuracy: number | null;
  loss: number | null;
}

export default function FLAccuracyChart() {
  const liveRounds = useLiveStore((s) => s.flRoundResults);
  const [historicalRounds, setHistoricalRounds] = useState<ChartPoint[]>([]);

  // Fetch historical rounds on mount
  useEffect(() => {
    flApi.rounds().then((rounds) => {
      const points: ChartPoint[] = rounds
        .sort((a, b) => a.round_number - b.round_number)
        .map((r) => ({
          round: r.round_number,
          accuracy: r.global_accuracy ?? null,
          loss: r.global_loss ?? null,
        }));
      setHistoricalRounds(points);
    }).catch(() => {
      // API not available yet — ignore
    });
  }, []);

  // Clear stale historical data when a new training session starts so old
  // round numbers don't persist in the merged chart data.
  // Uses Zustand subscribe (external-system sync pattern) to avoid setState-in-effect.
  useEffect(() => {
    let prev = useLiveStore.getState().flGlobalProgress?.is_training;
    const unsub = useLiveStore.subscribe((state) => {
      const cur = state.flGlobalProgress?.is_training;
      if (cur && !prev) setHistoricalRounds([]);
      prev = cur;
    });
    return unsub;
  }, []);

  // Merge historical + live (live overrides historical for same round)
  const liveMap = new Map(liveRounds.map((r) => [r.round, r]));
  const mergedMap = new Map<number, ChartPoint>();

  for (const h of historicalRounds) {
    mergedMap.set(h.round, h);
  }
  for (const [round, lr] of liveMap) {
    mergedMap.set(round, { round, accuracy: lr.accuracy, loss: lr.loss });
  }

  const data = Array.from(mergedMap.values()).sort((a, b) => a.round - b.round);

  return (
    <div className="flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <TrendingUp size={14} style={{ color: 'var(--n8n-text-muted)' }} />
        <span
          className="text-xs font-semibold uppercase tracking-wider"
          style={{ color: 'var(--n8n-text-muted)' }}
        >
          Training Progress
        </span>
      </div>

      {/* Chart */}
      {data.length === 0 ? (
        <div
          className="flex items-center justify-center h-[200px] rounded-lg"
          style={{
            background: 'var(--n8n-canvas-bg)',
            border: '1px solid var(--n8n-card-border)',
          }}
        >
          <span className="text-xs" style={{ color: 'var(--n8n-text-muted)' }}>
            No training rounds yet
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
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={data} margin={{ top: 10, right: 40, bottom: 10, left: 0 }}>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(255,255,255,0.06)"
              />
              <XAxis
                dataKey="round"
                tick={{ fontSize: 10, fill: '#888888' }}
                tickLine={false}
                axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
                label={{ value: 'Round', position: 'insideBottom', offset: -2, fontSize: 10, fill: '#888888' }}
              />
              <YAxis
                yAxisId="accuracy"
                tick={{ fontSize: 10, fill: '#888888' }}
                tickLine={false}
                axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
                domain={[0, 1]}
                orientation="left"
                label={{ value: 'Accuracy', angle: -90, position: 'insideLeft', offset: 15, fontSize: 9, fill: '#18a058' }}
              />
              <YAxis
                yAxisId="loss"
                tick={{ fontSize: 10, fill: '#888888' }}
                tickLine={false}
                axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
                domain={[0, 'auto']}
                orientation="right"
                label={{ value: 'Loss', angle: 90, position: 'insideRight', offset: 15, fontSize: 9, fill: '#d03050' }}
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
                labelFormatter={(label) => `Round ${label}`}
                formatter={(value?: number, name?: string) =>
                  typeof value === 'number'
                    ? [name === 'Accuracy' ? `${(value * 100).toFixed(1)}%` : value.toFixed(4), name ?? '']
                    : ['—', name ?? '']
                }
              />
              <Legend
                wrapperStyle={{ fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}
              />
              <Line
                yAxisId="accuracy"
                type="monotone"
                dataKey="accuracy"
                name="Accuracy"
                stroke="#18a058"
                strokeWidth={2}
                dot={{ r: 3, fill: '#18a058' }}
                activeDot={{ r: 5 }}
                connectNulls
              />
              <Line
                yAxisId="loss"
                type="monotone"
                dataKey="loss"
                name="Loss"
                stroke="#d03050"
                strokeWidth={2}
                dot={{ r: 3, fill: '#d03050' }}
                activeDot={{ r: 5 }}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
