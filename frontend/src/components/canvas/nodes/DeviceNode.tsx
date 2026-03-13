/**
 * DeviceNode — IoT sensor, actuator, or gateway.
 * Shape: default (150x80 rounded rectangle)
 * Accent: #18a058 (green)
 */

import { memo } from 'react';
import type { NodeProps } from 'reactflow';
import { BaseCanvasNode } from './BaseCanvasNode';
import type { DeviceNodeData } from '@/types/canvas';

function DeviceNode(props: NodeProps<DeviceNodeData>) {
  const { data } = props;

  return (
    <BaseCanvasNode {...props}>
      {data.protocol && (
        <span
          className="canvas-node-chip"
          style={{
            color: '#18a058',
            background: 'rgba(24, 160, 88, 0.12)',
            borderColor: 'rgba(24, 160, 88, 0.22)',
          }}
        >
          {data.protocol}
        </span>
      )}
    </BaseCanvasNode>
  );
}

export default memo(DeviceNode);
