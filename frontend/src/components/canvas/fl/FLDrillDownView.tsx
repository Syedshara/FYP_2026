/**
 * FLDrillDownView — Full-screen FL training drill-down sub-view.
 *
 * Replaces the main canvas when viewMode === 'fl-drilldown'.
 * Layout: top bar → 3-column (left controls/clients | center chart+log | right security).
 *
 * Fetches FL clients + status on mount, then relies on WebSocket for live updates.
 * Only shows clients whose canvas_node_id is connected to this FL Server via fl-communication edges.
 */

import { useEffect, useState, useCallback, useMemo } from 'react';
import { ArrowLeft, Server, Loader2, Activity } from 'lucide-react';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useLiveStore } from '@/stores/liveStore';
import { flApi } from '@/api/fl';
import type { FLClient } from '@/types';
import type { FLServerNodeData } from '@/types/canvas';
import FLTrainingControls from './FLTrainingControls';
import FLClientProgressList from './FLClientProgressList';
import FLSecurityPanel from './FLSecurityPanel';
import FLAccuracyChart from './FLAccuracyChart';
import FLRoundLog from './FLRoundLog';

export default function FLDrillDownView() {
  const setViewMode = useWorkspaceStore((s) => s.setViewMode);
  const setDrilldownServerId = useWorkspaceStore((s) => s.setDrilldownServerId);
  const drilldownServerId = useWorkspaceStore((s) => s.drilldownServerId);
  const nodes = useWorkspaceStore((s) => s.nodes);
  const edges = useWorkspaceStore((s) => s.edges);
  const flGlobal = useLiveStore((s) => s.flGlobalProgress);

  const [allClients, setAllClients] = useState<FLClient[]>([]);
  const [loading, setLoading] = useState(true);

  // Find the FL Server node data
  const serverNode = nodes.find((n) => n.id === drilldownServerId);
  const serverData = serverNode?.data as FLServerNodeData | undefined;
  const serverLabel = serverData?.label ?? 'FL Server';

  // Compute canvas node IDs of Clients connected to this FL Server
  const connectedClientNodeIds = useMemo(() => {
    if (!drilldownServerId) return new Set<string>();
    return new Set(
      edges
        .filter((e) => e.source === drilldownServerId && e.type === 'fl-communication')
        .map((e) => e.target),
    );
  }, [drilldownServerId, edges]);

  // Filter fetched clients to only those connected to this server
  const clients = useMemo(() => {
    if (connectedClientNodeIds.size === 0) return [];
    return allClients.filter(
      (c) => c.canvas_node_id !== null && connectedClientNodeIds.has(c.canvas_node_id),
    );
  }, [allClients, connectedClientNodeIds]);

  // Fetch FL clients on mount
  useEffect(() => {
    flApi.clients()
      .then(setAllClients)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Also refresh client list when training starts/stops or round changes
  useEffect(() => {
    flApi.clients().then(setAllClients).catch(() => {});
  }, [flGlobal?.is_training, flGlobal?.current_round]);

  const handleBack = useCallback(() => {
    setViewMode('canvas');
    setDrilldownServerId(null);
    // Clear stale FL progress so a new drilldown starts fresh
    useLiveStore.getState().clearFLProgress();
  }, [setViewMode, setDrilldownServerId]);

  // Keyboard: Escape to go back
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleBack();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleBack]);

  const isTraining = flGlobal?.is_training ?? false;

  return (
    <div
      className="flex flex-col w-full h-full overflow-hidden"
      style={{ background: 'var(--n8n-canvas-bg)' }}
    >
      {/* ── Top Bar ── */}
      <header
        className="flex items-center justify-between shrink-0 select-none"
        style={{
          background: 'var(--n8n-topbar-bg)',
          borderBottom: '1px solid var(--n8n-card-border)',
          padding: '0 16px',
          height: 52,
          minHeight: 52,
        }}
      >
        {/* Left: Back button + breadcrumb */}
        <div className="flex items-center gap-3">
          <button type="button" onClick={handleBack} className="fl-back-btn">
            <ArrowLeft size={14} />
            <span>Back to Canvas</span>
          </button>

          <div style={{ width: 1, height: 20, background: 'var(--n8n-card-border)', flexShrink: 0 }} />

          <div className="flex items-center gap-2.5">
            <div
              className="flex items-center justify-center rounded-lg"
              style={{ width: 28, height: 28, background: 'rgba(255, 109, 90, 0.12)', flexShrink: 0 }}
            >
              <Server size={13} style={{ color: 'var(--n8n-accent)' }} />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold" style={{ color: 'var(--n8n-text-primary)' }}>
                {serverLabel}
              </span>
              <span style={{ width: 1, height: 14, background: 'var(--n8n-card-border)' }} />
              <span className="text-xs" style={{ color: 'var(--n8n-text-muted)' }}>
                FL Training View
              </span>
            </div>
          </div>
        </div>

        {/* Right: Training status badge */}
        <div className="flex items-center gap-3">
          <div
            className={`fl-status-badge fl-status-badge--lg ${isTraining ? 'fl-status-badge--training' : 'fl-status-badge--idle'}`}
          >
            <span
              className="fl-status-dot"
              style={{
                background: isTraining ? 'var(--n8n-accent)' : 'var(--n8n-text-muted)',
                animation: isTraining ? 'pulse-dot 2s ease-in-out infinite' : 'none',
              }}
            />
            {isTraining
              ? `Training — Round ${flGlobal?.current_round ?? 0}/${flGlobal?.total_rounds ?? 0}`
              : 'Idle'}
          </div>

          {isTraining && flGlobal?.global_accuracy != null && (
            <span
              className="text-xs font-mono font-bold"
              style={{ color: 'var(--n8n-success)' }}
            >
              {(flGlobal.global_accuracy * 100).toFixed(1)}%
            </span>
          )}
        </div>
      </header>

      {/* ── Main 3-Column Layout ── */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 size={24} className="animate-spin" style={{ color: 'var(--n8n-accent)' }} />
        </div>
      ) : (
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* LEFT PANEL: Controls + Client List */}
          <aside
            className="shrink-0 flex flex-col gap-4 overflow-y-auto"
            style={{
              width: 296,
              background: 'var(--n8n-card-bg)',
              borderRight: '1px solid var(--n8n-card-border)',
              padding: '16px 14px',
            }}
          >
            <FLTrainingControls />
            <FLClientProgressList clients={clients} />
          </aside>

          {/* CENTER: Chart + Round Log */}
          <main
            className="flex-1 flex flex-col gap-5 overflow-y-auto min-w-0"
            style={{ padding: '16px 20px' }}
          >
            {/* Radial visualization */}
            <FLRadialVisualization
              clients={clients}
              serverLabel={serverLabel}
              isTraining={isTraining}
            />
            <FLAccuracyChart />
            <FLRoundLog />
          </main>

          {/* RIGHT PANEL: Security */}
          <aside
            className="shrink-0 flex flex-col overflow-y-auto"
            style={{
              width: 272,
              background: 'var(--n8n-card-bg)',
              borderLeft: '1px solid var(--n8n-card-border)',
              padding: '16px 14px',
              gap: 4,
            }}
          >
            <FLSecurityPanel securityFeatures={serverData?.securityFeatures} />
          </aside>
        </div>
      )}

      {/* ── Bottom Status Bar ── */}
      <footer
        className="flex items-center justify-between px-4 h-[32px] border-t shrink-0 text-[10px]"
        style={{
          background: 'var(--n8n-topbar-bg)',
          borderColor: 'var(--n8n-card-border)',
          color: 'var(--n8n-text-muted)',
        }}
      >
        <span>{clients.length} clients registered</span>
        <span>
          {isTraining ? 'Training in progress' : 'Ready'} •{' '}
          {flGlobal?.total_rounds ?? 0} rounds configured
        </span>
        <span>Press Esc to return</span>
      </footer>
    </div>
  );
}

