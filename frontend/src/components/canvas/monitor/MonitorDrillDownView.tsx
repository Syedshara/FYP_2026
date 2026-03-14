/**
 * MonitorDrillDownView — Full-screen Monitor analytics drill-down.
 *
 * Replaces the main canvas when viewMode === 'monitor-drilldown'.
 * Layout: top bar → 3-column (left summary | center charts+stream | right breakdown+latency).
 *
 * Reads per-device prediction history from liveStore via the deviceId
 * stored on the Monitor node's data.
 */

import { useEffect, useCallback, useMemo } from 'react';
import { ArrowLeft, Activity, ShieldAlert, Zap, Target, Server } from 'lucide-react';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useDevicePredictions, useLiveStore } from '@/stores/liveStore';
import type { MonitorNodeData } from '@/types/canvas';
import MonitorAttackChart from './MonitorAttackChart';
import MonitorConfidenceChart from './MonitorConfidenceChart';
import MonitorAttackBreakdown from './MonitorAttackBreakdown';
import MonitorLatencyChart from './MonitorLatencyChart';
import MonitorPredictionStream from './MonitorPredictionStream';

export default function MonitorDrillDownView() {
  const setViewMode = useWorkspaceStore((s) => s.setViewMode);
  const setDrilldownMonitorId = useWorkspaceStore((s) => s.setDrilldownMonitorId);
  const drilldownMonitorId = useWorkspaceStore((s) => s.drilldownMonitorId);
  const nodes = useWorkspaceStore((s) => s.nodes);

  // Find the Monitor node
  const monitorNode = nodes.find((n) => n.id === drilldownMonitorId);
  const monitorData = monitorNode?.data as MonitorNodeData | undefined;
  const deviceId = monitorData?.deviceId;
  const deviceLabel = monitorData?.deviceLabel ?? 'Unknown Device';
  const monitorLabel = monitorData?.label ?? 'Monitor';

  // Get per-device prediction history
  const predictions = useDevicePredictions(deviceId);

  // Get live device status
  const deviceStatus = useLiveStore((s) =>
    deviceId ? s.deviceStatuses[deviceId] : undefined,
  );

  // ── Computed summary stats ──
  const stats = useMemo(() => {
    if (predictions.length === 0) {
      return { attackRate: 0, avgLatency: 0, avgConfidence: 0, totalAttacks: 0 };
    }
    const attacks = predictions.filter((p) => p.label === 'attack');
    const attackRate = Math.round((attacks.length / predictions.length) * 100);
    const latencies = predictions
      .map((p) => p.inference_latency_ms)
      .filter((v): v is number => v != null);
    const avgLatency =
      latencies.length > 0
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : 0;
    const avgConfidence = Math.round(
      (predictions.reduce((sum, p) => sum + p.confidence, 0) / predictions.length) * 100,
    );
    return { attackRate, avgLatency, avgConfidence, totalAttacks: attacks.length };
  }, [predictions]);

  // ── Navigation ──
  const handleBack = useCallback(() => {
    setViewMode('canvas');
    setDrilldownMonitorId(null);
  }, [setViewMode, setDrilldownMonitorId]);

  // Escape key to go back
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleBack();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleBack]);

  const statusLabel = deviceStatus?.status ?? 'unknown';
  const isOnline = statusLabel === 'online' || statusLabel === 'under_attack';

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
        {/* Left: Back + breadcrumb */}
        <div className="flex items-center gap-3">
          <button type="button" onClick={handleBack} className="fl-back-btn">
            <ArrowLeft size={14} />
            <span>Back to Canvas</span>
          </button>

          <div
            style={{
              width: 1,
              height: 20,
              background: 'var(--n8n-card-border)',
              flexShrink: 0,
            }}
          />

          <div className="flex items-center gap-2.5">
            <div
              className="flex items-center justify-center rounded-lg"
              style={{
                width: 28,
                height: 28,
                background: 'rgba(56, 189, 248, 0.12)',
                flexShrink: 0,
              }}
            >
              <Activity size={13} style={{ color: '#38bdf8' }} />
            </div>
            <div className="flex items-center gap-2">
              <span
                className="text-sm font-semibold"
                style={{ color: 'var(--n8n-text-primary)' }}
              >
                {monitorLabel}
              </span>
              <span
                style={{
                  width: 1,
                  height: 14,
                  background: 'var(--n8n-card-border)',
                }}
              />
              <span className="text-xs" style={{ color: '#38bdf8' }}>
                {deviceLabel}
              </span>
            </div>
          </div>
        </div>

        {/* Right: Status badge + attack rate */}
        <div className="flex items-center gap-3">
          <div
            className={`fl-status-badge fl-status-badge--lg ${isOnline ? 'fl-status-badge--training' : 'fl-status-badge--idle'}`}
          >
            <span
              className="fl-status-dot"
              style={{
                background: isOnline ? '#38bdf8' : 'var(--n8n-text-muted)',
                animation: isOnline ? 'pulse-dot 2s ease-in-out infinite' : 'none',
              }}
            />
            {isOnline
              ? statusLabel === 'under_attack'
                ? 'Under Attack'
                : 'Online'
              : 'Offline'}
          </div>

          {predictions.length > 0 && (
            <span
              className="text-xs font-mono font-bold"
              style={{
                color: stats.attackRate > 50 ? '#d03050' : stats.attackRate > 20 ? '#f0a020' : '#18a058',
              }}
            >
              {stats.attackRate}% ATK
            </span>
          )}
        </div>
      </header>

      {/* ── Main 3-Column Layout ── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* LEFT PANEL: Summary Cards */}
        <aside
          className="shrink-0 flex flex-col gap-3 overflow-y-auto"
          style={{
            width: 240,
            background: 'var(--n8n-card-bg)',
            borderRight: '1px solid var(--n8n-card-border)',
            padding: '14px',
          }}
        >
          {/* Metrics section */}
          <div className="fl-panel-section">
            <div className="fl-section-header">
              <Activity size={13} style={{ color: 'var(--n8n-text-muted)', flexShrink: 0 }} />
              <span className="fl-section-header-title">Metrics</span>
            </div>

            <div className="flex flex-col gap-2">
              {/* Attack Rate */}
              <div className="fl-client-card">
                <div className="flex items-center gap-2">
                  <ShieldAlert size={12} style={{ color: '#d03050', flexShrink: 0 }} />
                  <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--n8n-text-muted)' }}>
                    Attack Rate
                  </span>
                </div>
                <span className="text-xl font-bold font-mono" style={{ color: '#d03050' }}>
                  {stats.attackRate}%
                </span>
                <span className="text-[10px]" style={{ color: 'var(--n8n-text-muted)' }}>
                  {stats.totalAttacks} of {predictions.length} predictions
                </span>
              </div>

              {/* Avg Latency */}
              <div className="fl-client-card">
                <div className="flex items-center gap-2">
                  <Zap size={12} style={{ color: '#f0a020', flexShrink: 0 }} />
                  <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--n8n-text-muted)' }}>
                    Avg Latency
                  </span>
                </div>
                <span className="text-xl font-bold font-mono" style={{ color: '#f0a020' }}>
                  {stats.avgLatency}ms
                </span>
                <span className="text-[10px]" style={{ color: 'var(--n8n-text-muted)' }}>
                  inference time
                </span>
              </div>

              {/* Avg Confidence */}
              <div className="fl-client-card">
                <div className="flex items-center gap-2">
                  <Target size={12} style={{ color: '#18a058', flexShrink: 0 }} />
                  <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--n8n-text-muted)' }}>
                    Avg Confidence
                  </span>
                </div>
                <span className="text-xl font-bold font-mono" style={{ color: '#18a058' }}>
                  {stats.avgConfidence}%
                </span>
                <span className="text-[10px]" style={{ color: 'var(--n8n-text-muted)' }}>
                  model certainty
                </span>
              </div>
            </div>
          </div>

          {/* Device Info section */}
          <div className="fl-panel-section">
            <div className="fl-section-header">
              <Server size={13} style={{ color: 'var(--n8n-text-muted)', flexShrink: 0 }} />
              <span className="fl-section-header-title">Device Info</span>
            </div>

            <div className="fl-client-card">
              <div className="flex flex-col gap-2 text-[11px] font-mono">
                <div className="flex justify-between gap-2">
                  <span style={{ color: 'var(--n8n-text-muted)' }}>Name</span>
                  <span className="truncate text-right" style={{ color: 'var(--n8n-text-primary)' }}>{deviceLabel}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span style={{ color: 'var(--n8n-text-muted)' }}>Status</span>
                  <span style={{ color: isOnline ? '#18a058' : '#888' }}>{statusLabel}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span style={{ color: 'var(--n8n-text-muted)' }}>History</span>
                  <span style={{ color: 'var(--n8n-text-primary)' }}>{predictions.length} preds</span>
                </div>
              </div>
            </div>
          </div>
        </aside>

        {/* CENTER: Charts + Prediction Stream */}
        <main
          className="flex-1 flex flex-col gap-5 overflow-y-auto min-w-0"
          style={{ padding: '16px 20px' }}
        >
          <MonitorAttackChart predictions={predictions} />
          <MonitorConfidenceChart predictions={predictions} />
          <MonitorPredictionStream predictions={predictions} />
        </main>

        {/* RIGHT PANEL: Breakdown + Latency */}
        <aside
          className="shrink-0 flex flex-col gap-4 overflow-y-auto"
          style={{
            width: 272,
            background: 'var(--n8n-card-bg)',
            borderLeft: '1px solid var(--n8n-card-border)',
            padding: '16px 14px',
          }}
        >
          <MonitorAttackBreakdown predictions={predictions} />
          <MonitorLatencyChart predictions={predictions} />
        </aside>
      </div>

      {/* ── Footer ── */}
      <footer
        className="flex items-center justify-between px-4 h-[32px] border-t shrink-0 text-[10px]"
        style={{
          background: 'var(--n8n-topbar-bg)',
          borderColor: 'var(--n8n-card-border)',
          color: 'var(--n8n-text-muted)',
        }}
      >
        <span>{predictions.length} predictions collected</span>
        <span>
          {stats.totalAttacks} attacks ({stats.attackRate}%) • Avg latency{' '}
          {stats.avgLatency}ms
        </span>
        <span>Press Esc to return</span>
      </footer>
    </div>
  );
}

