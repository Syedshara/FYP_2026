/**
 * liveStore — Zustand store for real-time WebSocket data.
 *
 * Holds ring-buffered predictions, FL training progress,
 * client/device statuses — all updated by WebSocket messages.
 */

import { create } from 'zustand';
import type { ClientTrustUpdatePayload, ClientFlaggedPayload, TrustScoreComponents, ClientEnforcementStatus, AggregationEnforcementPayload, GradientStats } from '../types/index';

// ── Types ──────────────────────────────────────────────

export interface LivePrediction {
  id?: number;
  device_id: string;
  device_name?: string;
  client_id?: number;
  /** FL client string ID (e.g. "client_abc123") — bridges predictions to canvas Client nodes */
  client_string_id?: string;
  score: number;
  label: string;
  confidence: number;
  attack_type?: string;
  inference_latency_ms?: number;
  model_version?: string;
  timestamp: string;
}

export interface FLClientProgress {
  client_id: string;
  status: string;           // training | encrypting | sending | idle | done | waiting
  current_epoch: number;
  total_epochs: number;
  local_loss: number;
  local_accuracy: number;
  num_samples: number;
  progress_pct: number;     // 0-100
  // ── Per-batch detailed progress (Task 4) ──
  batch?: number;                // current batch within epoch
  total_batches?: number;        // batches per epoch
  batches_processed?: number;    // cumulative batches across all epochs
  grand_total_batches?: number;  // total batches across all epochs
  samples_processed?: number;    // cumulative samples processed
  total_samples?: number;        // total samples to process
  throughput?: number;           // samples/sec
  eta_seconds?: number;          // estimated time remaining (sec)
  current_loss?: number;         // running loss
  current_accuracy?: number;     // running accuracy
  last_update_time?: string;     // ISO timestamp of last progress update
}

export interface FLGlobalProgress {
  is_training: boolean;
  current_round: number;
  total_rounds: number;
  global_loss: number | null;
  global_accuracy: number | null;
  aggregation_method?: string;
  use_he?: boolean;
  expected_clients?: number;
}

export interface LiveClientStatus {
  client_id: number;
  client_name?: string;
  status: string;          // active | inactive | training | error
  container_status: string; // running | exited | not_found
}

export interface LiveDeviceStatus {
  device_id: string;
  device_name?: string;
  status: string;         // online | offline | under_attack | quarantined
}

// ── Attack run live status ──

export interface AttackRunLiveStatus {
  run_id: string;
  attack_id: string;
  status: string;         // pending | running | completed | failed | cancelled
  packets_sent?: number;
  duration_seconds?: number;
  error_message?: string;
  results?: Record<string, unknown>;
}

// ── Ring buffer sizes ──
const MAX_PREDICTIONS = 50;
const MAX_DEVICE_HISTORY = 200;   // per-device prediction history for Monitor charts
const MAX_FLAGGED_EVENTS = 100;
const MAX_ATTACK_RESULTS = 50;
const MAX_SECURITY_EVENTS = 200;

// ── Security pipeline events (Phase 3) ──

export type SecurityEventKind =
  | 'nonce_issued'
  | 'nonce_verified'
  | 'signature_verified'
  | 'signature_failed'
  | 'he_encrypt'
  | 'he_decrypt'
  | 'he_aggregate'
  | 'vss_ceremony'
  | 'vss_share_dist'
  | 'mtls_handshake'
  | 'recess_detect'
  | 'recess_flag'
  | 'round_start'
  | 'round_complete'
  | 'global_dispatch'
  | 'client_update'
  | 'model_updated'
  // ── Granular RECESS detection events (Phase 3, Sprint 3) ──
  | 'recess_probe_built'
  | 'recess_probe_dispatched'
  | 'recess_response_received'
  | 'recess_vss_decrypt'
  | 'recess_score_computed'
  | 'recess_decision'
  | 'recess_round_complete';

export interface SecurityEvent {
  kind: SecurityEventKind;
  round: number;
  clientId?: string;
  detail?: string;
  /** Structured metrics payload — present on HE events (he_encrypt, he_aggregate, he_decrypt). */
  data?: Record<string, unknown>;
  timestamp: string;
}

