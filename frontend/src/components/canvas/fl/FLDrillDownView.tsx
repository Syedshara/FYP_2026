/**
 * FLDrillDownView — Full-screen FL training drill-down sub-view.
 *
 * Replaces the main canvas when viewMode === 'fl-drilldown'.
 * Layout: top bar → 2-column (left controls/clients | center chart+log).
 *
 * Security panels (trust, events, certificates) have been moved to
 * WatcherDrillDownView.  Only FL-training-specific state is managed here;
 * security state is owned and cleared by the Watcher drill-down.
 *
 * Fetches FL clients + status on mount, then relies on WebSocket for live updates.
 * Only shows clients whose canvas_node_id is connected to this FL Server via fl-communication edges.
 */

import { useEffect, useState, useCallback, useMemo } from 'react';
import { ArrowLeft, Server, Loader2 } from 'lucide-react';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useLiveStore } from '@/stores/liveStore';
import { flApi } from '@/api/fl';
import type { FLClient } from '@/types';
import type { FLServerNodeData } from '@/types/canvas';
import FLTrainingControls from './FLTrainingControls';
import FLClientProgressList from './FLClientProgressList';
import FLAccuracyChart from './FLAccuracyChart';
import FLRoundLog from './FLRoundLog';
import RecessSequenceDiagram from './RecessSequenceDiagram';
import RecessToastCard from './RecessToastCard';
import FedRecoveryModal from './FedRecoveryModal';

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
    // Clear FL-training-specific state so a new drilldown starts fresh
    useLiveStore.getState().clearFLProgress();
    useLiveStore.getState().clearFLRoundResults();
    useLiveStore.getState().clearFLClientRoundHistory();
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
      {/* Fixed-position RECESS decision toasts — renders above all panels */}
      <RecessToastCard />
      {/* FedRecovery correction pipeline modal — auto-opens on fedrecovery_event started */}
      <FedRecoveryModal />
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

      {/* ── Main 2-Column Layout ── */}
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
            <FLTrainingControls clients={clients} />
            <FLClientProgressList clients={clients} />
          </aside>

          {/* CENTER: Chart + Round Log + RECESS Sequence Diagram */}
          <main
            className="flex-1 flex flex-col gap-5 overflow-y-auto min-w-0"
            style={{ padding: '16px 20px' }}
          >
            <FLAccuracyChart />
            <FLRoundLog />
            <RecessSequenceDiagram />
          </main>
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
        <span className="flex items-center gap-2">
          <span
            className="fl-status-dot"
            style={{
              background: isTraining ? 'var(--n8n-accent)' : 'var(--n8n-success)',
              animation: isTraining ? 'pulse-dot 2s ease-in-out infinite' : 'none',
            }}
          />
          {isTraining ? 'Training' : 'Ready'} •{' '}
          {flGlobal?.total_rounds ?? 0} rounds configured
        </span>
        <span>Press Esc to return</span>
      </footer>
    </div>
  );
}

