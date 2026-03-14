/**
 * TrafficFeedEdge — Traffic Source → Device (green dotted line with arrow)
 *
 * Represents benign traffic flow from a traffic generator to a device.
 * Style: green dotted stroke, arrow at target.
 */

import type { EdgeProps } from 'reactflow';
import { getBezierPath, BaseEdge, MarkerType } from 'reactflow';

export default function TrafficFeedEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  data,
}: EdgeProps) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const isActive = data?.animated === true;

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={MarkerType.ArrowClosed}
      style={{
        ...style,
        stroke: '#18a058',
        strokeWidth: isActive ? 2 : 1.5,
        strokeDasharray: '4 4',
        animation: isActive ? 'fl-edge-flow 1.5s linear infinite' : 'none',
      }}
    />
  );
}