// ── Radial FL Visualization ──
// Shows FL Server in center with client nodes around it, animated connections during training.

function FLRadialVisualization({
  clients,
  serverLabel,
  isTraining,
}: {
  clients: FLClient[];
  serverLabel: string;
  isTraining: boolean;
}) {
  const progressMap = useLiveStore((s) => s.flClientProgress);

  if (clients.length === 0) {
    return (
      <div className="fl-vis-card">
        <div className="fl-vis-card-header">
          <Activity size={13} style={{ color: 'var(--n8n-text-muted)' }} />
          <span className="fl-section-header-title">Topology</span>
        </div>
        <div className="fl-empty-state" style={{ minHeight: 160 }}>
          <Activity size={24} className="fl-empty-state-icon" />
          <p className="fl-empty-state-text">No clients — add FL clients to begin</p>
        </div>
      </div>
    );
  }

  const cx = 250;
  const cy = 120;
  const radius = 85;
  const viewWidth = 500;
  const viewHeight = 240;

  return (
    <div className="fl-vis-card">
      <div className="fl-vis-card-header">
        <Activity size={13} style={{ color: 'var(--n8n-text-muted)' }} />
        <span className="fl-section-header-title">Topology</span>
        {isTraining && (
          <span className="fl-status-badge fl-status-badge--training" style={{ marginLeft: 'auto' }}>
            <span
              className="fl-status-dot"
              style={{ background: 'var(--n8n-accent)', animation: 'pulse-dot 2s ease-in-out infinite' }}
            />
            Live
          </span>
        )}
      </div>
      <svg viewBox={`0 0 ${viewWidth} ${viewHeight}`} className="w-full h-auto" style={{ maxHeight: 240, display: 'block' }}>
        <defs>
          {/* Animated dash for active connections */}
          <linearGradient id="fl-conn-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#ff6d5a" stopOpacity="0.2" />
            <stop offset="50%" stopColor="#ff6d5a" stopOpacity="1" />
            <stop offset="100%" stopColor="#ff6d5a" stopOpacity="0.2" />
          </linearGradient>
        </defs>

        {/* Connection lines */}
        {clients.map((client, i) => {
          const angle = (2 * Math.PI * i) / clients.length - Math.PI / 2;
          const x = cx + radius * Math.cos(angle);
          const y = cy + radius * Math.sin(angle);
          const clientProgress = progressMap[client.client_id];
          const isActive = clientProgress?.status === 'training' || clientProgress?.status === 'encrypting' || clientProgress?.status === 'sending';

          return (
            <line
              key={`line-${client.id}`}
              x1={cx}
              y1={cy}
              x2={x}
              y2={y}
              stroke={isActive ? '#ff6d5a' : '#3c3c3c'}
              strokeWidth={isActive ? 2 : 1}
              strokeDasharray={isActive ? '6 4' : isTraining ? '4 6' : 'none'}
              strokeOpacity={isActive ? 1 : 0.4}
            >
              {isActive && (
                <animate
                  attributeName="stroke-dashoffset"
                  from="20"
                  to="0"
                  dur="1s"
                  repeatCount="indefinite"
                />
              )}
            </line>
          );
        })}

        {/* Server node (center) */}
        <g>
          <rect
            x={cx - 40}
            y={cy - 20}
            width={80}
            height={40}
            rx={8}
            fill="#2b2b2b"
            stroke={isTraining ? '#ff6d5a' : '#3c3c3c'}
            strokeWidth={isTraining ? 2 : 1}
          />
          {isTraining && (
            <rect
              x={cx - 40}
              y={cy - 20}
              width={80}
              height={40}
              rx={8}
              fill="none"
              stroke="#ff6d5a"
              strokeWidth={2}
              strokeOpacity={0.3}
            >
              <animate
                attributeName="stroke-opacity"
                values="0.3;0.8;0.3"
                dur="2s"
                repeatCount="indefinite"
              />
            </rect>
          )}
          <text
            x={cx}
            y={cy + 1}
            textAnchor="middle"
            dominantBaseline="middle"
            fill="#ececec"
            fontSize="11"
            fontFamily="JetBrains Mono, monospace"
            fontWeight="600"
          >
            {serverLabel.length > 10 ? serverLabel.slice(0, 10) + '…' : serverLabel}
          </text>
        </g>

        {/* Client nodes (radial) */}
        {clients.map((client, i) => {
          const angle = (2 * Math.PI * i) / clients.length - Math.PI / 2;
          const x = cx + radius * Math.cos(angle);
          const y = cy + radius * Math.sin(angle);
          const clientProgress = progressMap[client.client_id];
          const status = clientProgress?.status ?? 'idle';
          const statusColors: Record<string, string> = {
            training: '#ff6d5a',
            encrypting: '#a78bfa',
            sending: '#38bdf8',
            done: '#18a058',
            idle: '#888888',
            waiting: '#f0a020',
            sending_weights: '#38bdf8',
          };
          const color = statusColors[status] ?? '#888888';

          return (
            <g key={`client-${client.id}`}>
              <circle
                cx={x}
                cy={y}
                r={22}
                fill="#2b2b2b"
                stroke={color}
                strokeWidth={status !== 'idle' ? 2 : 1}
              />
              {/* Progress arc */}
              {clientProgress?.progress_pct != null && clientProgress.progress_pct > 0 && (
                <circle
                  cx={x}
                  cy={y}
                  r={22}
                  fill="none"
                  stroke={color}
                  strokeWidth={3}
                  strokeDasharray={`${(clientProgress.progress_pct / 100) * 138.2} 138.2`}
                  strokeLinecap="round"
                  transform={`rotate(-90 ${x} ${y})`}
                  opacity={0.6}
                />
              )}
              <text
                x={x}
                y={y - 4}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="#ececec"
                fontSize="9"
                fontFamily="JetBrains Mono, monospace"
                fontWeight="600"
              >
                {client.name.length > 8 ? client.name.slice(0, 8) + '…' : client.name}
              </text>
              <text
                x={x}
                y={y + 9}
                textAnchor="middle"
                dominantBaseline="middle"
                fill={color}
                fontSize="8"
                fontFamily="JetBrains Mono, monospace"
                fontWeight="500"
              >
                {status}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
