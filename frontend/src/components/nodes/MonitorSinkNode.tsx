/**
 * MonitorSinkNode — React Flow v11 node component
 * NodeType: monitor_sink
 *
 * Sink node: ONE input handle on the left, NO output handle.
 * Terminal node — shows "→ Traffic Monitor" in body.
 */

import React from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';

// ── Design tokens ────────────────────────────────────────────────────────────

const T = {
  nodeBg:      '#2d2d2d',
  headerBg:    '#262626',
  border:      '#3c3c3c',
  radius:      12,
  font:        "'JetBrains Mono', monospace",
  accent:      '#ff6d5a',
  textPrimary: '#ececec',
  textMuted:   '#888888',
  handleColor: '#ff6d5a',
  nodeWidth:   220,
  handleSize:  10,
};

// ── Monitor / screen icon ─────────────────────────────────────────────────────

function MonitorIcon() {
  return (
    <svg width="14" height="13" viewBox="0 0 14 13" fill="none" aria-hidden="true">
      {/* Screen frame */}
      <rect x="1" y="1" width="12" height="8" rx="1.5" stroke={T.accent} strokeWidth="1.5" />
      {/* Stand */}
      <line x1="7" y1="9" x2="7" y2="12" stroke={T.accent} strokeWidth="1.5" />
      {/* Base */}
      <line x1="4.5" y1="12" x2="9.5" y2="12" stroke={T.accent} strokeWidth="1.5" />
      {/* Screen dot — indicates activity */}
      <circle cx="7" cy="5" r="1.5" fill={T.accent} />
    </svg>
  );
}

// ── Handle style ──────────────────────────────────────────────────────────────

const handleStyle: React.CSSProperties = {
  width:        T.handleSize,
  height:       T.handleSize,
  borderRadius: '50%',
  background:   T.handleColor,
  border:       '2px solid #2d2d2d',
};

// ── MonitorSinkNode ───────────────────────────────────────────────────────────

export function MonitorSinkNode({ selected }: NodeProps) {
  const containerStyle: React.CSSProperties = {
    width:        T.nodeWidth,
    borderRadius: T.radius,
    background:   T.nodeBg,
    border:       `1px solid ${T.border}`,
    fontFamily:   T.font,
    overflow:     'hidden',
    boxShadow:    selected
      ? `0 0 0 2px ${T.accent}`
      : '0 4px 12px rgba(0,0,0,0.5)',
    transition:   'box-shadow 0.15s',
  };

  const headerStyle: React.CSSProperties = {
    display:      'flex',
    alignItems:   'center',
    gap:          7,
    padding:      '8px 12px',
    background:   T.headerBg,
    borderBottom: `1px solid ${T.border}`,
  };

  const bodyStyle: React.CSSProperties = {
    padding:     '10px 12px 12px',
    display:     'flex',
    alignItems:  'center',
    gap:         8,
  };

  return (
    <div style={containerStyle}>
      {/* Header */}
      <div style={headerStyle}>
        <MonitorIcon />
        <span style={{
          fontSize:      11,
          fontWeight:    700,
          color:         T.accent,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          flex:          1,
        }}>
          Monitor Sink
        </span>
        <span style={{
          fontSize:     9,
          color:        T.textMuted,
          background:   '#1a1a1a',
          padding:      '2px 5px',
          borderRadius: 4,
        }}>
          SNK
        </span>
      </div>

      {/* Body */}
      <div style={bodyStyle}>
        {/* Arrow indicator */}
        <svg width="16" height="12" viewBox="0 0 16 12" fill="none" aria-hidden="true">
          <path
            d="M1 6 H13 M9 2 L13 6 L9 10"
            stroke={T.accent}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span style={{
          fontSize:   12,
          color:      T.textPrimary,
          fontWeight: 600,
          fontFamily: T.font,
        }}>
          Traffic Monitor
        </span>
      </div>

      {/* Input handle — left side only */}
      <Handle
        type="target"
        position={Position.Left}
        style={handleStyle}
      />
    </div>
  );
}

export default MonitorSinkNode;
