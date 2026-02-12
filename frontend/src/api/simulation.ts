import api from './client';

/* ── Types ─────────────────────────────────────── */

export interface Scenario {
  name: string;
  description: string;
  attack_labels: string[];
  total_windows: number;
  attack_rate: number;
  is_default: boolean;
}

export interface SimulationStartConfig {
  scenario: string;
  replay_speed: number;
  monitor_interval: number;
  replay_loop: boolean;
  replay_shuffle: boolean;
  clients: string[];
  selected_client_id?: string;
  selected_device_id?: string;
  attack_ratio?: number;
  attack_type?: string;
}

export interface ClientSimStatus {
  client_id: string;
  container_id: string | null;
  container_name: string | null;
  state: string;
  started_at: number | null;
  error: string | null;
}

export interface SimulationStatus {
  state: string;
  config: SimulationStartConfig;
  clients: ClientSimStatus[];
  started_at: number | null;
  uptime_seconds: number;
}

export interface ContainerStatusInfo {
  client_id: string;
  state: string;
  container_status?: string;
  container_name?: string;
}

/* ── API ───────────────────────────────────────── */

export const simulationApi = {
  /** List available scenario packs */
  scenarios: () =>
    api.get<Scenario[]>('/simulation/scenarios').then((r) => r.data),

  /** Get current simulation status */
  status: () =>
    api.get<SimulationStatus>('/simulation/status').then((r) => r.data),

  /** Start a simulation */
  start: (config: SimulationStartConfig) =>
    api.post<SimulationStatus>('/simulation/start', config).then((r) => r.data),

  /** Stop the running simulation */
  stop: () =>
    api.post<SimulationStatus>('/simulation/stop').then((r) => r.data),

  /** Get real-time container status */
  containers: () =>
    api.get<ContainerStatusInfo[]>('/simulation/containers').then((r) => r.data),
};
