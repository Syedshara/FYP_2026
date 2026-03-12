/**
 * MonitorNode — Live analytics collector.
 * Shape: default (150x80 rounded rectangle)
 * Accent: #38bdf8 (cyan)
 *
 * Shows 3 compact metric bars: attack rate %, avg latency, avg confidence %
 */

import { memo } from 'react';
import type { NodeProps } from 'reactflow';
import { BaseCanvasNode } from './BaseCanvasNode';
import type { MonitorNodeData } from '@/types/canvas';

/** Compact metric bar for the 150x80 node interior. */
function MetricBar({
  label,
  value,
  max,
  color,
  suffix,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
  suffix: string;
}) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className="flex flex-col gap-[1px] w-full">
      <div className="flex justify-between" style={{ fontSize: 9, color: 'var(--n8n-text-muted)' }}>
        <span>{label}</span>
        <span style={{ color }}>{value}{suffix}</span>
      </div>
      <div
        style={{
          width: '100%',
          height: 3,
          borderRadius: 2,
          background: 'var(--n8n-card-border)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            borderRadius: 2,
            background: color,
            transition: 'width 0.3s ease',
          }}
        />
      </div>
    </div>
  );
}

function MonitorNode(props: NodeProps<MonitorNodeData>) {
  const { data } = props;
  const m = data.metrics;

  const hasMetrics = m && m.totalPredictions != null && m.totalPredictions > 0;

  return (
    <BaseCanvasNode {...props}>
      {hasMetrics ? (
        <div className="flex flex-col gap-1 w-full">
          <MetricBar
            label="ATK"
            value={m.attackRate ?? 0}
            max={100}
            color="#d03050"
            suffix="%"
          />
          <MetricBar
            label="LAT"
            value={m.avgLatency ?? 0}
            max={200}
            color="#f0a020"
            suffix="ms"
          />
          <MetricBar
            label="CNF"
            value={m.avgConfidence ?? 0}
            max={100}
            color="#18a058"
            suffix="%"
          />
        </div>
      ) : (
        <span className="text-[9px]" style={{ color: 'var(--n8n-text-muted)' }}>
          No data
        </span>
      )}
    </BaseCanvasNode>
  );
}

export default memo(MonitorNode);
