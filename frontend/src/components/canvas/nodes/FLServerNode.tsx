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
      <div className="w-full flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="canvas-node-kpi shrink-0">Rounds</span>
          <div className="canvas-node-progress flex-1">
            <div
              className="canvas-node-progress-fill"
              style={{
                width: `${pct}%`,
                background: data.status === 'running' ? '#ff6d5a' : '#18a058',
              }}
            />
          </div>
          <span className="canvas-node-counter">
            {round}/{total}
          </span>
        </div>

        {data.securityFeatures && (
          <div className="flex flex-wrap gap-1.5">
            {data.securityFeatures.vss && <FeatureDot label="VSS" color="#a78bfa" />}
            {data.securityFeatures.mtls && <FeatureDot label="mTLS" color="#38bdf8" />}
            {data.securityFeatures.gradientSigning && <FeatureDot label="Sign" color="#18a058" />}
            {data.securityFeatures.roundNonces && <FeatureDot label="RN" color="#f0a020" />}
            {data.securityFeatures.recess && <FeatureDot label="RCS" color="#d03050" />}
          </div>
        )}
      </div>
    </BaseCanvasNode>
  );
}

function FeatureDot({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="canvas-node-chip"
      style={{
        background: `${color}1a`,
        color,
        borderColor: `${color}33`,
        fontSize: 9,
      }}
    >
      {label}
    </span>
  );
}

export default memo(FLServerNode);
