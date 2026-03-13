/* eslint-disable react-refresh/only-export-components */

import type { CSSProperties } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';

export type PipelineNodeData = {
  label: string;
  subtitle: string;
  color: string;
  status?: string;
  progressPct?: number;
};

export const PIPELINE_COLORS = {
  canvas: '#1B1B2E',
  dot: '#2A2A44',
  nodeBg: '#202038',
  nodeBorder: '#3C3C5E',
  text: '#E2E2F0',
  textMuted: '#9090B4',
  server: '#A78BFA',
  aggregate: '#FDBA74',
  waiting: '#FCD34D',
  training: '#34D399',
  danger: '#F87171',
  idle: '#8B8BB6',
} as const;

const HANDLE_BASE = { width: 8, height: 8, border: 'none' } as const;

const NODE_SHELL: CSSProperties = {
  minWidth: 190,
  borderRadius: 8,
  border: `1px solid ${PIPELINE_COLORS.nodeBorder}`,
  background: PIPELINE_COLORS.nodeBg,
  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.35)',
  overflow: 'hidden',
  display: 'grid',
  gridTemplateColumns: '4px 1fr',
};

const NODE_INNER: CSSProperties = { padding: '10px 12px' };

export function clientStatusColor(status: string): string {
  if (status === 'training' || status === 'done') return PIPELINE_COLORS.training;
  if (status === 'encrypting' || status === 'sending' || status === 'error') return PIPELINE_COLORS.danger;
  if (status === 'waiting') return PIPELINE_COLORS.waiting;
  return PIPELINE_COLORS.idle;
}

function AccentNode({ data }: NodeProps<PipelineNodeData>) {
  return (
    <div style={NODE_SHELL}>
      <div style={{ background: data.color }} />
      <div style={NODE_INNER}>
        <Handle type="target" position={Position.Left} id="in" style={{ ...HANDLE_BASE, background: data.color }} />
        <Handle type="source" position={Position.Right} id="src" style={{ ...HANDLE_BASE, background: data.color }} />
        <Handle type="target" position={Position.Top} id="retIn" style={{ ...HANDLE_BASE, background: data.color, left: '38%' }} />
        <Handle type="source" position={Position.Top} id="retOut" style={{ ...HANDLE_BASE, background: data.color, left: '62%' }} />
        <p style={{ fontSize: 12, fontWeight: 700, color: PIPELINE_COLORS.text, margin: 0 }}>{data.label}</p>
        <p style={{ fontSize: 10, color: PIPELINE_COLORS.textMuted, margin: '4px 0 0' }}>{data.subtitle}</p>
      </div>
    </div>
  );
}

function ClientNode({ data }: NodeProps<PipelineNodeData>) {
  const color = data.color;
  const pct = data.progressPct ?? 0;
  const status = data.status ?? 'idle';

  return (
    <div style={NODE_SHELL}>
      <div style={{ background: color }} />
      <div style={NODE_INNER}>
        <Handle type="target" position={Position.Left} id="in" style={{ ...HANDLE_BASE, background: color }} />
        <Handle type="source" position={Position.Right} id="out" style={{ ...HANDLE_BASE, background: color }} />
        <p style={{ fontSize: 12, fontWeight: 700, color: PIPELINE_COLORS.text, margin: 0 }}>{data.label}</p>

        <div style={{ marginTop: 5, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            fontSize: 10,
            fontWeight: 600,
            color,
            background: `${color}22`,
            border: `1px solid ${color}66`,
            borderRadius: 999,
            padding: '1px 7px',
            textTransform: 'capitalize',
          }}>
            {status}
          </span>
          <span style={{ fontSize: 10, color: PIPELINE_COLORS.textMuted }}>{Math.round(pct)}%</span>
        </div>

        <div style={{ marginTop: 7, height: 4, borderRadius: 99, background: '#2D2D49', overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', borderRadius: 99, background: color, transition: 'width 0.35s ease' }} />
        </div>
      </div>
    </div>
  );
}

export const pipelineNodeTypes = {
  serverPipe: AccentNode,
  aggregatePipe: AccentNode,
  clientPipe: ClientNode,
};
