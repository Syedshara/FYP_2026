/**
 * RecessSequenceDiagram — animated RECESS detection round visualisation.
 *
 * Layout:
 *   ┌─ Panel header (round number + queue indicator) ─────────┐
 *   │ Actor row: Server icon | per-client RecessScoreGauge     │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ Scrollable event stream (newest appended at bottom)      │
 *   │   Each row: timestamp | KIND badge | client chip | detail│
 *   └──────────────────────────────────────────────────────────┘
 *
 * The drain hook is mounted here so the animation loop runs
 * for as long as this panel is visible.
 *
 * Completed round summaries appear above the current round events.
 */

import { useRef, useEffect, useMemo } from 'react';
import { Shield, Activity } from 'lucide-react';
import {
  useRecessCurrentRound,
  useRecessCompletedRounds,
} from '@/stores/recessStore';
import type { RecessEvent, RecessDetectionRound } from '@/stores/recessStore';
import { useRecessAnimationDrain } from '@/hooks/useRecessAnimationDrain';
import { RecessScoreGauge } from './RecessScoreGauge';
import { useWorkspaceStore } from '@/stores/workspaceStore';

// ── Event kind metadata ───────────────────────────────

interface KindMeta {
  badge: string;
  color: string;
  bg:    string;
}

const EVENT_META: Record<string, KindMeta> = {
  recess_probe_built:       { badge: 'PROBE',    color: '#60a5fa',               bg: 'rgba(96,165,250,0.08)'  },
  recess_probe_dispatched:  { badge: 'DISPATCH', color: '#60a5fa',               bg: 'rgba(96,165,250,0.06)'  },
  recess_response_received: { badge: 'RESPONSE', color: '#34d399',               bg: 'rgba(52,211,153,0.08)'  },
  recess_vss_decrypt:       { badge: 'VSS',      color: '#38bdf8',               bg: 'rgba(56,189,248,0.08)'  },
  recess_score_computed:    { badge: 'SCORE',    color: '#fbbf24',               bg: 'rgba(251,191,36,0.08)'  },
  recess_decision:          { badge: 'DECISION', color: '#fb923c',               bg: 'rgba(251,146,60,0.08)'  },
  recess_round_complete:    { badge: 'COMPLETE', color: 'var(--n8n-success)',    bg: 'rgba(24,160,88,0.08)'   },
};

/** Override badge/colours for recess_decision based on the verdict. */
function decisionOverride(event: RecessEvent): KindMeta | null {
  if (event.kind !== 'recess_decision') return null;
  const d = event.data?.decision as string | undefined;
  if (d === 'flagged')
    return { badge: '⚠ FLAGGED',  color: 'var(--n8n-danger)',  bg: 'rgba(208,48,80,0.12)'  };
  if (d === 'downweighted')
    return { badge: '↓ DOWNWT',   color: 'var(--n8n-warning)', bg: 'rgba(240,160,32,0.10)' };
  return   { badge: '✓ TRUSTED',  color: 'var(--n8n-success)', bg: 'rgba(24,160,88,0.10)'  };
}

// ── Helpers ───────────────────────────────────────────

function shortId(id: string): string {
  return id.length <= 10 ? id : `${id.slice(0, 5)}…${id.slice(-3)}`;
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour:   '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '';
  }
}

function buildDetail(event: RecessEvent): string {
  const d = event.data ?? {};
  switch (event.kind) {
    case 'recess_probe_built':
      return `Probe built for R${event.round}`;

    case 'recess_probe_dispatched':
      return `Dispatching to ${d.num_clients ?? '?'} clients`;

    case 'recess_response_received':
      return 'Response received';

    case 'recess_vss_decrypt':
      return 'VSS threshold decrypt';

    case 'recess_score_computed': {
      const abn = (d.abnormality      as number | undefined)?.toFixed(3);
      const dir = (d.direction_score  as number | undefined)?.toFixed(2);
      const mag = (d.magnitude_score  as number | undefined)?.toFixed(2);
      return (
        [abn && `abn=${abn}`, dir && `dir=${dir}`, mag && `mag=${mag}`]
          .filter(Boolean)
          .join('  ') || 'Score computed'
      );
    }

    case 'recess_decision': {
      const before = (d.trust_before as number | undefined)?.toFixed(2);
      const after  = (d.trust_after  as number | undefined)?.toFixed(2);
      if (before != null && after != null) return `trust ${before}→${after}`;
      return String(d.decision ?? '');
    }

    case 'recess_round_complete': {
      const flagged = (d.flagged_clients as string[] | undefined) ?? [];
      return flagged.length > 0
        ? `${flagged.length} client(s) flagged: ${flagged.map(shortId).join(', ')}`
        : 'All clients cleared';
    }

    default:
      return event.detail ?? '';
  }
}

