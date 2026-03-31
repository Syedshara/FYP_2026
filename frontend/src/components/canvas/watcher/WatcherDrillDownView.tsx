/**
 * WatcherDrillDownView — Full-screen security audit drill-down.
 *
 * Replaces the main canvas when viewMode === 'watcher-drilldown'.
 * Layout: top bar → 4-tab body (Events | Trust | Certs | Recovery).
 *
 * All data is read from existing stores:
 *   - Events tab:   liveStore.securityEvents (chronological log)
 *   - Trust tab:    liveStore.trustScores / trustScoreHistory / flaggedEvents
 *   - Certs tab:    flApi.certificates() REST call
 *   - Recovery tab: fedRecoveryStore.activeRun + completedRuns
 */

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  ArrowLeft,
  Eye,
  Activity,
  ShieldCheck,
  Lock,
  RefreshCw,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Minus,
  CheckCircle,
  XCircle,
  Clock,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import {
  useSecurityEvents,
  useTrustScores,
  useFlaggedEvents,
  useCurrentDetectionRound,
  useClientEnforcementStatus,
  useLiveStore,
} from '@/stores/liveStore';
import {
  useFedRecoveryStore,
  useFedRecoveryActiveRun,
  useFedRecoveryCompletedRuns,
} from '@/stores/fedRecoveryStore';
import { flApi, type CertificateMetadata } from '@/api/fl';
import type { ClientEnforcementStatus } from '@/types';
import type { SecurityEvent, SecurityEventKind } from '@/stores/liveStore';
import type { FedRecoveryRun } from '@/stores/fedRecoveryStore';

// ── Tab type ──────────────────────────────────────────

type WatcherTab = 'events' | 'trust' | 'certs' | 'recovery';

const TAB_CONFIG: Array<{ id: WatcherTab; label: string; icon: typeof Activity }> = [
  { id: 'events',   label: 'Events',   icon: Activity },
  { id: 'trust',    label: 'Trust',    icon: ShieldCheck },
  { id: 'certs',    label: 'Certs',    icon: Lock },
  { id: 'recovery', label: 'Recovery', icon: RefreshCw },
];

// ── Helpers ───────────────────────────────────────────

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso;
  }
}

function shortClient(id: string): string {
  return id.length > 10 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}

function scoreColor(score: number): string {
  return score >= 0.8
    ? 'var(--n8n-success)'
    : score >= 0.5
      ? 'var(--n8n-warning)'
      : 'var(--n8n-danger)';
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function useNodeLabelMap(): Map<string, string> {
  const nodes = useWorkspaceStore((s) => s.nodes);
  return useMemo(
    () => new Map(nodes.map((n) => [n.id, (n.data as { label?: string }).label ?? n.id])),
    [nodes],
  );
}

// ── Event kind metadata (reused from FLTimelinePanel) ─

interface KindMeta { label: string; colorVar: string }

const KIND_META: Partial<Record<SecurityEventKind, KindMeta>> = {
  round_start:        { label: 'ROUND_START',  colorVar: 'var(--n8n-text-muted)' },
  round_complete:     { label: 'ROUND_OK',     colorVar: 'var(--n8n-success)' },
  nonce_issued:       { label: 'NONCE_ISSUE',  colorVar: 'var(--n8n-text-muted)' },
  nonce_verified:     { label: 'NONCE_OK',     colorVar: 'var(--n8n-success)' },
  signature_verified: { label: 'SIG_OK',       colorVar: 'var(--n8n-success)' },
  signature_failed:   { label: 'SIG_FAIL',     colorVar: 'var(--n8n-danger)' },
  he_encrypt:         { label: 'HE_ENC',       colorVar: '#a78bfa' },
  he_decrypt:         { label: 'HE_DEC',       colorVar: '#a78bfa' },
  he_aggregate:       { label: 'HE_AGG',       colorVar: '#a78bfa' },
  vss_ceremony:       { label: 'VSS_CERE',     colorVar: '#38bdf8' },
  vss_share_dist:     { label: 'VSS_SHARE',    colorVar: '#38bdf8' },
  mtls_handshake:     { label: 'MTLS_OK',      colorVar: 'var(--n8n-success)' },
  recess_detect:      { label: 'RECESS_DET',   colorVar: 'var(--n8n-warning)' },
  recess_flag:        { label: 'RECESS_FLAG',  colorVar: 'var(--n8n-danger)' },
  global_dispatch:    { label: 'DISPATCH',     colorVar: '#60a5fa' },
  client_update:      { label: 'CLIENT_UPD',   colorVar: '#34d399' },
  model_updated:      { label: 'MODEL_UPD',    colorVar: '#fbbf24' },
};

const ALERT_KINDS = new Set<SecurityEventKind>([
  'signature_failed',
  'recess_detect',
  'recess_flag',
]);

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
        {activeTab === 'events' && <EventsTab />}
        {activeTab === 'trust' && <TrustTab />}
        {activeTab === 'certs' && <CertsTab />}
        {activeTab === 'recovery' && <RecoveryTab />}
      </div>
    </>
  );
}