// ── Store ──────────────────────────────────────────────

interface LiveState {
  // Ring-buffered predictions (last N for display + counting)
  latestPredictions: LivePrediction[];
  addPrediction: (p: LivePrediction) => void;
  clearPredictions: () => void;

  // Per-device prediction history (larger buffer for Monitor charts)
  devicePredictionHistory: Record<string, LivePrediction[]>;
  clearDevicePredictionHistory: () => void;

  // FL training progress per client
  flClientProgress: Record<string, FLClientProgress>;
  setFLClientProgress: (clientId: string, progress: FLClientProgress) => void;
  clearFLProgress: () => void;

  // FL global progress
  flGlobalProgress: FLGlobalProgress | null;
  setFLGlobalProgress: (progress: FLGlobalProgress) => void;

  // FL round results (accumulated during training)
  flRoundResults: Array<{
    round: number;
    loss: number | null;
    accuracy: number | null;
    gradient_stats?: GradientStats;
    client_metrics?: Array<{ client_id: string; local_loss: number; local_accuracy: number; num_samples: number }>;
  }>;
  addFLRoundResult: (
    round: number,
    loss: number | null,
    accuracy: number | null,
    gradient_stats?: GradientStats,
    client_metrics?: Array<{ client_id: string; local_loss: number; local_accuracy: number; num_samples: number }>,
  ) => void;
  clearFLRoundResults: () => void;

  // FL per-client round history (for multi-line charts)
  flClientRoundHistory: Record<string, Array<{ round: number; loss: number; accuracy: number }>>;
  addFLClientRoundEntry: (clientId: string, round: number, loss: number, accuracy: number) => void;
  clearFLClientRoundHistory: () => void;

  // Client statuses (container running/stopped, client active/inactive)
  clientStatuses: Record<number, LiveClientStatus>;
  setClientStatus: (id: number, status: LiveClientStatus) => void;

  // Device statuses
  deviceStatuses: Record<string, LiveDeviceStatus>;
  setDeviceStatus: (id: string, status: LiveDeviceStatus) => void;

  // WebSocket connection state (mirrored from hook for non-component access)
  wsConnected: boolean;
  setWsConnected: (v: boolean) => void;

  // ── Security: client trust scores (CLIENT_TRUST_UPDATE) ──
  trustScores: Record<string, number>;
  currentDetectionRound: number | null;
  trustScoreHistory: Record<string, Array<{ round: number; score: number; components?: TrustScoreComponents }>>;
  setTrustScores: (payload: ClientTrustUpdatePayload) => void;
  hydrateTrustState: (
    scores: Record<string, number>,
    rounds: Array<{ round: number; scores: Record<string, number>; flagged: string[]; timestamp?: string }>,
    flagged: Array<{ client_id: string; round: number; abnormality: number; timestamp?: string }>,
  ) => void;
  clearTrustScores: () => void;

  // ── Security: flagged client events (CLIENT_FLAGGED) ──
  flaggedEvents: Array<{ clientId: string; round: number; abnormality: number; timestamp: string }>;
  addFlaggedEvent: (payload: ClientFlaggedPayload) => void;

  // ── Attack run live statuses (ATTACK_STATUS / ATTACK_RESULT) ──
  attackRunStatuses: Record<string, AttackRunLiveStatus>;
  setAttackRunStatus: (status: AttackRunLiveStatus) => void;
  clearAttackRunStatuses: () => void;

  // ── Attack completed results (ring buffer for history) ──
  attackResults: AttackRunLiveStatus[];
  addAttackResult: (result: AttackRunLiveStatus) => void;

  // ── Security pipeline events (SECURITY_EVENT) ──
  securityEvents: SecurityEvent[];
  addSecurityEvent: (evt: SecurityEvent) => void;
  clearSecurityEvents: () => void;

  // ── Aggregation enforcement (AGGREGATION_ENFORCEMENT) ──
  clientEnforcementStatus: Record<string, ClientEnforcementStatus>;
  lastEnforcementRound: number | null;
  setEnforcementStatus: (payload: AggregationEnforcementPayload) => void;
  hydrateEnforcementStatus: (enforcement: Record<string, ClientEnforcementStatus>) => void;
}

