/**
 * workspaceStore — Zustand store for canvas workspace state.
 *
 * Manages ReactFlow nodes, edges, selection, view mode,
 * and workspace persistence (load/save to backend API).
 */

import { create } from 'zustand';
import {
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  type Connection,
  type ReactFlowInstance,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
} from 'reactflow';
import type { CanvasNodeData, CanvasNodeType, CanvasEdgeType } from '@/types/canvas';
import { createDefaultNodeData, NODE_TYPE_CONFIGS } from '@/config/nodeTypes';
import {
  workspaceApi,
  type WorkspaceOut,
  type WorkspaceNodeCreate,
  type WorkspaceEdgeCreate,
} from '@/api/workspace';

// ── View modes ──
export type ViewMode = 'canvas' | 'fl-drilldown' | 'monitor-drilldown' | 'watcher-drilldown';

// ── Store interface ──
interface WorkspaceState {
  // ReactFlow state
  nodes: Node<CanvasNodeData>[];
  edges: Edge[];
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;

  // Selection
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;

  // View mode
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  drilldownServerId: string | null;
  setDrilldownServerId: (id: string | null) => void;
  drilldownMonitorId: string | null;
  setDrilldownMonitorId: (id: string | null) => void;
  drilldownWatcherId: string | null;
  setDrilldownWatcherId: (id: string | null) => void;

  // Node operations
  addNode: (type: CanvasNodeType, position: { x: number; y: number }) => string;
  updateNodeData: (id: string, data: Partial<CanvasNodeData>) => void;
  removeNode: (id: string) => void;

  // Edge operations
  addTypedEdge: (source: string, target: string, edgeType: CanvasEdgeType) => void;
  updateEdgeData: (id: string, data: Record<string, unknown>) => void;
  removeEdge: (id: string) => void;

  // Properties panel
  propertiesPanelOpen: boolean;
  setPropertiesPanelOpen: (open: boolean) => void;

  // Minimap
  minimapVisible: boolean;
  setMinimapVisible: (visible: boolean) => void;

  // ReactFlow instance (for zoom/fit from outside the <ReactFlow> tree)
  rfInstance: ReactFlowInstance | null;
  setRfInstance: (instance: ReactFlowInstance) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  fitView: () => void;

  // Workspace persistence
  workspaceId: number | null;
  workspaceName: string;
  setWorkspaceName: (name: string) => void;
  isDirty: boolean;
  setDirty: (dirty: boolean) => void;
  isSaving: boolean;
  isLoading: boolean;
  lastError: string | null;

  // Connection feedback
  connectionError: string | null;
  clearConnectionError: () => void;

  // FL training — track which canvas node is the active FL server
  activeFlServerNodeId: string | null;
  setActiveFlServerNodeId: (id: string | null) => void;

  // Backend persistence actions
  loadWorkspace: (id: number) => Promise<void>;
  createWorkspace: (name?: string) => Promise<number>;
  saveWorkspace: () => Promise<void>;
  deleteWorkspace: () => Promise<void>;
  loadOrCreateDefault: () => Promise<void>;
}

let nodeIdCounter = 0;

function generateNodeId(): string {
  nodeIdCounter += 1;
  return `node_${Date.now()}_${nodeIdCounter}`;
}

