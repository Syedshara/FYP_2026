/**
 * FLTimelinePanel — Terminal-style security event log.
 *
 * Flat chronological log (newest at bottom, auto-scrolls down like a real
 * terminal).  Round separator lines appear when the round number changes.
 * HE events (he_encrypt, he_aggregate, he_decrypt) and gradient lifecycle
 * events (global_dispatch, client_update, model_updated) with a `data`
 * payload are expandable to show per-layer metrics.
 *
 * Data: WebSocket → liveStore → useSecurityEvents().
 */

import { useState, useEffect, useRef } from 'react';
import { Activity, ChevronDown, ChevronRight } from 'lucide-react';
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
  recess_detect:           { label: 'RECESS_DET',    colorVar: 'var(--n8n-warning)' },
  recess_flag:             { label: 'RECESS_FLAG',   colorVar: 'var(--n8n-danger)' },
  global_dispatch:         { label: 'DISPATCH',      colorVar: '#60a5fa' },
  client_update:           { label: 'CLIENT_UPD',    colorVar: '#34d399' },
  model_updated:           { label: 'MODEL_UPD',     colorVar: '#fbbf24' },
  // ── Granular RECESS events — routed to recessStore, but kept here for type
  //    completeness so the exhaustive Record<SecurityEventKind, KindMeta> compiles.
  //    These are not displayed in FLTimelinePanel (they bypass addSecurityEvent).
  recess_probe_built:      { label: 'RECESS_PROBE',  colorVar: 'var(--n8n-warning)' },
  recess_probe_dispatched: { label: 'RECESS_DISP',   colorVar: 'var(--n8n-warning)' },
  recess_response_received:{ label: 'RECESS_RESP',   colorVar: 'var(--n8n-warning)' },
  recess_vss_decrypt:      { label: 'RECESS_VSS',    colorVar: '#38bdf8' },
  recess_score_computed:   { label: 'RECESS_SCORE',  colorVar: 'var(--n8n-warning)' },
  recess_decision:         { label: 'RECESS_DECIS',  colorVar: 'var(--n8n-warning)' },
  recess_round_complete:   { label: 'RECESS_DONE',   colorVar: 'var(--n8n-success)' },
};

const ALERT_KINDS = new Set<SecurityEventKind>([
  'signature_failed',
  'recess_detect',
  'recess_flag',
]);

const HE_KINDS = new Set<SecurityEventKind>(['he_encrypt', 'he_decrypt', 'he_aggregate']);
const GRADIENT_KINDS = new Set<SecurityEventKind>(['global_dispatch', 'client_update', 'model_updated']);
const EXPANDABLE_KINDS = new Set<SecurityEventKind>([...HE_KINDS, ...GRADIENT_KINDS]);

// ── HE data shapes ────────────────────────────────────

interface HEEncryptLayer {
  layer: string;
  delta_norm: number;
  cipher_kb: number | null;
  cipher_hex: string | null;
}

interface HEEncryptData {
  num_layers: number;
  num_clients: number;
  enc_time_sec: number;
  total_cipher_kb: number;
  layers: HEEncryptLayer[];
}

interface HEAggregateData {
  num_clients: number;
  num_layers: number;
  agg_time_sec: number;
  he_poly_modulus: number;
}

interface HEDecryptLayer {
  layer: string;
  delta_agg_norm: number;
  decrypted_preview: number[] | null;
}

interface HEDecryptData {
  num_layers: number;
  dec_time_sec: number;
  layers: HEDecryptLayer[];
}

// ── Gradient lifecycle data shapes ────────────────────

interface GlobalDispatchLayer {
  layer: string;
  weight_norm: number;
}

interface GlobalDispatchData {
  round: number;
  prior_loss: number | null;
  prior_accuracy: number | null;
  layers: GlobalDispatchLayer[];
}

interface ClientUpdateLayer {
  layer: string;
  delta_norm: number;
}

interface ClientUpdateData {
  client_id: string;
  loss: number;
  accuracy: number;
  num_samples: number;
  layers: ClientUpdateLayer[];
}

interface ModelUpdatedLayer {
  layer: string;
  weight_norm: number;
  delta_from_prior: number;
}

interface ModelUpdatedData {
  global_loss: number;
  global_accuracy: number;
  total_delta: number;
  layers: ModelUpdatedLayer[];
}

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

