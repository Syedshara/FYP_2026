/**
 * RateFilterNode — Traffic throttle / shape.
 * Shape: pill / circle (64x64, border-radius: 50%)
 * Accent: #888888 (gray)
 *
 * Pill nodes show the label below the circle, not inside.
 */

import { memo } from 'react';
import type { NodeProps } from 'reactflow';
import { BaseCanvasNode } from './BaseCanvasNode';
import type { RateFilterNodeData } from '@/types/canvas';

function RateFilterNode(props: NodeProps<RateFilterNodeData>) {
  return <BaseCanvasNode {...props} />;
}

export default memo(RateFilterNode);
