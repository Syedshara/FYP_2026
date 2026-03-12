/**
 * FLServerNode — Federated Learning aggregation server.
 * Shape: wide (280x80 rectangle)
 * Accent: #ff6d5a (orange)
 *
 * Shows round progress and security feature badges inside the wide body.
 */

import { memo } from 'react';
import type { NodeProps } from 'reactflow';
import { BaseCanvasNode } from './BaseCanvasNode';
import type { FLServerNodeData } from '@/types/canvas';

function FLServerNode(props: NodeProps<FLServerNodeData>) {
  const { data } = props;
  const round = data.currentRound ?? 0;
  const total = data.totalRounds ?? 10;
  const pct = total > 0 ? Math.round((round / total) * 100) : 0;

  return (
    <BaseCanvasNode {...props}>
      {/* Round progress */}
      <div className="flex items-center gap-2 mt-1">
        <div
          className="flex-1 h-[3px] rounded-full overflow-hidden"
          style={{ background: 'var(--n8n-card-border)' }}
        >
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{
              width: `${pct}%`,
              background: data.status === 'running' ? '#ff6d5a' : '#18a058',
            }}
          />
        </div>
        <span className="text-[10px] shrink-0" style={{ color: 'var(--n8n-text-muted)' }}>
          {round}/{total}
        </span>
      </div>

      {/* Security feature mini-badges */}
      {data.securityFeatures && (
        <div className="flex gap-1 mt-1.5">
          {data.securityFeatures.vss && <FeatureDot label="VSS" color="#a78bfa" />}
          {data.securityFeatures.mtls && <FeatureDot label="mTLS" color="#38bdf8" />}
          {data.securityFeatures.gradientSigning && <FeatureDot label="Sign" color="#18a058" />}
          {data.securityFeatures.roundNonces && <FeatureDot label="RN" color="#f0a020" />}
          {data.securityFeatures.recess && <FeatureDot label="RCS" color="#d03050" />}
        </div>
      )}
    </BaseCanvasNode>
  );
}

function FeatureDot({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="text-[8px] font-semibold px-1.5 rounded"
      style={{
        background: `${color}20`,
        color,
        lineHeight: '16px',
      }}
    >
      {label}
    </span>
  );
}

export default memo(FLServerNode);
