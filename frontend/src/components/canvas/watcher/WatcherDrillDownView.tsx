/**
 * WatcherDrillDownView — Full-screen security audit drill-down.
 *
 * Replaces the main canvas when viewMode === 'watcher-drilldown'.
 * Layout: top bar → 4-tab body (Events | Trust | Certs | Recovery).
 *
 * - Events tab:   EventsPipelineTab  (AWS Step Functions-style pipeline per round)
 * - Trust tab:    TrustPipelineTab   (RECESS detection pipeline per detection round)
 * - Certs tab:    CertsTab           (mTLS certificate validity cards — unchanged)
 * - Recovery tab: RecoveryPipelineTab (FedRecovery correction pipeline)
 */

import { useEffect, useState, useCallback } from 'react';
import {
  ArrowLeft,
  Eye,
  Activity,
  ShieldCheck,
  Lock,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  XCircle,
} from 'lucide-react';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useLiveStore } from '@/stores/liveStore';
import { flApi, type CertificateMetadata } from '@/api/fl';
import EventsPipelineTab from './EventsPipelineTab';
import TrustPipelineTab from './TrustPipelineTab';
import RecoveryPipelineTab from './RecoveryPipelineTab';

// ── Tab type ──────────────────────────────────────────

type WatcherTab = 'events' | 'trust' | 'certs' | 'recovery';

const TAB_CONFIG: Array<{ id: WatcherTab; label: string; icon: typeof Activity }> = [
  { id: 'events',   label: 'Events',   icon: Activity },
  { id: 'trust',    label: 'Trust',    icon: ShieldCheck },
  { id: 'certs',    label: 'Certs',    icon: Lock },
  { id: 'recovery', label: 'Recovery', icon: RefreshCw },
];

// ── Main Component ────────────────────────────────────

export default function WatcherDrillDownView() {
  const setViewMode = useWorkspaceStore((s) => s.setViewMode);
  const setDrilldownWatcherId = useWorkspaceStore((s) => s.setDrilldownWatcherId);
  const drilldownWatcherId = useWorkspaceStore((s) => s.drilldownWatcherId);
  const nodes = useWorkspaceStore((s) => s.nodes);

  const [activeTab, setActiveTab] = useState<WatcherTab>('events');

  // Find watcher node
  const watcherNode = nodes.find((n) => n.id === drilldownWatcherId);
  const watcherLabel = (watcherNode?.data as { label?: string })?.label ?? 'Watcher';

  // Navigation
  const handleBack = useCallback(() => {
    setViewMode('canvas');
    setDrilldownWatcherId(null);
  }, [setViewMode, setDrilldownWatcherId]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleBack();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleBack]);

  // Hydrate trust state on mount
  useEffect(() => {
    Promise.all([
      flApi.trustScores().catch(() => ({} as Record<string, number>)),
      flApi.detectionRounds().catch(() => []),
      flApi.flaggedClients().catch(() => []),
    ]).then(([scores, rounds, flagged]) => {
      useLiveStore.getState().hydrateTrustState(scores, rounds, flagged);
    });
  }, []);

  // Hydrate security event history on mount so Events pipeline tab is
  // populated even if the user opens Watcher after training has started.
  useEffect(() => {
    flApi.securityEvents().catch(() => []).then((events) => {
      if (events.length > 0) {
        useLiveStore.getState().hydrateSecurityEvents(events);
      }
    });
  }, []);

  // Hydrate FL round results on mount so Client Training metrics survive
  // page refreshes and late Watcher opens (gradient_stats, client_metrics).
  useEffect(() => {
    flApi.roundResults().catch(() => []).then((rounds) => {
      if (rounds.length > 0) {
        useLiveStore.getState().hydrateFlRoundResults(rounds);
      }
    });
  }, []);

  return (
    <>
      {/* ── Top bar ── */}
      <div className="fl-drilldown-topbar">
        <button className="fl-drilldown-back" onClick={handleBack} aria-label="Back to canvas">
          <ArrowLeft size={16} />
        </button>
        <Eye size={16} style={{ color: '#38bdf8' }} />
        <span className="fl-drilldown-title">{watcherLabel}</span>
        <span className="fl-drilldown-badge">Security Audit</span>

        {/* Tabs */}
        <div className="flex items-center gap-1 ml-6">
          {TAB_CONFIG.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors"
                style={{
                  background: isActive ? 'rgba(56, 189, 248, 0.12)' : 'transparent',
                  color: isActive ? '#38bdf8' : 'var(--n8n-text-muted)',
                  border: isActive ? '1px solid rgba(56, 189, 248, 0.25)' : '1px solid transparent',
                  fontSize: 12,
                  fontWeight: isActive ? 600 : 400,
                  cursor: 'pointer',
                }}
              >
                <Icon size={12} />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Tab content ── */}
      <div className="flex-1 min-h-0 overflow-hidden" style={{ padding: '16px 20px' }}>
        {activeTab === 'events'   && <EventsPipelineTab />}
        {activeTab === 'trust'    && <TrustPipelineTab />}
        {activeTab === 'certs'    && <CertsTab />}
        {activeTab === 'recovery' && <RecoveryPipelineTab />}
      </div>
    </>
  );
}

