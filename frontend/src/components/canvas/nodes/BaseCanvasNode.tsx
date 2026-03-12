/**
 * BaseCanvasNode — Shared renderer for all canvas node types.
 *
 * Implements n8n's visual style:
 *   - default: 150x80 clean card, icon in colored circle, label below
 *   - trigger: 150x80 D-shape (rounded left side)
 *   - pill: 64x64 circle, label below node
 *   - wide: 280x80 wide card, icon left, text + children right
 *
 * Node states: idle, active, running (glow animation), error, disabled, success
 * Handles appear on hover (via CSS class .n8n-node)
 */

import { memo, type ReactNode } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import * as LucideIcons from 'lucide-react';
import { NODE_TYPE_CONFIGS } from '@/config/nodeTypes';
import type { CanvasNodeData, NodeShape, NodeStatus } from '@/types/canvas';

// ── Shape → CSS border-radius mapping ──
const SHAPE_RADIUS: Record<NodeShape, string> = {
  default: '12px',
  trigger: '36px 12px 12px 36px',
  pill: '50%',
  wide: '12px',
};

// ── Status → glow / border color ──
function getStatusStyles(status: NodeStatus, accent: string) {
  switch (status) {
    case 'running':
      return {
        borderColor: accent,
        boxShadow: `0 0 12px ${accent}40`,
        animation: 'node-running 2s ease-in-out infinite',
      };
    case 'active':
      return {
        borderColor: accent,
        boxShadow: `0 0 8px ${accent}30`,
      };
    case 'success':
      return {
        borderColor: '#18a058',
        boxShadow: '0 0 8px rgba(24, 160, 88, 0.3)',
      };
    case 'error':
      return {
        borderColor: '#d03050',
        boxShadow: '0 0 8px rgba(208, 48, 80, 0.3)',
      };
    case 'disabled':
      return {
        borderColor: 'var(--n8n-node-border)',
        opacity: 0.5,
      };
    default: // idle
      return {
        borderColor: 'var(--n8n-node-border)',
      };
  }
}

// ── Status badge component ──
function StatusBadge({ status }: { status: NodeStatus }) {
  if (status === 'idle') return null;

  const colorMap: Record<NodeStatus, string> = {
    idle: '',
    active: '#18a058',
    running: '#ff6d5a',
    success: '#18a058',
    error: '#d03050',
    disabled: '#888888',
  };

  const animationMap: Record<string, string | undefined> = {
    running: 'status-pulse 2s ease-in-out infinite',
    error: 'status-pulse-error 3s ease-in-out infinite',
  };

  return (
    <div
      className="absolute -top-1 -right-1 flex items-center justify-center"
      style={{
        width: 12,
        height: 12,
        borderRadius: '50%',
        background: colorMap[status],
        border: '2px solid var(--n8n-node-bg)',
        animation: animationMap[status],
      }}
    />
  );
}

// ── Props for BaseCanvasNode ──
interface BaseCanvasNodeProps extends NodeProps<CanvasNodeData> {
  children?: ReactNode;
}

function BaseCanvasNode({ data, selected, children }: BaseCanvasNodeProps) {
  const config = NODE_TYPE_CONFIGS[data.nodeType];
  const shape = config.shape;
  const accent = config.accent;
  const borderRadius = SHAPE_RADIUS[shape];
  const statusStyles = getStatusStyles(data.status, accent);

  const Icon = (LucideIcons as Record<string, React.ComponentType<{ size?: number; style?: React.CSSProperties }>>)[config.icon];

  const isWide = shape === 'wide';
  const isPill = shape === 'pill';

  return (
    <div
      className="relative n8n-node"
      style={{
        width: config.width,
        height: config.height,
      }}
    >
      {/* ── Handles (hidden by default, appear on hover via CSS) ── */}
      <Handle
        type="target"
        position={Position.Left}
        style={{
          width: 7,
          height: 7,
          background: 'var(--n8n-handle-bg)',
          border: `2px solid ${accent}`,
          borderRadius: '50%',
        }}
      />
      <Handle
        type="source"
        position={Position.Right}
        style={{
          width: 7,
          height: 7,
          background: 'var(--n8n-handle-bg)',
          border: `2px solid ${accent}`,
          borderRadius: '50%',
        }}
      />

      {/* ── Node body ── */}
      <div
        className="w-full h-full flex transition-all duration-150"
        style={{
          borderRadius,
          background: 'var(--n8n-node-bg)',
          border: `1px solid ${statusStyles.borderColor ?? 'var(--n8n-node-border)'}`,
          boxShadow: selected
            ? `0 0 0 2px ${accent}60, var(--n8n-node-shadow-hover)`
            : statusStyles.boxShadow ?? 'var(--n8n-node-shadow)',
          opacity: statusStyles.opacity ?? 1,
          cursor: 'pointer',
          overflow: 'hidden',
          ...(statusStyles.animation ? { animation: statusStyles.animation } : {}),
        }}
      >
        {/* ── Content area ── */}
        {isWide ? (
          // Wide layout: icon left, text + children right
          <div className="flex items-center gap-3 px-4 py-3 flex-1 min-w-0">
            <div
              className="flex items-center justify-center shrink-0"
              style={{
                width: 36,
                height: 36,
                borderRadius: '8px',
                background: `${accent}18`,
              }}
            >
              {Icon && <Icon size={18} style={{ color: accent }} />}
            </div>
            <div className="flex flex-col min-w-0 flex-1 gap-1">
              <span
                className="text-xs font-semibold truncate"
                style={{ color: 'var(--n8n-text-primary)' }}
              >
                {data.label}
              </span>
              {data.subtitle && (
                <span className="text-[10px] truncate" style={{ color: 'var(--n8n-text-muted)' }}>
                  {data.subtitle}
                </span>
              )}
              {children}
            </div>
          </div>
        ) : isPill ? (
          // Pill layout: centered icon only
          <div className="flex items-center justify-center w-full h-full">
            {Icon && <Icon size={22} style={{ color: accent }} />}
          </div>
        ) : (
          // Default / trigger layout: icon circle + label + children
          <div className="flex flex-col items-center justify-center flex-1 gap-1 p-3">
            <div
              className="flex items-center justify-center shrink-0"
              style={{
                width: 32,
                height: 32,
                borderRadius: '8px',
                background: `${accent}18`,
              }}
            >
              {Icon && <Icon size={16} style={{ color: accent }} />}
            </div>
            <span
              className="text-[11px] font-semibold text-center truncate w-full"
              style={{ color: 'var(--n8n-text-primary)' }}
            >
              {data.label}
            </span>
            {children}
          </div>
        )}
      </div>

      {/* ── Status badge ── */}
      <StatusBadge status={data.status} />

      {/* ── Pill label (below node) ── */}
      {isPill && (
        <div
          className="absolute left-1/2 -translate-x-1/2 text-[9px] font-medium whitespace-nowrap mt-2"
          style={{ color: 'var(--n8n-text-muted)', top: '100%' }}
        >
          {data.label}
        </div>
      )}
    </div>
  );
}

export default memo(BaseCanvasNode);

export { BaseCanvasNode };
