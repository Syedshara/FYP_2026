/**
 * CanvasStatusBar — Bottom status bar for the workspace canvas.
 *
 * Shows: WS connection, entity counts, FL training state.
 */

import {
  Wifi,
  WifiOff,
  Building2,
  Cpu,
  BrainCircuit,
  Activity,
} from 'lucide-react';
import type { ComponentType, CSSProperties } from 'react';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useLiveStore } from '@/stores/liveStore';

export default function CanvasStatusBar() {
  const nodes = useWorkspaceStore((s) => s.nodes);
  const wsConnected = useLiveStore((s) => s.wsConnected);
  const flGlobal = useLiveStore((s) => s.flGlobalProgress);

  const clientCount = nodes.filter((n) => n.data.nodeType === 'client').length;
  const deviceCount = nodes.filter((n) => n.data.nodeType === 'device').length;
  const monitorCount = nodes.filter((n) => n.data.nodeType === 'monitor').length;

  const isTraining = flGlobal?.is_training ?? false;

  return (
    <footer
      className="flex items-center justify-between shrink-0 select-none text-[11px]"
      style={{
        background: 'var(--n8n-topbar-bg)',
        borderTop: '1px solid var(--n8n-card-border)',
        color: 'var(--n8n-text-muted)',
        height: '32px',
        paddingLeft: '20px',
        paddingRight: '20px',
      }}
    >
      {/* Left: Connection Status */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5">
          {wsConnected
            ? <Wifi size={12} style={{ color: 'var(--n8n-success)' }} />
            : <WifiOff size={12} style={{ color: 'var(--n8n-danger)' }} />
          }
          <span
            className="fl-status-dot"
            style={{
              background: wsConnected ? 'var(--n8n-success)' : 'var(--n8n-danger)',
              animation: !wsConnected ? 'pulse-dot 2s ease-in-out infinite' : 'none',
            }}
          />
        </div>
      </div>

      {/* Center: Entity Counts */}
      <div className="flex items-center gap-3">
        <CountPill icon={Building2} count={clientCount} label="Clients" accent="#5b9bf5" />
        <span style={{ color: 'var(--n8n-card-border)' }}>·</span>
        <CountPill icon={Cpu} count={deviceCount} label="Devices" accent="#18a058" />
        <span style={{ color: 'var(--n8n-card-border)' }}>·</span>
        <CountPill icon={Activity} count={monitorCount} label="Monitors" accent="#38bdf8" />
      </div>

      {/* Right: FL Status */}
      <div className="flex items-center gap-2">
        <BrainCircuit size={12} style={{ color: 'var(--n8n-accent)' }} />
        <span>FL:</span>
        <span
          className="fl-status-dot"
          style={{
            background: isTraining ? 'var(--n8n-accent)' : 'var(--n8n-success)',
            animation: isTraining ? 'pulse-dot 2s ease-in-out infinite' : 'none',
          }}
        />
        {isTraining && (
          <span style={{ color: 'var(--n8n-accent)' }}>
            Round {flGlobal!.current_round}/{flGlobal!.total_rounds}
          </span>
        )}
      </div>
    </footer>
  );
}

// ── Sub-components ──

function CountPill({
  icon: Icon,
  count,
  label,
  accent,
}: {
  icon: ComponentType<{ size?: number; style?: CSSProperties }>;
  count: number;
  label: string;
  accent: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Icon size={12} style={{ color: accent }} />
      <span>
        <span style={{ color: 'var(--n8n-text-primary)' }}>{count}</span>{' '}
        {label}
      </span>
    </div>
  );
}