function generateEdgeId(source: string, target: string): string {
  return `edge_${source}_${target}_${Date.now()}`;
}

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => ({
  // ── ReactFlow state ──
  nodes: [],
  edges: [],

  onNodesChange: (changes) => {
    set({ nodes: applyNodeChanges(changes, get().nodes), isDirty: true });
  },

  onEdgesChange: (changes) => {
    set({ edges: applyEdgeChanges(changes, get().edges), isDirty: true });
  },

  onConnect: (connection: Connection) => {
    const sourceNode = get().nodes.find((n) => n.id === connection.source);
    const targetNode = get().nodes.find((n) => n.id === connection.target);
    if (!sourceNode || !targetNode) return;

    const sourceType = sourceNode.data.nodeType;
    const targetType = targetNode.data.nodeType;

    let edgeType = inferEdgeType(sourceType, targetType);
    let finalSource = connection.source!;
    let finalTarget = connection.target!;

    // Auto-normalise direction: if user dragged backwards, flip source/target
    if (!edgeType) {
      const reversed = inferEdgeType(targetType, sourceType);
      if (reversed) {
        edgeType = reversed;
        finalSource = connection.target!;
        finalTarget = connection.source!;
      }
    }

    if (!edgeType) {
      const srcLabel = NODE_TYPE_CONFIGS[sourceType]?.label ?? sourceType;
      const tgtLabel = NODE_TYPE_CONFIGS[targetType]?.label ?? targetType;
      set({ connectionError: `Cannot connect ${srcLabel} → ${tgtLabel}` });
      return;
    }

    const newEdge: Edge = {
      ...connection,
      source: finalSource,
      target: finalTarget,
      id: generateEdgeId(finalSource, finalTarget),
      type: edgeType,
    };

    set({ edges: addEdge(newEdge, get().edges), isDirty: true });
  },

  // ── Selection ──
  selectedNodeId: null,
  setSelectedNodeId: (id) => {
    set({ selectedNodeId: id, propertiesPanelOpen: id !== null });
  },

  // ── View mode ──
  viewMode: 'canvas',
  setViewMode: (mode) => set({ viewMode: mode }),
  drilldownServerId: null,
  setDrilldownServerId: (id) => set({ drilldownServerId: id }),
  drilldownMonitorId: null,
  setDrilldownMonitorId: (id) => set({ drilldownMonitorId: id }),
  drilldownWatcherId: null,
  setDrilldownWatcherId: (id) => set({ drilldownWatcherId: id }),

  // ── Node operations ──
  addNode: (type, position) => {
    const id = generateNodeId();
    const config = NODE_TYPE_CONFIGS[type];
    const data = createDefaultNodeData(type);

    const newNode: Node<CanvasNodeData> = {
      id,
      type,
      position,
      data,
      style: { width: config.width, height: config.height },
    };

    set((state) => ({
      nodes: [...state.nodes, newNode],
      isDirty: true,
    }));

    return id;
  },

  updateNodeData: (id, partialData) => {
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, ...partialData } as CanvasNodeData } : n,
      ),
      isDirty: true,
    }));
  },

  removeNode: (id) => {
    set((state) => ({
      nodes: state.nodes.filter((n) => n.id !== id),
      edges: state.edges.filter((e) => e.source !== id && e.target !== id),
      selectedNodeId: state.selectedNodeId === id ? null : state.selectedNodeId,
      propertiesPanelOpen: state.selectedNodeId === id ? false : state.propertiesPanelOpen,
      isDirty: true,
    }));
  },

  // ── Edge operations ──
  addTypedEdge: (source, target, edgeType) => {
    const newEdge: Edge = {
      id: generateEdgeId(source, target),
      source,
      target,
      type: edgeType,
    };
    set((state) => ({
      edges: [...state.edges, newEdge],
      isDirty: true,
    }));
  },

  updateEdgeData: (id, data) => {
    set((state) => ({
      edges: state.edges.map((e) =>
        e.id === id ? { ...e, data: { ...e.data, ...data } } : e,
      ),
    }));
  },

  removeEdge: (id) => {
    set((state) => ({
      edges: state.edges.filter((e) => e.id !== id),
      isDirty: true,
    }));
  },

  // ── Properties panel ──
  propertiesPanelOpen: false,
  setPropertiesPanelOpen: (open) => set({ propertiesPanelOpen: open }),

  // ── Minimap ──
  minimapVisible: true,
  setMinimapVisible: (visible) => set({ minimapVisible: visible }),

  // ── ReactFlow instance (zoom/fit from outside <ReactFlow> tree) ──
  rfInstance: null,
  setRfInstance: (instance) => set({ rfInstance: instance }),
  zoomIn: () => get().rfInstance?.zoomIn({ duration: 200 }),
  zoomOut: () => get().rfInstance?.zoomOut({ duration: 200 }),
  fitView: () => get().rfInstance?.fitView({ padding: 0.2, duration: 300 }),

  // ── Workspace persistence ──
  workspaceId: null,
  workspaceName: 'IoT IDS Workspace',
  setWorkspaceName: (name) => set({ workspaceName: name, isDirty: true }),
  isDirty: false,
  setDirty: (dirty) => set({ isDirty: dirty }),
  isSaving: false,
  isLoading: false,
  lastError: null,

  // Connection feedback
  connectionError: null,
  clearConnectionError: () => set({ connectionError: null }),

  // FL training — active server node
  activeFlServerNodeId: null,
  setActiveFlServerNodeId: (id) => set({ activeFlServerNodeId: id }),

  loadWorkspace: async (id: number) => {
    set({ isLoading: true, lastError: null });
    try {
      const ws = await workspaceApi.get(id);
      const nodes = hydrateNodes(ws);
      const edges = hydrateEdges(ws);
      set({
        workspaceId: ws.id,
        workspaceName: ws.name,
        nodes,
        edges,
        isDirty: false,
        isLoading: false,
      });
    } catch (err) {
      set({ isLoading: false, lastError: `Failed to load workspace: ${err}` });
      throw err;
    }
  },

  createWorkspace: async (name?: string) => {
    set({ isLoading: true, lastError: null });
    try {
      const ws = await workspaceApi.create({ name: name ?? 'IoT IDS Workspace' });
      set({
        workspaceId: ws.id,
        workspaceName: ws.name,
        nodes: [],
        edges: [],
        isDirty: false,
        isLoading: false,
      });
      return ws.id;
    } catch (err) {
      set({ isLoading: false, lastError: `Failed to create workspace: ${err}` });
      throw err;
    }
  },

  saveWorkspace: async () => {
    const state = get();
    if (!state.workspaceId) return;

    set({ isSaving: true, lastError: null });
    try {
      const nodePayloads: WorkspaceNodeCreate[] = state.nodes.map((n) => ({
        node_key: n.id,
        node_type: n.data.nodeType,
        position_x: n.position.x,
        position_y: n.position.y,
        data: n.data as unknown as Record<string, unknown>,
      }));

      const edgePayloads: WorkspaceEdgeCreate[] = state.edges.map((e) => ({
        edge_key: e.id,
        edge_type: e.type ?? 'ownership',
        source_key: e.source,
        target_key: e.target,
        data: (e.data ?? {}) as Record<string, unknown>,
      }));

      await workspaceApi.save(state.workspaceId, {
        name: state.workspaceName,
        nodes: nodePayloads,
        edges: edgePayloads,
      });

      set({ isDirty: false, isSaving: false });
    } catch (err) {
      set({ isSaving: false, lastError: `Failed to save workspace: ${err}` });
      throw err;
    }
  },

  deleteWorkspace: async () => {
    const state = get();
    if (!state.workspaceId) return;

    try {
      await workspaceApi.delete(state.workspaceId);
      set({
        workspaceId: null,
        workspaceName: 'IoT IDS Workspace',
        nodes: [],
        edges: [],
        isDirty: false,
      });
    } catch (err) {
      set({ lastError: `Failed to delete workspace: ${err}` });
      throw err;
    }
  },

  loadOrCreateDefault: async () => {
    set({ isLoading: true, lastError: null });
    try {
      const list = await workspaceApi.list();
      if (list.length > 0) {
        // Load the most recently updated workspace
        await get().loadWorkspace(list[0].id);
      } else {
        // Create a fresh workspace
        await get().createWorkspace();
      }
    } catch (err) {
      set({ isLoading: false, lastError: `Failed to initialize workspace: ${err}` });
    }
  },
}));

