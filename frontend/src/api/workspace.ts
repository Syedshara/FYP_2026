/**
 * Workspace API — CRUD for canvas workspaces.
 *
 * Endpoints map to: /api/v1/workspaces/...
 */

import api from './client';

// ── Response types (match backend WorkspaceOut/WorkspaceBrief) ──

export interface WorkspaceNodeOut {
  id: number;
  workspace_id: number;
  node_key: string;
  node_type: string;
  position_x: number;
  position_y: number;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceEdgeOut {
  id: number;
  workspace_id: number;
  edge_key: string;
  edge_type: string;
  source_key: string;
  target_key: string;
  data: Record<string, unknown>;
  created_at: string;
}

export interface ViewportState {
  x: number;
  y: number;
  zoom: number;
}

export interface WorkspaceOut {
  id: number;
  name: string;
  description: string | null;
  viewport: ViewportState;
  created_at: string;
  updated_at: string;
  nodes: WorkspaceNodeOut[];
  edges: WorkspaceEdgeOut[];
}

export interface WorkspaceBrief {
  id: number;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

// ── Request types ──

export interface WorkspaceNodeCreate {
  node_key: string;
  node_type: string;
  position_x: number;
  position_y: number;
  data: Record<string, unknown>;
}

export interface WorkspaceEdgeCreate {
  edge_key: string;
  edge_type: string;
  source_key: string;
  target_key: string;
  data: Record<string, unknown>;
}

export interface WorkspaceCreatePayload {
  name?: string;
  description?: string;
  nodes?: WorkspaceNodeCreate[];
  edges?: WorkspaceEdgeCreate[];
  viewport?: ViewportState;
}

export interface WorkspaceSavePayload {
  name?: string;
  description?: string;
  nodes?: WorkspaceNodeCreate[];
  edges?: WorkspaceEdgeCreate[];
  viewport?: ViewportState;
}

// ── API functions ──

export const workspaceApi = {
  /** List all workspaces (lightweight — no nodes/edges). */
  list: () =>
    api.get<WorkspaceBrief[]>('/workspaces/').then((r) => r.data),

  /** Create a new workspace. */
  create: (data: WorkspaceCreatePayload = {}) =>
    api.post<WorkspaceOut>('/workspaces/', data).then((r) => r.data),

  /** Load a workspace (includes nodes + edges + viewport). */
  get: (id: number) =>
    api.get<WorkspaceOut>(`/workspaces/${id}`).then((r) => r.data),

  /** Full canvas save — atomically replaces nodes, edges, viewport. */
  save: (id: number, data: WorkspaceSavePayload) =>
    api.put<WorkspaceOut>(`/workspaces/${id}`, data).then((r) => r.data),

  /** Delete a workspace. */
  delete: (id: number) =>
    api.delete(`/workspaces/${id}`).then((r) => r.data),
};
