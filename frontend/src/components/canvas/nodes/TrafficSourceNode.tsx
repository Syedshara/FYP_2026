/**
 * TrafficSourceNode — Synthetic benign traffic generator.
 * Shape: trigger / D-shape (150x80, border-radius: 36px 12px 12px 36px)
 * Accent: #a78bfa (purple)
 */

import { memo } from 'react';
import type { NodeProps } from 'reactflow';
import { BaseCanvasNode } from './BaseCanvasNode';
import type { TrafficSourceNodeData } from '@/types/canvas';

function TrafficSourceNode(props: NodeProps<TrafficSourceNodeData>) {
  const { data } = props;

  return (
    <BaseCanvasNode {...props}>
      {data.rate != null && (
        <span
          className="canvas-node-chip"
          style={{
            color: '#a78bfa',
            background: 'rgba(167, 139, 250, 0.12)',
            borderColor: 'rgba(167, 139, 250, 0.26)',
          }}
        >
          {data.rate} pps
        </span>
      )}
    </BaseCanvasNode>
  );
}

export default memo(TrafficSourceNode);