// ── Event row ─────────────────────────────────────────

function EventRow({ event }: { event: RecessEvent }) {
  const meta =
    decisionOverride(event) ??
    EVENT_META[event.kind] ??
    { badge: event.kind, color: 'var(--n8n-text-muted)', bg: 'transparent' };

  return (
    <div
      style={{
        display:    'flex',
        alignItems: 'baseline',
        gap:        6,
        padding:    '3px 8px',
        borderRadius: 4,
        background: meta.bg,
        fontSize:   11,
        fontFamily: 'ui-monospace, monospace',
        lineHeight: 1.6,
        animation:  'recess-fade-in 0.22s ease-out',
      }}
    >
      {/* Timestamp */}
      <span style={{ color: 'var(--n8n-text-muted)', flexShrink: 0, fontSize: 10 }}>
        {fmtTime(event.timestamp)}
      </span>

      {/* Kind badge */}
      <span
        style={{
          color:          meta.color,
          fontWeight:     700,
          fontSize:       10,
          flexShrink:     0,
          letterSpacing:  '0.03em',
          minWidth:       64,
        }}
      >
        {meta.badge}
      </span>

      {/* Client chip */}
      {event.clientId && (
        <span
          style={{
            color:       'var(--n8n-accent)',
            fontSize:    10,
            flexShrink:  0,
            background:  'rgba(255,109,90,0.10)',
            borderRadius: 3,
            padding:     '0 4px',
          }}
        >
          {shortId(event.clientId)}
        </span>
      )}

      {/* Detail text */}
      <span
        style={{
          color:        'var(--n8n-text-muted)',
          minWidth:     0,
          overflow:     'hidden',
          textOverflow: 'ellipsis',
          whiteSpace:   'nowrap',
        }}
      >
        {buildDetail(event)}
      </span>
    </div>
  );
}

// ── Completed round summary row ───────────────────────

function CompletedRoundBadge({ round }: { round: RecessDetectionRound }) {
  const flagged = round.flaggedClients.length;
  const scores  = Object.entries(round.trustScores);

  return (
    <div
      style={{
        display:    'flex',
        alignItems: 'center',
        flexWrap:   'wrap',
        gap:        6,
        padding:    '3px 8px',
        borderRadius: 4,
        background: flagged > 0 ? 'rgba(208,48,80,0.07)' : 'rgba(24,160,88,0.05)',
        fontSize:   10,
        fontFamily: 'ui-monospace, monospace',
        color:      'var(--n8n-text-muted)',
        borderTop:  '1px solid rgba(255,255,255,0.04)',
        marginTop:  2,
      }}
    >
      <span>R{round.round}</span>
      <span
        style={{
          color:      flagged > 0 ? 'var(--n8n-danger)' : 'var(--n8n-success)',
          fontWeight: 600,
        }}
      >
        {flagged > 0 ? `${flagged} flagged` : 'all clear'}
      </span>
      {scores.map(([cid, score]) => (
        <span
          key={cid}
          style={{
            color:
              score < 0.3 ? 'var(--n8n-danger)'
              : score < 0.8 ? 'var(--n8n-warning)'
              : 'var(--n8n-success)',
          }}
        >
          {shortId(cid)}:{score.toFixed(2)}
        </span>
      ))}
    </div>
  );
}

// ── Main component ────────────────────────────────────