export const useLiveStore = create<LiveState>()((set) => ({
  // ── Predictions ──
  latestPredictions: [],
  clearPredictions: () => set({ latestPredictions: [] }),
  addPrediction: (p) =>
    set((state) => {
      // Also maintain per-device history for Monitor drill-down charts
      const devId = p.device_id;
      const prev = state.devicePredictionHistory[devId] ?? [];
      const next = [...prev, p].slice(-MAX_DEVICE_HISTORY);
      return {
        latestPredictions: [p, ...state.latestPredictions].slice(0, MAX_PREDICTIONS),
        devicePredictionHistory: { ...state.devicePredictionHistory, [devId]: next },
      };
    }),

  // Per-device prediction history
  devicePredictionHistory: {},
  clearDevicePredictionHistory: () => set({ devicePredictionHistory: {} }),

  // ── FL Client Progress ──
  flClientProgress: {},
  setFLClientProgress: (clientId, progress) =>
    set((state) => ({
      flClientProgress: { ...state.flClientProgress, [clientId]: progress },
    })),
  clearFLProgress: () =>
    set({ flClientProgress: {}, flGlobalProgress: null }),

  // ── FL Global Progress ──
  flGlobalProgress: null,
  setFLGlobalProgress: (progress) =>
    set({ flGlobalProgress: progress }),

  // ── FL Round Results ──
  flRoundResults: [],
  addFLRoundResult: (round, loss, accuracy, gradient_stats, client_metrics) =>
    set((state) => ({
      flRoundResults: [...state.flRoundResults, { round, loss, accuracy, gradient_stats, client_metrics }],
    })),
  clearFLRoundResults: () =>
    set({ flRoundResults: [] }),

  // ── FL Per-Client Round History ──
  flClientRoundHistory: {},
  addFLClientRoundEntry: (clientId, round, loss, accuracy) =>
    set((state) => {
      const prev = state.flClientRoundHistory[clientId] ?? [];
      return {
        flClientRoundHistory: {
          ...state.flClientRoundHistory,
          [clientId]: [...prev, { round, loss, accuracy }],
        },
      };
    }),
  clearFLClientRoundHistory: () =>
    set({ flClientRoundHistory: {} }),

  // ── Client Statuses ──
  clientStatuses: {},
  setClientStatus: (id, status) =>
    set((state) => ({
      clientStatuses: { ...state.clientStatuses, [id]: status },
    })),

  // ── Device Statuses ──
  deviceStatuses: {},
  setDeviceStatus: (id, status) =>
    set((state) => ({
      deviceStatuses: { ...state.deviceStatuses, [id]: status },
    })),

  // ── WS Connected ──
  wsConnected: false,
  setWsConnected: (v) => set({ wsConnected: v }),

  // ── Trust Scores ──
  trustScores: {},
  currentDetectionRound: null,
  trustScoreHistory: {},
  setTrustScores: (payload) =>
    set((state) => {
      // Append each client's score to history (capped at 10 per client)
      const newHistory = { ...state.trustScoreHistory };
      for (const [cid, score] of Object.entries(payload.scores)) {
        const prev = newHistory[cid] ?? [];
        const entry = {
          round: payload.round,
          score,
          components: payload.components?.[cid],
        };
        newHistory[cid] = [...prev, entry].slice(-10);
      }
      return {
        trustScores: payload.scores,
        currentDetectionRound: payload.round,
        trustScoreHistory: newHistory,
      };
    }),

  hydrateTrustState: (scores, rounds, flagged) =>
    set(() => {
      // Rebuild history from detection rounds (sorted ascending)
      const history: Record<string, Array<{ round: number; score: number; components?: TrustScoreComponents }>> = {};
      const sorted = [...rounds].sort((a, b) => a.round - b.round);
      for (const dr of sorted) {
        for (const [cid, score] of Object.entries(dr.scores)) {
          const prev = history[cid] ?? [];
          history[cid] = [...prev, { round: dr.round, score }].slice(-10);
        }
      }
      const lastRound = sorted.length > 0 ? sorted[sorted.length - 1].round : null;

      // Map flagged events
      const flaggedEvents = flagged
        .slice()
        .sort((a, b) => b.round - a.round)
        .map((f) => ({
          clientId: f.client_id,
          round: f.round,
          abnormality: f.abnormality,
          timestamp: f.timestamp ?? new Date().toISOString(),
        }))
        .slice(0, MAX_FLAGGED_EVENTS);

      return {
        trustScores: scores,
        currentDetectionRound: lastRound,
        trustScoreHistory: history,
        flaggedEvents,
      };
    }),

  clearTrustScores: () =>
    set({ trustScores: {}, currentDetectionRound: null, trustScoreHistory: {}, flaggedEvents: [] }),

  // ── Flagged Events ──
  flaggedEvents: [],
  addFlaggedEvent: (payload) =>
    set((state) => {
      const next = [
        ...state.flaggedEvents,
        {
          clientId: payload.clientId,
          round: payload.round,
          abnormality: payload.abnormality,
          timestamp: payload.timestamp ?? new Date().toISOString(),
        },
      ];
      return { flaggedEvents: next.slice(-MAX_FLAGGED_EVENTS) };
    }),

  // ── Attack Run Statuses ──
  attackRunStatuses: {},
  setAttackRunStatus: (status) =>
    set((state) => ({
      attackRunStatuses: { ...state.attackRunStatuses, [status.run_id]: status },
    })),
  clearAttackRunStatuses: () =>
    set({ attackRunStatuses: {} }),

  // ── Attack Results (completed runs) ──
  attackResults: [],
  addAttackResult: (result) =>
    set((state) => ({
      attackResults: [result, ...state.attackResults].slice(0, MAX_ATTACK_RESULTS),
    })),

  // ── Security Pipeline Events ──
  securityEvents: [],
  addSecurityEvent: (evt) =>
    set((state) => ({
      securityEvents: [...state.securityEvents, evt].slice(-MAX_SECURITY_EVENTS),
    })),
  clearSecurityEvents: () =>
    set({ securityEvents: [] }),

  // ── Aggregation Enforcement ──
  clientEnforcementStatus: {},
  lastEnforcementRound: null,
  setEnforcementStatus: (payload) =>
    set({
      clientEnforcementStatus: payload.enforcement,
      lastEnforcementRound: payload.round,
    }),
  hydrateEnforcementStatus: (enforcement) =>
    set({ clientEnforcementStatus: enforcement }),
}));