function fmtMs(sec: number): string {
  const ms = sec * 1000;
  return ms < 1000 ? `${ms.toFixed(1)}ms` : `${sec.toFixed(2)}s`;
}

function fmtNorm(v: number): string {
  return v < 0.001 ? v.toExponential(2) : v.toFixed(4);
}

function fmtKb(kb: number): string {
  return kb >= 1024 ? `${(kb / 1024).toFixed(2)} MB` : `${kb.toFixed(1)} KB`;
}

// ── Shared detail styles ──────────────────────────────

const DETAIL_STYLE: React.CSSProperties = {
  fontFamily: 'var(--n8n-font-mono)',
  fontSize: 10,
  color: 'var(--n8n-text-muted)',
  paddingLeft: 24,
  paddingBottom: 4,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

function DetailRow({
  cols,
  values,
  header,
  color,
}: {
  cols: string;
  values: React.ReactNode[];
  header?: boolean;
  color?: string;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: cols,
        gap: 8,
        paddingLeft: 4,
        color: header ? (color ?? '#a78bfa') : undefined,
        opacity: header ? 0.7 : undefined,
        fontWeight: header ? 700 : undefined,
        marginBottom: header ? 2 : undefined,
      }}
    >
      {values.map((v, i) => (
        <span key={i} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {v}
        </span>
      ))}
    </div>
  );
}

// ── HE detail sub-components ──────────────────────────

function HEEncryptDetail({ data }: { data: HEEncryptData }) {
  return (
    <div style={DETAIL_STYLE}>
      <span style={{ color: '#a78bfa', opacity: 0.8 }}>
        {data.num_clients} client{data.num_clients !== 1 ? 's' : ''} · {data.num_layers} layers ·{' '}
        {fmtMs(data.enc_time_sec)} · {fmtKb(data.total_cipher_kb)} total
      </span>
      <DetailRow cols="160px 80px 70px 140px" values={['layer', '‖Δ‖₂', 'cipher', 'cipher_hex (32B)']} header color="#a78bfa" />
      {data.layers.map((l) => (
        <DetailRow
          key={l.layer}
          cols="160px 80px 70px 140px"
          values={[
            l.layer,
            fmtNorm(l.delta_norm),
            l.cipher_kb != null ? fmtKb(l.cipher_kb) : '—',
            l.cipher_hex
              ? <span style={{ fontFamily: 'monospace', letterSpacing: 0 }}>{l.cipher_hex.slice(0, 32)}…</span>
              : '—',
          ]}
        />
      ))}
    </div>
  );
}

function HEAggregateDetail({ data }: { data: HEAggregateData }) {
  return (
    <div style={DETAIL_STYLE}>
      <span style={{ color: '#a78bfa', opacity: 0.8 }}>
        {data.num_clients} client{data.num_clients !== 1 ? 's' : ''} · {data.num_layers} layers ·{' '}
        {fmtMs(data.agg_time_sec)} · poly_mod={data.he_poly_modulus.toLocaleString()}
      </span>
    </div>
  );
}

function HEDecryptDetail({ data }: { data: HEDecryptData }) {
  return (
    <div style={DETAIL_STYLE}>
      <span style={{ color: '#a78bfa', opacity: 0.8 }}>
        {data.num_layers} layers · {fmtMs(data.dec_time_sec)}
      </span>
      <DetailRow cols="160px 80px 220px" values={['layer', '‖Δ_agg‖₂', 'plaintext preview (first 5)']} header color="#a78bfa" />
      {data.layers.map((l) => (
        <DetailRow
          key={l.layer}
          cols="160px 80px 220px"
          values={[
            l.layer,
            fmtNorm(l.delta_agg_norm),
            l.decrypted_preview
              ? <span style={{ fontFamily: 'monospace' }}>[{l.decrypted_preview.map((v) => v.toFixed(6)).join(', ')}]</span>
              : '—',
          ]}
        />
      ))}
    </div>
  );
}

// ── Gradient lifecycle detail sub-components ──────────

