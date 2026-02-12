import api from './client';

/* ── Types ─────────────────────────────────────── */

export interface Scenario {
  name: string;
  description: string;
  attack_labels: string[];
  total_windows: number;
  attack_rate: number;
  flow_rate: number;
  is_default: boolean;
}

export interface SimStartRequest {
  scenario: string;
  duration: string;          // "5min" | "30min" | "continuous"
  clients: string[];
}

export interface ClientSimStatus {
  client_id: string;
  client_name: string;
  container_id: string | null;
  container_name: string | null;
  state: string;
  started_at: number | null;
  error: string | null;
}

export interface SimConfig {
  scenario: string;
  duration: string;
  duration_seconds: number;
  flow_rate: number;
  monitor_interval: number;
  clients: string[];
}

export interface SimulationStatus {
  state: string;
  config: SimConfig;
  clients: ClientSimStatus[];
  started_at: number | null;
  uptime_seconds: number;
  scenario_description: string;
}

/** Lightweight FL client info for the sim page */
export interface SimClient {
  id: number;
  client_id: string;
  name: string;
  status: string;
  total_samples: number;
  device_count: number;
}

/* ── API ───────────────────────────────────────── */

export const simulationApi = {
  /** List available scenario packs */
  scenarios: () =>
    api.get<Scenario[]>('/simulation/scenarios').then((r) => r.data),

  /** Get current simulation status */
  status: () =>
    api.get<SimulationStatus>('/simulation/status').then((r) => r.data),

  /** List FL clients eligible for simulation */
  clients: () =>
    api.get<SimClient[]>('/simulation/clients').then((r) => r.data),

  /** Start a simulation */
  start: (req: SimStartRequest) =>
    api.post<SimulationStatus>('/simulation/start', req).then((r) => r.data),

  /** Stop the running simulation */
  stop: () =>
    api.post<SimulationStatus>('/simulation/stop').then((r) => r.data),
};
