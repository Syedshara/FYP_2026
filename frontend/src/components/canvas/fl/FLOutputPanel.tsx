/**
 * FLOutputPanel — Real-time security event timeline + certificate viewer.
 *
 * Tabs:
 *   Timeline     — chronological security events grouped by round
 *   Certificates — mTLS certificate metadata from the shared certs dir
 *
 * Data flows through WebSocket → liveStore → useSecurityEvents() selector.
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import {
  Activity,
  ShieldCheck,
  Lock,
  KeyRound,
  Fingerprint,
  Radio,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  FileKey2,
} from 'lucide-react';
import { useSecurityEvents } from '@/stores/liveStore';
import type { SecurityEvent, SecurityEventKind } from '@/stores/liveStore';
import { flApi } from '@/api/fl';
import type { CertificateMetadata } from '@/api/fl';

// ── Tab definitions ────────────────────────────────────

type Tab = 'timeline' | 'certificates';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'timeline', label: 'Timeline' },
  { key: 'certificates', label: 'Certificates' },
];

// ── Event kind metadata (icon, color token, short label) ──

interface EventMeta {
  icon: typeof Activity;
  colorVar: string;
  label: string;
  /** Category for grouping in round sections */
  category: 'round' | 'nonce' | 'signature' | 'he' | 'vss' | 'mtls' | 'recess';
}

const EVENT_META: Record<SecurityEventKind, EventMeta> = {
  round_start:         { icon: Radio,          colorVar: 'var(--n8n-accent)',  label: 'Round Start',       category: 'round' },
  round_complete:      { icon: CheckCircle2,   colorVar: 'var(--n8n-success)', label: 'Round Complete',    category: 'round' },
  nonce_issued:        { icon: KeyRound,        colorVar: 'var(--n8n-text-muted)', label: 'Nonce Issued',  category: 'nonce' },
  nonce_verified:      { icon: KeyRound,        colorVar: 'var(--n8n-success)', label: 'Nonce Verified',   category: 'nonce' },
  signature_verified:  { icon: Fingerprint,     colorVar: 'var(--n8n-success)', label: 'Sig Verified',     category: 'signature' },
  signature_failed:    { icon: XCircle,         colorVar: 'var(--n8n-danger)',  label: 'Sig FAILED',       category: 'signature' },
  he_encrypt:          { icon: Lock,            colorVar: '#a78bfa',            label: 'HE Encrypt',       category: 'he' },
  he_decrypt:          { icon: Lock,            colorVar: '#a78bfa',            label: 'HE Decrypt',       category: 'he' },
  he_aggregate:        { icon: Lock,            colorVar: '#a78bfa',            label: 'HE Aggregate',     category: 'he' },
  vss_ceremony:        { icon: ShieldCheck,     colorVar: '#38bdf8',            label: 'VSS Ceremony',     category: 'vss' },
  vss_share_dist:      { icon: ShieldCheck,     colorVar: '#38bdf8',            label: 'VSS Share Dist',   category: 'vss' },
  mtls_handshake:      { icon: FileKey2,        colorVar: 'var(--n8n-success)', label: 'mTLS Handshake',   category: 'mtls' },
  recess_detect:       { icon: AlertTriangle,   colorVar: 'var(--n8n-warning)', label: 'RECESS Detect',    category: 'recess' },
  recess_flag:         { icon: AlertTriangle,   colorVar: 'var(--n8n-danger)',  label: 'RECESS Flag',      category: 'recess' },
};

// ── Helpers ────────────────────────────────────────────

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso;
  }
}

/** Group events by round number, preserving insertion order within each round. */
function groupByRound(events: SecurityEvent[]): Map<number, SecurityEvent[]> {
  const map = new Map<number, SecurityEvent[]>();
  for (const evt of events) {
    const arr = map.get(evt.round);
    if (arr) arr.push(evt);
    else map.set(evt.round, [evt]);
  }
  return map;
}

// ── Component ──────────────────────────────────────────

