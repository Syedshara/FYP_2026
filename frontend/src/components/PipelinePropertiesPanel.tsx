/**
 * PipelinePropertiesPanel
 *
 * Right-side panel (280px) that shows and edits the configuration
 * of whichever React Flow node is currently selected.
 *
 * Supported node types:
 *   source_scenario | attack_inject | rate_filter | monitor_sink
 */

import React from 'react';
import type { Node } from 'reactflow';

// ── Design tokens ─────────────────────────────────────────────────────────────

const T = {
  panelBg:      '#101014',
  borderLeft:   '1px solid #3c3c3c',
  cardBg:       '#2d2d2d',
  border:       '1px solid #3c3c3c',
  radius:       6,
  accent:       '#ff6d5a',
  textPrimary:  '#ececec',
  textMuted:    '#888888',
  success:      '#18a058',
  danger:       '#d03050',
  warning:      '#f0a020',
  font:         "'JetBrains Mono', monospace",
  panelWidth:   280,
} as const;

// ── Node accent colours (match the node borders in the palette) ───────────────

const nodeAccent: Record<string, string> = {
  source_scenario: T.success,
  attack_inject:   T.danger,
  rate_filter:     T.warning,
  monitor_sink:    T.accent,
};

const nodeLabel: Record<string, string> = {
  source_scenario: 'Scenario Source',
  attack_inject:   'Attack Inject',
  rate_filter:     'Rate Filter',
  monitor_sink:    'Monitor Sink',
};

// ── Props ─────────────────────────────────────────────────────────────────────

interface PipelinePropertiesPanelProps {
  selectedNode: Node | null;
  onUpdateNode: (nodeId: string, config: Record<string, unknown>, label: string) => void;
  onClose: () => void;
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label style={{
      display:    'block',
      fontSize:   11,
      fontWeight: 500,
      color:      T.textMuted,
      marginBottom: 4,
      fontFamily: T.font,
    }}>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  width:        '100%',
  boxSizing:    'border-box',
  background:   T.cardBg,
  border:       T.border,
  borderRadius: T.radius,
  color:        T.textPrimary,
  padding:      '6px 10px',
  fontSize:     12,
  fontFamily:   T.font,
  outline:      'none',
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  appearance: 'none',
  cursor:     'pointer',
};

const fieldWrap: React.CSSProperties = {
  marginBottom: 14,
};

// ── Per-type forms ────────────────────────────────────────────────────────────

interface FormProps {
  nodeId:   string;
  config:   Record<string, unknown>;
  label:    string;
  onChange: (config: Record<string, unknown>, label: string) => void;
}