// ════════════════════════════════════════════════════════
// TAB 3: Certs — mTLS certificate validity cards
// (Unchanged from original implementation)
// ════════════════════════════════════════════════════════

function CertsTab() {
  const [certs, setCerts] = useState<CertificateMetadata[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    flApi.certificates()
      .then(setCerts)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Capture current timestamp once at mount — avoids impure Date.now() during render.
  // useState lazy initializer is the idiomatic React pattern for one-time values.
  const [now] = useState<number>(() => Date.now());

  return (
    <div className="fl-vis-card" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="fl-vis-card-header">
        <Lock size={13} style={{ color: 'var(--n8n-text-muted)' }} />
        <span className="fl-section-header-title">
          mTLS Certificates
          {certs.length > 0 && (
            <span style={{ color: 'var(--n8n-text-muted)', fontWeight: 400, marginLeft: 6 }}>
              ({certs.length})
            </span>
          )}
        </span>
      </div>

      {loading ? (
        <div className="fl-empty-state" style={{ flex: 1 }}>
          <RefreshCw size={24} className="fl-empty-state-icon" style={{ animation: 'spin 1s linear infinite' }} />
          <p className="fl-empty-state-text">Loading certificates...</p>
        </div>
      ) : certs.length === 0 ? (
        <div className="fl-empty-state" style={{ flex: 1 }}>
          <Lock size={24} className="fl-empty-state-icon" />
          <p className="fl-empty-state-text">No certificates found — run setup.sh to generate</p>
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 10, padding: '8px 0', alignContent: 'start' }}>
          {certs.map((cert) => {
            const expiry = new Date(cert.notAfter).getTime();
            const daysLeft = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
            const isExpired = daysLeft <= 0;
            const isExpiringSoon = !isExpired && daysLeft <= 30;
            const statusColor = isExpired ? 'var(--n8n-danger)' : isExpiringSoon ? 'var(--n8n-warning)' : 'var(--n8n-success)';
            const StatusIcon = isExpired ? XCircle : isExpiringSoon ? AlertTriangle : CheckCircle;

            return (
              <div
                key={cert.clientId}
                style={{
                  background: 'var(--n8n-card-bg)',
                  border: `1px solid ${isExpired ? 'rgba(208,48,80,0.3)' : 'var(--n8n-card-border)'}`,
                  borderRadius: 8,
                  padding: '12px 14px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                {/* Header */}
                <div className="flex items-center gap-2">
                  <StatusIcon size={14} style={{ color: statusColor, flexShrink: 0 }} />
                  <span style={{ color: 'var(--n8n-text-primary)', fontSize: 13, fontWeight: 600, flex: 1 }}>
                    {cert.displayName}
                  </span>
                  <span
                    className="text-xs px-1.5 py-0.5 rounded"
                    style={{
                      color: statusColor,
                      background: isExpired ? 'rgba(208,48,80,0.12)' : isExpiringSoon ? 'rgba(240,160,32,0.12)' : 'rgba(24,160,88,0.12)',
                      fontWeight: 600,
                    }}
                  >
                    {isExpired ? 'Expired' : isExpiringSoon ? `${daysLeft}d left` : 'Valid'}
                  </span>
                </div>

                {/* Details */}
                <div className="flex flex-col gap-1" style={{ fontSize: 11, color: 'var(--n8n-text-muted)' }}>
                  <div className="flex items-center gap-2">
                    <span style={{ width: 60, flexShrink: 0, color: 'var(--n8n-text-muted)' }}>Role</span>
                    <span style={{ color: 'var(--n8n-text-primary)' }}>{cert.role}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span style={{ width: 60, flexShrink: 0 }}>Issuer</span>
                    <span className="font-mono" style={{ fontSize: 10 }}>{cert.issuer}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span style={{ width: 60, flexShrink: 0 }}>Valid</span>
                    <span className="font-mono" style={{ fontSize: 10 }}>
                      {new Date(cert.notBefore).toLocaleDateString()} — {new Date(cert.notAfter).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span style={{ width: 60, flexShrink: 0 }}>SHA-256</span>
                    <span className="font-mono" style={{ fontSize: 9, wordBreak: 'break-all' }}>
                      {cert.fingerprint}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
