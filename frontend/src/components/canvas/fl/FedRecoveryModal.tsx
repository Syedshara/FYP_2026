/**
 * FedRecoveryModal — auto-opening modal for the FedRecovery correction pipeline.
 *
 * Opens automatically when fedRecoveryStore.isModalOpen becomes true
 * (triggered by the fedrecovery_event {kind:'started'} WS message).
 *
 * Layout (fl-modal CSS classes):
 *   Header  : icon + "FedRecovery R{flagRound}" + flaggedClient + status badge + close
 *   Body    :
 *     1. Summary stat grid (6 stats)
 *     2. FedRecoveryStepGraph — pipeline step chain
 *     3. FedRecoveryModelDiff — weight norm before/after (when data available)
 *   Footer  : DP noise parameters + close button
 */

import { useCallback } from 'react';
import { ShieldAlert, X, RefreshCw, CheckCircle, AlertTriangle, XCircle } from 'lucide-react';
import {
  useFedRecoveryStore,
  useFedRecoveryModalOpen,
  useFedRecoveryActiveRun,
  useFedRecoveryCompletedRuns,
} from '@/stores/fedRecoveryStore';
import type { FedRecoveryRun, FedRecoveryStatus } from '@/stores/fedRecoveryStore';
import FedRecoveryStepGraph from './FedRecoveryStepGraph';
import FedRecoveryModelDiff from './FedRecoveryModelDiff';

// ── Status badge ──────────────────────────────────────

const STATUS_META: Record<FedRecoveryStatus, { label: string; color: string; bg: string }> = {
  running:   { label: 'Running',   color: '#60a5fa',               bg: 'rgba(96,165,250,0.12)'  },
  complete:  { label: 'Complete',  color: 'var(--n8n-success)',    bg: 'rgba(24,160,88,0.12)'   },
  partial:   { label: 'Partial',   color: 'var(--n8n-warning)',    bg: 'rgba(240,160,32,0.12)'  },
  failed:    { label: 'Failed',    color: 'var(--n8n-danger)',     bg: 'rgba(208,48,80,0.12)'   },
  cancelled: { label: 'Cancelled', color: 'var(--n8n-text-muted)', bg: 'rgba(255,255,255,0.06)' },
};

function StatusBadge({ status }: { status: FedRecoveryStatus }) {
  const { label, color, bg } = STATUS_META[status] ?? STATUS_META.running;
  return (
    <span
      style={{
        fontSize:     10,
        fontWeight:   600,
        color,
        background:   bg,
        borderRadius: 4,
        padding:      '2px 7px',
        fontFamily:   'ui-monospace, monospace',
        letterSpacing: '0.03em',
        flexShrink:   0,
      }}
    >
      {label}
    </span>
  );
}

function StatusIcon({ status }: { status: FedRecoveryStatus }) {
  const size = 16;
  switch (status) {
    case 'running':   return <RefreshCw  size={size} style={{ color: '#60a5fa', animation: 'spin 1.2s linear infinite' }} />;
    case 'complete':  return <CheckCircle size={size} style={{ color: 'var(--n8n-success)' }} />;
    case 'partial':   return <AlertTriangle size={size} style={{ color: 'var(--n8n-warning)' }} />;
    case 'failed':    return <XCircle    size={size} style={{ color: 'var(--n8n-danger)' }} />;
    case 'cancelled': return <XCircle    size={size} style={{ color: 'var(--n8n-text-muted)' }} />;
    default:          return <ShieldAlert size={size} style={{ color: 'var(--n8n-accent)' }} />;
  }
}

// ── Stat card ─────────────────────────────────────────

