/**
 * RateFilterNode — React Flow v11 node component
 * NodeType: rate_filter
 *
 * Transform node: ONE input handle on the left, ONE output handle on the right.
 * Displays rate-limiting config fields as readonly.
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
  warning:     '#f0a020',
  handleColor: '#ff6d5a',
  nodeWidth:   220,
  handleSize:  10,
};

// ── Funnel / filter icon ──────────────────────────────────────────────────────

function FunnelIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      {/* wide trapezoid top */}
      <path
        d="M1 2 H12 L8.5 6 V11 L4.5 9.5 V6 Z"
        fill={T.warning}
      />
    </svg>
  );
}

// ── Config row ────────────────────────────────────────────────────────────────

function ConfigRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{
      display:        'flex',
      justifyContent: 'space-between',
      alignItems:     'center',
      padding:        '3px 0',
      borderBottom:   `1px solid ${T.border}`,
      fontSize:       11,
      fontFamily:     T.font,
    }}>
      <span style={{ color: T.textMuted }}>{label}</span>
      <span style={{ color: T.textPrimary, fontWeight: 600 }}>{value}</span>
    </div>
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

// ── RateFilterNode ────────────────────────────────────────────────────────────

export function RateFilterNode({ data, selected }: NodeProps) {
  const maxFlows   = (data.config?.max_flows_per_sec as number | undefined) ?? 0;
  const sampleRate = (data.config?.sample_rate        as number | undefined) ?? 0;

  const samplePct = `${Math.round(sampleRate * 100)}%`;

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
    padding:       '8px 12px 10px',
    display:       'flex',
    flexDirection: 'column',
    gap:           2,
  };

  return (
    <div style={containerStyle}>
      {/* Header */}
      <div style={headerStyle}>
        <FunnelIcon />
        <span style={{
          fontSize:      11,
          fontWeight:    700,
          color:         T.warning,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          flex:          1,
        }}>
          Rate Filter
        </span>
        <span style={{
          fontSize:     9,
          color:        T.textMuted,
          background:   '#1a1a1a',
          padding:      '2px 5px',
          borderRadius: 4,
        }}>
          FILT
        </span>
      </div>

      {/* Body */}
      <div style={bodyStyle}>
        <ConfigRow label="max_flows/s"  value={`${maxFlows} /s`} />
        <ConfigRow label="sample_rate"  value={samplePct} />
      </div>

      {/* Input handle — left side */}
      <Handle
        type="target"
        position={Position.Left}
        style={handleStyle}
      />

      {/* Output handle — right side */}
      <Handle
        type="source"
        position={Position.Right}
        style={handleStyle}
      />
    </div>
  );
}

export default RateFilterNode;
