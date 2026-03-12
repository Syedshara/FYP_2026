/**
 * ScenarioSourceNode — React Flow v11 node component
 * NodeType: source_scenario
 *
 * Source node: ONE output handle on the right, NO input handle.
 * Displays scenario config fields as readonly.
 */

import React from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';

// ── Design tokens ────────────────────────────────────────────────────────────

const T = {
  nodeBg:       '#2d2d2d',
  headerBg:     '#262626',
  border:       '#3c3c3c',
  radius:       12,
  font:         "'JetBrains Mono', monospace",
  accent:       '#ff6d5a',
  textPrimary:  '#ececec',
  textMuted:    '#888888',
  success:      '#18a058',
  handleColor:  '#ff6d5a',
  nodeWidth:    220,
  handleSize:   10,
};

// ── Play-triangle icon ────────────────────────────────────────────────────────

function PlayIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <polygon points="2,1 12,6.5 2,12" fill={T.success} />
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

// ── ScenarioSourceNode ────────────────────────────────────────────────────────

export function ScenarioSourceNode({ data, selected }: NodeProps) {
  const scenario   = (data.config?.scenario   as string  | undefined) ?? 'ddos_attack';
  const flowRate   = (data.config?.flow_rate  as number  | undefined) ?? 0;
  const loop       = (data.config?.loop       as boolean | undefined) ?? false;

  const containerStyle: React.CSSProperties = {
    width:      T.nodeWidth,
    borderRadius: T.radius,
    background: T.nodeBg,
    border:     `1px solid ${T.border}`,
    fontFamily: T.font,
    overflow:   'hidden',
    boxShadow:  selected
      ? `0 0 0 2px ${T.accent}`
      : '0 4px 12px rgba(0,0,0,0.5)',
    transition: 'box-shadow 0.15s',
  };

  const headerStyle: React.CSSProperties = {
    display:        'flex',
    alignItems:     'center',
    gap:            7,
    padding:        '8px 12px',
    background:     T.headerBg,
    borderBottom:   `1px solid ${T.border}`,
  };

  const bodyStyle: React.CSSProperties = {
    padding:    '8px 12px 10px',
    display:    'flex',
    flexDirection: 'column',
    gap:        2,
  };

  return (
    <div style={containerStyle}>
      {/* Header */}
      <div style={headerStyle}>
        <PlayIcon />
        <span style={{
          fontSize:   11,
          fontWeight: 700,
          color:      T.success,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          flex: 1,
        }}>
          Scenario Source
        </span>
        <span style={{
          fontSize:   9,
          color:      T.textMuted,
          background: '#1a1a1a',
          padding:    '2px 5px',
          borderRadius: 4,
        }}>
          SRC
        </span>
      </div>

      {/* Body */}
      <div style={bodyStyle}>
        <ConfigRow label="scenario"   value={scenario} />
        <ConfigRow label="flow_rate"  value={`${flowRate} /s`} />
        <ConfigRow label="loop"       value={loop ? 'true' : 'false'} />
      </div>

      {/* Output handle — right side only */}
      <Handle
        type="source"
        position={Position.Right}
        style={handleStyle}
      />
    </div>
  );
}

export default ScenarioSourceNode;
