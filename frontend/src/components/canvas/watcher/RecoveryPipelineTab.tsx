/**
 * RecoveryPipelineTab — AWS Step Functions-style drill-down for FedRecovery
 * correction pipeline runs.
 *
 * Renders a run-selector pill row (Level 1) above a split-pane pipeline view
 * (Level 2): left → StepFunctionGraph, right → StateDetailPanel.
 *
 * Data sources:
 *   - useFedRecoveryActiveRun / useFedRecoveryCompletedRuns  (fedRecoveryStore)
 *   - useWorkspaceStore nodes → client label resolution
 */

import { useState, useMemo } from 'react';
import {
  useFedRecoveryActiveRun,
  useFedRecoveryCompletedRuns,
} from '@/stores/fedRecoveryStore';
import type { FedRecoveryRun, FedRecoveryStep } from '@/stores/fedRecoveryStore';
import StepFunctionGraph from './StepFunctionGraph';
import type { GraphRow } from './StepFunctionGraph';
import StateDetailPanel from './StateDetailPanel';
import type { DetailSection } from './StateDetailPanel';
import type { NodeStatus } from './StateNode';
import { useClientIdLabelMap, formatTime, formatDuration } from './hooks';

// ── Status colour helper ──────────────────────────────────────────────────────

function runStatusColor(status: FedRecoveryRun['status']): string {
  switch (status) {
    case 'running':   return 'var(--n8n-warning)';
    case 'complete':  return 'var(--n8n-success)';
    case 'partial':   return 'var(--n8n-warning)';
    case 'failed':
    case 'cancelled': return 'var(--n8n-danger)';
  }
}

// ── RunCard sub-component ─────────────────────────────────────────────────────

interface RunCardProps {
  run: FedRecoveryRun;
  labelMap: Map<string, string>;
  selected: boolean;
  onClick: () => void;
}

function RunCard({ run, labelMap, selected, onClick }: RunCardProps) {
  const clientName = labelMap.get(run.flaggedClientId) ?? run.flaggedClientId;
  const isRunning = run.status === 'running';
  const statusColor = runStatusColor(run.status);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => e.key === 'Enter' && onClick()}
      aria-pressed={selected}
      aria-label={`Recovery run for ${clientName} at round ${run.flagRound}, status ${run.status}`}
      style={{
        background: 'var(--n8n-card-bg)',
        border: `1px solid ${selected ? 'var(--n8n-accent)' : 'var(--n8n-card-border)'}`,
        borderRadius: 8,
        padding: '8px 12px',
        cursor: 'pointer',
        minWidth: 120,
        flexShrink: 0,
        outline: 'none',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--n8n-text-primary)' }}>
        {clientName}
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
        <span style={{ fontSize: 10, color: 'var(--n8n-text-muted)' }}>R{run.flagRound}</span>
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: statusColor,
            ...(isRunning
              ? {
                  animation: 'pulse 1.5s ease-in-out infinite',
                }
              : {}),
          }}
        >
          {run.status}
        </span>
      </div>
    </div>
  );
}

// ── Graph row builder ─────────────────────────────────────────────────────────

