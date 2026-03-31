/**
 * WatcherLinkEdge — FL Server → Watcher (cyan dashed line with arrow)
 *
 * Represents the security audit feed from an FL Server to a Watcher node.
 * Style: cyan dashed stroke, arrow at target. Animates when training is active.
 */

import type { EdgeProps } from 'reactflow';
import { getBezierPath, BaseEdge, MarkerType } from 'reactflow';

export default function WatcherLinkEdge({
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

  const isAnimated = data?.animated === true;

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={MarkerType.ArrowClosed}
      style={{
        ...style,
        stroke: '#38bdf8',
        strokeWidth: 1.5,
        strokeDasharray: isAnimated ? undefined : '6,4',
        animation: isAnimated ? 'dash-flow 1s linear infinite' : undefined,
      }}
    />
  );
}
