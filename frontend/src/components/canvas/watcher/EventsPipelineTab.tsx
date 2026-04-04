/**
 * EventsPipelineTab — "Events" tab for the Watcher drill-down UI.
 *
 * Renders an AWS Step Functions-style vertical security pipeline for each FL
 * training round.  A round selector pill-bar at the top lets the user switch
 * rounds; the graph on the left shows minimal pipeline state nodes (label +
 * status only) and the detail panel on the right shows structured metrics
 * across Input / Output / Details tabs for the selected node.
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
import type { DetailSection, KVRow, DetailTabs, TabData } from './StateDetailPanel';
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
 * Build the GraphRow[] pipeline for a given round.
 * Nodes show ONLY label + status + duration — no metrics strings.
 * All data values are surfaced in the detail panel (buildDetailInfo).
 */
function buildPipelineRows(
  roundEvents: SecurityEvent[],
  selectedRound: number,
  roundResult: RoundResult | undefined,
  _prevRoundResult: RoundResult | undefined,
  enforcementForRound: Record<string, ClientEnforcementStatus> | undefined,
  labelMap: Map<string, string>,
  prefix: string,
  allEvents: SecurityEvent[],
): GraphRow[] {
  const rows: GraphRow[] = [];

  // ── 1. Round Start ──────────────────────────────────────────────────────
  const roundStartEvt    = roundEvents.filter((e: SecurityEvent) => e.kind === 'round_start').at(-1);
  const roundCompleteEvt = roundEvents.filter((e: SecurityEvent) => e.kind === 'round_complete').at(-1);

  let roundStartDuration: string | undefined;
  if (roundStartEvt && roundCompleteEvt) {
    roundStartDuration = formatDuration(roundStartEvt.timestamp, roundCompleteEvt.timestamp);
  }

  rows.push({
    kind: 'sequential',
    node: {
      id: `${prefix}-round-start`,
      label: 'Round Start',
      metrics: [],
      status: roundStartEvt ? 'succeeded' : 'pending',
      duration: roundStartDuration,
    } satisfies StateNodeProps,
  });

  // ── 2. Dispatch ─────────────────────────────────────────────────────────
  const dispatchEvt = roundEvents.filter((e: SecurityEvent) => e.kind === 'global_dispatch').at(-1);

  rows.push({
    kind: 'sequential',
    node: {
      id: `${prefix}-dispatch`,
      label: 'Dispatch',
      metrics: [],
      status: dispatchEvt ? 'succeeded' : 'pending',
    } satisfies StateNodeProps,
  });

  // ── 3. Client Training (parallel) ──────────────────────────────────────
  const clientUpdateEvents = roundEvents.filter((e) => e.kind === 'client_update');
  const uniqueClientIds = [...new Set(clientUpdateEvents.map((e) => e.clientId).filter(Boolean) as string[])];

  uniqueClientIds.sort((a, b) => {
    const la = labelMap.get(a) ?? a;
    const lb = labelMap.get(b) ?? b;
    return la.localeCompare(lb);
  });

  if (uniqueClientIds.length > 0) {
    const clientNodes: StateNodeProps[] = uniqueClientIds.map((clientId) => {
      const resolvedLabel = labelMap.get(clientId) ?? clientId;
      const cm = roundResult?.client_metrics?.find((m) => m.client_id === clientId);

      let clientStatus: NodeStatus = 'pending';
      if (cm) clientStatus = cm.local_loss > 0.5 ? 'warning' : 'succeeded';

      return {
        id: `${prefix}-client-${clientId}`,
        label: resolvedLabel,
        metrics: [],
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
      metrics: [],
      status: securityStatus,
    } satisfies StateNodeProps,
  });

  // ── 5a. Homomorphic Encryption ──────────────────────────────────────────
  const isRecessRound = roundEvents.some((e) => e.kind === 'recess_detect');
  const heEncryptEvt  = roundEvents.filter((e: SecurityEvent) => e.kind === 'he_encrypt').at(-1);
  const heDisabled    = !isRecessRound && roundCompleteEvt != null && heEncryptEvt == null;

  let heStatus: NodeStatus = 'pending';
  if (isRecessRound)    heStatus = 'warning';
  else if (heDisabled)  heStatus = 'warning';
  else if (heEncryptEvt) heStatus = 'succeeded';

  rows.push({
    kind: 'sequential',
    node: {
      id: `${prefix}-he-encryption`,
      label: 'Homomorphic Encryption',
      metrics: [],
      status: heStatus,
    } satisfies StateNodeProps,
  });

  // ── 5b. Aggregation ────────────────────────────────────────────────────
  const heAggEvt = roundEvents.filter((e: SecurityEvent) => e.kind === 'he_aggregate').at(-1);

  let aggStatus: NodeStatus = 'pending';
  if (isRecessRound) {
    aggStatus = 'warning';
  } else if (heDisabled) {
    const modelUpdEvt = roundEvents.filter((e: SecurityEvent) => e.kind === 'model_updated').at(-1);
    aggStatus = modelUpdEvt ? 'succeeded' : 'pending';
  } else if (heAggEvt) {
    aggStatus = 'succeeded';
  }

  rows.push({
    kind: 'sequential',
    node: {
      id: `${prefix}-aggregation`,
      label: 'Aggregation',
      metrics: [],
      status: aggStatus,
    } satisfies StateNodeProps,
  });

  // ── 6. RECESS Detection (only on rounds that emitted recess_detect events) ─
  if (isRecessRound) {
    const recessDetectEvts = roundEvents.filter((e) => e.kind === 'recess_detect');
    const recessFlagEvts   = roundEvents.filter((e) => e.kind === 'recess_flag');

    let recessStatus: NodeStatus = 'pending';
    if (recessFlagEvts.length > 0)    recessStatus = 'warning';
    else if (recessDetectEvts.length > 0) recessStatus = 'succeeded';

    rows.push({
      kind: 'sequential',
      node: {
        id: `${prefix}-recess-detection`,
        label: 'RECESS Detection',
        metrics: [],
        status: recessStatus,
      } satisfies StateNodeProps,
    });
  }

  // ── 7. Enforcement ──────────────────────────────────────────────────────
  const enforcementEntries = enforcementForRound ? Object.entries(enforcementForRound) : [];
  const excludedCount = enforcementEntries.filter(([, v]) => v === 'excluded').length;

  // Suppress unused-variable warning — we only use allEvents for detail panel
  void allEvents;
  void selectedRound;

  let enforcementStatus: NodeStatus = 'pending';
  if (enforcementEntries.length > 0) {
    enforcementStatus = excludedCount > 0 ? 'warning' : 'succeeded';
  }

  rows.push({
    kind: 'sequential',
    node: {
      id: `${prefix}-enforcement`,
      label: 'Enforcement',
      metrics: [],
      status: enforcementStatus,
    } satisfies StateNodeProps,
  });

  // ── 8. Model Update ─────────────────────────────────────────────────────
  const modelUpdatedEvt = roundEvents.filter((e: SecurityEvent) => e.kind === 'model_updated').at(-1);
  let modelStatus: NodeStatus;
  if (isRecessRound) {
    modelStatus = 'warning';
  } else {
    modelStatus = modelUpdatedEvt ? 'succeeded' : 'pending';
  }

  rows.push({
    kind: 'sequential',
    node: {
      id: `${prefix}-model-update`,
      label: 'Model Update',
      metrics: [],
      status: modelStatus,
    } satisfies StateNodeProps,
  });

  // ── 9. Round Complete ───────────────────────────────────────────────────
  const recessRoundCompleteEvt = roundEvents.filter((e: SecurityEvent) => e.kind === 'recess_round_complete').at(-1);
  const effectiveCompleteEvt   = roundCompleteEvt ?? recessRoundCompleteEvt;

  let roundCompleteStatus: NodeStatus = 'pending';
  if (effectiveCompleteEvt) roundCompleteStatus = 'succeeded';
  else if (roundStartEvt)   roundCompleteStatus = 'running';

  rows.push({
    kind: 'sequential',
    node: {
      id: `${prefix}-round-complete`,
      label: 'Round Complete',
      metrics: [],
      status: roundCompleteStatus,
    } satisfies StateNodeProps,
  });

  return rows;
}

// ── Detail tab builder ─────────────────────────────────────────────────────

/**
 * Return label, status, duration, and DetailTabs (Input/Output/Details) for
 * the currently selected node ID.
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
  allEvents: SecurityEvent[],
): { label: string | null; status: NodeStatus | undefined; duration: string | undefined; tabs: DetailTabs } {
  const emptyTab: TabData = { sections: [] };
  const EMPTY: ReturnType<typeof buildDetailInfo> = {
    label: null,
    status: undefined,
    duration: undefined,
    tabs: { input: emptyTab, output: emptyTab, details: emptyTab },
  };

  if (!nodeId.startsWith(`${prefix}-`)) return EMPTY;
  const localId = nodeId.slice(prefix.length + 1);

  const roundStartEvt    = roundEvents.filter((e: SecurityEvent) => e.kind === 'round_start').at(-1);
  const roundCompleteEvt = roundEvents.filter((e: SecurityEvent) => e.kind === 'round_complete').at(-1);
  const recessCompleteEvt    = roundEvents.filter((e: SecurityEvent) => e.kind === 'recess_round_complete').at(-1);
  const effectiveCompleteEvt = roundCompleteEvt ?? recessCompleteEvt;
  const isRecessRoundDetail  = roundEvents.some((e) => e.kind === 'recess_detect');

  // ── round-start ──────────────────────────────────────────────────────────
  if (localId === 'round-start') {
    const expectedClients = roundStartEvt
      ? ((roundStartEvt.data?.expected_clients ?? '?') as string | number)
      : '?';
    const ts = roundStartEvt ? formatTime(roundStartEvt.timestamp) : undefined;
    const nonceIssuedEvt = roundEvents.filter((e: SecurityEvent) => e.kind === 'nonce_issued').at(-1);
    const noncePrefix = (nonceIssuedEvt?.data?.nonce_prefix as string | undefined) ?? undefined;

    const dur = roundStartEvt && effectiveCompleteEvt
      ? formatDuration(roundStartEvt.timestamp, effectiveCompleteEvt.timestamp)
      : undefined;

    return {
      label: 'Round Start',
      status: roundStartEvt ? 'succeeded' : 'pending',
      duration: dur,
      tabs: {
        input: {
          sections: [
            {
              title: 'ROUND',
              rows: [
                { key: 'round', value: selectedRound },
                { key: 'expected_clients', value: expectedClients },
                { key: 'nonce_prefix', value: noncePrefix },
              ],
            },
          ],
        },
        output: { sections: [] },
        details: {
          sections: [
            {
              title: 'EVENT',
              rows: [
                { key: 'name', value: 'Round Start' },
                { key: 'status', value: roundStartEvt ? 'Succeeded' : 'Pending' },
                { key: 'timestamp', value: ts },
                { key: 'duration', value: dur },
                { key: 'event_kind', value: 'round_start' },
              ],
            },
          ],
        },
      },
    };
  }

  // ── dispatch ─────────────────────────────────────────────────────────────
  if (localId === 'dispatch') {
    const dispatchEvt   = roundEvents.filter((e: SecurityEvent) => e.kind === 'global_dispatch').at(-1);
    const dispatchNorms = roundResult?.gradient_stats?.dispatch_norms ?? {};
    const layerCount    = Object.keys(dispatchNorms).length;
    const totalNorm     = Object.values(dispatchNorms).reduce((a, b) => a + b, 0);

    const evtData    = dispatchEvt?.data ?? {};
    const priorLoss  = evtData.prior_loss  as number | null | undefined;
    const priorAcc   = evtData.prior_accuracy as number | null | undefined;
    const priorRound = evtData.prior_round as number | null | undefined;
    const numClients = evtData.num_clients as number | null | undefined;
    const localEpochs = evtData.local_epochs as number | undefined;
    const lr          = evtData.lr          as number | undefined;
    const batchSize   = evtData.batch_size  as number | undefined;
    const maxBatches  = evtData.max_batches as number | undefined;

    const normRows: KVRow[] = Object.entries(dispatchNorms).map(([layer, norm]) => ({
      key: layer,
      value: norm.toFixed(4),
    }));

    return {
      label: 'Dispatch',
      status: dispatchEvt ? 'succeeded' : 'pending',
      duration: undefined,
      tabs: {
        input: {
          sections: [
            {
              title: 'PRIOR MODEL METRICS',
              rows: [
                { key: 'from_round', value: priorRound != null ? `R${priorRound}` : 'initial model' },
                { key: 'loss', value: priorLoss != null ? priorLoss.toFixed(4) : 'N/A (first round)' },
                { key: 'accuracy', value: priorAcc != null ? `${(priorAcc * 100).toFixed(1)}%` : 'N/A (first round)' },
              ],
            },
            {
              title: 'TRAINING CONFIG',
              rows: [
                { key: 'local_epochs', value: localEpochs },
                { key: 'learning_rate', value: lr != null ? lr.toFixed(5) : undefined },
                { key: 'batch_size', value: batchSize },
                { key: 'max_batches', value: maxBatches },
                { key: 'num_clients', value: numClients ?? undefined },
              ],
            },
          ],
        },
        output: {
          sections: [
            {
              title: 'DISPATCH WEIGHTS',
              rows: [
                { key: 'layers', value: layerCount || undefined },
                { key: 'total_‖W‖', value: layerCount > 0 ? totalNorm.toFixed(3) : undefined },
                ...normRows,
              ],
            },
          ],
        },
        details: {
          sections: [
            {
              title: 'EVENT',
              rows: [
                { key: 'name', value: 'Dispatch' },
                { key: 'status', value: dispatchEvt ? 'Succeeded' : 'Pending' },
                { key: 'event_kind', value: 'global_dispatch' },
              ],
            },
          ],
        },
      },
    };
  }

  // ── client-<id> ──────────────────────────────────────────────────────────
  if (localId.startsWith('client-')) {
    const clientId     = localId.slice('client-'.length);
    const resolvedLabel = labelMap.get(clientId) ?? clientId;
    const cm = roundResult?.client_metrics?.find((m) => m.client_id === clientId);

    const nonceEvt = roundEvents.find(
      (e) => e.kind === 'nonce_verified' && e.clientId === clientId,
    );
    const mtlsEvt = roundEvents.find(
      (e) => e.kind === 'mtls_handshake' && e.clientId === clientId,
    );
    const sigVerEvt = roundEvents.find(
      (e) => e.kind === 'signature_verified' && e.clientId === clientId,
    );
    const sigFailEvt = roundEvents.find(
      (e) => e.kind === 'signature_failed' && e.clientId === clientId,
    );
    const clientUpdateEvt = roundEvents.find(
      (e) => e.kind === 'client_update' && e.clientId === clientId,
    );

    let clientStatus: NodeStatus = 'pending';
    if (cm) clientStatus = cm.local_loss > 0.5 ? 'warning' : 'succeeded';

    const dispatchEvtForClient = roundEvents.filter((e: SecurityEvent) => e.kind === 'global_dispatch').at(-1);
    const dispData = dispatchEvtForClient?.data ?? {};

    // Gradient delta info from client_update event
    const cuData = clientUpdateEvt?.data ?? {};
    const layerData = cuData.layers as Array<{ layer: string; delta_norm: number }> | undefined;
    const totalDeltaNorm = cuData.total_delta_norm as number | undefined;

    const gradientRows: KVRow[] = [
      { key: 'total_‖Δ‖', value: totalDeltaNorm != null ? totalDeltaNorm.toFixed(4) : undefined },
    ];
    if (layerData) {
      for (const ld of layerData) {
        gradientRows.push({ key: `Δ ${ld.layer}`, value: ld.delta_norm.toFixed(4) });
      }
    }

    // Nonce verification section
    const nonceRows: KVRow[] = nonceEvt
      ? [
          { key: 'status', value: `verified ✓ (${(nonceEvt.data?.status as string | undefined) ?? 'ok'})` },
          { key: 'timestamp', value: formatTime(nonceEvt.timestamp) },
        ]
      : [{ key: 'status', value: 'pending' }];

    // mTLS section
    const mtlsRows: KVRow[] = mtlsEvt
      ? [
          { key: 'transport', value: 'gRPC' },
          { key: 'certificate', value: `verified ✓ (${(mtlsEvt.data?.status as string | undefined) ?? 'ok'})` },
        ]
      : [{ key: 'transport', value: 'gRPC' }, { key: 'certificate', value: 'pending' }];

    // Signature section
    let sigRows: KVRow[];
    if (sigFailEvt) {
      sigRows = [
        { key: 'algorithm', value: 'Ed25519' },
        { key: 'result', value: `failed ✗ — ${sigFailEvt.detail ?? 'unknown'}`, valueColor: 'var(--color-status-error, #f87171)' },
      ];
    } else if (sigVerEvt) {
      sigRows = [
        { key: 'algorithm', value: 'Ed25519' },
        { key: 'result', value: `verified ✓ (${sigVerEvt.detail ?? 'Ed25519 OK'})` },
      ];
    } else {
      sigRows = [
        { key: 'algorithm', value: 'Ed25519' },
        { key: 'result', value: 'pending' },
      ];
    }

    return {
      label: resolvedLabel,
      status: clientStatus,
      duration: undefined,
      tabs: {
        input: {
          sections: [
            {
              title: 'TRAINING CONFIG',
              rows: [
                { key: 'round', value: selectedRound },
                { key: 'local_epochs', value: (dispData.local_epochs as number | undefined) },
                { key: 'learning_rate', value: (dispData.lr as number | undefined)?.toFixed(5) },
                { key: 'batch_size', value: (dispData.batch_size as number | undefined) },
                { key: 'max_batches', value: (dispData.max_batches as number | undefined) },
              ],
            },
          ],
        },
        output: {
          sections: [
            {
              title: 'TRAINING RESULTS',
              rows: [
                { key: 'local_loss', value: cm ? cm.local_loss.toFixed(4) : undefined },
                { key: 'local_accuracy', value: cm ? `${(cm.local_accuracy * 100).toFixed(1)}%` : undefined },
                { key: 'num_samples', value: cm ? cm.num_samples : undefined },
              ],
            },
            {
              title: 'GRADIENT DELTAS',
              rows: gradientRows,
            },
            {
              title: 'NONCE VERIFICATION',
              rows: nonceRows,
            },
            {
              title: 'mTLS HANDSHAKE',
              rows: mtlsRows,
            },
            {
              title: 'SIGNATURE',
              rows: sigRows,
            },
          ],
        },
        details: {
          sections: [
            {
              title: 'EVENT',
              rows: [
                { key: 'name', value: resolvedLabel },
                { key: 'status', value: cm ? (cm.local_loss > 0.5 ? 'Warning' : 'Succeeded') : 'Pending' },
                { key: 'client_id', value: clientId },
                { key: 'event_kind', value: 'client_update' },
              ],
            },
          ],
        },
      },
    };
  }

  // ── security-verify ──────────────────────────────────────────────────────
  if (localId === 'security-verify') {
    const nonceVerifiedEvts = roundEvents.filter((e) => e.kind === 'nonce_verified');
    const nonceIssuedEvts   = roundEvents.filter((e) => e.kind === 'nonce_issued');
    const mtlsEvts          = roundEvents.filter((e) => e.kind === 'mtls_handshake');
    const sigVerifiedEvts   = roundEvents.filter((e) => e.kind === 'signature_verified');
    const sigFailedEvts     = roundEvents.filter((e) => e.kind === 'signature_failed');

    // Deduplicate by client ID — backend emits duplicate events per client across
    // normal-round and RECESS code paths (e.g. 4 nonce_verified for 2 clients).
    // Use the LAST event per client so we keep the most recent status.
    const dedupeByClient = (evts: SecurityEvent[]): SecurityEvent[] => {
      const seen = new Map<string, SecurityEvent>();
      for (const e of evts) {
        const key = e.clientId ?? '__unknown__';
        seen.set(key, e); // later event overwrites earlier — keeps most recent
      }
      return [...seen.values()];
    };

    const nonceVerifiedUniq = dedupeByClient(nonceVerifiedEvts);
    const mtlsUniq          = dedupeByClient(mtlsEvts);
    const sigVerifiedUniq   = dedupeByClient(sigVerifiedEvts);
    const sigFailedUniq     = dedupeByClient(sigFailedEvts);

    const expectedClients = (roundStartEvt?.data?.expected_clients as number | undefined)
      ?? Math.max(nonceVerifiedUniq.length, mtlsUniq.length, sigVerifiedUniq.length);

    let secStatus: NodeStatus = 'pending';
    if (sigFailedUniq.length > 0) secStatus = 'failed';
    else if (nonceVerifiedUniq.length > 0 || mtlsUniq.length > 0 || sigVerifiedUniq.length > 0) {
      secStatus = 'succeeded';
    }

    // Build per-client nonce table (deduplicated)
    const nonceTableRows: KVRow[] = nonceVerifiedUniq.map((e) => ({
      key: labelMap.get(e.clientId ?? '') ?? e.clientId ?? 'unknown',
      value: `echo_match ✓  (${formatTime(e.timestamp)})`,
    }));
    if (nonceTableRows.length === 0) {
      nonceTableRows.push({ key: 'status', value: 'pending' });
    }

    // Per-client mTLS table (deduplicated)
    const mtlsTableRows: KVRow[] = mtlsUniq.map((e) => ({
      key: labelMap.get(e.clientId ?? '') ?? e.clientId ?? 'unknown',
      value: `gRPC · cert verified ✓`,
    }));
    if (mtlsTableRows.length === 0) {
      mtlsTableRows.push({ key: 'status', value: 'pending' });
    }

    // Per-client signature table (already deduplicated via Set on clientId)
    const allSigClientIds = new Set<string>();
    for (const e of [...sigVerifiedUniq, ...sigFailedUniq]) {
      if (e.clientId) allSigClientIds.add(e.clientId);
    }
    const sigTableRows: KVRow[] = [...allSigClientIds].map((cid) => {
      const lbl = labelMap.get(cid) ?? cid;
      const hasFail = sigFailedUniq.some((e) => e.clientId === cid);
      const failEvt = sigFailedUniq.find((e) => e.clientId === cid);
      return hasFail
        ? {
            key: lbl,
            value: `Ed25519 · failed ✗ — ${failEvt?.detail ?? 'unknown'}`,
            valueColor: 'var(--color-status-error, #f87171)',
          }
        : { key: lbl, value: 'Ed25519 · verified ✓' };
    });
    if (sigTableRows.length === 0) sigTableRows.push({ key: 'status', value: 'pending' });

    const failuresCount = sigFailedUniq.length;

    return {
      label: 'Security Verification',
      status: secStatus,
      duration: undefined,
      tabs: {
        input: {
          sections: [
            {
              title: 'EXPECTED',
              rows: [
                { key: 'expected_clients', value: expectedClients || '?' },
                { key: 'nonces_issued', value: nonceIssuedEvts.length || undefined },
              ],
            },
          ],
        },
        output: {
          sections: [
            { title: 'NONCE VERIFICATION', rows: nonceTableRows },
            { title: 'mTLS HANDSHAKE', rows: mtlsTableRows },
            { title: 'SIGNATURE VERIFICATION', rows: sigTableRows },
            {
              title: 'SUMMARY',
              rows: [
                { key: 'nonces_verified', value: `${nonceVerifiedUniq.length}/${expectedClients || '?'}` },
                { key: 'mtls_verified', value: `${mtlsUniq.length}/${expectedClients || '?'}` },
                { key: 'sigs_verified', value: sigVerifiedUniq.length || undefined },
                {
                  key: 'failures',
                  value: failuresCount > 0 ? failuresCount : undefined,
                  valueColor: failuresCount > 0 ? 'var(--color-status-error, #f87171)' : undefined,
                },
              ],
            },
          ],
        },
        details: {
          sections: [
            {
              title: 'EVENT',
              rows: [
                { key: 'name', value: 'Security Verification' },
                { key: 'status', value: secStatus.charAt(0).toUpperCase() + secStatus.slice(1) },
                { key: 'event_kind', value: 'nonce_verified / mtls_handshake / signature_verified' },
              ],
            },
          ],
        },
      },
    };
  }

  // ── he-encryption ──────────────────────────────────────────────────────
  if (localId === 'he-encryption') {
    const heEncryptEvt   = roundEvents.filter((e: SecurityEvent) => e.kind === 'he_encrypt').at(-1);
    const vssCeremonyEvt = allEvents.filter((e: SecurityEvent) => e.kind === 'vss_ceremony').at(-1);
    const vssShareEvts   = allEvents.filter((e: SecurityEvent) => e.kind === 'vss_share_dist');

    const roundCompleteEvtDetail  = roundEvents.filter((e: SecurityEvent) => e.kind === 'round_complete').at(-1);
    const heDisabledDetail = !isRecessRoundDetail && roundCompleteEvtDetail != null && heEncryptEvt == null;

    if (isRecessRoundDetail) {
      return {
        label: 'Homomorphic Encryption',
        status: 'warning',
        duration: undefined,
        tabs: {
          input: {
            sections: [
              {
                title: 'VSS CEREMONY',
                rows: [
                  { key: 'ceremony', value: vssCeremonyEvt ? 'completed ✓' : 'skipped' },
                  { key: 'share_dist', value: vssShareEvts.length > 0 ? `distributed (${vssShareEvts.length})` : 'skipped' },
                ],
              },
            ],
          },
          output: { sections: [{ title: 'STATUS', rows: [{ key: 'status', value: 'skipped — RECESS detection round' }] }] },
          details: {
            sections: [
              { title: 'EVENT', rows: [{ key: 'name', value: 'Homomorphic Encryption' }, { key: 'status', value: 'Warning (skipped)' }, { key: 'event_kind', value: 'he_encrypt' }] },
            ],
          },
        },
      };
    }

    if (heDisabledDetail) {
      return {
        label: 'Homomorphic Encryption',
        status: 'warning',
        duration: undefined,
        tabs: {
          input: {
            sections: [
              {
                title: 'VSS CEREMONY',
                rows: [
                  { key: 'ceremony', value: 'N/A (HE off)' },
                  { key: 'share_dist', value: 'N/A (HE off)' },
                ],
              },
            ],
          },
          output: { sections: [{ title: 'STATUS', rows: [{ key: 'status', value: 'disabled — plain FedAvg used' }] }] },
          details: {
            sections: [
              { title: 'EVENT', rows: [{ key: 'name', value: 'Homomorphic Encryption' }, { key: 'status', value: 'Warning (disabled)' }, { key: 'event_kind', value: 'he_encrypt' }] },
            ],
          },
        },
      };
    }

    let heStatus: NodeStatus = 'pending';
    if (heEncryptEvt) heStatus = 'succeeded';

    const heData = heEncryptEvt?.data ?? {};
    const encLayers = heData.layers as Array<{ layer: string; cipher_kb?: number; decrypted_preview?: number[] }> | undefined;

    // Per-layer ciphertext rows for output
    const perLayerRows: KVRow[] = encLayers
      ? encLayers.map((el) => ({
          key: el.layer,
          value: el.cipher_kb != null ? `${el.cipher_kb} KB` : 'encrypted',
        }))
      : [];

    // VSS per-client commitments
    const vssShareCommitRows: KVRow[] = vssShareEvts.map((e) => {
      const lbl = labelMap.get(e.clientId ?? '') ?? e.clientId ?? 'unknown';
      const commit = (e.data?.commitment_prefix as string | undefined) ?? '—';
      return { key: lbl, value: commit };
    });

    return {
      label: 'Homomorphic Encryption',
      status: heStatus,
      duration: undefined,
      tabs: {
        input: {
          sections: [
            {
              title: 'CKKS PARAMETERS',
              rows: [
                { key: 'scheme', value: 'CKKS' },
                { key: 'poly_modulus', value: (heData.poly_modulus as number | undefined) ?? undefined },
                { key: 'layers', value: (heData.num_layers as number | undefined) ?? undefined },
                { key: 'clients', value: (heData.num_clients as number | undefined) ?? undefined },
              ],
            },
            {
              title: 'VSS CEREMONY',
              rows: [
                { key: 'ceremony_round', value: vssCeremonyEvt ? (vssCeremonyEvt.round ?? 0) : undefined },
                ...(vssShareCommitRows.length > 0 ? vssShareCommitRows : [{ key: 'share_distribution', value: vssCeremonyEvt ? 'completed ✓' : 'pending' }]),
              ],
            },
          ],
        },
        output: {
          sections: [
            {
              title: 'ENCRYPTION RESULT',
              rows: [
                { key: 'enc_time', value: (heData.enc_time_sec as number | undefined) != null ? `${heData.enc_time_sec}s` : undefined },
                { key: 'total_cipher_kb', value: (heData.total_cipher_kb as number | undefined) != null ? `${heData.total_cipher_kb} KB` : undefined },
              ],
            },
            ...(perLayerRows.length > 0
              ? [{ title: 'PER-LAYER CIPHERTEXT', rows: perLayerRows }]
              : []),
          ],
        },
        details: {
          sections: [
            {
              title: 'EVENT',
              rows: [
                { key: 'name', value: 'Homomorphic Encryption' },
                { key: 'status', value: heStatus.charAt(0).toUpperCase() + heStatus.slice(1) },
                { key: 'event_kind', value: 'he_encrypt' },
              ],
            },
          ],
        },
      },
    };
  }

  // ── aggregation ──────────────────────────────────────────────────────────
  if (localId === 'aggregation') {
    const heAggEvtAgg      = roundEvents.filter((e: SecurityEvent) => e.kind === 'he_aggregate').at(-1);
    const heEncryptEvtAgg  = roundEvents.filter((e: SecurityEvent) => e.kind === 'he_encrypt').at(-1);
    const roundCompleteEvtAgg = roundEvents.filter((e: SecurityEvent) => e.kind === 'round_complete').at(-1);
    const heDisabledAgg = !isRecessRoundDetail && roundCompleteEvtAgg != null && heEncryptEvtAgg == null;

    if (isRecessRoundDetail) {
      return {
        label: 'Aggregation',
        status: 'warning',
        duration: undefined,
        tabs: {
          input: { sections: [] },
          output: { sections: [{ title: 'STATUS', rows: [{ key: 'status', value: 'skipped — RECESS detection round' }] }] },
          details: {
            sections: [
              { title: 'EVENT', rows: [{ key: 'name', value: 'Aggregation' }, { key: 'status', value: 'Warning (skipped)' }, { key: 'event_kind', value: 'he_aggregate' }] },
            ],
          },
        },
      };
    }

    const aggData    = heAggEvtAgg?.data ?? {};
    const totalDelta = roundResult?.gradient_stats?.total_delta ?? null;
    const deltaNorms = roundResult?.gradient_stats?.delta_norms ?? {};
    const postNorms  = roundResult?.gradient_stats?.post_norms ?? {};

    // HE decrypt event for VSS threshold decryption output
    const heDecryptEvt = roundEvents.filter((e: SecurityEvent) => e.kind === 'he_decrypt').at(-1);
    const decData = heDecryptEvt?.data ?? {};
    const decLayers = decData.layers as Array<{
      layer: string;
      delta_agg_norm?: number;
      decrypted_preview?: number[];
    }> | undefined;

    // Per-layer post-aggregation norm rows
    const postLayerRows: KVRow[] = Object.entries(postNorms).map(([layer, norm]) => {
      const deltaNorm = deltaNorms[layer];
      return {
        key: layer,
        value: deltaNorm != null
          ? `‖W‖=${norm.toFixed(4)}  Δ=${deltaNorm.toFixed(4)}`
          : `‖W‖=${norm.toFixed(4)}`,
      };
    });

    // VSS decrypted layer rows (delta_agg_norm summary; preview shown via LayerValuesPreview)
    const decLayerRows: KVRow[] = decLayers
      ? decLayers.map((dl) => ({
          key: dl.layer,
          value: dl.delta_agg_norm != null ? `‖Δ_agg‖=${dl.delta_agg_norm.toFixed(4)}` : 'decrypted',
        }))
      : [];

    const inputRows: KVRow[] = heDisabledAgg
      ? [
          { key: 'method', value: 'plain FedAvg (HE disabled)' },
          { key: 'weighting', value: 'trust_weight' },
        ]
      : [
          { key: 'method', value: 'CKKS FedAvg' },
          { key: 'weighting', value: 'trust_weight' },
          { key: 'num_clients', value: (aggData.num_clients as number | undefined) ?? undefined },
          { key: 'num_layers', value: (aggData.num_layers as number | undefined) ?? undefined },
          { key: 'he_poly_modulus', value: (aggData.he_poly_modulus as number | undefined) ?? undefined },
        ];

    let aggStatus: NodeStatus = 'pending';
    if (heDisabledAgg) {
      const modelUpdEvtAgg = roundEvents.filter((e: SecurityEvent) => e.kind === 'model_updated').at(-1);
      aggStatus = modelUpdEvtAgg ? 'succeeded' : 'pending';
    } else if (heAggEvtAgg) {
      aggStatus = 'succeeded';
    }

    const outputSections: DetailSection[] = [];
    outputSections.push({
      title: 'HE AGGREGATION',
      rows: [
        { key: 'agg_time', value: (aggData.agg_time_sec as number | undefined) != null ? `${aggData.agg_time_sec}s` : undefined },
        { key: 'total_‖Δ‖', value: totalDelta !== null ? totalDelta.toFixed(4) : undefined },
      ],
    });
    if (decLayerRows.length > 0) {
      outputSections.push({ title: 'VSS THRESHOLD DECRYPTION', rows: decLayerRows });
    }
    if (postLayerRows.length > 0) {
      outputSections.push({ title: 'POST-AGGREGATION WEIGHTS', rows: postLayerRows });
    }

    return {
      label: 'Aggregation',
      status: aggStatus,
      duration: undefined,
      tabs: {
        input: { sections: [{ title: 'AGGREGATION CONFIG', rows: inputRows }] },
        output: { sections: outputSections },
        details: {
          sections: [
            {
              title: 'EVENT',
              rows: [
                { key: 'name', value: 'Aggregation' },
                { key: 'status', value: aggStatus.charAt(0).toUpperCase() + aggStatus.slice(1) },
                { key: 'event_kind', value: heDisabledAgg ? 'model_updated (plain FedAvg)' : 'he_aggregate' },
              ],
            },
          ],
        },
      },
    };
  }

  // ── recess-detection ─────────────────────────────────────────────────────
  if (localId === 'recess-detection') {
    const recessDetectEvts     = roundEvents.filter((e) => e.kind === 'recess_detect');
    const recessFlagEvts       = roundEvents.filter((e) => e.kind === 'recess_flag');
    const recessProbeEvt       = roundEvents.filter((e) => e.kind === 'recess_probe_built').at(-1);
    const recessScoreEvts      = roundEvents.filter((e) => e.kind === 'recess_score_computed');
    const detectedClients      = new Set(recessDetectEvts.map((e) => e.clientId).filter(Boolean)).size;

    let recessStatus: NodeStatus = 'pending';
    if (recessFlagEvts.length > 0)      recessStatus = 'warning';
    else if (recessDetectEvts.length > 0) recessStatus = 'succeeded';

    // Probe info from recess_probe_built event
    const probeData = recessProbeEvt?.data ?? {};
    const probeInputRows: KVRow[] = [
      { key: 'flag_threshold', value: '0.7' },
      { key: 'clients_evaluated', value: detectedClients || undefined },
      { key: 'probe_num_elements', value: (probeData.num_elements as number | undefined) ?? undefined },
      { key: 'probe_norm', value: (probeData.probe_norm as number | undefined) != null ? (probeData.probe_norm as number).toFixed(4) : undefined },
    ];

    // Per-client analysis from recess_score_computed events
    const clientAnalysisSections: DetailSection[] = recessScoreEvts.map((evt) => {
      const lbl = evt.clientId ? (labelMap.get(evt.clientId) ?? evt.clientId) : 'unknown';
      const d = evt.data ?? {};
      const isFlagged = recessFlagEvts.some((fe) => fe.clientId === evt.clientId);
      return {
        title: lbl.toUpperCase(),
        rows: [
          { key: 'abnormality', value: (d.abnormality_score as number | undefined) != null ? (d.abnormality_score as number).toFixed(4) : undefined },
          { key: 'direction_score', value: (d.direction_score as number | undefined) != null ? (d.direction_score as number).toFixed(4) : undefined },
          { key: 'magnitude_score', value: (d.magnitude_score as number | undefined) != null ? (d.magnitude_score as number).toFixed(4) : undefined },
          { key: 'cos_sim', value: (d.cos_sim as number | undefined) != null ? (d.cos_sim as number).toFixed(4) : undefined },
          { key: 'mag_ratio', value: (d.mag_ratio as number | undefined) != null ? (d.mag_ratio as number).toFixed(4) : undefined },
          { key: 'residual_norm', value: (d.residual_norm as number | undefined) != null ? (d.residual_norm as number).toFixed(4) : undefined },
          {
            key: 'verdict',
            value: isFlagged ? 'flagged ⚠' : 'ok ✓',
            valueColor: isFlagged ? 'var(--color-status-warning, #fb923c)' : undefined,
          },
        ],
      };
    });

    return {
      label: 'RECESS Detection',
      status: recessStatus,
      duration: undefined,
      tabs: {
        input: { sections: [{ title: 'RECESS INPUT', rows: probeInputRows }] },
        output: {
          sections: clientAnalysisSections.length > 0
            ? clientAnalysisSections
            : [{ title: 'STATUS', rows: [{ key: 'status', value: 'no score data yet' }] }],
        },
        details: {
          sections: [
            {
              title: 'EVENT',
              rows: [
                { key: 'name', value: 'RECESS Detection' },
                { key: 'status', value: recessStatus.charAt(0).toUpperCase() + recessStatus.slice(1) },
                { key: 'event_kind', value: 'recess_detect / recess_flag' },
              ],
            },
          ],
        },
      },
    };
  }

  // ── enforcement ──────────────────────────────────────────────────────────
  if (localId === 'enforcement') {
    const entries = enforcementForRound ? Object.entries(enforcementForRound) : [];
    const excludedCount = entries.filter(([, v]) => v === 'excluded').length;

    const enfRows: KVRow[] = entries.map(([cid, status]) => ({
      key: labelMap.get(cid) ?? cid,
      value: status,
      valueColor:
        status === 'excluded'
          ? 'var(--color-status-error, #f87171)'
          : status === 'downweighted'
            ? 'var(--color-status-warning, #fb923c)'
            : undefined,
    }));

    const recessRoundsBeforeCurrentDetail = allEvents
      .filter((e) => e.kind === 'recess_detect' && e.round <= selectedRound)
      .map((e) => e.round);
    const lastRecessRound = recessRoundsBeforeCurrentDetail.length > 0
      ? Math.max(...recessRoundsBeforeCurrentDetail)
      : 0;

    let enfStatus: NodeStatus = 'pending';
    if (entries.length > 0) enfStatus = excludedCount > 0 ? 'warning' : 'succeeded';

    return {
      label: 'Enforcement',
      status: enfStatus,
      duration: undefined,
      tabs: {
        input: {
          sections: [
            {
              title: 'ENFORCEMENT CONFIG',
              rows: [
                { key: 'trust_source_round', value: lastRecessRound > 0 ? `R${lastRecessRound}` : 'initial (1.0)' },
                { key: 'flag_threshold', value: '0.3' },
                { key: 'downweight_threshold', value: '0.5' },
              ],
            },
          ],
        },
        output: {
          sections: [
            {
              title: 'PER-CLIENT ENFORCEMENT',
              rows: enfRows.length > 0
                ? enfRows
                : [{ key: 'status', value: 'no data' }],
            },
          ],
        },
        details: {
          sections: [
            {
              title: 'EVENT',
              rows: [
                { key: 'name', value: 'Enforcement' },
                { key: 'status', value: enfStatus.charAt(0).toUpperCase() + enfStatus.slice(1) },
                { key: 'event_kind', value: 'enforcement' },
              ],
            },
          ],
        },
      },
    };
  }

  // ── model-update ──────────────────────────────────────────────────────────
  if (localId === 'model-update') {
    const modelUpdatedEvt = roundEvents.filter((e: SecurityEvent) => e.kind === 'model_updated').at(-1);

    if (isRecessRoundDetail) {
      return {
        label: 'Model Update',
        status: 'warning',
        duration: undefined,
        tabs: {
          input: { sections: [] },
          output: { sections: [{ title: 'STATUS', rows: [{ key: 'status', value: 'skipped — RECESS detection round' }] }] },
          details: {
            sections: [
              { title: 'EVENT', rows: [{ key: 'name', value: 'Model Update' }, { key: 'status', value: 'Warning (skipped)' }, { key: 'event_kind', value: 'model_updated' }] },
            ],
          },
        },
      };
    }

    const prevAcc  = prevRoundResult?.accuracy  ?? null;
    const currAcc  = roundResult?.accuracy       ?? null;
    const prevLoss = prevRoundResult?.loss        ?? null;
    const currLoss = roundResult?.loss            ?? null;
    const totalDelta = roundResult?.gradient_stats?.total_delta ?? null;

    // From model_updated event payload
    const muData = modelUpdatedEvt?.data ?? {};
    const muLayers = muData.layers as Array<{
      layer: string; weight_norm: number; delta_from_prior: number;
    }> | undefined;

    const perLayerRows: KVRow[] = muLayers
      ? muLayers.map((l) => ({
          key: l.layer,
          value: `‖W‖=${l.weight_norm.toFixed(4)}  Δ=${l.delta_from_prior.toFixed(4)}`,
        }))
      : [];

    return {
      label: 'Model Update',
      status: modelUpdatedEvt ? 'succeeded' : 'pending',
      duration: undefined,
      tabs: {
        input: {
          sections: [
            {
              title: 'PRIOR MODEL',
              rows: [
                { key: 'prior_accuracy', value: prevAcc !== null ? `${(prevAcc * 100).toFixed(1)}%` : undefined },
                { key: 'prior_loss', value: prevLoss !== null ? prevLoss.toFixed(4) : undefined },
              ],
            },
          ],
        },
        output: {
          sections: [
            {
              title: 'UPDATED MODEL',
              rows: [
                {
                  key: 'accuracy',
                  value: prevAcc !== null && currAcc !== null
                    ? `${(prevAcc * 100).toFixed(1)}% → ${(currAcc * 100).toFixed(1)}%`
                    : currAcc !== null ? `${(currAcc * 100).toFixed(1)}%` : undefined,
                },
                {
                  key: 'loss',
                  value: prevLoss !== null && currLoss !== null
                    ? `${prevLoss.toFixed(3)} → ${currLoss.toFixed(3)}`
                    : currLoss !== null ? currLoss.toFixed(3) : undefined,
                },
                { key: 'total_delta', value: totalDelta !== null ? totalDelta.toFixed(4) : undefined },
              ],
            },
            ...(perLayerRows.length > 0
              ? [{ title: 'PER-LAYER WEIGHTS', rows: perLayerRows }]
              : []),
          ],
        },
        details: {
          sections: [
            {
              title: 'EVENT',
              rows: [
                { key: 'name', value: 'Model Update' },
                { key: 'status', value: modelUpdatedEvt ? 'Succeeded' : 'Pending' },
                { key: 'event_kind', value: 'model_updated' },
              ],
            },
          ],
        },
      },
    };
  }

  // ── round-complete ────────────────────────────────────────────────────────
  if (localId === 'round-complete') {
    let dur: string | undefined;
    if (roundStartEvt && effectiveCompleteEvt) {
      dur = formatDuration(roundStartEvt.timestamp, effectiveCompleteEvt.timestamp);
    }

    let rcStatus: NodeStatus = 'pending';
    if (effectiveCompleteEvt) rcStatus = 'succeeded';
    else if (roundStartEvt)   rcStatus = 'running';

    const currAcc  = roundResult?.accuracy ?? null;
    const currLoss = roundResult?.loss ?? null;

    return {
      label: 'Round Complete',
      status: rcStatus,
      duration: dur,
      tabs: {
        input: { sections: [] },
        output: {
          sections: [
            {
              title: 'ROUND SUMMARY',
              rows: [
                { key: 'duration', value: dur },
                { key: 'type', value: isRecessRoundDetail ? 'RECESS detection' : 'training' },
                { key: 'next_round', value: isRecessRoundDetail ? undefined : String(selectedRound + 1) },
                { key: 'final_accuracy', value: currAcc !== null ? `${(currAcc * 100).toFixed(1)}%` : undefined },
                { key: 'final_loss', value: currLoss !== null ? currLoss.toFixed(4) : undefined },
              ],
            },
          ],
        },
        details: {
          sections: [
            {
              title: 'EVENT',
              rows: [
                { key: 'name', value: 'Round Complete' },
                { key: 'status', value: rcStatus.charAt(0).toUpperCase() + rcStatus.slice(1) },
                { key: 'start_ts', value: roundStartEvt ? formatTime(roundStartEvt.timestamp) : undefined },
                { key: 'end_ts', value: effectiveCompleteEvt ? formatTime(effectiveCompleteEvt.timestamp) : undefined },
                { key: 'event_kind', value: isRecessRoundDetail ? 'recess_round_complete' : 'round_complete' },
              ],
            },
          ],
        },
      },
    };
  }

  return EMPTY;
}

// ── Component ──────────────────────────────────────────────────────────────

export default function EventsPipelineTab() {
  const events             = useSecurityEvents();
  const enforcementHistory = useEnforcementHistory();
  const flRoundResults     = useLiveStore((s) => s.flRoundResults);
  const labelMap           = useClientIdLabelMap();

  const [selectedRound, setSelectedRound]     = useState<number | null>(null);
  const [selectedNodeId, setSelectedNodeId]   = useState<string | null>(null);
  const [autoSelectLatest, setAutoSelectLatest] = useState(true);

  // ── Derive sorted unique round numbers ────────────────────────────────
  const rounds = useMemo<number[]>(() => {
    const roundSet = new Set<number>();
    for (const e of events) roundSet.add(e.round);
    roundSet.delete(0); // Round 0 = VSS ceremony, not a real training round
    return [...roundSet].sort((a, b) => a - b);
  }, [events]);

  // ── Derive set of rounds that had actual RECESS detection ─────────────
  const recessRoundNums = useMemo<Set<number>>(() => {
    const s = new Set<number>();
    for (const e of events) {
      if (e.kind === 'recess_detect') s.add(e.round);
    }
    return s;
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
      events,
    );
  }, [selectedRound, eventsByRound, flRoundResults, enforcementHistory, labelMap, events]);

  // ── Build detail panel for selected node ──────────────────────────────
  const detailInfo = useMemo(() => {
    if (selectedRound === null || selectedNodeId === null) {
      return {
        label: null as string | null,
        status: undefined as NodeStatus | undefined,
        duration: undefined as string | undefined,
        tabs: undefined as DetailTabs | undefined,
      };
    }
    const roundEvents = eventsByRound.get(selectedRound) ?? [];
    const roundResult = flRoundResults.find((r) => r.round === selectedRound);
    const prevRoundResult = flRoundResults.find((r) => r.round === selectedRound - 1);
    const enforcementForRound = enforcementHistory[selectedRound];
    const prefix = String(selectedRound);

    const result = buildDetailInfo(
      selectedNodeId,
      roundEvents,
      selectedRound,
      roundResult,
      prevRoundResult,
      enforcementForRound,
      labelMap,
      prefix,
      events,
    );
    return { ...result, tabs: result.label !== null ? result.tabs : undefined };
  }, [selectedRound, selectedNodeId, eventsByRound, flRoundResults, enforcementHistory, labelMap, events]);

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
          const isRecess  = recessRoundNums.has(round);
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
            tabs={detailInfo.tabs}
          />
        </div>
      </div>
    </div>
  );
}