// ── Hydration helpers ──

function hydrateNodes(ws: WorkspaceOut): Node<CanvasNodeData>[] {
  return ws.nodes.map((n) => {
    const nodeType = n.node_type as CanvasNodeType;
    const config = NODE_TYPE_CONFIGS[nodeType];
    return {
      id: n.node_key,
      type: nodeType,
      position: { x: n.position_x, y: n.position_y },
      data: n.data as unknown as CanvasNodeData,
      style: config ? { width: config.width, height: config.height } : undefined,
    };
  });
}

function hydrateEdges(ws: WorkspaceOut): Edge[] {
  return ws.edges.map((e) => ({
    id: e.edge_key,
    source: e.source_key,
    target: e.target_key,
    type: e.edge_type,
    data: e.data,
  }));
}

// ── Edge type inference ──

function inferEdgeType(
  sourceType: CanvasNodeType,
  targetType: CanvasNodeType,
): CanvasEdgeType | null {
  if (sourceType === 'client' && targetType === 'device') return 'ownership';
  if (sourceType === 'fl-server' && targetType === 'client') return 'fl-communication';
  if (sourceType === 'traffic-source' && targetType === 'device') return 'traffic-feed';
  if (sourceType === 'attack' && targetType === 'device') return 'attack-vector';
  if (sourceType === 'device' && targetType === 'monitor') return 'observation';
  // Allow reverse connections for some types
  if (sourceType === 'device' && targetType === 'rate-filter') return 'observation';
  if (sourceType === 'rate-filter' && targetType === 'monitor') return 'observation';
  return null;
}

// ── Selectors ──

export const useSelectedNode = () =>
  useWorkspaceStore((s) => {
    if (!s.selectedNodeId) return null;
    return s.nodes.find((n) => n.id === s.selectedNodeId) ?? null;
  });

export const useNodesByType = (type: CanvasNodeType) =>
  useWorkspaceStore((s) => s.nodes.filter((n) => n.data.nodeType === type));
