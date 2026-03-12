/**
 * AttackNode — Real attack generator (Scapy).
 * Shape: trigger / D-shape (150x80, border-radius: 36px 12px 12px 36px)
 * Accent: #d03050 (red)
 */

import { memo } from 'react';
import type { NodeProps } from 'reactflow';
import { BaseCanvasNode } from './BaseCanvasNode';
import type { AttackNodeData } from '@/types/canvas';

function AttackNode(props: NodeProps<AttackNodeData>) {
  const { data } = props;

  return (
    <BaseCanvasNode {...props}>
      {data.attackCategory && (
        <span className="text-[10px]" style={{ color: '#d03050' }}>
          {data.attackCategory}
        </span>
      )}
    </BaseCanvasNode>
  );
}

export default memo(AttackNode);