function buildGraphRows(
  run: FedRecoveryRun,
  resolvedClientName: string,
): GraphRow[] {
  const rows: GraphRow[] = [];
  const isRunning = run.status === 'running';

  // ── 1. Trigger ──────────────────────────────────────────────────
  const triggerMetrics: string[] = [
    `client: ${resolvedClientName}`,
    `flag_round: ${run.flagRound}`,
  ];
  const trustVal = (run as { data?: Record<string, unknown> }).data?.trust as
    | number
    | undefined;
  if (trustVal != null) {
    triggerMetrics.push(`trust: ${trustVal.toFixed(3)}`);
  }
  rows.push({
    kind: 'sequential',
    node: {
      id: `${run.runId}-trigger`,
      label: 'Trigger',
      metrics: triggerMetrics,
      status: 'failed',
    },
  });

  // ── 2. DP Calibration ───────────────────────────────────────────
  rows.push({
    kind: 'sequential',
    node: {
      id: `${run.runId}-dp-calibration`,
      label: 'DP Calibration',
      metrics: [
        `ε: ${run.epsilon != null ? run.epsilon.toFixed(4) : '—'}`,
        `σ: ${run.sigma != null ? run.sigma.toFixed(4) : '—'}`,
        `mechanism: Gaussian`,
      ],
      status: run.epsilon != null ? 'succeeded' : 'pending',
    },
  });

  // ── 3+. Correction steps ────────────────────────────────────────
  run.steps.forEach((step, idx) => {
    const isLastStep = idx === run.steps.length - 1;
    let stepStatus: NodeStatus;
    if (isRunning && isLastStep) {
      stepStatus = 'running';
    } else if (step.step === 'corrected') {
      stepStatus = 'succeeded';
    } else {
      stepStatus = 'pending';
    }

    const weightDelta = step.data?.weight_delta as number | undefined;
    const stepMetrics: string[] = [
      `status: ${step.step}`,
      `Δ‖w‖: ${weightDelta != null ? weightDelta.toFixed(3) : '—'}`,
    ];
    if (step.detail) {
      stepMetrics.push(`detail: ${step.detail}`);
    }

    rows.push({
      kind: 'sequential',
      node: {
        id: `${run.runId}-step-${step.round}`,
        label: `R${step.round} — ${step.step === 'corrected' ? 'Correction' : 'Skipped'}`,
        metrics: stepMetrics,
        status: stepStatus,
      },
    });
  });

  // ── N-1. Model Impact (only when before/after accuracy present) ──
  if (run.accuracyBefore != null && run.accuracyAfter != null) {
    const improved = run.accuracyAfter > run.accuracyBefore;
    const impactMetrics: string[] = [
      `acc: ${(run.accuracyBefore * 100).toFixed(1)}% → ${(run.accuracyAfter * 100).toFixed(1)}%`,
    ];
    if (run.lossBefore != null && run.lossAfter != null) {
      impactMetrics.push(
        `loss: ${run.lossBefore.toFixed(4)} → ${run.lossAfter.toFixed(4)}`,
      );
    }
    rows.push({
      kind: 'sequential',
      node: {
        id: `${run.runId}-model-impact`,
        label: 'Model Impact',
        metrics: impactMetrics,
        status: improved ? 'succeeded' : 'warning',
      },
    });
  }

  // ── N. Result ───────────────────────────────────────────────────
  let resultStatus: NodeStatus;
  switch (run.status) {
    case 'complete':   resultStatus = 'succeeded'; break;
    case 'partial':    resultStatus = 'warning';   break;
    case 'failed':
    case 'cancelled':  resultStatus = 'failed';    break;
    case 'running':    resultStatus = 'running';   break;
  }

  rows.push({
    kind: 'sequential',
    node: {
      id: `${run.runId}-result`,
      label: 'Result',
      metrics: [
        `rounds_corrected: ${run.roundsCorrected}`,
        `rounds_skipped: ${run.roundsSkipped}`,
        `status: ${run.status}`,
        run.completedAt
          ? `duration: ${formatDuration(run.startedAt, run.completedAt)}`
          : 'duration: running...',
      ],
      status: resultStatus,
    },
  });

  return rows;
}

// ── Detail panel builder ──────────────────────────────────────────────────────

interface SelectedNodeInfo {
  label: string;
  status: NodeStatus;
  sections: DetailSection[];
}