// ════════════════════════════════════════════════════════
// TAB 1: Events — Chronological security event log
// ════════════════════════════════════════════════════════

function EventsTab() {
  const events = useSecurityEvents();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const prevCountRef = useRef(0);

  useEffect(() => {
    if (autoScroll && scrollRef.current && events.length > prevCountRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevCountRef.current = events.length;
  }, [events.length, autoScroll]);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
  };

  const alertCount = events.filter((e) => ALERT_KINDS.has(e.kind)).length;

  return (
    <div className="fl-vis-card" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="fl-vis-card-header">
        <Activity size={13} style={{ color: 'var(--n8n-text-muted)' }} />
        <span className="fl-section-header-title">
          Security Events
          {events.length > 0 && (
            <span style={{ color: 'var(--n8n-text-muted)', fontWeight: 400, marginLeft: 6 }}>
              ({events.length})
            </span>
          )}
        </span>
        {alertCount > 0 && (
          <span className="fl-term-alert-badge">
            {alertCount} ALERT{alertCount !== 1 ? 'S' : ''}
          </span>
        )}
        {!autoScroll && (
          <button
            type="button"
            className="ml-auto"
            style={{
              color: 'var(--n8n-accent)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontFamily: 'var(--n8n-font-mono)',
              fontSize: 10,
              fontWeight: 600,
            }}
            onClick={() => {
              setAutoScroll(true);
              if (scrollRef.current) {
                scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
              }
            }}
          >
            Jump to latest
          </button>
        )}
      </div>

      {events.length === 0 ? (
        <div className="fl-empty-state" style={{ flex: 1 }}>
          <Activity size={24} className="fl-empty-state-icon" />
          <p className="fl-empty-state-text">No security events yet — start FL training</p>
        </div>
      ) : (
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="fl-term-scroll"
          style={{ flex: 1 }}
        >
          {events.map((evt, i) => {
            const prevRound = i > 0 ? events[i - 1].round : null;
            const showSep = prevRound !== null && evt.round !== prevRound;
            return <EventRow key={`${evt.kind}-${evt.round}-${evt.clientId ?? ''}-${i}`} event={evt} showSeparator={showSep} />;
          })}
        </div>
      )}
    </div>
  );
}

function EventRow({ event, showSeparator }: { event: SecurityEvent; showSeparator: boolean }) {
  const meta = KIND_META[event.kind] ?? { label: event.kind.toUpperCase(), colorVar: 'var(--n8n-text-muted)' };
  const isAlert = ALERT_KINDS.has(event.kind);

  return (
    <>
      {showSeparator && <div className="fl-term-separator">R{event.round}</div>}
      <div className={`fl-term-row${isAlert ? ' fl-term-row--alert' : ''}`}>
        <span style={{ width: 14, flexShrink: 0 }} />
        <span className="fl-term-ts">{formatTime(event.timestamp)}</span>
        <span className="fl-term-round">R{event.round}</span>
        <span className="fl-term-kind" style={{ color: meta.colorVar }}>{meta.label}</span>
        <span className="fl-term-client">{event.clientId ? shortClient(event.clientId) : '\u2014'}</span>
        <span className="fl-term-detail">
          {event.detail ?? ''}
          {isAlert && <span className="fl-term-alert-badge">ALERT</span>}
        </span>
      </div>
    </>
  );
}

// ════════════════════════════════════════════════════════
// TAB 2: Trust — Per-client trust score sparklines
// ════════════════════════════════════════════════════════

