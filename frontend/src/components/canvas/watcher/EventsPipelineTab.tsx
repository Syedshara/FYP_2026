/**
 * EventsPipelineTab — "Events" tab for the Watcher drill-down UI.
 *
 * Renders an AWS Step Functions-style vertical security pipeline for each FL
 * training round.  A round selector pill-bar at the top lets the user switch
 * rounds; the graph on the left shows pipeline state nodes and the detail
 * panel on the right shows structured metrics for the selected node.
 *
 * Auto-advances to the latest round as new SecurityEvents stream in.
 */

import { useState, useMemo, useEffect } from 'react';
import { useSecurityEvents, useEnforcementHistory, useLiveStore } from '@/stores/liveStore';
import type { SecurityEvent } from '@/stores/liveStore';
import type { ClientEnforcementStatus } from '@/types';
import StepFunctionGraph from './StepFunctionGraph';
import type { GraphRow } from './StepFunctionGraph';
import StateDetailPanel from './StateDetailPanel';
import type { DetailSection } from './StateDetailPanel';
import type { NodeStatus, StateNodeProps } from './StateNode';
import { useClientIdLabelMap, formatTime, formatDuration } from './hooks';

// ── Round result type (mirrors LiveState) ─────────────────────────────────

interface RoundResult {
  round: number;
  loss: number | null;
  accuracy: number | null;
  gradient_stats?: {
    dispatch_norms?: Record<string, number>;
    delta_norms?: Record<string, number>;
    delta_means?: Record<string, number>;
    post_norms?: Record<string, number>;
    total_delta?: number;
  };
  client_metrics?: Array<{
    client_id: string;
    local_loss: number;
    local_accuracy: number;
    num_samples: number;
  }>;
}

// ── Pipeline builder ───────────────────────────────────────────────────────

/**
 * Build the GraphRow[] pipeline for a given round from its security events
 * and associated store data.
 */
