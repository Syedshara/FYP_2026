import api from './client';
import type {
  FLRound,
  FLRoundDetail,
  FLStatus,
  FLClient,
  FLClientDetail,
  ContainerStatus,
  ClientEnforcementStatus,
  TrustScoreComponents,
} from '@/types';
import type { SecurityEvent } from '@/stores/liveStore';
import type { GradientStats } from '@/types';

// ── Round result shape returned by GET /fl/round-results ──

interface RoundResultResponse {
  round: number;
  loss: number | null;
  accuracy: number | null;
  gradient_stats: GradientStats | null;
  client_metrics: Array<{
    client_id: string;
    local_loss: number;
    local_accuracy: number;
    num_samples: number;
  }> | null;
}

// ── Request / Response types ──

export interface FLStartConfig {
  num_rounds: number;
  min_clients?: number;
  use_he?: boolean;
  local_epochs?: number;
  learning_rate?: number;
  max_batches?: number;
  workspace_id?: number;
  /** Canvas node IDs of Client nodes connected to the FL Server — takes priority over client_ids */
  canvas_node_ids?: string[];
  /** Legacy: direct client_id strings */
  client_ids?: string[];
}

export interface FLStartResponse {
  status: string;
  message: string;
  num_rounds: number;
  num_clients: number;
  client_ids: string[];
}

export interface FLStopResponse {
  status: string;
  message: string;
}

export interface FlaggedClientEvent {
  client_id: string;
  round: number;
  abnormality: number;
  timestamp?: string;
}

export interface DetectionRound {
  round: number;
  scores: Record<string, number>;
  flagged: string[];
  timestamp?: string;
}

export interface CertificateMetadata {
  clientId: string;       // cert filename stem — stable unique key
  displayName: string;    // human label: client name / "FL Server" / "IoT-IDS-CA"
  role: string;           // "FL Client" | "FL Server" | "Root CA"
  issuer: string;
  notBefore: string;
  notAfter: string;
  fingerprint: string;
}

// ── API client ──

export const flApi = {
  // Status
  status: () =>
    api.get<FLStatus>('/fl/status').then((r) => r.data),

  // Rounds
  rounds: () =>
    api.get<FLRound[]>('/fl/rounds').then((r) => r.data),

  round: (roundNumber: number) =>
    api.get<FLRoundDetail>(`/fl/rounds/${roundNumber}`).then((r) => r.data),

  // Clients
  clients: () =>
    api.get<FLClient[]>('/fl/clients').then((r) => r.data),

  clientDetail: (clientPk: number) =>
    api.get<FLClientDetail>(`/fl/clients/${clientPk}`).then((r) => r.data),

  // Container management
  containerStart: (clientPk: number, mode: 'IDLE' | 'MONITOR' | 'TRAIN' = 'IDLE') =>
    api.post(`/fl/clients/${clientPk}/container/start`, null, { params: { mode } }).then((r) => r.data),

  containerStop: (clientPk: number) =>
    api.post(`/fl/clients/${clientPk}/container/stop`).then((r) => r.data),

  containerStatus: (clientPk: number) =>
    api.get<ContainerStatus>(`/fl/clients/${clientPk}/container/status`).then((r) => r.data),

  // Training control
  start: (config: FLStartConfig) =>
    api.post<FLStartResponse>('/fl/start', config).then((r) => r.data),

  stop: () =>
    api.post<FLStopResponse>('/fl/stop').then((r) => r.data),

  // Trust / Detection / Security
  trustScores: () =>
    api.get<{ trust_scores: Record<string, number> }>('/fl/trust_scores')
      .then((r) => r.data.trust_scores),

  resetTrustScores: () =>
    api.post<{ status: string; message: string }>('/fl/trust_scores/reset')
      .then((r) => r.data),

  detectionRounds: () =>
    api.get<{
      rounds: Array<{
        round_number: number;
        scores: Record<string, number>;
        flagged: string[];
        /** Per-client component breakdown — present after backend stores components in detection rounds */
        components?: Record<string, TrustScoreComponents>;
        timestamp?: string;
      }>;
    }>('/fl/detection_rounds')
      .then((r) => r.data.rounds.map((row) => ({
        round: row.round_number,
        scores: row.scores,
        flagged: row.flagged,
        components: row.components,
        timestamp: row.timestamp,
      }))),

  flaggedClients: () =>
    api.get<{ flagged: Array<{ client_id: string; round_number: number; abnormality: number; timestamp?: string }> }>('/fl/flagged_clients')
      .then((r) => r.data.flagged.map((row) => ({
        client_id: row.client_id,
        round: row.round_number,
        abnormality: row.abnormality,
        timestamp: row.timestamp,
      }))),

  enforcementStatus: () =>
    api.get<{ enforcement: Record<string, string>; rounds: unknown[] }>('/fl/enforcement_status')
      .then((r) => r.data.enforcement as Record<string, ClientEnforcementStatus>),

  /** Fetch the per-round enforcement history for Watcher hydration.
   *  Uses the same endpoint as enforcementStatus() but maps the ``rounds``
   *  array that was previously discarded.
   */
  enforcementRounds: () =>
    api.get<{
      enforcement: Record<string, string>;
      rounds: Array<{
        round_number: number;
        enforcement: Record<string, string>;
        excluded_count: number;
        downweighted_count: number;
        timestamp: string;
      }>;
    }>('/fl/enforcement_status')
      .then((r) => r.data.rounds.map((row) => ({
        round: row.round_number,
        enforcement: row.enforcement as Record<string, ClientEnforcementStatus>,
      }))),

  /** Fetch persisted security pipeline events from the audit log.
   *  Used to hydrate the Watcher Events tab on first open.
   */
  securityEvents: (limit = 500) =>
    api.get<{
      events: Array<{
        id: number;
        round: number;
        kind: string;
        client_id: string | null;
        detail: string | null;
        data: Record<string, unknown> | null;
        timestamp: string | null;
      }>;
    }>('/fl/security-events', { params: { limit } })
      .then((r) =>
        r.data.events.map((e): SecurityEvent => ({
          id: e.id,
          round: e.round,
          kind: e.kind as SecurityEvent['kind'],
          clientId: e.client_id ?? undefined,
          detail: e.detail ?? undefined,
          data: e.data ?? undefined,
          timestamp: e.timestamp ?? new Date(0).toISOString(),
        }))
      ),

  // Certificates (mTLS)
  certificates: () =>
    api.get<CertificateMetadata[]>('/security/certificates').then((r) => r.data),

  // Poison mode toggle (adversarial simulation)
  togglePoison: (clientPk: number, strategy: 'direction_flip' | 'scale_attack' | 'noise_inject' | 'none') =>
    api.post<PoisonToggleResponse>(`/fl/clients/${clientPk}/poison`, { strategy }).then((r) => r.data),

  /** Fetch persisted FL round results with gradient stats and client metrics.
   *  Used to hydrate flRoundResults on Watcher mount after page refresh.
   */
  roundResults: () =>
    api.get<{ rounds: RoundResultResponse[] }>('/fl/round-results')
      .then((r) =>
        r.data.rounds.map((rr) => ({
          round: rr.round,
          loss: rr.loss,
          accuracy: rr.accuracy,
          gradient_stats: rr.gradient_stats ?? undefined,
          client_metrics: rr.client_metrics ?? undefined,
        }))
      ),
};

// ── Poison toggle types ──

export interface PoisonToggleResponse {
  client_id: string;
  strategy: string;
  active: boolean;
  message: string;
}
