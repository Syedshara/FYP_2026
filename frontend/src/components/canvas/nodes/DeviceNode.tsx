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
        <span className="text-[10px]" style={{ color: '#18a058' }}>
          {data.protocol}
        </span>
      )}
    </BaseCanvasNode>
  );
}

export default memo(DeviceNode);
