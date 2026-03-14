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

import { memo, type CSSProperties, type ReactNode } from 'react';
import { Check, Pause, Play, X, type LucideIcon } from 'lucide-react';
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
function getStatusStyles(status: NodeStatus, accent: string, accentLight: string): CSSProperties {
  switch (status) {
    case 'running':
      return {
        borderColor: accent,
        boxShadow: `0 0 0 1px ${accent}33, var(--n8n-node-shadow)`,
        animation: 'node-running 2.6s ease-in-out infinite',
      };
    case 'active':
      return {
        borderColor: accent,
        boxShadow: `0 0 0 1px ${accent}40, 0 10px 22px -18px ${accent}90, var(--n8n-node-shadow)`,
      };
    case 'success':
      return {
        borderColor: '#18a058',
        boxShadow: '0 0 0 1px rgba(24, 160, 88, 0.3), 0 14px 26px -20px rgba(24, 160, 88, 0.8), var(--n8n-node-shadow)',
      };
    case 'error':
      return {
        borderColor: '#d03050',
        boxShadow: '0 0 0 1px rgba(208, 48, 80, 0.3), 0 14px 26px -20px rgba(208, 48, 80, 0.85), var(--n8n-node-shadow)',
      };
    case 'disabled':
      return {
        borderColor: 'var(--n8n-node-border)',
        opacity: 0.5,
      };
    default: // idle
      return {
        borderColor: 'var(--n8n-node-border)',
        boxShadow: `inset 0 1px 0 ${accentLight}, var(--n8n-node-shadow)`,
      };
  }
}

// ── Status badge component ──
function StatusBadge({ status }: { status: NodeStatus }) {
  if (status === 'idle') return null;

  const colorMap: Record<Exclude<NodeStatus, 'idle'>, string> = {
    active: '#3b8fe8',
    running: '#ff6d5a',
    success: '#18a058',
    error: '#d03050',
    disabled: '#888888',
  };

  const backgroundMap: Record<Exclude<NodeStatus, 'idle'>, string> = {
    active: 'rgba(59, 143, 232, 0.14)',
    running: 'rgba(255, 109, 90, 0.14)',
    success: 'rgba(24, 160, 88, 0.16)',
    error: 'rgba(208, 48, 80, 0.16)',
    disabled: 'rgba(136, 136, 136, 0.14)',
  };

  const IconMap: Partial<Record<NodeStatus, React.ComponentType<{ size?: number; className?: string }>>> = {
    active: Play,
    success: Check,
    error: X,
    disabled: Pause,
  };

  const Icon = IconMap[status];

  return (
    <div
      className={`n8n-node-status-badge n8n-node-status-badge--${status}`}
      aria-label={`Node status: ${status}`}
      style={{
        color: colorMap[status],
        background: backgroundMap[status],
      }}
    >
      {status === 'running' ? (
        <>
          <span className="n8n-node-status-ring" />
          <span className="n8n-node-status-dot" />
        </>
      ) : Icon ? (
        <Icon size={10} className="n8n-node-status-icon" />
      ) : (
        <span className="n8n-node-status-dot" />
      )}
    </div>
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
  const statusStyles = getStatusStyles(data.status, accent, config.accentLight);

  const Icon = LucideIcons[config.icon as keyof typeof LucideIcons] as LucideIcon | undefined;

  const isWide = shape === 'wide';
  const isPill = shape === 'pill';
  const shellShadow = selected
    ? `0 0 0 1px ${accent}90, 0 0 0 4px ${config.accentLight}, var(--n8n-node-shadow-hover)`
    : statusStyles.boxShadow ?? 'var(--n8n-node-shadow)';
  const iconStyle: CSSProperties = {
    background: config.accentLight,
    border: `1px solid ${config.accent}33`,
    color: accent,
  };

  return (
    <div
      className={`relative n8n-node ${selected ? 'selected' : ''}`}
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
        className="w-full h-full flex n8n-node-shell"
        data-status={data.status}
        data-shape={shape}
        style={{
          borderRadius,
          background: 'var(--n8n-node-bg)',
          border: `1px solid ${statusStyles.borderColor ?? 'var(--n8n-node-border)'}`,
          boxShadow: shellShadow,
          opacity: statusStyles.opacity ?? 1,
          cursor: 'pointer',
          overflow: 'hidden',
          ...(statusStyles.animation ? { animation: statusStyles.animation } : {}),
        }}
      >
        {/* ── Content area ── */}
        {isWide ? (
          <div className="canvas-node-content canvas-node-content--wide">
            <div className="canvas-node-header">
              <div className="canvas-node-icon" style={iconStyle}>
                {Icon && <Icon size={18} style={{ color: accent }} />}
              </div>
              <div className="canvas-node-copy">
                <span className="canvas-node-title">{data.label}</span>
                {data.subtitle && (
                  <span className="canvas-node-subtitle">
                    {data.subtitle}
                  </span>
                )}
              </div>
            </div>
            {children && <div className="canvas-node-extra">{children}</div>}
          </div>
        ) : isPill ? (
          <div className="canvas-node-pill-content">
            <div className="canvas-node-icon canvas-node-icon--pill" style={iconStyle}>
              {Icon && <Icon size={22} style={{ color: accent }} />}
            </div>
          </div>
        ) : (
          <div className="canvas-node-content">
            <div className="canvas-node-header">
              <div className="canvas-node-icon" style={iconStyle}>
                {Icon && <Icon size={16} style={{ color: accent }} />}
              </div>
              <div className="canvas-node-copy">
                <span className="canvas-node-title">{data.label}</span>
                {data.subtitle && (
                  <span className="canvas-node-subtitle">
                    {data.subtitle}
                  </span>
                )}
              </div>
            </div>
            {children && <div className="canvas-node-extra">{children}</div>}
          </div>
        )}
      </div>

      {/* ── Status badge ── */}
      <StatusBadge status={data.status} />

      {/* ── Pill label (below node) ── */}
      {isPill && (
        <div
          className="canvas-node-pill-label"
          style={{ color: 'var(--n8n-text-muted)' }}
        >
          {data.label}
        </div>
      )}
    </div>
  );
}

export default memo(BaseCanvasNode);

export { BaseCanvasNode };