function ScenarioSourceForm({ nodeId: _nodeId, config, label, onChange }: FormProps) {
  const scenario  = (config.scenario  as string  | undefined) ?? 'mixed_traffic';
  const flowRate  = (config.flow_rate as number  | undefined) ?? 5;
  const loop      = (config.loop      as boolean | undefined) ?? true;

  const push = (patch: Partial<typeof config>) =>
    onChange({ ...config, ...patch }, label);

  return (
    <>
      <div style={fieldWrap}>
        <FieldLabel>Label</FieldLabel>
        <input
          style={inputStyle}
          value={label}
          onChange={e => onChange(config, e.target.value)}
        />
      </div>

      <div style={fieldWrap}>
        <FieldLabel>Scenario</FieldLabel>
        <select style={selectStyle} value={scenario}
          onChange={e => push({ scenario: e.target.value })}>
          {[
            'ddos_attack', 'portscan', 'brute_force', 'web_attacks',
            'infiltration', 'botnet', 'benign_only', 'mixed_traffic',
            'high_intensity', 'client_data',
          ].map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <div style={fieldWrap}>
        <FieldLabel>Flow rate (flows/sec)</FieldLabel>
        <input
          type="number"
          style={inputStyle}
          min={0.1}
          step={0.1}
          value={flowRate}
          onChange={e => push({ flow_rate: parseFloat(e.target.value) || 0.1 })}
        />
      </div>

      <div style={{ ...fieldWrap, display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          id="loop-cb"
          checked={loop}
          onChange={e => push({ loop: e.target.checked })}
          style={{ accentColor: T.accent, width: 14, height: 14 }}
        />
        <label htmlFor="loop-cb" style={{ fontSize: 12, color: T.textPrimary, fontFamily: T.font, cursor: 'pointer' }}>
          Loop
        </label>
      </div>
    </>
  );
}

function AttackInjectForm({ nodeId: _nodeId, config, label, onChange }: FormProps) {
  const attackType  = (config.attack_type  as string | undefined) ?? 'ddos';
  const intensity   = (config.intensity    as number | undefined) ?? 0.5;
  const durationSec = (config.duration_sec as number | undefined) ?? 60;

  const push = (patch: Partial<typeof config>) =>
    onChange({ ...config, ...patch }, label);

  return (
    <>
      <div style={fieldWrap}>
        <FieldLabel>Label</FieldLabel>
        <input
          style={inputStyle}
          value={label}
          onChange={e => onChange(config, e.target.value)}
        />
      </div>

      <div style={fieldWrap}>
        <FieldLabel>Attack type</FieldLabel>
        <select style={selectStyle} value={attackType}
          onChange={e => push({ attack_type: e.target.value })}>
          {['ddos', 'portscan', 'brute_force', 'web', 'infiltration', 'botnet']
            .map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <div style={fieldWrap}>
        <FieldLabel>Intensity — {intensity.toFixed(2)}</FieldLabel>
        <input
          type="range"
          min={0} max={1} step={0.01}
          value={intensity}
          onChange={e => push({ intensity: parseFloat(e.target.value) })}
          style={{ width: '100%', accentColor: T.danger }}
        />
      </div>

      <div style={fieldWrap}>
        <FieldLabel>Duration (sec)</FieldLabel>
        <input
          type="number"
          style={inputStyle}
          min={1}
          value={durationSec}
          onChange={e => push({ duration_sec: parseInt(e.target.value, 10) || 1 })}
        />
      </div>
    </>
  );
}

function RateFilterForm({ nodeId: _nodeId, config, label, onChange }: FormProps) {
  const maxFlows  = (config.max_flows_per_sec as number | undefined) ?? 10;
  const sampleRate = (config.sample_rate      as number | undefined) ?? 1.0;

  const push = (patch: Partial<typeof config>) =>
    onChange({ ...config, ...patch }, label);

  return (
    <>
      <div style={fieldWrap}>
        <FieldLabel>Label</FieldLabel>
        <input
          style={inputStyle}
          value={label}
          onChange={e => onChange(config, e.target.value)}
        />
      </div>

      <div style={fieldWrap}>
        <FieldLabel>Max flows/sec</FieldLabel>
        <input
          type="number"
          style={inputStyle}
          min={0.1}
          step={0.1}
          value={maxFlows}
          onChange={e => push({ max_flows_per_sec: parseFloat(e.target.value) || 0.1 })}
        />
      </div>

      <div style={fieldWrap}>
        <FieldLabel>Sample rate — {sampleRate.toFixed(2)}</FieldLabel>
        <input
          type="range"
          min={0} max={1} step={0.01}
          value={sampleRate}
          onChange={e => push({ sample_rate: parseFloat(e.target.value) })}
          style={{ width: '100%', accentColor: T.warning }}
        />
      </div>
    </>
  );
}

const ALL_CLIENTS = ['bank_a', 'bank_b', 'bank_c'] as const;

function MonitorSinkForm({ nodeId: _nodeId, config, label, onChange }: FormProps) {
  const clients = (config.clients as string[] | undefined) ?? [...ALL_CLIENTS];

  const toggle = (client: string) => {
    const next = clients.includes(client)
      ? clients.filter(c => c !== client)
      : [...clients, client];
    onChange({ ...config, clients: next }, label);
  };

  return (
    <>
      <div style={fieldWrap}>
        <FieldLabel>Label</FieldLabel>
        <input
          style={inputStyle}
          value={label}
          onChange={e => onChange(config, e.target.value)}
        />
      </div>

      <div style={fieldWrap}>
        <FieldLabel>Clients</FieldLabel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {ALL_CLIENTS.map(c => {
            const checked = clients.includes(c);
            return (
              <div key={c} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  id={`client-${c}`}
                  checked={checked}
                  onChange={() => toggle(c)}
                  style={{ accentColor: T.accent, width: 14, height: 14 }}
                />
                <label
                  htmlFor={`client-${c}`}
                  style={{ fontSize: 12, color: T.textPrimary, fontFamily: T.font, cursor: 'pointer' }}
                >
                  {c}
                </label>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export default function PipelinePropertiesPanel({
  selectedNode,
  onUpdateNode,
  onClose,
}: PipelinePropertiesPanelProps) {

  const handleChange = (config: Record<string, unknown>, label: string) => {
    if (!selectedNode) return;
    onUpdateNode(selectedNode.id, config, label);
  };

  const nodeType = selectedNode?.type as string | undefined;
  const config   = (selectedNode?.data?.config as Record<string, unknown> | undefined) ?? {};
  const label    = (selectedNode?.data?.label  as string | undefined) ?? '';
  const accent   = nodeType ? (nodeAccent[nodeType] ?? T.accent) : T.accent;

  const formProps: FormProps = {
    nodeId:   selectedNode?.id ?? '',
    config,
    label,
    onChange: handleChange,
  };

  return (
    <div style={{
      width:      T.panelWidth,
      flexShrink: 0,
      display:    'flex',
      flexDirection: 'column',
      background: T.panelBg,
      borderLeft: T.borderLeft,
      overflow:   'hidden',
    }}>

      {/* Header */}
      <div style={{
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'space-between',
        padding:        '12px 14px',
        borderBottom:   T.border,
        flexShrink:     0,
      }}>
        <span style={{
          fontSize:   11,
          fontWeight: 700,
          color:      T.textMuted,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          fontFamily: T.font,
        }}>
          Properties
        </span>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border:     'none',
            color:      T.textMuted,
            cursor:     'pointer',
            fontSize:   18,
            lineHeight: 1,
            padding:    0,
          }}
          aria-label="Close properties panel"
        >
          ×
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>

        {/* Empty state */}
        {!selectedNode && (
          <div style={{
            height:         '100%',
            display:        'flex',
            alignItems:     'center',
            justifyContent: 'center',
            textAlign:      'center',
            color:          T.textMuted,
            fontSize:       12,
            fontFamily:     T.font,
            lineHeight:     1.6,
            padding:        '0 20px',
          }}>
            Select a node to configure it
          </div>
        )}

        {/* Node type badge */}
        {selectedNode && nodeType && (
          <>
            <div style={{
              display:      'inline-block',
              padding:      '3px 10px',
              borderRadius: 20,
              fontSize:     10,
              fontWeight:   700,
              fontFamily:   T.font,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color:        accent,
              background:   `${accent}22`,
              border:       `1px solid ${accent}44`,
              marginBottom: 16,
            }}>
              {nodeLabel[nodeType] ?? nodeType}
            </div>

            {/* Forms */}
            {nodeType === 'source_scenario' && <ScenarioSourceForm {...formProps} />}
            {nodeType === 'attack_inject'   && <AttackInjectForm   {...formProps} />}
            {nodeType === 'rate_filter'     && <RateFilterForm      {...formProps} />}
            {nodeType === 'monitor_sink'    && <MonitorSinkForm     {...formProps} />}

            {/* Fallback for unknown node types */}
            {!['source_scenario', 'attack_inject', 'rate_filter', 'monitor_sink'].includes(nodeType) && (
              <div style={{ fontSize: 12, color: T.textMuted, fontFamily: T.font }}>
                No configuration available for this node type.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
