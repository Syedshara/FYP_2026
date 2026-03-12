/**
 * TrafficTopology — animated network graph of the full IoT-IDS deployment.
 *
 * Layout (3 tiers):
 *   Top    : Global FL Server (single node)
 *   Middle : FL Clients (one node per registered client)
 *   Bottom : IoT Devices (grouped under their client)
 *
 * Animations:
 *   • Edges animate when data is flowing (predictions device→client, weights client→server)
 *   • Node status drives border color and pulse ring
 *
 * Data sources (all from liveStore — no extra API calls):
 *   clientStatuses    → container running/training/idle
 *   flClientProgress  → current training phase
 *   deviceStatuses    → online/offline/under_attack
 *   latestPredictions → triggers device→client edge animation
 */

import { useMemo, useCallback } from 'react';
import ReactFlow, {
  Background,
  Controls,
  type Node,
  type Edge,
  type NodeProps,
  Handle,
  Position,
  BackgroundVariant,
} from 'reactflow';
import { useLiveStore } from '@/stores/liveStore';
import type { FLClient, Device } from '@/types';

// ── Colour helpers ──────────────────────────────────────────────────────────

function serverColor(isAggregating: boolean): string {
  return isAggregating ? '#a78bfa' : '#818cf8'; // purple / indigo
}

function clientColor(status: string): string {
  switch (status) {
    case 'training':   return '#38bdf8'; // sky-400
    case 'encrypting': return '#fb923c'; // orange-400
    case 'sending':    return '#4ade80'; // green-400
    case 'done':       return '#4ade80';
    default:           return '#64748b'; // slate-500
  }
}

function deviceColor(status: string, lastLabel?: string): string {
  if (lastLabel?.toLowerCase() === 'attack') return '#f87171'; // red-400
  switch (status) {
    case 'online':       return '#4ade80'; // green-400
    case 'under_attack': return '#f87171'; // red-400
    case 'quarantined':  return '#fb923c'; // orange-400
    default:             return '#475569'; // slate-600
  }
}

// ── Node renderers ──────────────────────────────────────────────────────────

function ServerNode({ data }: NodeProps) {
  const pulse = data.isAggregating as boolean;
  const color = serverColor(pulse);
  return (
    <div style={{
      width: 120,
      textAlign: 'center',
      padding: '10px 14px',
      borderRadius: 12,
      background: 'var(--n8n-card-bg)',
      border: `2px solid ${color}`,
      boxShadow: pulse ? `0 0 16px 4px ${color}66` : '0 2px 8px rgba(0,0,0,0.4)',
      transition: 'all 0.4s',
      position: 'relative',
    }}>
      {pulse && (
        <span style={{
          position: 'absolute', inset: -6, borderRadius: 16,
          border: `2px solid ${color}`,
          animation: 'topology-ping 1.2s ease-out infinite',
          pointerEvents: 'none',
        }} />
      )}
      <div style={{ fontSize: 22, marginBottom: 4 }}>🖥️</div>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--n8n-text-primary)' }}>
        FL Server
      </div>
      <div style={{ fontSize: 9, color, marginTop: 2, fontWeight: 600, textTransform: 'uppercase' }}>
        {pulse ? 'Aggregating' : 'Idle'}
      </div>
      <Handle type="target" position={Position.Bottom} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}

function ClientNode({ data }: NodeProps) {
  const status = (data.status as string) || 'idle';
  const color  = clientColor(status);
  const label  = (data.label as string) || 'client';
  const pulse  = status === 'training' || status === 'encrypting';
  return (
    <div style={{
      width: 108,
      textAlign: 'center',
      padding: '8px 10px',
      borderRadius: 10,
      background: 'var(--n8n-card-bg)',
      border: `2px solid ${color}`,
      boxShadow: pulse ? `0 0 12px 3px ${color}55` : '0 1px 6px rgba(0,0,0,0.4)',
      transition: 'all 0.4s',
      position: 'relative',
    }}>
      {pulse && (
        <span style={{
          position: 'absolute', inset: -5, borderRadius: 12,
          border: `2px solid ${color}`,
          animation: 'topology-ping 1.4s ease-out infinite',
          pointerEvents: 'none',
        }} />
      )}
      <div style={{ fontSize: 18, marginBottom: 3 }}>💻</div>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--n8n-text-primary)', wordBreak: 'break-all' }}>
        {label}
      </div>
      <div style={{ fontSize: 9, color, marginTop: 2, fontWeight: 600, textTransform: 'uppercase' }}>
        {status}
      </div>
      <Handle type="source" id="to-server" position={Position.Top}    style={{ opacity: 0 }} />
      <Handle type="target" position={Position.Bottom} style={{ opacity: 0 }} />
      <Handle type="source" id="to-devices" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}

