/**
 * FLTimelinePanel — Terminal-style security event log.
 *
 * Flat chronological log (newest at bottom, auto-scrolls down like a real
 * terminal).  Round separator lines appear when the round number changes.
 *
 * Data: WebSocket → liveStore → useSecurityEvents().
 */

import { useState, useEffect, useRef } from 'react';
import { Activity } from 'lucide-react';
import { useSecurityEvents } from '@/stores/liveStore';
import type { SecurityEvent, SecurityEventKind } from '@/stores/liveStore';

// ── Color mapping per event kind ──────────────────────

interface KindMeta {
  label: string;
  colorVar: string;
}

const KIND_META: Record<SecurityEventKind, KindMeta> = {
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
};

const ALERT_KINDS = new Set<SecurityEventKind>([
  'signature_failed',
  'recess_detect',
  'recess_flag',
]);

// ── Helpers ───────────────────────────────────────────

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso;
  }
}

/** Shorten long client IDs: "node_1773425257739_1" → "node…39_1" */
function shortClient(id: string): string {
  return id.length > 10 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}

// ── Component ─────────────────────────────────────────

export default function FLTimelinePanel() {
  const events = useSecurityEvents();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Track event count to trigger auto-scroll on new events
  const prevCountRef = useRef(0);
  useEffect(() => {
    if (autoScroll && scrollRef.current && events.length > prevCountRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevCountRef.current = events.length;
  }, [events.length, autoScroll]);

  // Detect manual scroll-up → pause auto-scroll
  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    // Within 40px of the bottom = "at bottom"
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
  };

  // Count alerts for the header
  const alertCount = events.filter((e) => ALERT_KINDS.has(e.kind)).length;

  return (
    <div className="fl-vis-card shrink-0">
      {/* Header */}
      <div className="fl-vis-card-header">
        <Activity size={13} style={{ color: 'var(--n8n-text-muted)', flexShrink: 0 }} />
        <span className="fl-section-header-title">
          Log
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

      {/* Body */}
      {events.length === 0 ? (
        <div className="fl-empty-state">
          <Activity size={24} className="fl-empty-state-icon" />
          <p className="fl-empty-state-text">No security events yet</p>
        </div>
      ) : (        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="fl-term-scroll"
        >
          {events.map((evt, i) => {
            const prevRound = i > 0 ? events[i - 1].round : null;
            const showSeparator = prevRound !== null && evt.round !== prevRound;
            return (
              <LogEntry
                key={`${evt.kind}-${evt.round}-${evt.clientId ?? ''}-${i}`}
                event={evt}
                showSeparator={showSeparator}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Log Entry (separator + row) ───────────────────────

interface LogEntryProps {
  event: SecurityEvent;
  showSeparator: boolean;
}

function LogEntry({ event, showSeparator }: LogEntryProps) {
  const meta = KIND_META[event.kind] ?? {
    label: event.kind.toUpperCase(),
    colorVar: 'var(--n8n-text-muted)',
  };
  const isAlert = ALERT_KINDS.has(event.kind);

  return (
    <>
      {showSeparator && (
        <div className="fl-term-separator">R{event.round}</div>
      )}
      <div className={`fl-term-row${isAlert ? ' fl-term-row--alert' : ''}`}>
        <span className="fl-term-ts">{formatTime(event.timestamp)}</span>
        <span className="fl-term-round">R{event.round}</span>
        <span className="fl-term-kind" style={{ color: meta.colorVar }}>
          {meta.label}
        </span>
        <span className="fl-term-client">
          {event.clientId ? shortClient(event.clientId) : '\u2014'}
        </span>
        <span className="fl-term-detail">
          {event.detail ?? ''}
          {isAlert && <span className="fl-term-alert-badge">ALERT</span>}
        </span>
      </div>
    </>
  );
}
