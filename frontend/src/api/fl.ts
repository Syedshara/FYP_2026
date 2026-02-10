import api from './client';
import type { FLRound, FLRoundDetail, FLStatus, FLClient } from '@/types';

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

export const flApi = {
  status: () =>
    api.get<FLStatus>('/fl/status').then((r) => r.data),

  rounds: () =>
    api.get<FLRound[]>('/fl/rounds').then((r) => r.data),

  round: (roundNumber: number) =>
    api.get<FLRoundDetail>(`/fl/rounds/${roundNumber}`).then((r) => r.data),

  clients: () =>
    api.get<FLClient[]>('/fl/clients').then((r) => r.data),

  start: (config: FLStartConfig) =>
    api.post<FLStartResponse>('/fl/start', config).then((r) => r.data),

  stop: () =>
    api.post<FLStopResponse>('/fl/stop').then((r) => r.data),
};