function Stat({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="fl-detail-stat">
      <div className="fl-detail-stat__label">{label}</div>
      <div className="fl-detail-stat__value" style={{ color: color ?? 'var(--n8n-text-primary)' }}>
        {value}
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────

function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 9)}…`;
}

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60)  return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function duration(startIso: string, endIso?: string): string {
  const end   = endIso ? new Date(endIso).getTime() : Date.now();
  const start = new Date(startIso).getTime();
  const secs  = Math.round((end - start) / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

// ── Run panel (body content) ──────────────────────────

function RunPanel({ run }: { run: FedRecoveryRun }) {
  const hasDiff =
    run.beforeNorms != null && run.afterNorms != null &&
    Object.keys(run.beforeNorms).length > 0;

  const hasMetrics =
    run.accuracyBefore != null && run.accuracyAfter != null;

  return (
    <div className="fl-modal__body">
      {/* ── Summary stats ── */}
      <div className="fl-detail-stats">
        <Stat label="Flagged Client" value={shortId(run.flaggedClientId)} />
        <Stat label="Flag Round"     value={`R${run.flagRound}`} />
        <Stat
          label="Status"
          value={<StatusBadge status={run.status} /> as unknown as string}
        />
        <Stat
          label="Corrected"
          value={run.roundsCorrected}
          color="var(--n8n-success)"
        />
        <Stat
          label="Skipped"
          value={run.roundsSkipped}
          color={run.roundsSkipped > 0 ? 'var(--n8n-warning)' : 'var(--n8n-text-muted)'}
        />
        <Stat
          label="Duration"
          value={duration(run.startedAt, run.completedAt)}
        />
      </div>

      {/* ── Step pipeline ── */}
      <div className="fl-detail-section">
        <div className="fl-detail-section__title">
          <RefreshCw size={13} />
          Correction Pipeline
        </div>
        <div style={{ padding: '8px 0 4px' }}>
          <FedRecoveryStepGraph run={run} />
        </div>
      </div>

      {/* ── DP noise parameters ── */}
      {(run.epsilon != null || run.sigma != null) && (
        <div
          style={{
            display:    'flex',
            gap:        16,
            fontSize:   11,
            fontFamily: 'ui-monospace, monospace',
            color:      'var(--n8n-text-muted)',
            padding:    '6px 10px',
            borderRadius: 5,
            background: 'rgba(255,255,255,0.03)',
            border:     '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <span>DP noise</span>
          {run.epsilon != null && (
            <span>ε = <strong style={{ color: 'var(--n8n-text-primary)' }}>{run.epsilon.toFixed(2)}</strong></span>
          )}
          {run.sigma != null && (
            <span>σ = <strong style={{ color: 'var(--n8n-text-primary)' }}>{run.sigma.toFixed(4)}</strong></span>
          )}
        </div>
      )}

      {/* ── Model diff ── */}
      {(hasDiff || hasMetrics) && (
        <div className="fl-detail-section">
          <div className="fl-detail-section__title">
            <ShieldAlert size={13} />
            Model Weight Diff
          </div>
          <div style={{ padding: '8px 0 4px' }}>
            <FedRecoveryModelDiff run={run} />
          </div>
        </div>
      )}

      {/* ── Timestamps ── */}
      <div
        style={{
          fontSize:   10,
          color:      'var(--n8n-text-muted)',
          fontFamily: 'ui-monospace, monospace',
          display:    'flex',
          gap:        16,
          paddingTop: 2,
        }}
      >
        <span>Started {relTime(run.startedAt)}</span>
        {run.completedAt && <span>Completed {relTime(run.completedAt)}</span>}
      </div>
    </div>
  );
}

// ── History tab ───────────────────────────────────────

function HistoryList({ runs }: { runs: FedRecoveryRun[] }) {
  if (runs.length === 0) {
    return (
      <div className="fl-modal__body">
        <p style={{ fontSize: 11, color: 'var(--n8n-text-muted)', fontStyle: 'italic' }}>
          No completed runs yet.
        </p>
      </div>
    );
  }

  return (
    <div className="fl-modal__body">
      {runs.map((run) => (
        <div
          key={run.runId}
          style={{
            padding:      '8px 10px',
            borderRadius: 5,
            border:       '1px solid var(--n8n-card-border)',
            display:      'flex',
            flexDirection: 'column',
            gap:          4,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <StatusIcon status={run.status} />
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--n8n-text-primary)', flex: 1 }}>
              R{run.flagRound} — {shortId(run.flaggedClientId)}
            </span>
            <StatusBadge status={run.status} />
            <span style={{ fontSize: 10, color: 'var(--n8n-text-muted)', fontFamily: 'ui-monospace, monospace' }}>
              {relTime(run.startedAt)}
            </span>
          </div>
          <div style={{ fontSize: 10, color: 'var(--n8n-text-muted)', fontFamily: 'ui-monospace, monospace', display: 'flex', gap: 12 }}>
            <span style={{ color: 'var(--n8n-success)' }}>✓ {run.roundsCorrected}</span>
            <span>↷ {run.roundsSkipped} skipped</span>
            <span>dur {duration(run.startedAt, run.completedAt)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main modal ────────────────────────────────────────

export default function FedRecoveryModal() {
  const isOpen       = useFedRecoveryModalOpen();
  const activeRun    = useFedRecoveryActiveRun();
  const completedRuns = useFedRecoveryCompletedRuns();
  const closeModal   = useFedRecoveryStore((s) => s.closeModal);

  const handleClose = useCallback(() => closeModal(), [closeModal]);
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => { if (e.target === e.currentTarget) handleClose(); },
    [handleClose],
  );

  if (!isOpen) return null;

  // Prefer showing the active run; fall back to the most recent completed run.
  const displayRun = activeRun ?? completedRuns[0] ?? null;
  const isHistoryMode = activeRun === null;

  const title = displayRun
    ? `FedRecovery — R${displayRun.flagRound}`
    : 'FedRecovery History';

  return (
    <div
      className="fl-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={handleBackdropClick}
    >
      <div
        className="fl-modal fl-detail-modal"
        style={{ width: 560 }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="fl-modal__header">
          <div className="fl-modal__title">
            {displayRun
              ? <StatusIcon status={displayRun.status} />
              : <ShieldAlert size={16} style={{ color: 'var(--n8n-accent)' }} />
            }
            <span>{title}</span>
            {displayRun && (
              <span
                style={{
                  fontSize:   11,
                  fontWeight: 400,
                  color:      'var(--n8n-text-muted)',
                  fontFamily: 'ui-monospace, monospace',
                }}
              >
                {shortId(displayRun.flaggedClientId)}
              </span>
            )}
            {displayRun && <StatusBadge status={displayRun.status} />}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {/* History count badge */}
            {completedRuns.length > 0 && (
              <span
                style={{
                  fontSize:   10,
                  color:      'var(--n8n-text-muted)',
                  fontFamily: 'ui-monospace, monospace',
                }}
              >
                {completedRuns.length} prior
              </span>
            )}
            <button className="fl-modal__close" onClick={handleClose} aria-label="Close FedRecovery panel">
              <X size={14} />
            </button>
          </div>
        </div>

        {/* ── Body ── */}
        {isHistoryMode
          ? <HistoryList runs={completedRuns} />
          : displayRun && <RunPanel run={displayRun} />
        }
      </div>
    </div>
  );
}