function buildPipelineRows(
  roundEvents: SecurityEvent[],
  selectedRound: number,
  roundResult: RoundResult | undefined,
  prevRoundResult: RoundResult | undefined,
  enforcementForRound: Record<string, ClientEnforcementStatus> | undefined,
  labelMap: Map<string, string>,
  prefix: string,
): GraphRow[] {
  const rows: GraphRow[] = [];

  // ── 1. Round Start ──────────────────────────────────────────────────────
  // Use .filter().at(-1) to pick the most recent event for this kind (guards
  // against stale cross-session duplicates that haven't been cleared yet).
  // (findLast requires ES2023; .filter+at(-1) is ES2022-safe.)
  const roundStartEvt = roundEvents.filter((e: SecurityEvent) => e.kind === 'round_start').at(-1);
  const roundCompleteEvt = roundEvents.filter((e: SecurityEvent) => e.kind === 'round_complete').at(-1);

  const roundStartMetrics: string[] = [`round: ${selectedRound}`];
  if (roundStartEvt) {
    const expectedClients = (roundStartEvt.data?.expected_clients ?? '?') as string | number;
    roundStartMetrics.push(`clients: ${expectedClients}`);
  }

  let roundStartDuration: string | undefined;
  if (roundStartEvt && roundCompleteEvt) {
    roundStartDuration = formatDuration(roundStartEvt.timestamp, roundCompleteEvt.timestamp);
  }

  rows.push({
    kind: 'sequential',
    node: {
      id: `${prefix}-round-start`,
      label: 'Round Start',
      metrics: roundStartMetrics,
      status: roundStartEvt ? 'succeeded' : 'pending',
      duration: roundStartDuration,
    } satisfies StateNodeProps,
  });

  // ── 2. Dispatch ─────────────────────────────────────────────────────────
  const dispatchEvt = roundEvents.filter((e: SecurityEvent) => e.kind === 'global_dispatch').at(-1);
  const dispatchMetrics: string[] = [];

  const dispatchNorms = roundResult?.gradient_stats?.dispatch_norms;
  if (dispatchNorms) {
    const layerCount = Object.keys(dispatchNorms).length;
    const totalNorm = Object.values(dispatchNorms).reduce((a, b) => a + b, 0);
    dispatchMetrics.push(`layers: ${layerCount}`);
    dispatchMetrics.push(`‖W‖: ${totalNorm.toFixed(2)}`);
  }
  if (dispatchEvt) {
    const clients = (dispatchEvt.data?.clients ?? null) as number | null;
    if (clients !== null) dispatchMetrics.push(`clients: ${clients}`);
  }

  rows.push({
    kind: 'sequential',
    node: {
      id: `${prefix}-dispatch`,
      label: 'Dispatch',
      metrics: dispatchMetrics,
      status: dispatchEvt ? 'succeeded' : 'pending',
    } satisfies StateNodeProps,
  });

  // ── 3. Client Training (parallel) ──────────────────────────────────────
  const clientUpdateEvents = roundEvents.filter((e) => e.kind === 'client_update');
  const uniqueClientIds = [...new Set(clientUpdateEvents.map((e) => e.clientId).filter(Boolean) as string[])];

  // Sort by resolved label for stable ordering
  uniqueClientIds.sort((a, b) => {
    const la = labelMap.get(a) ?? a;
    const lb = labelMap.get(b) ?? b;
    return la.localeCompare(lb);
  });

  if (uniqueClientIds.length > 0) {
    const clientNodes: StateNodeProps[] = uniqueClientIds.map((clientId) => {
      const resolvedLabel = labelMap.get(clientId) ?? clientId;
      const cm = roundResult?.client_metrics?.find((m) => m.client_id === clientId);

      const clientMetrics: string[] = [];
      let clientStatus: NodeStatus = 'pending';

      if (cm) {
        clientMetrics.push(`loss: ${cm.local_loss.toFixed(3)}`);
        clientMetrics.push(`acc: ${(cm.local_accuracy * 100).toFixed(1)}%`);
        const kSamples = cm.num_samples >= 1000
          ? `${(cm.num_samples / 1000).toFixed(1)}k`
          : String(cm.num_samples);
        clientMetrics.push(`samples: ${kSamples}`);
        clientStatus = cm.local_loss > 0.5 ? 'warning' : 'succeeded';
      }

      return {
        id: `${prefix}-client-${clientId}`,
        label: resolvedLabel,
        metrics: clientMetrics,
        status: clientStatus,
      } satisfies StateNodeProps;
    });

    rows.push({ kind: 'parallel', nodes: clientNodes });
  }

  // ── 4. Security Verification ────────────────────────────────────────────
  const nonceVerifiedEvts = roundEvents.filter((e) => e.kind === 'nonce_verified');
  const mtlsEvts          = roundEvents.filter((e) => e.kind === 'mtls_handshake');
  const sigVerifiedEvts   = roundEvents.filter((e) => e.kind === 'signature_verified');
  const sigFailedEvts     = roundEvents.filter((e) => e.kind === 'signature_failed');

  // Bug 6 fix: use expected_clients from round_start event as denominator;
  // the nonce_issued event is one-per-round (not per-client), so using its
  // count as a denominator gives nonsensical results like "4/1".
  const expectedClients = (roundStartEvt?.data?.expected_clients as number | undefined)
    ?? Math.max(nonceVerifiedEvts.length, mtlsEvts.length, sigVerifiedEvts.length);
  const nonceCheck    = nonceVerifiedEvts.length > 0 ? '✓' : '?';
  const mtlsCheck     = mtlsEvts.length > 0 ? '✓' : '?';
  const sigCheck      = sigFailedEvts.length > 0 ? '✗' : sigVerifiedEvts.length > 0 ? '✓' : '?';

  const securityMetrics: string[] = [
    `nonces: ${nonceVerifiedEvts.length}/${expectedClients || '?'} ${nonceCheck}`,
    `mTLS: ${mtlsEvts.length}/${expectedClients || '?'} ${mtlsCheck}`,
    `signatures: ${sigVerifiedEvts.length}/${expectedClients || '?'} ${sigCheck}`,
  ];

  let securityStatus: NodeStatus = 'pending';
  if (sigFailedEvts.length > 0) {
    securityStatus = 'failed';
  } else if (nonceVerifiedEvts.length > 0 || mtlsEvts.length > 0 || sigVerifiedEvts.length > 0) {
    securityStatus = 'succeeded';
  }

  rows.push({
    kind: 'sequential',
    node: {
      id: `${prefix}-security-verify`,
      label: 'Security Verification',
      metrics: securityMetrics,
      status: securityStatus,
    } satisfies StateNodeProps,
  });

  // ── 5. HE + Aggregation ─────────────────────────────────────────────────
  // Bug 2 fix: RECESS rounds intentionally skip HE and model update — detect
  // them by the presence of a recess_detect event so we can show 'skipped'
  // instead of leaving these nodes stuck at 'pending' forever.
  const isRecessRound = roundEvents.some((e) => e.kind === 'recess_detect');

  const heEncryptEvt  = roundEvents.filter((e: SecurityEvent) => e.kind === 'he_encrypt').at(-1);
  const heAggEvt      = roundEvents.filter((e: SecurityEvent) => e.kind === 'he_aggregate').at(-1);
  const vssCeremonyEvt = roundEvents.filter((e: SecurityEvent) => e.kind === 'vss_ceremony').at(-1);

  const heMetrics: string[] = [];
  if (heEncryptEvt?.data) {
    const encLayers = (heEncryptEvt.data.encrypted_layers ?? heEncryptEvt.data.layer_count ?? null) as number | null;
    if (encLayers !== null) heMetrics.push(`encrypted_layers: ${encLayers}`);
  }
  if (vssCeremonyEvt) heMetrics.push('vss: ✓');
  heMetrics.push('method: trust_weight');

  let heStatus: NodeStatus = 'pending';
  if (isRecessRound) {
    heStatus = 'warning';
    heMetrics.length = 0;
    heMetrics.push('skipped — RECESS round');
  } else if (heAggEvt) {
    heStatus = 'succeeded';
  } else if (heEncryptEvt) {
    heStatus = 'running';
  }

  rows.push({
    kind: 'sequential',
    node: {
      id: `${prefix}-he-aggregation`,
      label: 'HE + Aggregation',
      metrics: heMetrics,
      status: heStatus,
    } satisfies StateNodeProps,
  });

  // ── 6. RECESS Detection (every 5th round only) ──────────────────────────
  if (selectedRound % 5 === 0) {
    const recessDetectEvts = roundEvents.filter((e) => e.kind === 'recess_detect');
    const recessFlagEvts   = roundEvents.filter((e) => e.kind === 'recess_flag');

    const detectedClients = new Set(
      recessDetectEvts.map((e) => e.clientId).filter(Boolean),
    ).size;

    const recessMetrics: string[] = [
      `clients_evaluated: ${detectedClients}`,
      `flagged: ${recessFlagEvts.length}`,
    ];

    let recessStatus: NodeStatus = 'pending';
    if (recessFlagEvts.length > 0) recessStatus = 'warning';
    else if (recessDetectEvts.length > 0) recessStatus = 'succeeded';

    rows.push({
      kind: 'sequential',
      node: {
        id: `${prefix}-recess-detection`,
        label: 'RECESS Detection',
        metrics: recessMetrics,
        status: recessStatus,
      } satisfies StateNodeProps,
    });
  }

  // ── 7. Enforcement ──────────────────────────────────────────────────────
  const enforcementEntries = enforcementForRound ? Object.entries(enforcementForRound) : [];
  const excludedCount = enforcementEntries.filter(([, v]) => v === 'excluded').length;

  const MAX_ENFORCEMENT_LINES = 3;
  const enforcementMetrics: string[] = enforcementEntries
    .slice(0, MAX_ENFORCEMENT_LINES)
    .map(([cid, status]) => {
      const lbl = labelMap.get(cid) ?? cid;
      return `${lbl}: ${status}`;
    });

  if (enforcementEntries.length > MAX_ENFORCEMENT_LINES) {
    enforcementMetrics.push(`+${enforcementEntries.length - MAX_ENFORCEMENT_LINES} more`);
  }

  // Trust source round — Bug 9 fix: show 'initial (1.0)' before first RECESS
  const lastRecessRound = Math.floor(selectedRound / 5) * 5;
  if (lastRecessRound > 0) {
    enforcementMetrics.push(`trust from: R${lastRecessRound}`);
  } else {
    enforcementMetrics.push('trust from: initial (1.0)');
  }

  let enforcementStatus: NodeStatus = 'pending';
  if (enforcementEntries.length > 0) {
    enforcementStatus = excludedCount > 0 ? 'warning' : 'succeeded';
  }

  rows.push({
    kind: 'sequential',
    node: {
      id: `${prefix}-enforcement`,
      label: 'Enforcement',
      metrics: enforcementMetrics,
      status: enforcementStatus,
    } satisfies StateNodeProps,
  });

  // ── 8. Model Update ─────────────────────────────────────────────────────
  const modelUpdatedEvt = roundEvents.filter((e: SecurityEvent) => e.kind === 'model_updated').at(-1);

  const modelMetrics: string[] = [];
  let modelStatus: NodeStatus;

  if (isRecessRound) {
    // Bug 2 fix: RECESS rounds don't update the model — show skipped, not pending
    modelStatus = 'warning';
    modelMetrics.push('skipped — RECESS round');
  } else {
    if (roundResult !== undefined && prevRoundResult !== undefined) {
      const prevAcc  = prevRoundResult.accuracy;
      const currAcc  = roundResult.accuracy;
      const prevLoss = prevRoundResult.loss;
      const currLoss = roundResult.loss;
      if (prevAcc !== null && currAcc !== null) {
        modelMetrics.push(`acc: ${(prevAcc * 100).toFixed(1)}% → ${(currAcc * 100).toFixed(1)}%`);
      } else if (currAcc !== null) {
        modelMetrics.push(`acc: ${(currAcc * 100).toFixed(1)}%`);
      }
      if (prevLoss !== null && currLoss !== null) {
        modelMetrics.push(`loss: ${prevLoss.toFixed(3)} → ${currLoss.toFixed(3)}`);
      } else if (currLoss !== null) {
        modelMetrics.push(`loss: ${currLoss.toFixed(3)}`);
      }
    } else if (roundResult !== undefined) {
      if (roundResult.accuracy !== null) {
        modelMetrics.push(`acc: ${(roundResult.accuracy * 100).toFixed(1)}%`);
      }
      if (roundResult.loss !== null) {
        modelMetrics.push(`loss: ${roundResult.loss.toFixed(3)}`);
      }
    }
    modelStatus = modelUpdatedEvt ? 'succeeded' : 'pending';
  }

  rows.push({
    kind: 'sequential',
    node: {
      id: `${prefix}-model-update`,
      label: 'Model Update',
      metrics: modelMetrics,
      status: modelStatus,
    } satisfies StateNodeProps,
  });

  // ── 9. Round Complete ───────────────────────────────────────────────────
  // Bug 1 fix: RECESS rounds emit 'recess_round_complete', not 'round_complete'.
  // Accept either as a completion signal.
  const recessRoundCompleteEvt = roundEvents.filter((e: SecurityEvent) => e.kind === 'recess_round_complete').at(-1);
  const effectiveCompleteEvt   = roundCompleteEvt ?? recessRoundCompleteEvt;

  const roundCompleteMetrics: string[] = [];
  if (roundStartEvt && effectiveCompleteEvt) {
    roundCompleteMetrics.push(
      `duration: ${formatDuration(roundStartEvt.timestamp, effectiveCompleteEvt.timestamp)}`,
    );
  }
  if (isRecessRound) roundCompleteMetrics.push('type: RECESS detection');

  let roundCompleteStatus: NodeStatus = 'pending';
  if (effectiveCompleteEvt) roundCompleteStatus = 'succeeded';
  else if (roundStartEvt) roundCompleteStatus = 'running';

  rows.push({
    kind: 'sequential',
    node: {
      id: `${prefix}-round-complete`,
      label: 'Round Complete',
      metrics: roundCompleteMetrics,
      status: roundCompleteStatus,
    } satisfies StateNodeProps,
  });

  return rows;
}

