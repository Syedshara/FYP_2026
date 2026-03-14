/**
 * WorkspacePage — Single unified canvas workspace.
 *
 * Wires together: ReactFlow canvas, CanvasTopBar, CanvasStatusBar,
 * NodePalette (left), PropertiesPanel (right).
 *
 * Handles: drag-to-add from palette, node selection → properties panel,
 * double-click FL Server → drilldown (future), minimap toggle.
 */

import { useCallback, useEffect, useRef, type DragEvent } from 'react';
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  MarkerType,
  type ReactFlowInstance,
  type NodeMouseHandler,
} from 'reactflow';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import type { CanvasNodeType } from '@/types/canvas';
import { NODE_TYPE_CONFIGS } from '@/config/nodeTypes';
import CanvasTopBar from '@/components/canvas/CanvasTopBar';
import CanvasStatusBar from '@/components/canvas/CanvasStatusBar';
import NodePalette from '@/components/canvas/NodePalette';
import PropertiesPanel from '@/components/canvas/PropertiesPanel';
import FLDrillDownView from '@/components/canvas/fl/FLDrillDownView';
import MonitorDrillDownView from '@/components/canvas/monitor/MonitorDrillDownView';
import LiveDataSync from '@/components/canvas/LiveDataSync';

// Custom node components
import ClientNode from '@/components/canvas/nodes/ClientNode';
import DeviceNode from '@/components/canvas/nodes/DeviceNode';
import FLServerNode from '@/components/canvas/nodes/FLServerNode';
import AttackNode from '@/components/canvas/nodes/AttackNode';
import TrafficSourceNode from '@/components/canvas/nodes/TrafficSourceNode';
import RateFilterNode from '@/components/canvas/nodes/RateFilterNode';
import MonitorNode from '@/components/canvas/nodes/MonitorNode';

// Custom edge components
import OwnershipEdge from '@/components/canvas/edges/OwnershipEdge';
import FLCommunicationEdge from '@/components/canvas/edges/FLCommunicationEdge';
import TrafficFeedEdge from '@/components/canvas/edges/TrafficFeedEdge';
import AttackVectorEdge from '@/components/canvas/edges/AttackVectorEdge';
import ObservationEdge from '@/components/canvas/edges/ObservationEdge';

// ── Register custom node types with ReactFlow ──
const nodeTypes = {
  client: ClientNode,
  device: DeviceNode,
  'fl-server': FLServerNode,
  attack: AttackNode,
  'traffic-source': TrafficSourceNode,
  'rate-filter': RateFilterNode,
  monitor: MonitorNode,
};

// ── Register custom edge types with ReactFlow ──
const edgeTypes = {
  ownership: OwnershipEdge,
  'fl-communication': FLCommunicationEdge,
  'traffic-feed': TrafficFeedEdge,
  'attack-vector': AttackVectorEdge,
  observation: ObservationEdge,
};