export default function RecessSequenceDiagram() {
  // Mount the drain loop — runs as long as this component is rendered.
  const queueLength    = useRecessAnimationDrain();
  const currentRound   = useRecessCurrentRound();
  const completedRounds = useRecessCompletedRounds();
  const nodes          = useWorkspaceStore((s) => s.nodes);

  // Build a canvas-node-id → display-label map for human-readable names.
  const labelMap = useMemo(
    () =>
      new Map(
        nodes.map((n) => [n.id, (n.data as { label?: string }).label ?? n.id]),
      ),
    [nodes],
  );

  // Auto-scroll to the newest event.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [currentRound?.events.length]);

  const clientIds  = currentRound ? Object.keys(currentRound.clientStates) : [];
  const hasActivity = currentRound !== null || completedRounds.length > 0;

  return (
    <div
      style={{
        background:     'var(--n8n-card-bg)',
        border:         '1px solid var(--n8n-card-border)',
        borderRadius:   8,
        overflow:       'hidden',
        display:        'flex',
        flexDirection:  'column',
      }}
    >
      {/* ── Panel header ── */}
      <div
        style={{
          display:      'flex',
          alignItems:   'center',
          gap:          6,
          padding:      '8px 12px',
          borderBottom: '1px solid var(--n8n-card-border)',
          flexShrink:   0,
        }}
      >
        <Shield size={12} style={{ color: 'var(--n8n-warning)', flexShrink: 0 }} />

        <span
          style={{
            fontSize:  11,
            fontWeight: 600,
            color:     'var(--n8n-text-primary)',
            flex:      1,
          }}
        >
          RECESS Detection
          {currentRound && (
            <span
              style={{
                fontWeight: 400,
                color:      'var(--n8n-text-muted)',
                marginLeft: 6,
              }}
            >
              Round {currentRound.round}
            </span>
          )}
        </span>

        {/* Queue indicator */}
        {queueLength > 0 && (
          <span
            style={{
              display:    'flex',
              alignItems: 'center',
              gap:        4,
              fontSize:   10,
              color:      '#60a5fa',
              fontFamily: 'ui-monospace, monospace',
            }}
          >
            <Activity size={10} style={{ animation: 'spin 1.5s linear infinite' }} />
            {queueLength} queued
          </span>
        )}

        {/* Prior-round counter */}
        {completedRounds.length > 0 && (
          <span
            style={{
              fontSize:   10,
              color:      'var(--n8n-text-muted)',
              fontFamily: 'ui-monospace, monospace',
            }}
          >
            {completedRounds.length} prior
          </span>
        )}
      </div>

      {/* ── Actor row (Server + per-client gauges) ── */}
      {clientIds.length > 0 && (
        <div
          style={{
            display:      'flex',
            gap:          8,
            padding:      '8px 12px',
            borderBottom: '1px solid rgba(255,255,255,0.04)',
            flexWrap:     'wrap',
            flexShrink:   0,
            alignItems:   'flex-start',
          }}
        >
          {/* Server actor (fixed icon, no gauge) */}
          <div
            style={{
              display:       'flex',
              flexDirection: 'column',
              alignItems:    'center',
              gap:           2,
            }}
          >
            <div
              style={{
                width:          48,
                height:         48,
                display:        'flex',
                alignItems:     'center',
                justifyContent: 'center',
                borderRadius:   '50%',
                border:         '1.5px solid var(--n8n-card-border)',
                background:     'rgba(255,109,90,0.08)',
              }}
            >
              <Shield size={16} style={{ color: 'var(--n8n-accent)' }} />
            </div>
            <span
              style={{
                fontSize:   9,
                color:      'var(--n8n-text-muted)',
                fontFamily: 'ui-monospace, monospace',
              }}
            >
              Server
            </span>
          </div>

          {/* Client actors */}
          {clientIds.map((cid) => (
            <RecessScoreGauge
              key={cid}
              label={labelMap.get(cid) ?? shortId(cid)}
              state={currentRound?.clientStates[cid] ?? null}
            />
          ))}
        </div>
      )}

      {/* ── Event stream ── */}
      {hasActivity ? (
        <div
          ref={scrollRef}
          style={{
            overflowY:     'auto',
            maxHeight:     280,
            padding:       '6px 8px',
            display:       'flex',
            flexDirection: 'column',
            gap:           2,
          }}
        >
          {/* Completed round summaries (oldest → newest from top) */}
          {[...completedRounds].reverse().map((r) => (
            <CompletedRoundBadge key={r.round} round={r} />
          ))}

          {/* Current round live events */}
          {currentRound?.events.map((evt, i) => (
            <EventRow key={`${evt.kind}-${evt.clientId ?? ''}-${i}`} event={evt} />
          ))}
        </div>
      ) : (
        <div
          style={{
            padding:   '24px 12px',
            textAlign: 'center',
            color:     'var(--n8n-text-muted)',
            fontSize:  11,
          }}
        >
          <Shield
            size={20}
            style={{ margin: '0 auto 8px', opacity: 0.3, display: 'block' }}
          />
          No RECESS activity yet — detection runs every 5 rounds
        </div>
      )}
    </div>
  );
}
