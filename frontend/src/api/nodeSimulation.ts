import api from './client';

/* ── Types ─────────────────────────────────────── */

export interface AttackNodeStartRequest {
  attack_node_id: string;
  attack_category: string;
  target_device_ids: string[];
  intensity?: number;            // 0.0–1.0 (default 0.8)
}

export interface AttackNodeStopRequest {
  attack_node_id: string;
}

export interface AttackNodeResponse {
  run_id: string;
  attack_node_id: string;
  status: string;
  container_names: string[];
  class_id: number | null;
  class_name: string | null;
  attack_ratio: number | null;
  containers_stopped: number | null;
}

export interface TrafficNodeStartRequest {
  traffic_node_id: string;
  target_device_ids: string[];
  flow_rate?: number;            // default 5.0
  traffic_type?: 'benign' | 'mixed';  // default 'benign'
}

export interface TrafficNodeStopRequest {
  traffic_node_id: string;
}

export interface TrafficNodeResponse {
  run_id: string;
  traffic_node_id: string;
  status: string;
  container_names: string[];
  class_id: number;
  class_name: string;
  containers_stopped: number | null;
}

/* ── API ───────────────────────────────────────── */

export const attackNodeApi = {
  /** Start CVAE attack generation for an attack node */
  start: (req: AttackNodeStartRequest) =>
    api.post<AttackNodeResponse>('/simulation/attack-node/start', req).then((r) => r.data),

  /** Stop all containers for an attack node */
  stop: (attackNodeId: string) =>
    api.post<AttackNodeResponse>('/simulation/attack-node/stop', {
      attack_node_id: attackNodeId,
    }).then((r) => r.data),
};

export const trafficNodeApi = {
  /** Start CVAE benign traffic generation for a traffic source node */
  start: (req: TrafficNodeStartRequest) =>
    api.post<TrafficNodeResponse>('/simulation/traffic-node/start', req).then((r) => r.data),

  /** Stop all containers for a traffic source node */
  stop: (trafficNodeId: string) =>
    api.post<TrafficNodeResponse>('/simulation/traffic-node/stop', {
      traffic_node_id: trafficNodeId,
    }).then((r) => r.data),
};
