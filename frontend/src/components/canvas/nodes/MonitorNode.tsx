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
    <div className="flex flex-col gap-1 w-full">
      <div className="flex justify-between gap-2 canvas-node-kpi" style={{ color: 'var(--n8n-text-muted)' }}>
        <span>{label}</span>
        <span style={{ color }}>{value}{suffix}</span>
      </div>

      <div className="canvas-node-progress">
        <div
          className="canvas-node-progress-fill"
          style={{
            width: `${pct}%`,
            background: color,
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
        <div className="flex flex-col gap-2 w-full">
          {data.deviceLabel && (
            <div className="text-[10px] text-center" style={{ color: 'var(--n8n-text-muted)' }}>
              Monitoring: <span style={{ fontWeight: 600, color: '#38bdf8' }}>{data.deviceLabel}</span>
            </div>
          )}
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
        <span className="canvas-node-kpi" style={{ color: 'var(--n8n-text-muted)' }}>
          No data
        </span>
      )}
    </BaseCanvasNode>
  );
}

export default memo(MonitorNode);
