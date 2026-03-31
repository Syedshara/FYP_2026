/**
 * RecessToastCard — fixed-position toast stack for RECESS flagged/downweighted decisions.
 *
 * Watches the recessStore currentRound.events array for newly drained
 * recess_decision events where decision === 'flagged' or 'downweighted'.
 * Each toast auto-dismisses after 5 s.  Maximum 3 toasts visible at once
 * (oldest evicted when the limit is reached).
 *
 * Mount once at the FLDrillDownView level so it renders above all panels.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { useRecessCurrentRound } from '@/stores/recessStore';

// ── Types ─────────────────────────────────────────────

interface Toast {
  id:          string;
  clientId:    string;
  decision:    'flagged' | 'downweighted';
  abnormality: number;
  round:       number;
  trustBefore?: number;
  trustAfter?:  number;
}

// ── Constants ─────────────────────────────────────────

const MAX_TOASTS  = 3;
const DISMISS_MS  = 5000;

// ── Helpers ───────────────────────────────────────────

function shortClient(id: string): string {
  return id.length > 14 ? `${id.slice(0, 10)}…` : id;
}

// ── Toast item ────────────────────────────────────────

function ToastItem({
  toast,
  onDismiss,
}: {
  toast:     Toast;
  onDismiss: (id: string) => void;
}) {
  const isFlagged = toast.decision === 'flagged';
  const color     = isFlagged ? 'var(--n8n-danger)' : 'var(--n8n-warning)';
  const bg        = isFlagged ? 'rgba(208,48,80,0.14)' : 'rgba(240,160,32,0.12)';

  // Auto-dismiss after DISMISS_MS
  useEffect(() => {
    const id = setTimeout(() => onDismiss(toast.id), DISMISS_MS);
    return () => clearTimeout(id);
  }, [toast.id, onDismiss]);

  return (
    <div
      role="alert"
      style={{
        background:   'var(--n8n-card-bg)',
        border:       `1px solid ${color}`,
        borderRadius: 8,
        padding:      '10px 12px',
        minWidth:     240,
        maxWidth:     300,
        boxShadow:    '0 4px 16px rgba(0,0,0,0.45)',
        pointerEvents: 'all',
        display:      'flex',
        gap:          8,
        alignItems:   'flex-start',
        animation:    'recess-toast-in 0.18s ease-out',
      }}
    >
      {/* Icon circle */}
      <div
        style={{
          width:          28,
          height:         28,
          borderRadius:   '50%',
          background:     bg,
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'center',
          flexShrink:     0,
        }}
      >
        <AlertTriangle size={13} style={{ color }} />
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize:    12,
            fontWeight:  600,
            color:       'var(--n8n-text-primary)',
            marginBottom: 2,
          }}
        >
          {isFlagged ? 'Client Flagged' : 'Client Downweighted'}
        </div>

        <div
          style={{
            fontSize:   11,
            color:      'var(--n8n-text-muted)',
            fontFamily: 'ui-monospace, monospace',
          }}
        >
          {shortClient(toast.clientId)}
          <span style={{ marginLeft: 6, color }}>
            abn={toast.abnormality.toFixed(3)}
          </span>
        </div>

        {toast.trustBefore != null && toast.trustAfter != null && (
          <div
            style={{
              fontSize:   10,
              color:      'var(--n8n-text-muted)',
              marginTop:  2,
              fontFamily: 'ui-monospace, monospace',
            }}
          >
            trust {toast.trustBefore.toFixed(2)} → {toast.trustAfter.toFixed(2)}
            {' · '}R{toast.round}
          </div>
        )}
      </div>

      {/* Dismiss button */}
      <button
        style={{
          background:     'transparent',
          border:         'none',
          cursor:         'pointer',
          color:          'var(--n8n-text-muted)',
          padding:        2,
          flexShrink:     0,
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'center',
          borderRadius:   3,
        }}
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
      >
        <X size={12} />
      </button>
    </div>
  );
}

// ── Main component ────────────────────────────────────

export default function RecessToastCard() {
  const [toasts, setToasts]       = useState<Toast[]>([]);
  const currentRound              = useRecessCurrentRound();
  // Track how many events from the current round we've already processed.
  const seenCountRef              = useRef(0);

  // Watch for newly drained recess_decision events with notable verdicts.
  useEffect(() => {
    if (!currentRound) return;
    const events   = currentRound.events;
    const newCount = events.length;
    if (newCount <= seenCountRef.current) return;

    const newEvents = events.slice(seenCountRef.current);
    seenCountRef.current = newCount;

    for (const evt of newEvents) {
      if (evt.kind !== 'recess_decision') continue;
      const decision = evt.data?.decision as string | undefined;
      if (decision !== 'flagged' && decision !== 'downweighted') continue;

      const toast: Toast = {
        id:          `${evt.round}-${evt.clientId ?? 'unknown'}-${Date.now()}`,
        clientId:    evt.clientId ?? 'unknown',
        decision:    decision as 'flagged' | 'downweighted',
        abnormality: (evt.data?.abnormality as number | undefined) ?? 0,
        round:       evt.round,
        trustBefore: evt.data?.trust_before as number | undefined,
        trustAfter:  evt.data?.trust_after  as number | undefined,
      };

      setToasts((prev) => [toast, ...prev].slice(0, MAX_TOASTS));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRound?.events.length]);

  // Reset seen count when the round number changes.
  useEffect(() => {
    seenCountRef.current = 0;
  }, [currentRound?.round]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position:      'fixed',
        bottom:        48,        // above the status-bar footer
        right:         16,
        zIndex:        9999,
        display:       'flex',
        flexDirection: 'column',
        gap:           8,
        pointerEvents: 'none',   // click-through on the wrapper; items re-enable it
      }}
      aria-live="assertive"
      aria-atomic="false"
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
      ))}
    </div>
  );
}