function buildDetailInfo(
  nodeId: string | null,
  run: FedRecoveryRun,
  resolvedClientName: string,
): SelectedNodeInfo | null {
  if (nodeId === null) return null;

  // Trigger
  if (nodeId === `${run.runId}-trigger`) {
    return {
      label: 'Trigger',
      status: 'failed',
      sections: [
        {
          title: 'TRIGGER',
          rows: [
            { key: 'client', value: resolvedClientName },
            { key: 'flag_round', value: run.flagRound },
            { key: 'started_at', value: formatTime(run.startedAt) },
          ],
        },
      ],
    };
  }

  // DP Calibration
  if (nodeId === `${run.runId}-dp-calibration`) {
    return {
      label: 'DP Calibration',
      status: run.epsilon != null ? 'succeeded' : 'pending',
      sections: [
        {
          title: 'DIFFERENTIAL PRIVACY',
          rows: [
            { key: 'epsilon', value: run.epsilon != null ? run.epsilon.toFixed(4) : '—' },
            { key: 'sigma', value: run.sigma != null ? run.sigma.toFixed(4) : '—' },
            { key: 'mechanism', value: 'Gaussian' },
          ],
        },
      ],
    };
  }

  // Model Impact
  if (nodeId === `${run.runId}-model-impact`) {
    const improved =
      run.accuracyBefore != null &&
      run.accuracyAfter != null &&
      run.accuracyAfter > run.accuracyBefore;
    const rows: DetailSection['rows'] = [];
    if (run.accuracyBefore != null) {
      rows.push({ key: 'acc_before', value: `${(run.accuracyBefore * 100).toFixed(1)}%` });
    }
    if (run.accuracyAfter != null) {
      rows.push({
        key: 'acc_after',
        value: `${(run.accuracyAfter * 100).toFixed(1)}%`,
        valueColor: 'var(--n8n-success)',
      });
    }
    if (run.lossBefore != null) {
      rows.push({ key: 'loss_before', value: run.lossBefore.toFixed(4) });
    }
    if (run.lossAfter != null) {
      rows.push({
        key: 'loss_after',
        value: run.lossAfter.toFixed(4),
        valueColor: 'var(--n8n-success)',
      });
    }
    return {
      label: 'Model Impact',
      status: improved ? 'succeeded' : 'warning',
      sections: [{ title: 'MODEL IMPACT', rows }],
    };
  }

  // Result
  if (nodeId === `${run.runId}-result`) {
    let resultStatus: NodeStatus;
    switch (run.status) {
      case 'complete':   resultStatus = 'succeeded'; break;
      case 'partial':    resultStatus = 'warning';   break;
      case 'failed':
      case 'cancelled':  resultStatus = 'failed';    break;
      case 'running':    resultStatus = 'running';   break;
    }
    return {
      label: 'Result',
      status: resultStatus,
      sections: [
        {
          title: 'SUMMARY',
          rows: [
            { key: 'rounds_corrected', value: run.roundsCorrected },
            { key: 'rounds_skipped', value: run.roundsSkipped },
            {
              key: 'total_duration',
              value: run.completedAt
                ? formatDuration(run.startedAt, run.completedAt)
                : 'running...',
            },
            { key: 'status', value: run.status },
          ],
        },
      ],
    };
  }

  // Correction step — nodeId matches `${run.runId}-step-${step.round}`
  const stepPrefix = `${run.runId}-step-`;
  if (nodeId.startsWith(stepPrefix)) {
    const roundStr = nodeId.slice(stepPrefix.length);
    const round = parseInt(roundStr, 10);
    const step: FedRecoveryStep | undefined = run.steps.find((s) => s.round === round);
    if (!step) return null;

    const isLastStep = run.steps.indexOf(step) === run.steps.length - 1;
    const isRunning = run.status === 'running';
    let stepStatus: NodeStatus;
    if (isRunning && isLastStep) {
      stepStatus = 'running';
    } else if (step.step === 'corrected') {
      stepStatus = 'succeeded';
    } else {
      stepStatus = 'pending';
    }

    // Primary step section
    const stepRows: DetailSection['rows'] = [
      { key: 'status', value: step.step },
      { key: 'detail', value: step.detail ?? '—' },
    ];
    if (step.data) {
      for (const [k, v] of Object.entries(step.data)) {
        if (k !== 'weight_delta') {
          stepRows.push({ key: k, value: String(v) });
        } else {
          const delta = v as number;
          stepRows.push({ key: 'weight_delta', value: delta.toFixed(3) });
        }
      }
    }

    const sections: DetailSection[] = [
      { title: `R${step.round} CORRECTION`, rows: stepRows },
    ];

    // Weight norms section (if before/after norms available for this round)
    const normKey = String(step.round);
    const beforeNorm = run.beforeNorms?.[normKey];
    const afterNorm = run.afterNorms?.[normKey];
    if (beforeNorm != null || afterNorm != null) {
      const normRows: DetailSection['rows'] = [];
      if (beforeNorm != null) {
        normRows.push({ key: 'norm_before', value: beforeNorm.toFixed(6) });
      }
      if (afterNorm != null) {
        normRows.push({ key: 'norm_after', value: afterNorm.toFixed(6) });
      }
      sections.push({ title: 'WEIGHT NORMS', rows: normRows });
    }

    return { label: `R${step.round} — ${step.step === 'corrected' ? 'Correction' : 'Skipped'}`, status: stepStatus, sections };
  }

  return null;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function RecoveryPipelineTab() {
  const activeRun = useFedRecoveryActiveRun();
  const completedRuns = useFedRecoveryCompletedRuns();
  const labelMap = useClientIdLabelMap();

  const allRuns = useMemo<FedRecoveryRun[]>(() => {
    const runs: FedRecoveryRun[] = [];
    if (activeRun) runs.push(activeRun);
    runs.push(...completedRuns);
    return runs;
  }, [activeRun, completedRuns]);

  // User-initiated override — null means "use automatic selection"
  const [userSelectedRunId, setUserSelectedRunId] = useState<string | null>(null);

  // Effective selection: user override (if still present) → active run → first completed
  const selectedRun = useMemo<FedRecoveryRun | null>(() => {
    if (userSelectedRunId) {
      const override = allRuns.find((r) => r.runId === userSelectedRunId);
      if (override) return override;
    }
    if (activeRun) return activeRun;
    return completedRuns[0] ?? null;
  }, [userSelectedRunId, allRuns, activeRun, completedRuns]);

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const handleSelectRun = (runId: string) => {
    setUserSelectedRunId(runId);
    setSelectedNodeId(null);
  };

  // Build graph rows for selected run
  const rows = useMemo<GraphRow[]>(() => {
    if (!selectedRun) return [];
    const clientName = labelMap.get(selectedRun.flaggedClientId) ?? selectedRun.flaggedClientId;
    return buildGraphRows(selectedRun, clientName);
  }, [selectedRun, labelMap]);

  // Build detail panel data
  const detailInfo = useMemo<SelectedNodeInfo | null>(() => {
    if (!selectedRun || !selectedNodeId) return null;
    const clientName = labelMap.get(selectedRun.flaggedClientId) ?? selectedRun.flaggedClientId;
    return buildDetailInfo(selectedNodeId, selectedRun, clientName);
  }, [selectedNodeId, selectedRun, labelMap]);

  // ── Empty state ──
  if (allRuns.length === 0) {
    return (
      <div className="fl-empty-state" style={{ height: '100%' }}>
        <svg
          width="32"
          height="32"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="fl-empty-state-icon"
          aria-hidden="true"
        >
          <path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" />
          <path d="M12 8v4M12 16h.01" strokeLinecap="round" />
        </svg>
        <p className="fl-empty-state-text">
          No recovery runs yet — triggers when RECESS flags a client
        </p>
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* ── Level 1: Run selector ── */}
      <div
        style={{
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          flexShrink: 0,
          maxHeight: 180,
          overflowY: 'auto',
          paddingBottom: 4,
        }}
      >
        {allRuns.map((run) => (
          <RunCard
            key={run.runId}
            run={run}
            labelMap={labelMap}
            selected={run.runId === selectedRun?.runId}
            onClick={() => handleSelectRun(run.runId)}
          />
        ))}
      </div>

      {/* ── Level 2: Pipeline for selected run ── */}
      {selectedRun && (
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
              sections={detailInfo?.sections ?? []}
            />
          </div>
        </div>
      )}
    </div>
  );
}
