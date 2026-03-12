/**
 * AttackVectorEdge — Attack → Device (red dashed line with arrow, pulses when active)
 *
 * Represents attack traffic from a Scapy attack node to a target device.
 * Style: red dashed stroke with pulse animation when attack is running, arrow at target.
 */

import type { EdgeProps } from 'reactflow';
import { getBezierPath, BaseEdge, MarkerType } from 'reactflow';

export default function AttackVectorEdge({
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

  const isActive = data?.active === true;

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={MarkerType.ArrowClosed}
      style={{
        ...style,
        stroke: '#d03050',
        strokeWidth: isActive ? 2.5 : 1.5,
        strokeDasharray: '6 3',
        animation: isActive ? 'attack-edge-pulse 0.8s ease-in-out infinite' : 'none',
        opacity: isActive ? 1 : 0.7,
      }}
    />
  );
}