export default function WorkspacePage() {
  const reactFlowRef = useRef<HTMLDivElement>(null);
  const reactFlowInstance = useRef<ReactFlowInstance | null>(null);

  // Store selectors
  const nodes = useWorkspaceStore((s) => s.nodes);
  const edges = useWorkspaceStore((s) => s.edges);
  const onNodesChange = useWorkspaceStore((s) => s.onNodesChange);
  const onEdgesChange = useWorkspaceStore((s) => s.onEdgesChange);
  const onConnect = useWorkspaceStore((s) => s.onConnect);
  const addNode = useWorkspaceStore((s) => s.addNode);
  const setSelectedNodeId = useWorkspaceStore((s) => s.setSelectedNodeId);
  const minimapVisible = useWorkspaceStore((s) => s.minimapVisible);
  const isLoading = useWorkspaceStore((s) => s.isLoading);
  const loadOrCreateDefault = useWorkspaceStore((s) => s.loadOrCreateDefault);
  const saveWorkspace = useWorkspaceStore((s) => s.saveWorkspace);
  const isDirty = useWorkspaceStore((s) => s.isDirty);
  const viewMode = useWorkspaceStore((s) => s.viewMode);
  const setViewMode = useWorkspaceStore((s) => s.setViewMode);
  const setDrilldownServerId = useWorkspaceStore((s) => s.setDrilldownServerId);
  const setDrilldownMonitorId = useWorkspaceStore((s) => s.setDrilldownMonitorId);
  const setRfInstance = useWorkspaceStore((s) => s.setRfInstance);

  // ── Auto-load workspace on mount ──
  useEffect(() => {
    loadOrCreateDefault();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Ctrl+S to save ──
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (isDirty) {
          saveWorkspace();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isDirty, saveWorkspace]);

  // ── Auto-save on changes (debounced 2s) ──
  useEffect(() => {
    if (!isDirty) return;
    const timer = setTimeout(() => {
      saveWorkspace();
    }, 2000);
    return () => clearTimeout(timer);
  }, [isDirty, nodes, edges, saveWorkspace]);

  // ── Drag-to-add handler ──
  const onDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();

      const type = event.dataTransfer.getData('application/reactflow-node-type') as CanvasNodeType;
      if (!type || !NODE_TYPE_CONFIGS[type]) return;

      const instance = reactFlowInstance.current;
      if (!instance || !reactFlowRef.current) return;

      const bounds = reactFlowRef.current.getBoundingClientRect();
      const position = instance.project({
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      });

      const id = addNode(type, position);
      setSelectedNodeId(id);
    },
    [addNode, setSelectedNodeId],
  );

  // ── Node click → select → open properties ──
  const onNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      setSelectedNodeId(node.id);
    },
    [setSelectedNodeId],
  );

  // ── Canvas click → deselect ──
  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, [setSelectedNodeId]);

  // ── Double-click FL Server node → enter drill-down ──
  const onNodeDoubleClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      if (node.type === 'fl-server') {
        setDrilldownServerId(node.id);
        setViewMode('fl-drilldown');
      } else if (node.type === 'monitor') {
        setDrilldownMonitorId(node.id);
        setViewMode('monitor-drilldown');
      }
    },
    [setDrilldownServerId, setDrilldownMonitorId, setViewMode],
  );

  // ── If in FL drill-down mode, render that view instead ──
  if (viewMode === 'fl-drilldown') {
    return (
      <div
        className="flex flex-col w-screen h-screen overflow-hidden"
        style={{ background: 'var(--n8n-canvas-bg)' }}
      >
        <LiveDataSync />
        <FLDrillDownView />
      </div>
    );
  }

  // ── If in Monitor drill-down mode, render analytics dashboard ──
  if (viewMode === 'monitor-drilldown') {
    return (
      <div
        className="flex flex-col w-screen h-screen overflow-hidden"
        style={{ background: 'var(--n8n-canvas-bg)' }}
      >
        <LiveDataSync />
        <MonitorDrillDownView />
      </div>
    );
  }

  return (
    <div
      className="flex flex-col w-screen h-screen overflow-hidden"
      style={{ background: 'var(--n8n-canvas-bg)' }}
    >
      {/* Live data sync (headless — bridges liveStore → workspaceStore) */}
      <LiveDataSync />

      {/* Top bar */}
      <CanvasTopBar />

      {/* Loading overlay */}
      {isLoading && (
        <div className="absolute inset-0 z-50 flex items-center justify-center"
             style={{ background: 'rgba(24, 25, 28, 0.8)' }}>
          <div className="text-center">
            <div className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin mx-auto mb-3"
                 style={{ borderColor: 'var(--n8n-accent)', borderTopColor: 'transparent' }} />
            <p style={{ color: 'var(--n8n-text-primary)' }}>
              Loading workspace...
            </p>
          </div>
        </div>
      )}

      {/* Main area: Palette + Canvas + Properties */}
      <div className="flex flex-1 min-h-0">
        {/* Left: Node Palette */}
        <NodePalette />

        {/* Center: ReactFlow Canvas */}
        <div className="flex-1 relative" ref={reactFlowRef}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onInit={(instance) => {
              reactFlowInstance.current = instance;
              setRfInstance(instance);
            }}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onNodeClick={onNodeClick}
            onNodeDoubleClick={onNodeDoubleClick}
            onPaneClick={onPaneClick}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{
              animated: false,
              type: 'default',
              markerEnd: {
                type: MarkerType.ArrowClosed,
                width: 16,
                height: 16,
                color: 'var(--n8n-edge-default)',
              },
              style: { stroke: 'var(--n8n-edge-default)', strokeWidth: 1.5 },
            }}
            style={{ background: 'var(--n8n-canvas-bg)' }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={24}
              size={1.5}
              color="var(--n8n-dot-color)"
            />
            <Controls
              showInteractive={false}
            />
            {minimapVisible && (
              <MiniMap
                nodeColor={(node) => {
                  const config = NODE_TYPE_CONFIGS[node.data?.nodeType as CanvasNodeType];
                  return config?.accent ?? '#3c3c3c';
                }}
                maskColor="rgba(0, 0, 0, 0.6)"
                style={{
                  background: 'var(--n8n-card-bg)',
                  borderRadius: '8px',
                  border: '1px solid var(--n8n-card-border)',
                }}
              />
            )}
          </ReactFlow>
        </div>

        {/* Right: Properties Panel */}
        <PropertiesPanel />
      </div>

      {/* Bottom status bar */}
      <CanvasStatusBar />

      {/* Connection error toast */}
      <ConnectionToast />
    </div>
  );
}

/* ── Connection error toast (auto-dismiss) ── */

function ConnectionToast() {
  const error = useWorkspaceStore((s) => s.connectionError);
  const clear = useWorkspaceStore((s) => s.clearConnectionError);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(clear, 2500);
    return () => clearTimeout(timer);
  }, [error, clear]);

  if (!error) return null;

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 48,
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'var(--n8n-card-bg)',
        border: '1px solid var(--n8n-danger)',
        borderRadius: 8,
        padding: '8px 16px',
        fontSize: 12,
        fontWeight: 500,
        color: 'var(--n8n-danger)',
        boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
        zIndex: 100,
        animation: 'toast-in 0.2s ease-out',
        pointerEvents: 'none',
      }}
    >
      {error}
    </div>
  );
}
