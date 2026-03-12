/**
 * ObservationEdge — Device → Monitor (blue solid line with arrow)
 *
 * Represents the observation/data-collection link from a device to a monitor node.
 * Style: cyan/blue solid stroke, arrow at target.
 */

import type { EdgeProps } from 'reactflow';
import { getBezierPath, BaseEdge, MarkerType } from 'reactflow';

export default function ObservationEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
}: EdgeProps) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={MarkerType.ArrowClosed}
      style={{
        ...style,
        stroke: '#38bdf8',
        strokeWidth: 1.5,
      }}
    />
  );
}
