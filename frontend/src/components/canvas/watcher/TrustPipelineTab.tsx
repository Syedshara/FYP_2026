/**
 * TrustPipelineTab — AWS Step Functions-style pipeline view for RECESS trust detection.
 *
 * Shows the full trust evaluation pipeline executed every 5 FL rounds:
 *   RECESS Trigger → Per-client Trust Evaluation (parallel) → Enforcement Decision → Outcome
 *
 * Uses StepFunctionGraph + StateDetailPanel to render an interactive graph where each node
 * can be clicked to inspect its data in the right-hand detail panel.
 */

import { useState, useMemo, useEffect } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useLiveStore, useSecurityEvents, useFlaggedEvents } from '@/stores/liveStore';
import { flApi } from '@/api/fl';
import type { SecurityEvent } from '@/stores/liveStore';
import type { ClientEnforcementStatus } from '@/types';
import type { TrustScoreComponents } from '@/types';
import StepFunctionGraph from './StepFunctionGraph';
import type { GraphRow } from './StepFunctionGraph';
import StateDetailPanel from './StateDetailPanel';
import type { DetailSection, KVRow } from './StateDetailPanel';
import type { NodeStatus } from './StateNode';
import { useClientIdLabelMap } from './hooks';

// ── Score helpers ─────────────────────────────────────

function scoreToStatus(score: number): NodeStatus {
  if (score < 0.3) return 'failed';
  if (score < 0.5) return 'warning';
  return 'succeeded';
}

function scoreColor(score: number): string {
  return score >= 0.8
    ? 'var(--n8n-success)'
    : score >= 0.5
      ? 'var(--n8n-warning)'
      : 'var(--n8n-danger)';
}

function abnormalityColor(abnormality: number): string {
  return abnormality > 0.7
    ? 'var(--n8n-danger)'
    : abnormality > 0.4
      ? 'var(--n8n-warning)'
      : 'var(--n8n-success)';
}

function enforcementWeight(tier: ClientEnforcementStatus): string {
  if (tier === 'included') return '1.0';
  if (tier === 'downweighted') return '0.5';
  return '0.0';
}

// ── Small sub-components ──────────────────────────────

function FlaggedBadge({ count }: { count: number }) {
  return (
    <span className="sfn-flagged-badge">
      {count} flagged
    </span>
  );
}

