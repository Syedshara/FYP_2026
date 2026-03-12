import api from './client';

/* ── Types ─────────────────────────────────────── */

export type NodeType = 'source_scenario' | 'attack_inject' | 'rate_filter' | 'monitor_sink';
export type PipelineStatus = 'idle' | 'running' | 'error';

export interface PipelineNodeData {
  id: number;
  pipeline_id: number;
  node_key: string;
  node_type: NodeType;
  label: string;
  config: Record<string, unknown>;
  position_x: number;
  position_y: number;
  edges_json: Array<{ source_key: string; target_key: string }>;
  created_at: string;
  updated_at: string;
}

export interface PipelineNodeCreate {
  node_key: string;
  node_type: NodeType;
  label: string;
  config: Record<string, unknown>;
  position_x: number;
  position_y: number;
  edges_json: Array<{ source_key: string; target_key: string }>;
}

export interface PipelineOut {
  id: number;
  name: string;
  description?: string;
  status: PipelineStatus;
  created_at: string;
  updated_at: string;
  nodes: PipelineNodeData[];
}

export interface PipelineBrief {
  id: number;
  name: string;
  description?: string;
  status: PipelineStatus;
  created_at: string;
  updated_at: string;
}

export interface PipelineCreate {
  name?: string;
  description?: string;
  nodes?: PipelineNodeCreate[];
}

export interface PipelineUpdate {
  name?: string;
  description?: string;
  nodes?: PipelineNodeCreate[];
}

export interface PipelineStatusOut {
  pipeline_id: number;
  status: PipelineStatus;
  active_clients: string[];
  scenario?: string;
  uptime_seconds?: number;
  error_message?: string;
}

/* ── API ───────────────────────────────────────── */

export const pipelineApi = {
  /** List all pipelines (brief) */
  list: () =>
    api.get<PipelineBrief[]>('/pipelines/').then((r) => r.data),

  /** Create a new pipeline */
  create: (body: PipelineCreate) =>
    api.post<PipelineOut>('/pipelines/', body).then((r) => r.data),

  /** Get a single pipeline by id */
  get: (id: number) =>
    api.get<PipelineOut>(`/pipelines/${id}`).then((r) => r.data),

  /** Update a pipeline */
  update: (id: number, body: PipelineUpdate) =>
    api.put<PipelineOut>(`/pipelines/${id}`, body).then((r) => r.data),

  /** Delete a pipeline */
  remove: (id: number) =>
    api.delete<{ ok: true }>(`/pipelines/${id}`).then((r) => r.data),

  /** Start running a pipeline */
  run: (id: number) =>
    api.post<{ ok: true }>(`/pipelines/${id}/run`).then((r) => r.data),

  /** Stop a running pipeline */
  stop: (id: number) =>
    api.post<{ ok: true }>(`/pipelines/${id}/stop`).then((r) => r.data),

  /** Get runtime status of a pipeline */
  status: (id: number) =>
    api.get<PipelineStatusOut>(`/pipelines/${id}/status`).then((r) => r.data),
};
