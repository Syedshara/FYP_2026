/**
 * AttackInjectNode — React Flow v11 node component
 * NodeType: attack_inject
 *
 * Transform node: ONE input handle on the left, ONE output handle on the right.
 * Displays attack config fields as readonly.
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
  danger:      '#d03050',
  handleColor: '#ff6d5a',
  nodeWidth:   220,
  handleSize:  10,
};

// ── Bolt / warning icon ───────────────────────────────────────────────────────

function BoltIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <polygon
        points="7.5,1 2,7.5 6,7.5 5.5,12 11,5.5 7,5.5"
        fill={T.danger}
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

// ── AttackInjectNode ──────────────────────────────────────────────────────────

export function AttackInjectNode({ data, selected }: NodeProps) {
  const attackType   = (data.config?.attack_type   as string | undefined) ?? 'ddos';
  const intensity    = (data.config?.intensity      as number | undefined) ?? 0;
  const durationSec  = (data.config?.duration_sec   as number | undefined) ?? 0;

  const intensityPct = `${Math.round(intensity * 100)}%`;

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
        <BoltIcon />
        <span style={{
          fontSize:      11,
          fontWeight:    700,
          color:         T.danger,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          flex:          1,
        }}>
          Attack Inject
        </span>
        <span style={{
          fontSize:     9,
          color:        T.textMuted,
          background:   '#1a1a1a',
          padding:      '2px 5px',
          borderRadius: 4,
        }}>
          ATK
        </span>
      </div>

      {/* Body */}
      <div style={bodyStyle}>
        <ConfigRow label="attack_type"   value={attackType} />
        <ConfigRow label="intensity"     value={intensityPct} />
        <ConfigRow label="duration_sec"  value={`${durationSec}s`} />
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

export default AttackInjectNode;