// ── Selectors ──────────────────────────────────────────

// Stable empty array — reused as fallback to prevent infinite re-render loops in
// useSyncExternalStore (a new `[]` on every call creates a new reference, which
// Zustand treats as changed state and triggers another render).
const EMPTY_PREDICTIONS: LivePrediction[] = [];
const EMPTY_TRUST_HISTORY: Array<{ round: number; score: number; components?: TrustScoreComponents }> = [];

export const useTrustScores = () => useLiveStore((s) => s.trustScores);
export const useCurrentDetectionRound = () => useLiveStore((s) => s.currentDetectionRound);
export const useTrustScoreHistory = (clientId: string) =>
  useLiveStore((s) => s.trustScoreHistory[clientId] ?? EMPTY_TRUST_HISTORY);
export const useFlaggedEvents = () => useLiveStore((s) => s.flaggedEvents);
export const useAttackRunStatuses = () => useLiveStore((s) => s.attackRunStatuses);
export const useAttackResults = () => useLiveStore((s) => s.attackResults);
export const useSecurityEvents = () => useLiveStore((s) => s.securityEvents);
export const useDevicePredictions = (deviceId: string | undefined) =>
  useLiveStore((s) =>
    deviceId ? (s.devicePredictionHistory[deviceId] ?? EMPTY_PREDICTIONS) : EMPTY_PREDICTIONS,
  );
export const useClientEnforcementStatus = () => useLiveStore((s) => s.clientEnforcementStatus);
export const useLastEnforcementRound = () => useLiveStore((s) => s.lastEnforcementRound);