function DeviceNode({ data }: NodeProps) {
  const status    = (data.status as string) || 'offline';
  const lastLabel = (data.lastLabel as string | undefined);
  const isAttack  = lastLabel?.toLowerCase() === 'attack';
  const color     = deviceColor(status, lastLabel);
  const label     = (data.label as string) || 'device';
  const pulse     = isAttack || status === 'under_attack';
  return (
    <div style={{
      width: 90,
      textAlign: 'center',
      padding: '6px 8px',
      borderRadius: 8,
      background: 'var(--n8n-card-bg)',
      border: `1.5px solid ${color}`,
      boxShadow: pulse ? `0 0 10px 3px ${color}55` : '0 1px 4px rgba(0,0,0,0.3)',
      transition: 'all 0.4s',
      position: 'relative',
    }}>
      {pulse && (
        <span style={{
          position: 'absolute', inset: -4, borderRadius: 10,
          border: `1.5px solid ${color}`,
          animation: 'topology-ping 1s ease-out infinite',
          pointerEvents: 'none',
        }} />
      )}
      <div style={{ fontSize: 15, marginBottom: 2 }}>📡</div>
      <div style={{
        fontSize: 9, fontWeight: 700,
        color: 'var(--n8n-text-primary)',
        wordBreak: 'break-all', lineHeight: 1.3,
        maxWidth: 80, margin: '0 auto',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {label}
      </div>
      <div style={{ fontSize: 8, color, marginTop: 2, fontWeight: 600, textTransform: 'uppercase' }}>
        {isAttack ? 'ATTACK' : status}
      </div>
      <Handle type="source" position={Position.Top} style={{ opacity: 0 }} />
    </div>
  );
}

// Register custom node types outside component to prevent re-registration on render
const nodeTypes = {
  server: ServerNode,
  client: ClientNode,
  device: DeviceNode,
};

// ── Main component ──────────────────────────────────────────────────────────

interface TrafficTopologyProps {
  clients: FLClient[];
  devices: Device[];
}

export default function TrafficTopology({ clients, devices }: TrafficTopologyProps) {
  const flClientProgress = useLiveStore((s) => s.flClientProgress);
  const flGlobalProgress = useLiveStore((s) => s.flGlobalProgress);
  const clientStatuses   = useLiveStore((s) => s.clientStatuses);
  const deviceStatuses   = useLiveStore((s) => s.deviceStatuses);
  const latestPredictions = useLiveStore((s) => s.latestPredictions);

  // ── Derive live status for each client ──────────────────────────────────
  const getClientStatus = useCallback((client: FLClient): string => {
    // Prefer fine-grained training phase from flClientProgress
    const prog = flClientProgress[client.client_id];
    if (prog?.status && prog.status !== 'idle') return prog.status;
    // Fall back to container status
    const cs = clientStatuses[client.id];
    if (cs?.status === 'training') return 'training';
    return cs?.status ?? 'idle';
  }, [flClientProgress, clientStatuses]);

  // ── Detect which device→client edges are active (recent prediction) ──────
  const activeDeviceIds = useMemo(() => {
    const cutoff = Date.now() - 4000; // active if prediction in last 4s
    const ids = new Set<string>();
    for (const p of latestPredictions) {
      if (new Date(p.timestamp).getTime() >= cutoff) {
        ids.add(String(p.device_id));
      }
    }
    return ids;
  }, [latestPredictions]);

  // ── Detect which client→server edges are active (sending weights) ────────
  const sendingClients = useMemo(() => {
    const ids = new Set<string>();
    for (const [cid, prog] of Object.entries(flClientProgress)) {
      if (prog.status === 'sending' || prog.status === 'encrypting') ids.add(cid);
    }
    return ids;
  }, [flClientProgress]);

  const isAggregating = !!flGlobalProgress?.is_training &&
    Object.values(flClientProgress).some((p) => p.status === 'sending' || p.status === 'encrypting');

  // ── Last label per device (to color red on attack) ────────────────────────
  const lastLabelByDevice = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of [...latestPredictions].reverse()) {
      if (!map[String(p.device_id)]) map[String(p.device_id)] = p.label;
    }
    return map;
  }, [latestPredictions]);

  // ── Build ReactFlow nodes ─────────────────────────────────────────────────
  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];

    const CANVAS_W    = 900;
    const SERVER_Y    = 40;
    const CLIENT_Y    = 200;
    const DEVICE_Y    = 380;
    const clientCount = clients.length || 1;

    // Server node
    nodes.push({
      id: 'server',
      type: 'server',
      position: { x: CANVAS_W / 2 - 60, y: SERVER_Y },
      data: { isAggregating },
      draggable: false,
      selectable: false,
    });

    // Client nodes — spread evenly across canvas width
    clients.forEach((client, ci) => {
      const spacing = CANVAS_W / (clientCount + 1);
      const cx = spacing * (ci + 1) - 54;
      const clientStatus = getClientStatus(client);

      const clientNodeId = `client-${client.id}`;
      nodes.push({
        id: clientNodeId,
        type: 'client',
        position: { x: cx, y: CLIENT_Y },
        data: { label: client.name || client.client_id, status: clientStatus },
        draggable: false,
        selectable: false,
      });

      // Server → Client edge
      const isSending = sendingClients.has(client.client_id);
      edges.push({
        id: `edge-server-${client.id}`,
        source: 'server',
        target: clientNodeId,
        animated: true, // always animated — toggling causes CSS snap/reset jump
        style: {
          stroke: '#a78bfa',
          strokeWidth: isSending ? 2 : 1.5,
          strokeOpacity: isSending ? 1 : 0.2,
          transition: 'stroke-opacity 0.4s, stroke-width 0.4s',
        },
        type: 'smoothstep',
      });

      // Devices for this client
      const clientDevices = devices.filter((d) => d.client_id === client.id);
      const devCount = clientDevices.length || 1;

      clientDevices.forEach((device, di) => {
        const devSpacing = Math.min(120, CANVAS_W / (clientCount * (devCount + 1)));
        const baseX = cx - ((devCount - 1) * devSpacing) / 2;
        const dx = baseX + di * devSpacing;

        const devStatus    = deviceStatuses[device.id]?.status ?? device.status ?? 'offline';
        const lastLabel    = lastLabelByDevice[device.id];
        const devNodeId    = `device-${device.id}`;
        const isDevActive  = activeDeviceIds.has(device.id);

        nodes.push({
          id: devNodeId,
          type: 'device',
          position: { x: dx, y: DEVICE_Y },
          data: { label: device.name, status: devStatus, lastLabel },
          draggable: false,
          selectable: false,
        });

        // Device → Client edge
        edges.push({
          id: `edge-${device.id}-${client.id}`,
          source: devNodeId,
          target: clientNodeId,
          animated: true, // always animated — toggling causes CSS snap/reset jump
          style: {
            stroke: lastLabel?.toLowerCase() === 'attack' ? '#f87171' : '#4ade80',
            strokeWidth: isDevActive ? 2 : 1.5,
            strokeOpacity: isDevActive ? 1 : 0.2,
            transition: 'stroke-opacity 0.4s, stroke-width 0.4s',
          },
          type: 'smoothstep',
        });
      });
    });

    return { nodes, edges };
  }, [
    clients, devices,
    isAggregating, getClientStatus, sendingClients,
    deviceStatuses, activeDeviceIds, lastLabelByDevice,
  ]);

  if (clients.length === 0) {
    return (
      <div style={{
        width: '100%', height: 520, minHeight: 520,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        borderRadius: 10, background: 'var(--n8n-canvas-bg)',
        border: '1px solid var(--n8n-card-border)',
      }}>
        <div style={{ textAlign: 'center', color: 'var(--n8n-text-muted)' }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>🌐</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>No clients registered</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Create FL clients to visualize the topology</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: 520, minHeight: 520, position: 'relative', borderRadius: 10, overflow: 'hidden', background: '#18191c' }}>
      {/* Keyframe animation injected once */}
      <style>{`
        @keyframes topology-ping {
          0%   { transform: scale(1);   opacity: 0.9; }
          70%  { transform: scale(1.3); opacity: 0.3; }
          100% { transform: scale(1.5); opacity: 0; }
        }
        .react-flow__attribution { display: none !important; }
      `}</style>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        style={{ background: '#18191c' }}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          color="#2d2d2d"
        />
        <Controls showInteractive={false} style={{ bottom: 12, right: 12, left: 'auto', top: 'auto' }} />
      </ReactFlow>

      {/* Legend */}
      <div style={{
        position: 'absolute', top: 12, right: 12,
        background: 'var(--n8n-card-bg)',
        border: '1px solid var(--n8n-card-border)',
        borderRadius: 8, padding: '8px 12px',
        fontSize: 10, lineHeight: 1.8,
        color: 'var(--n8n-text-muted)',
        pointerEvents: 'none',
      }}>
        <div style={{ fontWeight: 700, marginBottom: 4, color: 'var(--n8n-text-primary)' }}>Legend</div>
        {[
          ['#38bdf8', 'Training'],
          ['#fb923c', 'Encrypting'],
          ['#4ade80', 'Sending / Benign'],
          ['#f87171', 'Attack detected'],
          ['#a78bfa', 'Aggregating'],
          ['#64748b', 'Idle / Offline'],
        ].map(([color, label]) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block', flexShrink: 0 }} />
            {label}
          </div>
        ))}
      </div>
    </div>
  );
}