export default function FLOutputPanel() {
  const [activeTab, setActiveTab] = useState<Tab>('timeline');

  return (
    <div className="flex flex-col gap-0 h-full">
      {/* Tab bar */}
      <div className="fl-output-tab-bar">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`fl-output-tab ${activeTab === tab.key ? 'fl-output-tab--active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {activeTab === 'timeline' && <TimelineTab />}
        {activeTab === 'certificates' && <CertificatesTab />}
      </div>
    </div>
  );
}

// ── Timeline Tab ───────────────────────────────────────

function TimelineTab() {
  const events = useSecurityEvents();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Auto-scroll to bottom when new events arrive (if user hasn't scrolled up)
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events.length, autoScroll]);

  // Detect manual scroll-up to pause auto-scroll
  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 40;
    setAutoScroll(atBottom);
  };

  // Group by round (descending — newest round first)
  const grouped = useMemo(() => {
    const map = groupByRound(events);
    return Array.from(map.entries()).sort((a, b) => b[0] - a[0]);
  }, [events]);

  if (events.length === 0) {
    return (
      <div className="fl-empty-state" style={{ padding: '40px 16px' }}>
        <Activity size={24} className="fl-empty-state-icon" />
        <p className="fl-empty-state-text">
          No security events yet.<br />
          Events will appear here once training starts.
        </p>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex flex-col gap-2"
      style={{ padding: '10px 10px', overflowY: 'auto', height: '100%' }}
    >
      {/* Event count header */}
      <div
        className="flex items-center justify-between px-2 pb-1"
        style={{ borderBottom: '1px solid var(--n8n-card-border)' }}
      >
        <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--n8n-text-muted)' }}>
          {events.length} events
        </span>
        {!autoScroll && (
          <button
            type="button"
            className="text-[10px] font-medium"
            style={{ color: 'var(--n8n-accent)', background: 'none', border: 'none', cursor: 'pointer' }}
            onClick={() => {
              setAutoScroll(true);
              scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
            }}
          >
            Scroll to latest
          </button>
        )}
      </div>

      {grouped.map(([round, roundEvents]) => (
        <RoundGroup key={round} round={round} events={roundEvents} />
      ))}
    </div>
  );
}

// ── Round Group ────────────────────────────────────────

function RoundGroup({ round, events }: { round: number; events: SecurityEvent[] }) {
  // Count successes vs failures in this round
  const failures = events.filter(
    (e) => e.kind === 'signature_failed' || e.kind === 'recess_flag',
  ).length;
  const hasFailure = failures > 0;

  return (
    <div className="fl-timeline-round-group">
      {/* Round header */}
      <div className="fl-timeline-round-header">
        <span
          className="fl-timeline-round-badge"
          style={{
            borderColor: hasFailure ? 'rgba(208, 48, 80, 0.3)' : 'rgba(255, 109, 90, 0.3)',
            color: hasFailure ? 'var(--n8n-danger)' : 'var(--n8n-accent)',
          }}
        >
          R{round}
        </span>
        <span className="text-[10px]" style={{ color: 'var(--n8n-text-muted)' }}>
          {events.length} event{events.length !== 1 ? 's' : ''}
          {hasFailure && (
            <span style={{ color: 'var(--n8n-danger)', marginLeft: 6, fontWeight: 700 }}>
              {failures} alert{failures !== 1 ? 's' : ''}
            </span>
          )}
        </span>
      </div>

      {/* Event rows */}
      <div className="fl-timeline-events">
        {events.map((evt, i) => (
          <EventRow key={`${evt.kind}-${evt.clientId ?? ''}-${i}`} event={evt} />
        ))}
      </div>
    </div>
  );
}

// ── Single Event Row ───────────────────────────────────

function EventRow({ event }: { event: SecurityEvent }) {
  const meta = EVENT_META[event.kind] ?? {
    icon: Activity,
    colorVar: 'var(--n8n-text-muted)',
    label: event.kind,
    category: 'round',
  };
  const Icon = meta.icon;

  return (
    <div className="fl-timeline-event-row">
      {/* Timeline dot + line */}
      <div className="fl-timeline-dot-col">
        <span className="fl-timeline-dot" style={{ background: meta.colorVar }} />
        <span className="fl-timeline-line" />
      </div>

      {/* Content */}
      <div className="fl-timeline-event-content">
        <div className="flex items-center gap-1.5">
          <Icon size={12} style={{ color: meta.colorVar, flexShrink: 0 }} />
          <span className="text-[11px] font-semibold" style={{ color: meta.colorVar }}>
            {meta.label}
          </span>
          {event.clientId && (
            <span className="fl-timeline-client-tag">{event.clientId}</span>
          )}
          <span className="ml-auto text-[10px] font-mono" style={{ color: 'var(--n8n-text-muted)' }}>
            {formatTime(event.timestamp)}
          </span>
        </div>

        {event.detail && (
          <p className="text-[10px] mt-0.5" style={{ color: 'var(--n8n-text-muted)', lineHeight: 1.4 }}>
            {event.detail}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Certificates Tab ───────────────────────────────────

function CertificatesTab() {
  const [certs, setCerts] = useState<CertificateMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    flApi
      .certificates()
      .then(setCerts)
      .catch((err) => setError(err?.message ?? 'Failed to load certificates'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="fl-empty-state" style={{ padding: '40px 16px' }}>
        <Activity size={20} className="fl-empty-state-icon animate-spin" />
        <p className="fl-empty-state-text">Loading certificates...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="fl-empty-state" style={{ padding: '40px 16px' }}>
        <XCircle size={20} style={{ color: 'var(--n8n-danger)', opacity: 0.5 }} />
        <p className="fl-empty-state-text">{error}</p>
      </div>
    );
  }

  if (certs.length === 0) {
    return (
      <div className="fl-empty-state" style={{ padding: '40px 16px' }}>
        <FileKey2 size={24} className="fl-empty-state-icon" />
        <p className="fl-empty-state-text">
          No certificates found.<br />
          Certificates will be available when mTLS is configured.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" style={{ padding: '10px 10px' }}>
      {certs.map((cert) => (
        <CertificateCard key={cert.clientId} cert={cert} />
      ))}
    </div>
  );
}

// ── Certificate Card ───────────────────────────────────

function CertificateCard({ cert }: { cert: CertificateMetadata }) {
  const isExpired = new Date(cert.notAfter) < new Date();
  const statusColor = isExpired ? 'var(--n8n-danger)' : 'var(--n8n-success)';

  return (
    <div className="fl-cert-card">
      <div className="flex items-center gap-2 mb-2">
        <FileKey2 size={14} style={{ color: statusColor, flexShrink: 0 }} />
        <span className="text-xs font-semibold" style={{ color: 'var(--n8n-text-primary)' }}>
          {cert.clientId}
        </span>
        <span
          className={`fl-status-badge ${isExpired ? 'fl-status-badge--error' : 'fl-status-badge--on'}`}
          style={{ marginLeft: 'auto' }}
        >
          {isExpired ? 'Expired' : 'Valid'}
        </span>
      </div>

      <div className="fl-cert-grid">
        <CertField label="Issuer" value={cert.issuer} />
        <CertField label="Valid From" value={new Date(cert.notBefore).toLocaleDateString()} />
        <CertField label="Valid Until" value={new Date(cert.notAfter).toLocaleDateString()} />
        <CertField label="Fingerprint" value={cert.fingerprint.substring(0, 24) + '...'} mono />
      </div>
    </div>
  );
}

function CertField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[9px] font-semibold uppercase tracking-wider" style={{ color: 'var(--n8n-text-muted)' }}>
        {label}
      </span>
      <span
        className={`text-[11px] ${mono ? 'font-mono' : ''}`}
        style={{ color: 'var(--n8n-text-primary)', wordBreak: 'break-all' }}
      >
        {value}
      </span>
    </div>
  );
}