function GlobalDispatchDetail({ data }: { data: GlobalDispatchData }) {
  const hasPrior = data.prior_loss != null;
  return (
    <div style={DETAIL_STYLE}>
      <span style={{ color: '#60a5fa', opacity: 0.8 }}>
        {hasPrior
          ? `prior loss=${data.prior_loss!.toFixed(4)} acc=${data.prior_accuracy!.toFixed(4)}`
          : 'initial model (no prior round)'}
      </span>
      <DetailRow cols="160px 80px" values={['layer', '‖W‖₂']} header color="#60a5fa" />
      {data.layers.map((l) => (
        <DetailRow key={l.layer} cols="160px 80px" values={[l.layer, fmtNorm(l.weight_norm)]} />
      ))}
    </div>
  );
}

function ClientUpdateDetail({ data }: { data: ClientUpdateData }) {
  return (
    <div style={DETAIL_STYLE}>
      <span style={{ color: '#34d399', opacity: 0.8 }}>
        {shortClient(data.client_id)} · loss={data.loss.toFixed(4)} acc={data.accuracy.toFixed(4)} · {data.num_samples} samples
      </span>
      <DetailRow cols="160px 80px" values={['layer', '‖Δ‖₂']} header color="#34d399" />
      {data.layers.map((l) => (
        <DetailRow key={l.layer} cols="160px 80px" values={[l.layer, fmtNorm(l.delta_norm)]} />
      ))}
    </div>
  );
}

function ModelUpdatedDetail({ data }: { data: ModelUpdatedData }) {
  return (
    <div style={DETAIL_STYLE}>
      <span style={{ color: '#fbbf24', opacity: 0.8 }}>
        loss={data.global_loss.toFixed(4)} acc={data.global_accuracy.toFixed(4)} · total_Δ={data.total_delta.toFixed(6)}
      </span>
      <DetailRow cols="160px 80px 80px" values={['layer', '‖W‖₂', 'Δ_prior']} header color="#fbbf24" />
      {data.layers.map((l) => (
        <DetailRow
          key={l.layer}
          cols="160px 80px 80px"
          values={[l.layer, fmtNorm(l.weight_norm), fmtNorm(l.delta_from_prior)]}
        />
      ))}
    </div>
  );
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
      ) : (
        <div
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

// ── Log Entry (separator + row + optional detail) ─────

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
  const isExpandable = EXPANDABLE_KINDS.has(event.kind) && event.data != null;
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      {showSeparator && (
        <div className="fl-term-separator">R{event.round}</div>
      )}
      <div
        className={`fl-term-row${isAlert ? ' fl-term-row--alert' : ''}`}
        style={isExpandable ? { cursor: 'pointer', userSelect: 'none' } : undefined}
        onClick={isExpandable ? () => setExpanded((v) => !v) : undefined}
        role={isExpandable ? 'button' : undefined}
        aria-expanded={isExpandable ? expanded : undefined}
      >
        {/* expand chevron for expandable events */}
        {isExpandable ? (
          <span style={{ width: 14, flexShrink: 0, color: meta.colorVar, display: 'flex', alignItems: 'center' }}>
            {expanded
              ? <ChevronDown size={11} />
              : <ChevronRight size={11} />}
          </span>
        ) : (
          <span style={{ width: 14, flexShrink: 0 }} />
        )}
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

      {/* structured detail rows */}
      {isExpandable && expanded && (
        <EventDetail kind={event.kind} data={event.data!} />
      )}
    </>
  );
}

// ── Detail dispatcher ─────────────────────────────────

function EventDetail({ kind, data }: { kind: SecurityEventKind; data: Record<string, unknown> }) {
  if (kind === 'he_encrypt') {
    return <HEEncryptDetail data={data as unknown as HEEncryptData} />;
  }
  if (kind === 'he_aggregate') {
    return <HEAggregateDetail data={data as unknown as HEAggregateData} />;
  }
  if (kind === 'he_decrypt') {
    return <HEDecryptDetail data={data as unknown as HEDecryptData} />;
  }
  if (kind === 'global_dispatch') {
    return <GlobalDispatchDetail data={data as unknown as GlobalDispatchData} />;
  }
  if (kind === 'client_update') {
    return <ClientUpdateDetail data={data as unknown as ClientUpdateData} />;
  }
  if (kind === 'model_updated') {
    return <ModelUpdatedDetail data={data as unknown as ModelUpdatedData} />;
  }
  return null;
}
