/**
 * liveStore — Zustand store for real-time WebSocket data.
 *
 * Holds ring-buffered predictions, FL training progress,
 * client/device statuses — all updated by WebSocket messages.
 */

import { create } from 'zustand';

// ── Types ──────────────────────────────────────────────

export interface LivePrediction {
  id?: number;
  device_id: string;
  device_name?: string;
  client_id?: number;
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
  status: string;           // training | encrypting | sending | idle | done
  current_epoch: number;
  total_epochs: number;
  local_loss: number;
  local_accuracy: number;
  num_samples: number;
  progress_pct: number;     // 0-100
}

export interface FLGlobalProgress {
  is_training: boolean;
  current_round: number;
  total_rounds: number;
  global_loss: number | null;
  global_accuracy: number | null;
  aggregation_method?: string;
  use_he?: boolean;
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

// ── Ring buffer size ──
const MAX_PREDICTIONS = 50;

// ── Store ──────────────────────────────────────────────

interface LiveState {
  // Ring-buffered predictions
  latestPredictions: LivePrediction[];
  addPrediction: (p: LivePrediction) => void;

  // FL training progress per client
  flClientProgress: Record<string, FLClientProgress>;
  setFLClientProgress: (clientId: string, progress: FLClientProgress) => void;
  clearFLProgress: () => void;

  // FL global progress
  flGlobalProgress: FLGlobalProgress | null;
  setFLGlobalProgress: (progress: FLGlobalProgress) => void;

  // FL round results (accumulated during training)
  flRoundResults: Array<{ round: number; loss: number | null; accuracy: number | null }>;
  addFLRoundResult: (round: number, loss: number | null, accuracy: number | null) => void;
  clearFLRoundResults: () => void;

  // Client statuses (container running/stopped, client active/inactive)
  clientStatuses: Record<number, LiveClientStatus>;
  setClientStatus: (id: number, status: LiveClientStatus) => void;

  // Device statuses
  deviceStatuses: Record<string, LiveDeviceStatus>;
  setDeviceStatus: (id: string, status: LiveDeviceStatus) => void;

  // WebSocket connection state (mirrored from hook for non-component access)
  wsConnected: boolean;
  setWsConnected: (v: boolean) => void;
}

export const useLiveStore = create<LiveState>()((set) => ({
  // ── Predictions ──
  latestPredictions: [],
  addPrediction: (p) =>
    set((state) => ({
      latestPredictions: [p, ...state.latestPredictions].slice(0, MAX_PREDICTIONS),
    })),

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
  addFLRoundResult: (round, loss, accuracy) =>
    set((state) => ({
      flRoundResults: [...state.flRoundResults, { round, loss, accuracy }],
    })),
  clearFLRoundResults: () =>
    set({ flRoundResults: [] }),

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
}));