// ── Detail section builder ─────────────────────────────────────────────────

/**
 * Return label, status, duration, and DetailSection[] for the currently
 * selected node ID (prefixed with the round, e.g. "3-round-start").
 */
function buildDetailInfo(
  nodeId: string,
  roundEvents: SecurityEvent[],
  selectedRound: number,
  roundResult: RoundResult | undefined,
  prevRoundResult: RoundResult | undefined,
  enforcementForRound: Record<string, ClientEnforcementStatus> | undefined,
  labelMap: Map<string, string>,
  prefix: string,
): { label: string | null; status: NodeStatus | undefined; duration: string | undefined; sections: DetailSection[] } {
  const EMPTY = { label: null, status: undefined, duration: undefined, sections: [] };

  if (!nodeId.startsWith(`${prefix}-`)) return EMPTY;
  const localId = nodeId.slice(prefix.length + 1); // strip "<round>-"

  const roundStartEvt   = roundEvents.filter((e: SecurityEvent) => e.kind === 'round_start').at(-1);
  const roundCompleteEvt = roundEvents.filter((e: SecurityEvent) => e.kind === 'round_complete').at(-1);
  // Bug 1 fix: RECESS rounds emit 'recess_round_complete' instead of 'round_complete'
  const recessCompleteEvt     = roundEvents.filter((e: SecurityEvent) => e.kind === 'recess_round_complete').at(-1);
  const effectiveCompleteEvt  = roundCompleteEvt ?? recessCompleteEvt;
  const isRecessRoundDetail   = roundEvents.some((e) => e.kind === 'recess_detect');

  // ── round-start ──────────────────────────────────────────────────────────
  if (localId === 'round-start') {
    const expectedClients = roundStartEvt
      ? ((roundStartEvt.data?.expected_clients ?? '?') as string | number)
      : '?';
    const ts = roundStartEvt ? formatTime(roundStartEvt.timestamp) : undefined;

    return {
      label: 'Round Start',
      status: roundStartEvt ? 'succeeded' : 'pending',
      duration: roundStartEvt && effectiveCompleteEvt
        ? formatDuration(roundStartEvt.timestamp, effectiveCompleteEvt.timestamp)
        : undefined,
      sections: [
        {
          title: 'ROUND',
          rows: [
            { key: 'round', value: selectedRound },
            { key: 'expected_clients', value: expectedClients },
            { key: 'timestamp', value: ts },
          ],
        },
      ],
    };
  }

  // ── dispatch ─────────────────────────────────────────────────────────────
  if (localId === 'dispatch') {
    const dispatchEvt  = roundEvents.filter((e: SecurityEvent) => e.kind === 'global_dispatch').at(-1);
    const dispatchNorms = roundResult?.gradient_stats?.dispatch_norms ?? {};
    const layerCount = Object.keys(dispatchNorms).length;
    const totalNorm  = Object.values(dispatchNorms).reduce((a, b) => a + b, 0);

    const normRows = Object.entries(dispatchNorms).map(([layer, norm]) => ({
      key: layer,
      value: norm.toFixed(4),
    }));

    return {
      label: 'Dispatch',
      status: dispatchEvt ? 'succeeded' : 'pending',
      duration: undefined,
      sections: [
        {
          title: 'DISPATCH',
          rows: [
            { key: 'layers', value: layerCount || undefined },
            { key: 'total_‖W‖', value: layerCount > 0 ? totalNorm.toFixed(3) : undefined },
            ...normRows,
          ],
        },
      ],
    };
  }

  // ── client-<id> ──────────────────────────────────────────────────────────
  if (localId.startsWith('client-')) {
    const clientId = localId.slice('client-'.length);
    const resolvedLabel = labelMap.get(clientId) ?? clientId;
    const cm = roundResult?.client_metrics?.find((m) => m.client_id === clientId);

    const nonceVerified = roundEvents.some(
      (e) => e.kind === 'nonce_verified' && e.clientId === clientId,
    );
    const mtlsOk = roundEvents.some(
      (e) => e.kind === 'mtls_handshake' && e.clientId === clientId,
    );
    const sigOk = roundEvents.some(
      (e) => e.kind === 'signature_verified' && e.clientId === clientId,
    );
    const sigFailed = roundEvents.some(
      (e) => e.kind === 'signature_failed' && e.clientId === clientId,
    );

    let clientStatus: NodeStatus = 'pending';
    if (cm) clientStatus = cm.local_loss > 0.5 ? 'warning' : 'succeeded';

    return {
      label: resolvedLabel,
      status: clientStatus,
      duration: undefined,
      sections: [
        {
          title: 'OUTPUT',
          rows: [
            { key: 'local_loss', value: cm ? cm.local_loss.toFixed(4) : undefined },
            { key: 'local_accuracy', value: cm ? `${(cm.local_accuracy * 100).toFixed(1)}%` : undefined },
            { key: 'num_samples', value: cm ? cm.num_samples : undefined },
          ],
        },
        {
          title: 'SECURITY',
          rows: [
            { key: 'nonce', value: nonceVerified ? 'verified ✓' : 'pending' },
            { key: 'mTLS', value: mtlsOk ? 'verified ✓' : 'pending' },
            {
              key: 'signature',
              value: sigFailed ? 'failed ✗' : sigOk ? 'verified ✓' : 'pending',
              valueColor: sigFailed ? 'var(--color-status-error, #f87171)' : undefined,
            },
          ],
        },
      ],
    };
  }

  // ── security-verify ──────────────────────────────────────────────────────
  if (localId === 'security-verify') {
    const nonceVerifiedEvts = roundEvents.filter((e) => e.kind === 'nonce_verified');
    const nonceIssuedEvts   = roundEvents.filter((e) => e.kind === 'nonce_issued');
    const mtlsEvts          = roundEvents.filter((e) => e.kind === 'mtls_handshake');
    const sigVerifiedEvts   = roundEvents.filter((e) => e.kind === 'signature_verified');
    const sigFailedEvts     = roundEvents.filter((e) => e.kind === 'signature_failed');
    // Bug 6 fix: use expected_clients from round_start event as denominator
    const expectedClients   = (roundStartEvt?.data?.expected_clients as number | undefined)
      ?? Math.max(nonceVerifiedEvts.length, mtlsEvts.length, sigVerifiedEvts.length);

    let secStatus: NodeStatus = 'pending';
    if (sigFailedEvts.length > 0) secStatus = 'failed';
    else if (nonceVerifiedEvts.length > 0 || mtlsEvts.length > 0 || sigVerifiedEvts.length > 0) {
      secStatus = 'succeeded';
    }

    return {
      label: 'Security Verification',
      status: secStatus,
      duration: undefined,
      sections: [
        {
          title: 'VERIFICATION',
          rows: [
            { key: 'nonces_issued', value: nonceIssuedEvts.length || undefined },
            { key: 'nonces_verified', value: `${nonceVerifiedEvts.length}/${expectedClients || '?'}` },
            { key: 'mtls_handshakes', value: `${mtlsEvts.length}/${expectedClients || '?'}` },
            { key: 'signatures_verified', value: sigVerifiedEvts.length || undefined },
            {
              key: 'signatures_failed',
              value: sigFailedEvts.length > 0 ? sigFailedEvts.length : undefined,
              valueColor: 'var(--color-status-error, #f87171)',
            },
          ],
        },
      ],
    };
  }

  // ── he-aggregation ───────────────────────────────────────────────────────
  if (localId === 'he-aggregation') {
    const heEncryptEvt   = roundEvents.filter((e: SecurityEvent) => e.kind === 'he_encrypt').at(-1);
    const heAggEvt       = roundEvents.filter((e: SecurityEvent) => e.kind === 'he_aggregate').at(-1);
    const vssCeremonyEvt = roundEvents.filter((e: SecurityEvent) => e.kind === 'vss_ceremony').at(-1);
    const vssShareEvt    = roundEvents.filter((e: SecurityEvent) => e.kind === 'vss_share_dist').at(-1);

    // Bug 2 fix: RECESS rounds skip HE — show as skipped, not pending
    if (isRecessRoundDetail) {
      return {
        label: 'HE + Aggregation',
        status: 'warning',
        duration: undefined,
        sections: [
          {
            title: 'HOMOMORPHIC ENCRYPTION',
            rows: [{ key: 'status', value: 'skipped — RECESS detection round' }],
          },
          {
            title: 'VSS',
            rows: [
              { key: 'ceremony', value: vssCeremonyEvt ? '✓' : 'skipped' },
              { key: 'share_dist', value: vssShareEvt ? '✓' : 'skipped' },
            ],
          },
        ],
      };
    }

    let heStatus: NodeStatus = 'pending';
    if (heAggEvt) heStatus = 'succeeded';
    else if (heEncryptEvt) heStatus = 'running';

    // Build rows from he_encrypt data keys
    const heRows = heEncryptEvt?.data
      ? Object.entries(heEncryptEvt.data).map(([k, v]) => ({
          key: k,
          value: typeof v === 'object' ? JSON.stringify(v) : String(v),
        }))
      : [];

    return {
      label: 'HE + Aggregation',
      status: heStatus,
      duration: undefined,
      sections: [
        {
          title: 'HOMOMORPHIC ENCRYPTION',
          rows: heRows.length > 0 ? heRows : [{ key: 'status', value: heEncryptEvt ? 'encrypted' : 'pending' }],
        },
        {
          title: 'VSS',
          rows: [
            { key: 'ceremony', value: vssCeremonyEvt ? '✓' : 'pending' },
            { key: 'share_dist', value: vssShareEvt ? '✓' : 'pending' },
          ],
        },
      ],
    };
  }

  // ── recess-detection ─────────────────────────────────────────────────────
  if (localId === 'recess-detection') {
    const recessDetectEvts = roundEvents.filter((e) => e.kind === 'recess_detect');
    const recessFlagEvts   = roundEvents.filter((e) => e.kind === 'recess_flag');
    const detectedClients  = new Set(recessDetectEvts.map((e) => e.clientId).filter(Boolean)).size;

    const flaggedRows = recessFlagEvts.map((e) => {
      const lbl = e.clientId ? (labelMap.get(e.clientId) ?? e.clientId) : 'unknown';
      const score = (e.data?.abnormality_score ?? e.data?.score ?? null) as number | null;
      return {
        key: 'flagged',
        value: score !== null ? `${lbl} (${score.toFixed(3)})` : lbl,
        valueColor: 'var(--color-status-warning, #fb923c)',
      };
    });

    let recessStatus: NodeStatus = 'pending';
    if (recessFlagEvts.length > 0) recessStatus = 'warning';
    else if (recessDetectEvts.length > 0) recessStatus = 'succeeded';

    return {
      label: 'RECESS Detection',
      status: recessStatus,
      duration: undefined,
      sections: [
        {
          title: 'RECESS DETECTION',
          rows: [
            { key: 'clients_evaluated', value: detectedClients || undefined },
            ...flaggedRows,
            { key: 'threshold', value: '0.3' },
          ],
        },
      ],
    };
  }

  // ── enforcement ──────────────────────────────────────────────────────────
  if (localId === 'enforcement') {
    const entries = enforcementForRound ? Object.entries(enforcementForRound) : [];
    const excludedCount = entries.filter(([, v]) => v === 'excluded').length;

    const enfRows = entries.map(([cid, status]) => ({
      key: labelMap.get(cid) ?? cid,
      value: status,
      valueColor:
        status === 'excluded'
          ? 'var(--color-status-error, #f87171)'
          : status === 'downweighted'
            ? 'var(--color-status-warning, #fb923c)'
            : undefined,
    }));

    const lastRecessRound = Math.floor(selectedRound / 5) * 5;

    let enfStatus: NodeStatus = 'pending';
    if (entries.length > 0) enfStatus = excludedCount > 0 ? 'warning' : 'succeeded';

    return {
      label: 'Enforcement',
      status: enfStatus,
      duration: undefined,
      sections: [
        {
          title: 'ENFORCEMENT',
          rows: enfRows.length > 0 ? enfRows : [{ key: 'status', value: 'no data' }],
        },
        {
          title: 'TRUST SOURCE',
          rows: [
            // Bug 9 fix: rounds before the first RECESS use initial trust (1.0),
            // not 'none' which implies unknown/missing data.
            { key: 'from_round', value: lastRecessRound > 0 ? `R${lastRecessRound}` : 'initial (1.0)' },
          ],
        },
      ],
    };
  }

  // ── model-update ──────────────────────────────────────────────────────────
  if (localId === 'model-update') {
    const modelUpdatedEvt = roundEvents.filter((e: SecurityEvent) => e.kind === 'model_updated').at(-1);

    // Bug 2 fix: RECESS rounds don't update the model
    if (isRecessRoundDetail) {
      return {
        label: 'Model Update',
        status: 'warning',
        duration: undefined,
        sections: [
          {
            title: 'MODEL UPDATE',
            rows: [{ key: 'status', value: 'skipped — RECESS detection round' }],
          },
        ],
      };
    }

    const prevAcc  = prevRoundResult?.accuracy ?? null;
    const currAcc  = roundResult?.accuracy ?? null;
    const prevLoss = prevRoundResult?.loss ?? null;
    const currLoss = roundResult?.loss ?? null;

    const totalDelta = roundResult?.gradient_stats?.total_delta ?? null;

    return {
      label: 'Model Update',
      status: modelUpdatedEvt ? 'succeeded' : 'pending',
      duration: undefined,
      sections: [
        {
          title: 'MODEL UPDATE',
          rows: [
            {
              key: 'accuracy',
              value:
                prevAcc !== null && currAcc !== null
                  ? `${(prevAcc * 100).toFixed(1)}% → ${(currAcc * 100).toFixed(1)}%`
                  : currAcc !== null
                    ? `${(currAcc * 100).toFixed(1)}%`
                    : undefined,
            },
            {
              key: 'loss',
              value:
                prevLoss !== null && currLoss !== null
                  ? `${prevLoss.toFixed(3)} → ${currLoss.toFixed(3)}`
                  : currLoss !== null
                    ? currLoss.toFixed(3)
                    : undefined,
            },
            {
              key: 'total_delta',
              value: totalDelta !== null ? totalDelta.toFixed(3) : undefined,
            },
          ],
        },
      ],
    };
  }

  // ── round-complete ────────────────────────────────────────────────────────
  if (localId === 'round-complete') {
    // Bug 1 fix: accept recess_round_complete as a completion signal
    let dur: string | undefined;
    if (roundStartEvt && effectiveCompleteEvt) {
      dur = formatDuration(roundStartEvt.timestamp, effectiveCompleteEvt.timestamp);
    }

    let rcStatus: NodeStatus = 'pending';
    if (effectiveCompleteEvt) rcStatus = 'succeeded';
    else if (roundStartEvt) rcStatus = 'running';

    const summaryRows = [
      { key: 'duration', value: dur },
      { key: 'type', value: isRecessRoundDetail ? 'RECESS detection' : 'training' },
    ];
    if (!isRecessRoundDetail) {
      summaryRows.push({ key: 'next_round', value: String(selectedRound + 1) });
    }

    return {
      label: 'Round Complete',
      status: rcStatus,
      duration: dur,
      sections: [{ title: 'SUMMARY', rows: summaryRows }],
    };
  }

  return EMPTY;
}

