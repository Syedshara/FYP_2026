/**
 * FLCommunicationEdge — FL Server → Client
 *
 * Animated dashes during training, lock icon when mTLS active, arrow at target.
 * Style: orange stroke, animated when FL is running.
 */

import { getBezierPath, BaseEdge, EdgeLabelRenderer, MarkerType, type EdgeProps } from 'reactflow';
import { Lock } from 'lucide-react';

export default function FLCommunicationEdge({
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
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const isTraining = data?.animated === true;
  const hasMtls = data?.mtls === true;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={MarkerType.ArrowClosed}
        style={{
          ...style,
          stroke: '#ff6d5a',
          strokeWidth: 2,
          strokeDasharray: isTraining ? '8 4' : 'none',
          animation: isTraining ? 'fl-edge-flow 1s linear infinite' : 'none',
        }}
      />
      {hasMtls && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 20,
              height: 20,
              borderRadius: '50%',
              background: 'var(--n8n-canvas-bg)',
              border: '1.5px solid #ff6d5a',
            }}
          >
            <Lock size={10} color="#ff6d5a" />
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