function ResetButton() {
  const [resetting, setResetting] = useState(false);

  const handleReset = async () => {
    if (!window.confirm('Reset all trust scores and flagged events? This cannot be undone.')) return;
    setResetting(true);
    try {
      await flApi.resetTrustScores();
    } catch {
      // Backend error — proceed with local clear anyway so the UI isn't stuck
    } finally {
      // Immediately clear local state — WS broadcast will re-hydrate if training is live
      const store = useLiveStore.getState();
      store.clearTrustScores();
      store.clearEnforcementHistory();
      setResetting(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => { void handleReset(); }}
      disabled={resetting}
      style={{
        marginLeft: 'auto',
        fontSize: 11,
        fontWeight: 600,
        padding: '3px 10px',
        borderRadius: 4,
        cursor: resetting ? 'not-allowed' : 'pointer',
        color: resetting ? 'var(--n8n-text-disabled)' : 'var(--n8n-text-muted)',
        background: 'none',
        border: '1px solid var(--n8n-card-border)',
        transition: 'color 0.15s, border-color 0.15s',
        opacity: resetting ? 0.6 : 1,
      }}
      onMouseEnter={(e) => {
        if (resetting) return;
        (e.currentTarget as HTMLButtonElement).style.color = 'var(--n8n-danger)';
        (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(208,48,80,0.4)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.color = resetting ? 'var(--n8n-text-disabled)' : 'var(--n8n-text-muted)';
        (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--n8n-card-border)';
      }}
    >
      {resetting ? 'Resetting…' : 'Reset Trust Scores'}
    </button>
  );
}

// ── Detail panel builder helpers ──────────────────────

interface DetailInfo {
  label: string;
  status: NodeStatus;
  duration: string | undefined;
  sections: DetailSection[];
}

// ── Main component ────────────────────────────────────

export default function TrustPipelineTab() {
  const trustHistory   = useLiveStore((s) => s.trustScoreHistory);
  const enforcementHistory = useLiveStore((s) => s.enforcementHistory);
  const flaggedEvents  = useFlaggedEvents();
  const securityEvents = useSecurityEvents();
  const labelMap       = useClientIdLabelMap();

  // Combine round + node into one state object so changing the round atomically
  // clears the selected node — no useEffect cascade needed.
  const [selection, setSelection] = useState<{ round: number | null; nodeId: string | null }>({
    round:  null,
    nodeId: null,
  });

  const selectedRound  = selection.round;
  const selectedNodeId = selection.nodeId;

  const setSelectedRound = (round: number) =>
    setSelection({ round, nodeId: null });

  const setSelectedNodeId = (nodeId: string) =>
    setSelection((prev) => ({ ...prev, nodeId }));

  // ── Detection rounds ──────────────────────────────────
  // Collect from trust history + security events (kind === 'recess_detect'), union + sort.
  // Any round present in trust score history IS a detection round — do not apply a
  // hardcoded % 5 filter because RECESS can fire on any round (e.g., the last round of
  // a short training run that is not a multiple of the detection interval).
  const detectionRounds = useMemo<number[]>(() => {
    const set = new Set<number>();

    // From trust score history: every round with an entry is a detection round
    for (const entries of Object.values(trustHistory)) {
      for (const entry of entries) {
        set.add(entry.round);
      }
    }

    // From security events
    for (const evt of securityEvents as SecurityEvent[]) {
      if (evt.kind === 'recess_detect') {
        set.add(evt.round);
      }
    }

    return [...set].sort((a, b) => a - b);
  }, [trustHistory, securityEvents]);

  // ── Auto-advance to newest detection round ────────────
  const latestRound = detectionRounds.length > 0
    ? detectionRounds[detectionRounds.length - 1]
    : null;

  useEffect(() => {
    if (latestRound === null) return;
    // Auto-select the latest round when it advances, or if nothing is selected
    if (selectedRound === null || latestRound > selectedRound) {
      setSelection({ round: latestRound, nodeId: null });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestRound]);
  // NOTE: selectedRound intentionally omitted — this effect only fires when
  // a new detection round arrives, not on every user-initiated round change.

  const flaggedCount = flaggedEvents.length;

  // ── Build graph rows for selected round ──────────────
  const rows = useMemo<GraphRow[]>(() => {
    if (selectedRound === null) return [];

    const roundEnforcement = enforcementHistory[selectedRound] ?? null;
    const roundFlagged     = flaggedEvents.filter((e) => e.round === selectedRound);

    // ── Row 1: RECESS Trigger ──────────────────────────
    const triggerRow: GraphRow = {
      kind: 'sequential',
      node: {
        id:      `${selectedRound}-recess-trigger`,
        label:   'RECESS Trigger',
        metrics: [
          `round: ${selectedRound}`,
          `detection_interval: 5`,
          `probe_built: ✓`,
        ],
        status: 'succeeded',
      },
    };

    // ── Row 2: Per-client evaluation (parallel) ────────
    const clientIds = Object.keys(trustHistory);
    const clientNodes = clientIds
      .map((clientId) => {
        const entries = trustHistory[clientId];
        const entry   = entries?.find((e) => e.round === selectedRound);
        if (!entry) return null;

        const displayName = labelMap.get(clientId) ?? clientId;
        const { score, components } = entry;

        return {
          id:      `${selectedRound}-client-${clientId}`,
          label:   displayName,
          metrics: [
            `score: ${score.toFixed(3)}`,
            `dir: ${components?.direction_score.toFixed(3) ?? '—'}`,
            `mag: ${components?.magnitude_score.toFixed(3) ?? '—'}`,
            `abn: ${components?.abnormality.toFixed(3) ?? '—'}`,
          ],
          status: scoreToStatus(score),
        };
      })
      .filter((n): n is NonNullable<typeof n> => n !== null);

    const parallelRow: GraphRow | null = clientNodes.length > 0
      ? { kind: 'parallel', nodes: clientNodes }
      : null;

    // ── Row 3: Enforcement Decision ────────────────────
    let includedCount    = 0;
    let downweightedCount = 0;
    let excludedCount    = 0;
    let enforcementStatus: NodeStatus = 'pending';

    if (roundEnforcement) {
      for (const tier of Object.values(roundEnforcement)) {
        if (tier === 'included')    includedCount++;
        else if (tier === 'downweighted') downweightedCount++;
        else if (tier === 'excluded')     excludedCount++;
      }
      enforcementStatus = excludedCount > 0 ? 'warning' : 'succeeded';
    }

    const enforcementRow: GraphRow = {
      kind: 'sequential',
      node: {
        id:      `${selectedRound}-enforcement-decision`,
        label:   'Enforcement Decision',
        metrics: [
          `included: ${includedCount}`,
          `downweighted: ${downweightedCount}`,
          `excluded: ${excludedCount}`,
        ],
        status: enforcementStatus,
      },
    };

    // ── Row 4: Outcome ─────────────────────────────────
    // Being "flagged" (abnormality > 0.7 in one round) is NOT the same as being
    // "excluded" (trust_score < FLAG_THRESHOLD = 0.3).  A recovered client
    // (score 0.963) is still in flaggedEvents but must be shown with their actual
    // enforcement tier, not hardcoded "excluded".
    //
    // Display the trust SCORE (the metric RECESS actually uses for enforcement
    // decisions) rather than the raw abnormality signal so the value matches what
    // the client node detail panel shows.
    let outcomeStatus: NodeStatus = 'pending';
    let outcomeMetrics: string[];

    if (roundEnforcement !== null || roundFlagged.length > 0) {
      const actuallyExcluded = roundFlagged.filter(
        (f) => roundEnforcement?.[f.clientId] === 'excluded',
      );
      const flaggedNotExcluded = roundFlagged.filter(
        (f) => roundEnforcement !== null && roundEnforcement[f.clientId] !== 'excluded',
      );

      // Helper: look up the trust score from history; fall back to abnormality label
      const clientScoreStr = (clientId: string): string => {
        const entry = (trustHistory[clientId] ?? []).find((e) => e.round === selectedRound);
        return entry != null ? entry.score.toFixed(3) : `abn:${(roundFlagged.find((f) => f.clientId === clientId)?.abnormality ?? 0).toFixed(3)}`;
      };

      if (actuallyExcluded.length > 0) {
        outcomeStatus  = 'failed';
        outcomeMetrics = actuallyExcluded.map((f) => {
          const name = labelMap.get(f.clientId) ?? f.clientId;
          return `${name}: ${clientScoreStr(f.clientId)} → excluded`;
        });
        if (flaggedNotExcluded.length > 0) {
          outcomeMetrics.push(`${flaggedNotExcluded.length} flagged, trust monitored`);
        }
      } else if (roundFlagged.length > 0) {
        // Flagged but still above exclusion threshold — trust monitored, still participating
        outcomeStatus  = 'warning';
        outcomeMetrics = roundFlagged.map((f) => {
          const name = labelMap.get(f.clientId) ?? f.clientId;
          const tier = roundEnforcement?.[f.clientId] ?? 'included';
          return `${name}: ${clientScoreStr(f.clientId)} → ${tier}`;
        });
      } else {
        outcomeStatus  = 'succeeded';
        outcomeMetrics = ['All clients trusted'];
      }
    } else {
      outcomeMetrics = ['awaiting enforcement data'];
    }

    const outcomeRow: GraphRow = {
      kind: 'sequential',
      node: {
        id:      `${selectedRound}-outcome`,
        label:   'Outcome',
        metrics: outcomeMetrics,
        status:  outcomeStatus,
      },
    };

    const allRows: GraphRow[] = [triggerRow];
    if (parallelRow) allRows.push(parallelRow);
    allRows.push(enforcementRow, outcomeRow);
    return allRows;
  }, [selectedRound, trustHistory, enforcementHistory, flaggedEvents, labelMap]);

  // ── Build detail panel for selected node ──────────────
  const detailInfo = useMemo<DetailInfo | null>(() => {
    if (!selectedNodeId || selectedRound === null) return null;

    // ── RECESS Trigger ────────────────────────────────
    if (selectedNodeId === `${selectedRound}-recess-trigger`) {
      return {
        label:    'RECESS Trigger',
        status:   'succeeded',
        duration: undefined,
        sections: [
          {
            title: 'TRIGGER',
            rows: [
              { key: 'round',              value: selectedRound },
              { key: 'detection_interval', value: 5 },
              { key: 'probe_built',        value: '✓' },
            ] satisfies KVRow[],
          },
        ],
      };
    }

    // ── Enforcement Decision ──────────────────────────
    if (selectedNodeId === `${selectedRound}-enforcement-decision`) {
      const roundEnforcement = enforcementHistory[selectedRound] ?? null;
      const decisionRows: KVRow[] = roundEnforcement
        ? Object.entries(roundEnforcement).map(([clientId, tier]) => {
            const name = labelMap.get(clientId) ?? clientId;
            return {
              key:   name,
              value: `${tier} (${enforcementWeight(tier)})`,
            };
          })
        : [{ key: 'status', value: 'awaiting enforcement data' }];

      let excludedCount = 0;
      if (roundEnforcement) {
        for (const t of Object.values(roundEnforcement)) {
          if (t === 'excluded') excludedCount++;
        }
      }

      return {
        label:    'Enforcement Decision',
        status:   roundEnforcement
          ? excludedCount > 0 ? 'warning' : 'succeeded'
          : 'pending',
        duration: undefined,
        sections: [{ title: 'DECISION', rows: decisionRows }],
      };
    }

    // ── Outcome ───────────────────────────────────────
    if (selectedNodeId === `${selectedRound}-outcome`) {
      const roundFlagged     = flaggedEvents.filter((e) => e.round === selectedRound);
      const roundEnforcement = enforcementHistory[selectedRound] ?? null;

      const actuallyExcluded   = roundFlagged.filter((f) => roundEnforcement?.[f.clientId] === 'excluded');
      const flaggedNotExcluded = roundFlagged.filter(
        (f) => roundEnforcement !== null && roundEnforcement[f.clientId] !== 'excluded',
      );

      // Helper: show the trust score from history (the value RECESS uses for
      // enforcement); fall back to the raw abnormality if history is unavailable.
      const clientScoreStr = (clientId: string, fallbackAbnormality: number): string => {
        const entry = (trustHistory[clientId] ?? []).find((e) => e.round === selectedRound);
        return entry != null ? entry.score.toFixed(3) : `abn:${fallbackAbnormality.toFixed(3)}`;
      };

      let outcomeStatus: NodeStatus = 'pending';
      const outcomeRows: KVRow[] = [
        { key: 'flagged_count', value: roundFlagged.length },
      ];

      if (roundEnforcement !== null || roundFlagged.length > 0) {
        if (actuallyExcluded.length > 0) {
          outcomeStatus = 'failed';
          for (const f of actuallyExcluded) {
            const name = labelMap.get(f.clientId) ?? f.clientId;
            outcomeRows.push({ key: name, value: `${clientScoreStr(f.clientId, f.abnormality)} → excluded` });
          }
          if (flaggedNotExcluded.length > 0) {
            for (const f of flaggedNotExcluded) {
              const name  = labelMap.get(f.clientId) ?? f.clientId;
              const tier  = roundEnforcement?.[f.clientId] ?? 'included';
              outcomeRows.push({ key: name, value: `${clientScoreStr(f.clientId, f.abnormality)} → ${tier} (monitored)` });
            }
          }
        } else if (roundFlagged.length > 0) {
          // Flagged but not excluded — show actual enforcement tier
          outcomeStatus = 'warning';
          for (const f of roundFlagged) {
            const name = labelMap.get(f.clientId) ?? f.clientId;
            const tier = roundEnforcement?.[f.clientId] ?? 'included';
            outcomeRows.push({ key: name, value: `${clientScoreStr(f.clientId, f.abnormality)} → ${tier}` });
          }
        } else {
          outcomeStatus = 'succeeded';
        }
      }

      return {
        label:    'Outcome',
        status:   outcomeStatus,
        duration: undefined,
        sections: [{ title: 'OUTCOME', rows: outcomeRows }],
      };
    }

    // ── Client node ───────────────────────────────────
    const clientPrefix = `${selectedRound}-client-`;
    if (selectedNodeId.startsWith(clientPrefix)) {
      const clientId    = selectedNodeId.slice(clientPrefix.length);
      const entries     = trustHistory[clientId] ?? [];
      const entry       = entries.find((e) => e.round === selectedRound);
      const displayName = labelMap.get(clientId) ?? clientId;

      if (!entry) return null;

      const { score, components } = entry;
      const components_val: TrustScoreComponents | undefined = components;

      const roundEnforcement   = enforcementHistory[selectedRound] ?? null;
      const tier: ClientEnforcementStatus = roundEnforcement?.[clientId] ??
        (score >= 0.5 ? 'included' : score >= 0.3 ? 'downweighted' : 'excluded');

      // Last 5 history entries for sparkline-style rows
      const historyRows: KVRow[] = [...entries]
        .slice(-5)
        .map((e) => ({ key: `R${e.round}`, value: e.score.toFixed(3) }));

      return {
        label:    displayName,
        status:   scoreToStatus(score),
        duration: undefined,
        sections: [
          {
            title: 'TRUST SCORE',
            rows: [
              {
                key:        'score',
                value:      score.toFixed(3),
                valueColor: scoreColor(score),
              },
              {
                key:   'direction',
                value: components_val?.direction_score.toFixed(3) ?? '—',
              },
              {
                key:   'magnitude',
                value: components_val?.magnitude_score.toFixed(3) ?? '—',
              },
              {
                key:        'abnormality',
                value:      components_val?.abnormality.toFixed(3) ?? '—',
                valueColor: components_val
                  ? abnormalityColor(components_val.abnormality)
                  : undefined,
              },
            ] satisfies KVRow[],
          },
          {
            title: 'HISTORY',
            rows:  historyRows,
          },
          {
            title: 'ENFORCEMENT',
            rows: [
              { key: 'tier',   value: tier },
              { key: 'weight', value: enforcementWeight(tier) },
            ] satisfies KVRow[],
          },
        ],
      };
    }

    return null;
  }, [selectedNodeId, selectedRound, trustHistory, enforcementHistory, flaggedEvents, labelMap]);

  // ── Empty state ───────────────────────────────────────
  if (detectionRounds.length === 0) {
    return (
      <div className="fl-vis-card" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div className="fl-vis-card-header" style={{ flexShrink: 0 }}>
          <ShieldCheck size={13} style={{ color: 'var(--n8n-text-muted)' }} />
          <span className="fl-section-header-title">Trust Detection Pipeline</span>
          <ResetButton />
        </div>
        <div className="fl-empty-state" style={{ flex: 1 }}>
          <ShieldCheck size={24} className="fl-empty-state-icon" />
          <p className="fl-empty-state-text">
            No RECESS detection rounds yet — pipeline runs every 5 FL training rounds
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* ── Header ── */}
      <div className="fl-vis-card-header" style={{ flexShrink: 0 }}>
        <ShieldCheck size={13} style={{ color: 'var(--n8n-text-muted)' }} />
        <span className="fl-section-header-title">Trust Detection Pipeline</span>
        {flaggedCount > 0 && <FlaggedBadge count={flaggedCount} />}
        <ResetButton />
      </div>

      {/* ── Round selector ── */}
      <div className="sfn-round-selector" style={{ padding: '12px 0 0', flexShrink: 0 }}>
        {detectionRounds.map((round) => {
          const isActive = round === selectedRound;
          const roundFlagged = flaggedEvents.filter((e) => e.round === round);
          const hasFlagged   = roundFlagged.length > 0;
          return (
            <button
              key={round}
              type="button"
              className={`sfn-round-pill${isActive ? ' sfn-round-pill--active' : ''}`}
              onClick={() => setSelectedRound(round)}
              aria-pressed={isActive}
            >
              {hasFlagged && (
                <span
                  className="sfn-round-pill__dot"
                  style={{ background: 'var(--n8n-danger)' }}
                  aria-hidden="true"
                />
              )}
              R{round}
            </button>
          );
        })}
      </div>

      {/* ── Split layout ── */}
      <div className="sfn-layout" style={{ flex: 1, minHeight: 0 }}>
        <div className="sfn-graph-pane">
          <StepFunctionGraph
            rows={rows}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
          />
        </div>
        <div className="sfn-detail-pane">
          <StateDetailPanel
            nodeLabel={detailInfo?.label ?? null}
            nodeStatus={detailInfo?.status}
            nodeDuration={detailInfo?.duration}
            sections={detailInfo?.sections ?? []}
          />
        </div>
      </div>
    </div>
  );
}
