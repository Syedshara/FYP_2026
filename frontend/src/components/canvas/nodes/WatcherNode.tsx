/**
 * WatcherNode — Security audit & event monitor.
 * Shape: wide (320x116 rectangle)
 * Accent: #38bdf8 (cyan)
 *
 * Displays a compact overview of security state:
 *   - Event count (total security events received)
 *   - Flagged count (clients with trust < 0.3)
 *   - FedRecovery status indicator
 *   - Latest RECESS detection round
 *
 * Connect to an FL Server via a `watcher-link` edge to auto-subscribe
 * to security events. Double-click to open the full WatcherDrillDownView.
 */

import { memo } from 'react';
import type { NodeProps } from 'reactflow';
import { BaseCanvasNode } from './BaseCanvasNode';
import type { WatcherNodeData } from '@/types/canvas';

function WatcherNode(props: NodeProps<WatcherNodeData>) {
  const { data } = props;
  const eventCount = data._eventCount ?? 0;
  const flaggedCount = data._flaggedCount ?? 0;
  const recoveryActive = data._recoveryActive ?? false;
  const lastRound = data._lastDetectionRound;

  return (
    <BaseCanvasNode {...props}>
      <div className="w-full flex flex-col gap-2">
        {/* KPI row */}
        <div className="flex items-center gap-3">
          <KPI label="Events" value={eventCount} color="#38bdf8" />
          <KPI
            label="Flagged"
            value={flaggedCount}
            color={flaggedCount > 0 ? '#d03050' : 'var(--n8n-text-muted)'}
          />
          {lastRound != null && (
            <span
              className="canvas-node-kpi"
              style={{ color: 'var(--n8n-text-muted)', fontSize: 10 }}
            >
              R{lastRound}
            </span>
          )}
        </div>

        {/* Status chips */}
        <div className="flex flex-wrap gap-1.5">
          <StatusChip label="RECESS" active={eventCount > 0} color="#d03050" />
          <StatusChip label="HE" active={eventCount > 0} color="#a78bfa" />
          <StatusChip label="mTLS" active={eventCount > 0} color="#38bdf8" />
          {recoveryActive && <StatusChip label="REC" active color="#fb923c" />}
        </div>
      </div>
    </BaseCanvasNode>
  );
}

function KPI({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-1">
      <span className="canvas-node-kpi" style={{ color: 'var(--n8n-text-muted)' }}>
        {label}
      </span>
      <span
        className="canvas-node-kpi font-mono font-semibold"
        style={{ color, fontSize: 12 }}
      >
        {value}
      </span>
    </div>
  );
}

function StatusChip({ label, active, color }: { label: string; active: boolean; color: string }) {
  return (
    <span
      className="canvas-node-chip"
      style={{
        background: active ? `${color}1a` : 'transparent',
        color: active ? color : 'var(--n8n-text-muted)',
        borderColor: active ? `${color}33` : 'var(--n8n-border)',
        fontSize: 9,
        opacity: active ? 1 : 0.5,
      }}
    >
      {label}
    </span>
  );
}

export default memo(WatcherNode);
