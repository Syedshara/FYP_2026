/**
 * PipelineBuilderPage
 *
 * Full-viewport pipeline editor with:
 *  - Toolbar (name edit + Save/Run/Stop + status badge)
 *  - Node palette (left, 200px)
 *  - ReactFlow canvas (centre, fills remaining space)
 *  - Properties panel (right, 280px, from PipelinePropertiesPanel)
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type Node,
  type Connection,
  BackgroundVariant,
} from 'reactflow';
import { Loader2, Play, Square, Save } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

import { nodeTypes }                  from '@/components/nodes';
import PipelinePropertiesPanel        from '@/components/PipelinePropertiesPanel';
import { pipelineApi }                from '@/api/pipeline';
import type { PipelineOut, PipelineStatusOut, NodeType, PipelineNodeCreate } from '@/api/pipeline';

// ── Design tokens ─────────────────────────────────────────────────────────────

const T = {
  canvasBg:      '#18191c',
  sidebarBg:     '#101014',
  topbarBg:      '#1c1c1c',
  cardBg:        '#2d2d2d',
  border:        '1px solid #3c3c3c',
  borderColor:   '#3c3c3c',
  radius:        12,
  accent:        '#ff6d5a',
  textPrimary:   '#ececec',
  textMuted:     '#888888',
  success:       '#18a058',
  danger:        '#d03050',
  warning:       '#f0a020',
  font:          "'JetBrains Mono', monospace",
  paletteWidth:  200,
  propertiesWidth: 280,
  toolbarHeight: 52,
} as const;

// ── Status badge helpers ──────────────────────────────────────────────────────

function statusColor(s: string) {
  switch (s) {
    case 'running': return { bg: `${T.success}22`, fg: T.success,  dot: T.success  };
    case 'error':   return { bg: `${T.danger}22`,  fg: T.danger,   dot: T.danger   };
    default:        return { bg: `${T.cardBg}`,    fg: T.textMuted, dot: T.textMuted };
  }
}

// ── Default configs per node type ─────────────────────────────────────────────

const DEFAULT_CONFIGS: Record<NodeType, object> = {
  source_scenario: { scenario: 'mixed_traffic', flow_rate: 5,  loop: true },
  attack_inject:   { attack_type: 'ddos',       intensity: 0.5, duration_sec: 60 },
  rate_filter:     { max_flows_per_sec: 10,      sample_rate: 1.0 },
  monitor_sink:    { clients: ['bank_a', 'bank_b', 'bank_c'] },
};

// ── Palette item definitions ──────────────────────────────────────────────────

const PALETTE_ITEMS: { type: NodeType; label: string; accent: string; sub: string }[] = [
  { type: 'source_scenario', label: 'Scenario Source', accent: T.success,  sub: 'Traffic source' },
  { type: 'attack_inject',   label: 'Attack Inject',   accent: T.danger,   sub: 'Inject attacks' },
  { type: 'rate_filter',     label: 'Rate Filter',     accent: T.warning,  sub: 'Throttle flows' },
  { type: 'monitor_sink',    label: 'Monitor Sink',    accent: T.accent,   sub: 'Send to clients' },
];

// ── Animation variants (match SimulationControlPage patterns) ─────────────────

const fadeIn = { hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0 } };

// ══════════════════════════════════════════════════════════════════════════════

export default function PipelineBuilderPage() {

  // ── State ──────────────────────────────────────────────────────────────────
  const [pipeline,       setPipeline]       = useState<PipelineOut | null>(null);
  const [nodes,          setNodes,          onNodesChange] = useNodesState([]);
  const [edges,          setEdges,          onEdgesChange] = useEdgesState([]);
  const [selectedNode,   setSelectedNode]   = useState<Node | null>(null);
  const [pipelineStatus, setPipelineStatus] = useState<PipelineStatusOut | null>(null);
  const [saving,         setSaving]         = useState(false);
  const [running,        setRunning]        = useState(false);
  const [stopping,       setStopping]       = useState(false);
  const [error,          setError]          = useState<string | null>(null);
  const [nameValue,      setNameValue]      = useState('');

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── On mount: load or create pipeline ──────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const list = await pipelineApi.list().catch(() => []);
        let loaded: PipelineOut;
        if (list.length > 0) {
          loaded = await pipelineApi.get(list[0].id);
        } else {
          loaded = await pipelineApi.create({ name: 'My Pipeline' });
        }
        setPipeline(loaded);
        setNameValue(loaded.name);
        hydrate(loaded);
      } catch (err: unknown) {
        const e = err as { message?: string };
        setError(e?.message ?? 'Failed to load pipeline');
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Hydrate React Flow state from PipelineOut ──────────────────────────────
  function hydrate(p: PipelineOut) {
    const rfNodes: Node[] = p.nodes.map(n => ({
      id:       n.node_key,
      type:     n.node_type,
      position: { x: n.position_x, y: n.position_y },
      data:     { config: n.config, label: n.label },
    }));

    const rfEdges = p.nodes.flatMap(n =>
      n.edges_json.map(e => ({
        id:       `e-${e.source_key}-${e.target_key}`,
        source:   e.source_key,
        target:   e.target_key,
        animated: true,
        style:    { stroke: T.accent },
      })),
    );

    setNodes(rfNodes);
    setEdges(rfEdges);
  }

  // ── Status polling ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!pipeline) return;
    pollRef.current = setInterval(async () => {
      try {
        const s = await pipelineApi.status(pipeline.id);
        setPipelineStatus(s);
      } catch { /* swallow */ }
    }, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [pipeline]);

  // ── Connect edges ──────────────────────────────────────────────────────────
  const onConnect = useCallback((params: Connection) => {
    setEdges(eds => addEdge(
      { ...params, animated: true, style: { stroke: T.accent } },
      eds,
    ));
  }, [setEdges]);

  // ── Add node from palette ──────────────────────────────────────────────────
  const addNode = useCallback((type: NodeType) => {
    const id = `${type}-${Date.now()}`;
    setNodes(nds => [
      ...nds,
      {
        id,
        type,
        position: { x: 250 + nds.length * 30, y: 150 + nds.length * 30 },
        data: {
          config: DEFAULT_CONFIGS[type],
          label:  type.replace(/_/g, ' '),
        },
      },
    ]);
  }, [setNodes]);

  // ── Update node data from properties panel ─────────────────────────────────
  const handleUpdateNode = useCallback((
    nodeId: string,
    config: Record<string, unknown>,
    label:  string,
  ) => {
    setNodes(nds =>
      nds.map(n =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, config, label } }
          : n,
      ),
    );
    // Keep selectedNode in sync
    setSelectedNode(prev =>
      prev?.id === nodeId
        ? { ...prev, data: { ...prev.data, config, label } }
        : prev,
    );
  }, [setNodes]);

  // ── Save ───────────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!pipeline) return;
    setSaving(true);
    setError(null);
    try {
      const nodeCreateList: PipelineNodeCreate[] = nodes.map(n => ({
        node_key:   n.id,
        node_type:  n.type as NodeType,
        label:      (n.data.label as string) ?? '',
        config:     (n.data.config as Record<string, unknown>) ?? {},
        position_x: n.position.x,
        position_y: n.position.y,
        edges_json: edges
          .filter(e => e.source === n.id)
          .map(e => ({ source_key: e.source, target_key: e.target })),
      }));
      const updated = await pipelineApi.update(pipeline.id, {
        name:  nameValue,
        nodes: nodeCreateList,
      });
      setPipeline(updated);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setError(e?.response?.data?.detail ?? e?.message ?? 'Failed to save pipeline');
    } finally {
      setSaving(false);
    }
  }, [pipeline, nodes, edges, nameValue]);

  // ── Run ────────────────────────────────────────────────────────────────────
  const handleRun = useCallback(async () => {
    if (!pipeline) return;
    setRunning(true);
    setError(null);
    try {
      await pipelineApi.run(pipeline.id);
      const s = await pipelineApi.status(pipeline.id);
      setPipelineStatus(s);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setError(e?.response?.data?.detail ?? e?.message ?? 'Failed to start pipeline');
    } finally {
      setRunning(false);
    }
  }, [pipeline]);

  // ── Stop ───────────────────────────────────────────────────────────────────
  const handleStop = useCallback(async () => {
    if (!pipeline) return;
    setStopping(true);
    setError(null);
    try {
      await pipelineApi.stop(pipeline.id);
      const s = await pipelineApi.status(pipeline.id);
      setPipelineStatus(s);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setError(e?.response?.data?.detail ?? e?.message ?? 'Failed to stop pipeline');
    } finally {
      setStopping(false);
    }
  }, [pipeline]);

  // ── Derived ────────────────────────────────────────────────────────────────
  const isRunning = pipelineStatus?.status === 'running';
  const sc        = statusColor(pipelineStatus?.status ?? 'idle');

  // ──────────────────────────────────────────────────────────────────────────
  // RENDER
  // ──────────────────────────────────────────────────────────────────────────
  return (
    <div style={{
      display:        'flex',
      flexDirection:  'column',
      height:         '100%',
      overflow:       'hidden',
      fontFamily:     T.font,
      background:     T.canvasBg,
    }}>

      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div style={{
        height:         T.toolbarHeight,
        flexShrink:     0,
        background:     T.topbarBg,
        borderBottom:   T.border,
        display:        'flex',
        alignItems:     'center',
        gap:            10,
        padding:        '0 16px',
      }}>

        {/* Pipeline name */}
        <input
          value={nameValue}
          onChange={e => setNameValue(e.target.value)}
          style={{
            background:   'transparent',
            border:       'none',
            borderBottom: `1px solid ${T.borderColor}`,
            color:        T.textPrimary,
            fontSize:     14,
            fontWeight:   600,
            fontFamily:   T.font,
            padding:      '2px 4px',
            outline:      'none',
            width:        220,
          }}
          aria-label="Pipeline name"
        />

        <div style={{ flex: 1 }} />

        {/* Status badge */}
        {pipelineStatus && (
          <div style={{
            display:      'flex',
            alignItems:   'center',
            gap:          6,
            padding:      '4px 12px',
            borderRadius: 20,
            fontSize:     11,
            fontWeight:   600,
            background:   sc.bg,
            color:        sc.fg,
            border:       T.border,
          }}>
            <div style={{
              width:        6,
              height:       6,
              borderRadius: '50%',
              background:   sc.dot,
              animation:    isRunning ? 'pipe-pulse 2s infinite' : undefined,
            }} />
            {(pipelineStatus.status ?? 'idle').toUpperCase()}
          </div>
        )}

        {/* Save */}
        <button
          onClick={handleSave}
          disabled={saving || !pipeline}
          style={{
            display:        'flex',
            alignItems:     'center',
            gap:            6,
            padding:        '7px 14px',
            borderRadius:   8,
            border:         T.border,
            background:     T.cardBg,
            color:          saving ? T.textMuted : T.textPrimary,
            fontSize:       12,
            fontWeight:     600,
            fontFamily:     T.font,
            cursor:         saving ? 'not-allowed' : 'pointer',
            opacity:        saving ? 0.7 : 1,
          }}
        >
          {saving
            ? <Loader2 style={{ width: 14, height: 14 }} className="animate-spin" />
            : <Save    style={{ width: 14, height: 14 }} />}
          Save
        </button>

        {/* Run */}
        <button
          onClick={handleRun}
          disabled={running || isRunning || !pipeline}
          style={{
            display:        'flex',
            alignItems:     'center',
            gap:            6,
            padding:        '7px 14px',
            borderRadius:   8,
            border:         'none',
            background:     T.success,
            color:          '#fff',
            fontSize:       12,
            fontWeight:     600,
            fontFamily:     T.font,
            cursor:         (running || isRunning) ? 'not-allowed' : 'pointer',
            opacity:        (running || isRunning) ? 0.5 : 1,
          }}
        >
          {running
            ? <Loader2 style={{ width: 14, height: 14 }} className="animate-spin" />
            : <Play    style={{ width: 14, height: 14 }} />}
          Run
        </button>

        {/* Stop */}
        <button
          onClick={handleStop}
          disabled={stopping || !isRunning || !pipeline}
          style={{
            display:        'flex',
            alignItems:     'center',
            gap:            6,
            padding:        '7px 14px',
            borderRadius:   8,
            border:         'none',
            background:     T.danger,
            color:          '#fff',
            fontSize:       12,
            fontWeight:     600,
            fontFamily:     T.font,
            cursor:         (stopping || !isRunning) ? 'not-allowed' : 'pointer',
            opacity:        (stopping || !isRunning) ? 0.5 : 1,
          }}
        >
          {stopping
            ? <Loader2 style={{ width: 14, height: 14 }} className="animate-spin" />
            : <Square  style={{ width: 14, height: 14 }} />}
          Stop
        </button>
      </div>

      {/* ── Error banner ─────────────────────────────────────────────────── */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            style={{
              flexShrink: 0,
              padding:    '10px 16px',
              fontSize:   12,
              background: `${T.danger}22`,
              color:      T.danger,
              border:     `1px solid ${T.danger}44`,
              display:    'flex',
              alignItems: 'center',
              gap:        8,
              fontFamily: T.font,
            }}
          >
            <span style={{ flex: 1 }}>{error}</span>
            <button
              onClick={() => setError(null)}
              style={{
                background: 'none',
                border:     'none',
                color:      T.danger,
                cursor:     'pointer',
                fontSize:   18,
                lineHeight: 1,
                padding:    0,
              }}
            >×</button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Body row: Palette | Canvas | Properties ───────────────────────── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* ── Node Palette ────────────────────────────────────────────────── */}
        <div style={{
          width:        T.paletteWidth,
          flexShrink:   0,
          background:   T.sidebarBg,
          borderRight:  T.border,
          display:      'flex',
          flexDirection: 'column',
          overflow:     'hidden',
        }}>
          <div style={{
            padding:      '12px 12px 8px',
            fontSize:     10,
            fontWeight:   700,
            color:        T.textMuted,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            fontFamily:   T.font,
            borderBottom: T.border,
          }}>
            Node Palette
          </div>

          <div style={{
            flex:      1,
            overflowY: 'auto',
            padding:   12,
            display:   'flex',
            flexDirection: 'column',
            gap:       8,
          }}>
            {PALETTE_ITEMS.map(item => (
              <motion.button
                key={item.type}
                variants={fadeIn}
                onClick={() => addNode(item.type)}
                style={{
                  display:      'flex',
                  flexDirection: 'column',
                  alignItems:   'flex-start',
                  gap:          2,
                  width:        '100%',
                  padding:      '10px 12px',
                  borderRadius: 8,
                  background:   T.cardBg,
                  border:       T.border,
                  borderLeft:   `3px solid ${item.accent}`,
                  color:        T.textPrimary,
                  fontSize:     12,
                  fontWeight:   600,
                  fontFamily:   T.font,
                  cursor:       'pointer',
                  textAlign:    'left',
                  transition:   'background 0.15s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = '#3a3a3a')}
                onMouseLeave={e => (e.currentTarget.style.background = T.cardBg)}
              >
                <span style={{ color: item.accent, fontSize: 11, fontWeight: 700 }}>
                  + {item.label}
                </span>
                <span style={{ color: T.textMuted, fontSize: 10, fontWeight: 400 }}>
                  {item.sub}
                </span>
              </motion.button>
            ))}
          </div>
        </div>

        {/* ── ReactFlow Canvas ────────────────────────────────────────────── */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => setSelectedNode(node)}
            onPaneClick={() => setSelectedNode(null)}
            fitView
            style={{ background: T.canvasBg }}
            proOptions={{ hideAttribution: true }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={20}
              size={1}
              color="#2d2d2d"
            />
            <Controls style={{ background: T.cardBg, border: T.border }} />
            <MiniMap
              style={{ background: T.sidebarBg }}
              nodeColor={T.accent}
            />
          </ReactFlow>

          {/* Empty canvas hint */}
          {nodes.length === 0 && (
            <div style={{
              position:       'absolute',
              inset:          0,
              display:        'flex',
              alignItems:     'center',
              justifyContent: 'center',
              pointerEvents:  'none',
              flexDirection:  'column',
              gap:            8,
            }}>
              <div style={{ fontSize: 36, opacity: 0.15 }}>⬡</div>
              <div style={{
                fontSize:   13,
                color:      T.textMuted,
                fontFamily: T.font,
                opacity:    0.5,
              }}>
                Add nodes from the palette to build your pipeline
              </div>
            </div>
          )}
        </div>

        {/* ── Properties Panel ────────────────────────────────────────────── */}
        <PipelinePropertiesPanel
          selectedNode={selectedNode}
          onUpdateNode={handleUpdateNode}
          onClose={() => setSelectedNode(null)}
        />
      </div>

      {/* Keyframe for status dot pulse */}
      <style>{`
        @keyframes pipe-pulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.4; }
        }
        .react-flow__attribution { display: none !important; }
      `}</style>
    </div>
  );
}
