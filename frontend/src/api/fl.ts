import api from './client';
import type {
  FLRound,
  FLRoundDetail,
  FLStatus,
  FLClient,
  FLClientDetail,
  ContainerStatus,
} from '@/types';

// ── Request / Response types ──

export interface FLStartConfig {
  num_rounds: number;
  min_clients?: number;
  use_he?: boolean;
  local_epochs?: number;
  learning_rate?: number;
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
    api.get<Record<string, number>>('/fl/trust_scores').then((r) => r.data),

  detectionRounds: () =>
    api.get<DetectionRound[]>('/fl/detection_rounds').then((r) => r.data),

  flaggedClients: () =>
    api.get<FlaggedClientEvent[]>('/fl/flagged_clients').then((r) => r.data),
};
