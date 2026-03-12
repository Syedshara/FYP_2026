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
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useLiveStore } from '@/stores/liveStore';

export default function CanvasStatusBar() {
  const nodes = useWorkspaceStore((s) => s.nodes);
  const wsConnected = useLiveStore((s) => s.wsConnected);
  const flGlobal = useLiveStore((s) => s.flGlobalProgress);

  const clientCount = nodes.filter((n) => n.data.nodeType === 'client').length;
  const deviceCount = nodes.filter((n) => n.data.nodeType === 'device').length;
  const monitorCount = nodes.filter((n) => n.data.nodeType === 'monitor').length;

  const flStatus = flGlobal?.is_training
    ? `Round ${flGlobal.current_round}/${flGlobal.total_rounds}`
    : 'Idle';

  return (
    <footer
      className="flex items-center justify-between px-4 h-[32px] border-t select-none shrink-0 text-[11px]"
      style={{
        background: 'var(--n8n-topbar-bg)',
        borderColor: 'var(--n8n-card-border)',
        color: 'var(--n8n-text-muted)',
      }}
    >
      {/* Left: Connection Status */}
      <div className="flex items-center gap-4">
        <StatusPill
          icon={wsConnected ? Wifi : WifiOff}
          label={wsConnected ? 'Connected' : 'Disconnected'}
          color={wsConnected ? 'var(--n8n-success)' : 'var(--n8n-danger)'}
        />
      </div>

      {/* Center: Entity Counts */}
      <div className="flex items-center gap-4">
        <CountPill icon={Building2} count={clientCount} label="Clients" accent="#5b9bf5" />
        <CountPill icon={Cpu} count={deviceCount} label="Devices" accent="#18a058" />
        <CountPill icon={Activity} count={monitorCount} label="Monitors" accent="#38bdf8" />
      </div>

      {/* Right: FL Status */}
      <div className="flex items-center gap-2">
        <BrainCircuit size={12} style={{ color: 'var(--n8n-accent)' }} />
        <span>
          FL: <span style={{ color: flGlobal?.is_training ? 'var(--n8n-accent)' : 'inherit' }}>{flStatus}</span>
        </span>
      </div>
    </footer>
  );
}

// ── Sub-components ──

function StatusPill({
  icon: Icon,
  label,
  color,
}: {
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  label: string;
  color: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Icon size={12} style={{ color }} />
      <span style={{ color }}>{label}</span>
    </div>
  );
}

function CountPill({
  icon: Icon,
  count,
  label,
  accent,
}: {
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
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
