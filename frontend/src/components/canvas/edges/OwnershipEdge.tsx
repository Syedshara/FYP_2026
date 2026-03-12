/**
 * OwnershipEdge — Client → Device (solid gray line with arrow)
 *
 * Represents the organizational ownership relationship.
 * Style: solid gray stroke, arrow at target.
 */

import type { EdgeProps } from 'reactflow';
import { getBezierPath, BaseEdge, MarkerType } from 'reactflow';

export default function OwnershipEdge({
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
        stroke: 'var(--n8n-edge-default)',
        strokeWidth: 1.5,
      }}
    />
  );
}
