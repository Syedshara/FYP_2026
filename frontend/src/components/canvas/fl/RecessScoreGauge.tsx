/**
 * RecessScoreGauge — 48×48 SVG radial arc gauge for per-client RECESS state.
 *
 * Arc fill (−130° to +130°) encodes the abnormality score: 0→green, 0.6→red.
 * Centre dot colour reflects the current FSM status (idle / waiting / responding /
 * analyzing / decided).  A decision ring appears once a verdict has been rendered.
 */

import type { RecessClientState, RecessClientDecision } from '@/stores/recessStore';

// ── Colour helpers ────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  idle:       'var(--n8n-text-muted)',
  waiting:    '#60a5fa',
  responding: '#34d399',
  analyzing:  '#fbbf24',
  decided:    'var(--n8n-text-primary)',
};

function abnColor(v: number): string {
  if (v < 0.3) return 'var(--n8n-success)';
  if (v < 0.6) return 'var(--n8n-warning)';
  return 'var(--n8n-danger)';
}

function decisionColor(d: RecessClientDecision | undefined): string {
  if (d === 'flagged')      return 'var(--n8n-danger)';
  if (d === 'downweighted') return 'var(--n8n-warning)';
  return 'var(--n8n-success)';
}

// ── SVG arc path helper ───────────────────────────────

/**
 * Returns an SVG arc path string.
 * Angles are clock-face degrees (0 = top), positive = clockwise.
 */
function arcPath(
  cx: number,
  cy: number,
  r: number,
  startDeg: number,
  endDeg: number,
): string {
  const toRad = (d: number) => ((d - 90) * Math.PI) / 180;
  const x1 = cx + r * Math.cos(toRad(startDeg));
  const y1 = cy + r * Math.sin(toRad(startDeg));
  const x2 = cx + r * Math.cos(toRad(endDeg));
  const y2 = cy + r * Math.sin(toRad(endDeg));
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  return (
    `M${x1.toFixed(2)} ${y1.toFixed(2)} ` +
    `A${r} ${r} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`
  );
}

// ── Component ─────────────────────────────────────────

export interface RecessScoreGaugeProps {
  /** Display label (canvas node label or shortened client ID). */
  label: string;
  /** Current per-client state from recessStore, or null when not yet seen. */
  state: RecessClientState | null;
}

/**
 * Compact radial gauge showing a client's RECESS abnormality score and status.
 */
export function RecessScoreGauge({ label, state }: RecessScoreGaugeProps) {
  const status   = state?.status   ?? 'idle';
  const abn      = Math.min(state?.abnormality ?? 0, 1);
  const decision = state?.decision;

  // Arc geometry
  const CX = 24; const CY = 24; const R = 17;
  const ARC_START = -130; const ARC_END = 130;
  const fillEnd   = ARC_START + (ARC_END - ARC_START) * abn;

  const dotColor = decision
    ? decisionColor(decision)
    : (STATUS_COLOR[status] ?? 'var(--n8n-text-muted)');

  const displayLabel = label.length > 8 ? `${label.slice(0, 7)}…` : label;

  return (
    <div
      style={{
        display:       'flex',
        flexDirection: 'column',
        alignItems:    'center',
        gap:           1,
      }}
    >
      <svg
        width={48}
        height={48}
        viewBox="0 0 48 48"
        aria-label={`${label} RECESS abnormality gauge`}
      >
        {/* Track arc */}
        <path
          d={arcPath(CX, CY, R, ARC_START, ARC_END)}
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth={4}
          strokeLinecap="round"
        />

        {/* Fill arc (only when there's meaningful data) */}
        {abn > 0.005 && (
          <path
            d={arcPath(CX, CY, R, ARC_START, fillEnd)}
            fill="none"
            stroke={abnColor(abn)}
            strokeWidth={4}
            strokeLinecap="round"
          />
        )}

        {/* Centre status dot */}
        <circle cx={CX} cy={CY} r={5} fill={dotColor} />

        {/* Decision ring — appears after recess_decision is applied */}
        {status === 'decided' && decision && (
          <circle
            cx={CX}
            cy={CY}
            r={9}
            fill="none"
            stroke={decisionColor(decision)}
            strokeWidth={1.5}
            opacity={0.55}
          />
        )}
      </svg>

      {/* Client label */}
      <span
        style={{
          fontSize:      9,
          color:         'var(--n8n-text-muted)',
          fontFamily:    'ui-monospace, monospace',
          maxWidth:      60,
          overflow:      'hidden',
          textOverflow:  'ellipsis',
          whiteSpace:    'nowrap',
          textAlign:     'center',
        }}
        title={label}
      >
        {displayLabel}
      </span>

      {/* Decision chip */}
      {decision && (
        <span
          style={{
            fontSize:      8,
            color:         decisionColor(decision),
            fontFamily:    'ui-monospace, monospace',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            fontWeight:    700,
          }}
        >
          {decision}
        </span>
      )}
    </div>
  );
}