// ── Component ──────────────────────────────────────────────────────────────

export default function EventsPipelineTab() {
  const events           = useSecurityEvents();
  const enforcementHistory = useEnforcementHistory();
  const flRoundResults   = useLiveStore((s) => s.flRoundResults);
  const labelMap         = useClientIdLabelMap();

  const [selectedRound, setSelectedRound] = useState<number | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [autoSelectLatest, setAutoSelectLatest] = useState(true);

  // ── Derive sorted unique round numbers ────────────────────────────────
  const rounds = useMemo<number[]>(() => {
    const roundSet = new Set<number>();
    for (const e of events) roundSet.add(e.round);
    return [...roundSet].sort((a, b) => a - b);
  }, [events]);

  // ── Auto-advance to latest round ──────────────────────────────────────
  useEffect(() => {
    if (!autoSelectLatest || rounds.length === 0) return;
    const latest = rounds[rounds.length - 1];
    if (selectedRound !== latest) {
      setSelectedRound(latest);
      setSelectedNodeId(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, rounds, autoSelectLatest]);
  // NOTE: `selectedRound` is intentionally omitted from deps — this effect
  // only fires when incoming event data changes, not on every render caused
  // by the round-select pill bar.

  // ── Group events by round ─────────────────────────────────────────────
  const eventsByRound = useMemo<Map<number, SecurityEvent[]>>(() => {
    const m = new Map<number, SecurityEvent[]>();
    for (const e of events) {
      const bucket = m.get(e.round) ?? [];
      bucket.push(e);
      m.set(e.round, bucket);
    }
    return m;
  }, [events]);

  // ── Build graph rows for selected round ───────────────────────────────
  const rows = useMemo<GraphRow[]>(() => {
    if (selectedRound === null) return [];
    const roundEvents = eventsByRound.get(selectedRound) ?? [];
    const roundResult = flRoundResults.find((r) => r.round === selectedRound);
    const prevRoundResult = flRoundResults.find((r) => r.round === selectedRound - 1);
    const enforcementForRound = enforcementHistory[selectedRound];
    const prefix = String(selectedRound);

    return buildPipelineRows(
      roundEvents,
      selectedRound,
      roundResult,
      prevRoundResult,
      enforcementForRound,
      labelMap,
      prefix,
    );
  }, [selectedRound, eventsByRound, flRoundResults, enforcementHistory, labelMap]);

  // ── Build detail panel for selected node ──────────────────────────────
  const detailInfo = useMemo(() => {
    if (selectedRound === null || selectedNodeId === null) {
      return { label: null as string | null, status: undefined as NodeStatus | undefined, duration: undefined as string | undefined, sections: [] as DetailSection[] };
    }
    const roundEvents = eventsByRound.get(selectedRound) ?? [];
    const roundResult = flRoundResults.find((r) => r.round === selectedRound);
    const prevRoundResult = flRoundResults.find((r) => r.round === selectedRound - 1);
    const enforcementForRound = enforcementHistory[selectedRound];
    const prefix = String(selectedRound);

    return buildDetailInfo(
      selectedNodeId,
      roundEvents,
      selectedRound,
      roundResult,
      prevRoundResult,
      enforcementForRound,
      labelMap,
      prefix,
    );
  }, [selectedRound, selectedNodeId, eventsByRound, flRoundResults, enforcementHistory, labelMap]);

  // ── Empty state ───────────────────────────────────────────────────────
  if (rounds.length === 0) {
    return (
      <div
        style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--n8n-text-muted, #9ca3af)',
          fontSize: 13,
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <svg
          width="36"
          height="36"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path
            d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span>No security events yet — start FL training</span>
      </div>
    );
  }

  // ── Handle round pill click: disable auto-select if user picks a past round
  function handleRoundSelect(round: number) {
    const latest = rounds[rounds.length - 1];
    setAutoSelectLatest(round === latest);
    setSelectedRound(round);
    setSelectedNodeId(null);
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* ── Round selector pill bar ── */}
      <div className="sfn-round-selector" role="tablist" aria-label="Select FL round">
        {rounds.map((round) => {
          const isActive  = round === selectedRound;
          const isRecess  = round % 5 === 0;
          const pillClass = `sfn-round-pill${isActive ? ' sfn-round-pill--active' : ''}`;
          return (
            <button
              key={round}
              role="tab"
              aria-selected={isActive}
              className={pillClass}
              onClick={() => handleRoundSelect(round)}
              title={isRecess ? `Round ${round} (RECESS)` : `Round ${round}`}
            >
              {isRecess && <span className="sfn-round-pill__dot" aria-hidden="true" />}
              R{round}
            </button>
          );
        })}
      </div>

      {/* ── Split layout: graph left, detail right ── */}
      <div className="sfn-layout" style={{ flex: 1, minHeight: 0 }}>
        <div className="sfn-graph-pane">
          {selectedRound !== null ? (
            <StepFunctionGraph
              rows={rows}
              selectedNodeId={selectedNodeId}
              onSelectNode={setSelectedNodeId}
            />
          ) : (
            <div
              style={{
                padding: '24px',
                color: 'var(--n8n-text-muted, #9ca3af)',
                fontSize: 13,
              }}
            >
              Select a round to view the pipeline.
            </div>
          )}
        </div>

        <div className="sfn-detail-pane">
          <StateDetailPanel
            nodeLabel={detailInfo.label}
            nodeStatus={detailInfo.status}
            nodeDuration={detailInfo.duration}
            sections={detailInfo.sections}
          />
        </div>
      </div>
    </div>
  );
}