function TrustTab() {
  const trustScores = useTrustScores();
  const flaggedEvents = useFlaggedEvents();
  const currentRound = useCurrentDetectionRound();
  const clientEnforcement = useClientEnforcementStatus();
  const labelMap = useNodeLabelMap();
  const trustHistory = useLiveStore((s) => s.trustScoreHistory);

  const hasScores = Object.keys(trustScores).length > 0;
  const flaggedCount = flaggedEvents.length;

  return (
    <div className="fl-vis-card" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="fl-vis-card-header">
        <ShieldCheck size={13} style={{ color: 'var(--n8n-text-muted)' }} />
        <span className="fl-section-header-title">
          Trust Scores
          {currentRound != null && (
            <span style={{ color: 'var(--n8n-text-muted)', fontWeight: 400, marginLeft: 6 }}>
              R{currentRound}
            </span>
          )}
        </span>
        {flaggedCount > 0 && (
          <span
            className="text-xs font-semibold px-1.5 py-0.5 rounded"
            style={{ color: 'var(--n8n-danger)', background: 'rgba(208,48,80,0.12)' }}
          >
            {flaggedCount} flagged
          </span>
        )}
      </div>

      {!hasScores ? (
        <div className="fl-empty-state" style={{ flex: 1 }}>
          <ShieldCheck size={24} className="fl-empty-state-icon" />
          <p className="fl-empty-state-text">No detection data — RECESS runs every 5 rounds</p>
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0' }}>
          {Object.entries(trustScores).map(([clientId, score]) => {
            const history = trustHistory[clientId] ?? [];
            const enforcement = clientEnforcement[clientId] ?? enforcementFromScore(score);
            const displayName = labelMap.get(clientId) ?? clientId;
            const color = scoreColor(score);

            // Trend
            let TrendIcon = Minus;
            let trendColor = 'var(--n8n-text-muted)';
            if (history.length >= 2) {
              const prev = history[history.length - 2].score;
              const delta = score - prev;
              if (delta > 0.005) { TrendIcon = TrendingUp; trendColor = 'var(--n8n-success)'; }
              else if (delta < -0.005) { TrendIcon = TrendingDown; trendColor = 'var(--n8n-danger)'; }
            }

            return (
              <div
                key={clientId}
                style={{
                  background: 'var(--n8n-card-bg)',
                  border: '1px solid var(--n8n-card-border)',
                  borderRadius: 8,
                  padding: '10px 14px',
                }}
              >
                {/* Header row */}
                <div className="flex items-center gap-2 mb-2">
                  <span style={{ color: 'var(--n8n-text-primary)', fontSize: 13, fontWeight: 600, flex: 1 }}>
                    {displayName}
                  </span>
                  <TrendIcon size={12} style={{ color: trendColor }} />
                  <span className="font-mono font-semibold" style={{ color, fontSize: 14 }}>
                    {score.toFixed(3)}
                  </span>
                  <EnforcementBadge status={enforcement} />
                </div>

                {/* Sparkline */}
                {history.length >= 2 && (
                  <Sparkline
                    values={history.map((h) => h.score)}
                    width={280}
                    height={32}
                    color={color}
                  />
                )}

                {/* Component breakdown (latest) */}
                {history.length > 0 && history[history.length - 1].components && (
                  <div className="flex items-center gap-3 mt-2" style={{ fontSize: 11, color: 'var(--n8n-text-muted)' }}>
                    <span>Dir: <strong style={{ color: '#38bdf8' }}>{history[history.length - 1].components!.direction_score.toFixed(3)}</strong></span>
                    <span>Mag: <strong style={{ color: '#a78bfa' }}>{history[history.length - 1].components!.magnitude_score.toFixed(3)}</strong></span>
                    <span>Abn: <strong style={{ color: 'var(--n8n-danger)' }}>{history[history.length - 1].components!.abnormality.toFixed(3)}</strong></span>
                  </div>
                )}
              </div>
            );
          })}

          {/* Flagged events summary */}
          {flaggedEvents.length > 0 && (
            <div style={{
              background: 'rgba(208,48,80,0.06)',
              border: '1px solid rgba(208,48,80,0.15)',
              borderRadius: 8,
              padding: '10px 14px',
            }}>
              <div className="flex items-center gap-2 mb-2" style={{ fontSize: 12, fontWeight: 600, color: 'var(--n8n-danger)' }}>
                <AlertTriangle size={13} />
                Flagged Events ({flaggedEvents.length})
              </div>
              <div className="flex flex-col gap-1" style={{ maxHeight: 200, overflowY: 'auto' }}>
                {[...flaggedEvents].reverse().slice(0, 20).map((evt, i) => (
                  <div key={i} className="flex items-center gap-3" style={{ fontSize: 11 }}>
                    <span className="font-mono font-semibold" style={{ color: 'var(--n8n-danger)' }}>
                      {evt.abnormality.toFixed(3)}
                    </span>
                    <span style={{ color: 'var(--n8n-text-muted)' }}>
                      {labelMap.get(evt.clientId) ?? shortClient(evt.clientId)} — R{evt.round}
                    </span>
                    <span style={{ color: 'var(--n8n-text-muted)', marginLeft: 'auto' }}>
                      {relativeTime(evt.timestamp)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function enforcementFromScore(score: number): ClientEnforcementStatus {
  if (score >= 0.5) return 'included';
  if (score >= 0.3) return 'downweighted';
  return 'excluded';
}

const ENFORCEMENT_META: Record<ClientEnforcementStatus, { label: string; modifier: string }> = {
  included:     { label: 'Included',     modifier: 'fl-enforcement-badge--included' },
  downweighted: { label: 'Downweighted', modifier: 'fl-enforcement-badge--downweighted' },
  excluded:     { label: 'Excluded',     modifier: 'fl-enforcement-badge--excluded' },
};

function EnforcementBadge({ status }: { status: ClientEnforcementStatus }) {
  const { label, modifier } = ENFORCEMENT_META[status];
  return <span className={`fl-enforcement-badge ${modifier}`}>{label}</span>;
}

/** Inline SVG sparkline for trust score history */
function Sparkline({ values, width, height, color }: { values: number[]; width: number; height: number; color: string }) {
  if (values.length < 2) return null;
  const pad = 2;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const n = values.length;
  const pts = values.map((v, i) => {
    const x = pad + (i / (n - 1)) * w;
    const y = pad + h - (Math.min(Math.max(v, 0), 1)) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p}`).join(' ');

  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      {/* 0.3 and 0.5 threshold lines */}
      <line x1={pad} x2={width - pad} y1={pad + h - 0.3 * h} y2={pad + h - 0.3 * h}
        stroke="var(--n8n-danger)" strokeWidth={0.5} strokeDasharray="3,2" opacity={0.4} />
      <line x1={pad} x2={width - pad} y1={pad + h - 0.5 * h} y2={pad + h - 0.5 * h}
        stroke="var(--n8n-warning)" strokeWidth={0.5} strokeDasharray="3,2" opacity={0.4} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={parseFloat(pts[n - 1].split(',')[0])} cy={parseFloat(pts[n - 1].split(',')[1])} r={2.5} fill={color} />
    </svg>
  );
}

// ════════════════════════════════════════════════════════
// TAB 3: Certs — mTLS certificate validity cards
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

  const now = Date.now();

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

// ════════════════════════════════════════════════════════
// TAB 4: Recovery — FedRecovery run history + active run
// ════════════════════════════════════════════════════════

function RecoveryTab() {
  const activeRun = useFedRecoveryActiveRun();
  const completedRuns = useFedRecoveryCompletedRuns();
  const labelMap = useNodeLabelMap();

  const allRuns = useMemo(() => {
    const runs: FedRecoveryRun[] = [];
    if (activeRun) runs.push(activeRun);
    runs.push(...completedRuns);
    return runs;
  }, [activeRun, completedRuns]);

  return (
    <div className="fl-vis-card" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="fl-vis-card-header">
        <RefreshCw size={13} style={{ color: 'var(--n8n-text-muted)' }} />
        <span className="fl-section-header-title">
          FedRecovery
          {allRuns.length > 0 && (
            <span style={{ color: 'var(--n8n-text-muted)', fontWeight: 400, marginLeft: 6 }}>
              ({allRuns.length} run{allRuns.length !== 1 ? 's' : ''})
            </span>
          )}
        </span>
        {activeRun && (
          <span
            className="text-xs font-semibold px-1.5 py-0.5 rounded"
            style={{ color: '#fb923c', background: 'rgba(251,146,60,0.12)' }}
          >
            Running
          </span>
        )}
      </div>

      {allRuns.length === 0 ? (
        <div className="fl-empty-state" style={{ flex: 1 }}>
          <RefreshCw size={24} className="fl-empty-state-icon" />
          <p className="fl-empty-state-text">No recovery runs yet — triggers when RECESS flags a client</p>
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, padding: '8px 0' }}>
          {allRuns.map((run) => (
            <RecoveryRunCard key={run.runId} run={run} labelMap={labelMap} />
          ))}
        </div>
      )}
    </div>
  );
}

function RecoveryRunCard({ run, labelMap }: { run: FedRecoveryRun; labelMap: Map<string, string> }) {
  const [expanded, setExpanded] = useState(run.status === 'running');
  const isActive = run.status === 'running';
  const clientName = labelMap.get(run.flaggedClientId) ?? shortClient(run.flaggedClientId);

  const statusColor = isActive ? '#fb923c'
    : run.status === 'complete' ? 'var(--n8n-success)'
    : run.status === 'partial' ? 'var(--n8n-warning)'
    : 'var(--n8n-danger)';

  const StatusIcon = isActive ? Clock
    : run.status === 'complete' ? CheckCircle
    : run.status === 'partial' ? AlertTriangle
    : XCircle;

  return (
    <div
      style={{
        background: 'var(--n8n-card-bg)',
        border: `1px solid ${isActive ? 'rgba(251,146,60,0.3)' : 'var(--n8n-card-border)'}`,
        borderRadius: 8,
        padding: '10px 14px',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2"
        style={{ cursor: 'pointer' }}
        onClick={() => setExpanded((v) => !v)}
        role="button"
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown size={12} style={{ color: 'var(--n8n-text-muted)' }} /> : <ChevronRight size={12} style={{ color: 'var(--n8n-text-muted)' }} />}
        <StatusIcon size={14} style={{ color: statusColor }} />
        <span style={{ color: 'var(--n8n-text-primary)', fontSize: 13, fontWeight: 600, flex: 1 }}>
          {clientName}
          <span style={{ color: 'var(--n8n-text-muted)', fontWeight: 400, marginLeft: 6, fontSize: 11 }}>
            R{run.flagRound}
          </span>
        </span>
        <span
          className="text-xs font-semibold px-1.5 py-0.5 rounded"
          style={{ color: statusColor, background: `${statusColor}1a` }}
        >
          {run.status}
        </span>
        <span style={{ color: 'var(--n8n-text-muted)', fontSize: 10 }}>
          {relativeTime(run.startedAt)}
        </span>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* Stats row */}
          <div className="flex items-center gap-4" style={{ fontSize: 11, color: 'var(--n8n-text-muted)' }}>
            <span>Corrected: <strong style={{ color: 'var(--n8n-success)' }}>{run.roundsCorrected}</strong></span>
            <span>Skipped: <strong>{run.roundsSkipped}</strong></span>
            {run.epsilon != null && <span>Epsilon: <strong className="font-mono">{run.epsilon.toFixed(4)}</strong></span>}
            {run.sigma != null && <span>Sigma: <strong className="font-mono">{run.sigma.toFixed(4)}</strong></span>}
          </div>

          {/* Accuracy before/after */}
          {run.accuracyBefore != null && run.accuracyAfter != null && (
            <div className="flex items-center gap-4" style={{ fontSize: 11, color: 'var(--n8n-text-muted)' }}>
              <span>Acc before: <strong className="font-mono">{(run.accuracyBefore * 100).toFixed(1)}%</strong></span>
              <span>Acc after: <strong className="font-mono" style={{ color: 'var(--n8n-success)' }}>{(run.accuracyAfter * 100).toFixed(1)}%</strong></span>
              {run.lossBefore != null && run.lossAfter != null && (
                <>
                  <span>Loss: <strong className="font-mono">{run.lossBefore.toFixed(4)}</strong> → <strong className="font-mono" style={{ color: 'var(--n8n-success)' }}>{run.lossAfter.toFixed(4)}</strong></span>
                </>
              )}
            </div>
          )}

          {/* Step timeline */}
          {run.steps.length > 0 && (
            <div style={{ maxHeight: 200, overflowY: 'auto' }}>
              <div className="flex flex-col gap-1">
                {run.steps.map((step, i) => (
                  <div key={i} className="flex items-center gap-2" style={{ fontSize: 10 }}>
                    <span
                      className="font-mono"
                      style={{
                        color: step.step === 'corrected' ? 'var(--n8n-success)' : 'var(--n8n-text-muted)',
                        width: 70,
                        flexShrink: 0,
                      }}
                    >
                      R{step.round} {step.step}
                    </span>
                    <span style={{ color: 'var(--n8n-text-muted)' }}>{step.detail ?? ''}</span>
                    <span style={{ color: 'var(--n8n-text-muted)', marginLeft: 'auto' }}>
                      {formatTime(step.timestamp)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
