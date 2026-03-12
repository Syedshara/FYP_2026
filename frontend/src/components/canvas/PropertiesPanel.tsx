/**
 * PropertiesPanel — Right panel for editing selected node properties.
 *
 * Context-sensitive: shows different fields based on the selected node type.
 * All hover states are CSS-only (no onMouseEnter/Leave).
 * Form fields use .prop-input / .form-label from index.css.
 */

import React from 'react';
import { X, Trash2 } from 'lucide-react';
import * as LucideIcons from 'lucide-react';
import { useWorkspaceStore, useSelectedNode } from '@/stores/workspaceStore';
import { NODE_TYPE_CONFIGS } from '@/config/nodeTypes';
import type { CanvasNodeData } from '@/types/canvas';

/**
 * Convert a hex color like "#ff6d5a" to an rgba() with the given alpha.
 * Falls back gracefully if the input isn't a valid 6-char hex.
 */
function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return `${hex}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export default function PropertiesPanel() {
  const propertiesPanelOpen = useWorkspaceStore((s) => s.propertiesPanelOpen);
  const setPropertiesPanelOpen = useWorkspaceStore((s) => s.setPropertiesPanelOpen);
  const updateNodeData = useWorkspaceStore((s) => s.updateNodeData);
  const removeNode = useWorkspaceStore((s) => s.removeNode);
  const selectedNode = useSelectedNode();

  if (!propertiesPanelOpen || !selectedNode) return null;

  const config = NODE_TYPE_CONFIGS[selectedNode.data.nodeType];
  const Icon = (LucideIcons as Record<string, React.ComponentType<{ size?: number; style?: React.CSSProperties }>>)[config.icon];

  const handleFieldChange = (field: string, value: string | number | boolean) => {
    updateNodeData(selectedNode.id, { [field]: value } as Partial<CanvasNodeData>);
  };

  const handleDelete = () => {
    removeNode(selectedNode.id);
  };

  return (
    <aside
      className="flex flex-col w-[260px] border-l shrink-0 overflow-y-auto"
      style={{
        background: 'var(--n8n-sidebar-bg)',
        borderColor: 'var(--n8n-card-border)',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b"
        style={{ borderColor: 'var(--n8n-card-border)' }}
      >
        <div className="flex items-center gap-2">
          <div
            className="icon-badge icon-badge-sm"
            style={{ background: hexToRgba(config.accent, 0.12) }}
          >
            {Icon && <Icon size={14} style={{ color: config.accent }} />}
          </div>
          <div className="flex flex-col">
            <span className="text-xs font-semibold" style={{ color: 'var(--n8n-text-primary)' }}>
              {config.label}
            </span>
            <span className="text-[10px]" style={{ color: 'var(--n8n-text-muted)' }}>
              Properties
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setPropertiesPanelOpen(false)}
          className="panel-close-btn"
          aria-label="Close properties panel"
        >
          <X size={14} />
        </button>
      </div>

      {/* Fields */}
      <div className="flex flex-col gap-4 px-4 pt-4 pb-4">
        {/* Common fields */}
        <PropertyField
          label="Label"
          value={selectedNode.data.label}
          onChange={(v) => handleFieldChange('label', v)}
        />
        <PropertyField
          label="Subtitle"
          value={selectedNode.data.subtitle ?? ''}
          onChange={(v) => handleFieldChange('subtitle', v)}
        />

        {/* Status */}
        <PropertySelect
          label="Status"
          value={selectedNode.data.status}
          options={['idle', 'active', 'running', 'error', 'disabled', 'success']}
          onChange={(v) => handleFieldChange('status', v)}
        />

        {/* Type-specific fields */}
        <div className="panel-divider" />
        <TypeSpecificFields node={selectedNode.data} onChange={handleFieldChange} />
      </div>

      {/* Delete button */}
      <div
        className="mt-auto px-4 pb-4 pt-3 border-t"
        style={{ borderColor: 'var(--n8n-card-border)' }}
      >
        <button type="button" onClick={handleDelete} className="delete-btn">
          <Trash2 size={13} />
          Delete Node
        </button>
      </div>
    </aside>
  );
}

// ── Type-specific field renderers ──

function TypeSpecificFields({
  node,
  onChange,
}: {
  node: CanvasNodeData;
  onChange: (field: string, value: string | number | boolean) => void;
}) {
  switch (node.nodeType) {
    case 'client':
      return (
        <PropertySelect
          label="Industry"
          value={node.industry ?? 'general'}
          options={['general', 'banking', 'healthcare', 'manufacturing', 'energy', 'transport']}
          onChange={(v) => onChange('industry', v)}
        />
      );

    case 'device':
      return (
        <>
          <PropertySelect
            label="Device Type"
            value={node.deviceType ?? 'sensor'}
            options={['sensor', 'actuator', 'gateway', 'camera', 'controller']}
            onChange={(v) => onChange('deviceType', v)}
          />
          <PropertyField
            label="IP Address"
            value={node.ipAddress ?? ''}
            onChange={(v) => onChange('ipAddress', v)}
            placeholder="192.168.1.100"
          />
          <PropertySelect
            label="Protocol"
            value={node.protocol ?? 'MQTT'}
            options={['MQTT', 'CoAP', 'HTTP', 'Modbus', 'TCP', 'UDP']}
            onChange={(v) => onChange('protocol', v)}
          />
          <PropertyField
            label="Port"
            value={String(node.port ?? 1883)}
            onChange={(v) => onChange('port', parseInt(v) || 0)}
            type="number"
          />
        </>
      );

    case 'fl-server':
      return (
        <>
          <PropertyField
            label="Total Rounds"
            value={String(node.totalRounds ?? 10)}
            onChange={(v) => onChange('totalRounds', parseInt(v) || 10)}
            type="number"
          />
          <PropertySelect
            label="Aggregation"
            value={node.aggregationMethod ?? 'FedAvg'}
            options={['FedAvg', 'FedAvgHE']}
            onChange={(v) => onChange('aggregationMethod', v)}
          />
        </>
      );

    case 'attack':
      return <AttackFields node={node} onChange={onChange} />;

    case 'traffic-source':
      return (
        <>
          <PropertySelect
            label="Traffic Type"
            value={node.trafficType ?? 'benign'}
            options={['benign', 'mixed']}
            onChange={(v) => onChange('trafficType', v)}
          />
          <PropertyField
            label="Rate (pps)"
            value={String(node.rate ?? 100)}
            onChange={(v) => onChange('rate', parseInt(v) || 100)}
            type="number"
          />
        </>
      );

    case 'rate-filter':
      return (
        <>
          <PropertyField
            label="Max Rate (pps)"
            value={String(node.maxRate ?? 1000)}
            onChange={(v) => onChange('maxRate', parseInt(v) || 1000)}
            type="number"
          />
          <PropertySelect
            label="Drop Policy"
            value={node.dropPolicy ?? 'tail'}
            options={['tail', 'random']}
            onChange={(v) => onChange('dropPolicy', v)}
          />
        </>
      );

    case 'monitor':
      return (
        <div className="text-[11px]" style={{ color: 'var(--n8n-text-muted)' }}>
          Monitor nodes display live metrics from connected devices. Connect devices to see analytics.
        </div>
      );

    default:
      return null;
  }
}

// ── Attack-specific fields with catalog-driven sub-type dropdown ──

function AttackFields({
  node,
  onChange,
}: {
  node: import('@/types/canvas').AttackNodeData;
  onChange: (field: string, value: string | number | boolean) => void;
}) {
  const [catalog, setCatalog] = React.useState<Record<string, Array<{ sub_type: string; label: string }>>>({});
  const [catalogLoading, setCatalogLoading] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setCatalogLoading(true);
    import('@/api/attacks').then((mod) =>
      mod.fetchAttackCatalog().then((data) => {
        if (!cancelled) {
          setCatalog(data);
          setCatalogLoading(false);
        }
      }).catch(() => {
        if (!cancelled) setCatalogLoading(false);
      })
    );
    return () => { cancelled = true; };
  }, []);

  const category = node.attackCategory ?? 'ddos';
  const subTypes = catalog[category] ?? [];

  return (
    <>
      <PropertySelect
        label="Category"
        value={category}
        options={['ddos', 'mitm', 'port-scan', 'replay', 'malformed', 'botnet', 'iot-protocol']}
        onChange={(v) => {
          onChange('attackCategory', v);
          const firstSub = catalog[v]?.[0]?.sub_type;
          if (firstSub) onChange('attackType', firstSub);
        }}
      />
      {catalogLoading ? (
        <div className="text-[10px]" style={{ color: 'var(--n8n-text-muted)' }}>Loading sub-types...</div>
      ) : subTypes.length > 0 ? (
        <PropertySelect
          label="Sub-Type"
          value={node.attackType ?? subTypes[0]?.sub_type ?? ''}
          options={subTypes.map((s) => s.sub_type)}
          onChange={(v) => onChange('attackType', v)}
        />
      ) : null}
      <PropertyField
        label="Target IP"
        value={node.targetIp ?? ''}
        onChange={(v) => onChange('targetIp', v)}
        placeholder="192.168.1.100"
      />
      <PropertyField
        label="Intensity (1-10)"
        value={String(node.intensity ?? 5)}
        onChange={(v) => onChange('intensity', Math.max(1, Math.min(10, parseInt(v) || 5)))}
        type="number"
      />
      <PropertyField
        label="Duration (s)"
        value={String(node.duration ?? 30)}
        onChange={(v) => onChange('duration', parseInt(v) || 30)}
        type="number"
      />
    </>
  );
}

// ── Reusable field components ──

function PropertyField({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="form-label">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="prop-input"
      />
    </div>
  );
}

function PropertySelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="form-label">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="prop-input"
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt.charAt(0).toUpperCase() + opt.slice(1).replace(/-/g, ' ')}
          </option>
        ))}
      </select>
    </div>
  );
}
