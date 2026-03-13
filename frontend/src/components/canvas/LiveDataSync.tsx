/**
 * LiveDataSync — bridges liveStore → workspaceStore for real-time canvas animations.
 *
 * This headless component (renders null) subscribes to live WebSocket data
 * (FL training state, attack statuses, device statuses, predictions) and
 * dynamically updates canvas node `data.status` and edge `data` props so
 * that visual animations fire automatically.
 *
 * Mapping logic:
 *   - FL training active → FL Server node status=running, currentRound/totalRounds updated
 *   - FL training active → Client nodes with matching clientId get status=running
 *   - FL communication edges get data.animated=true + data.mtls=true during training
 *   - Attack runs active → Attack nodes with matching attackId get status=running
 *   - Attack vector edges get data.active=true when attack is running
 *   - Device statuses → Device node status mapped (online→active, under_attack→error)
 *   - Predictions flowing → Monitor nodes get metrics updated
 */

import { useEffect, useRef } from 'react';
import { useLiveStore } from '@/stores/liveStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import type {
  CanvasNodeData,
  FLServerNodeData,
  ClientNodeData,
  AttackNodeData,
  DeviceNodeData,
  MonitorNodeData,
  NodeStatus,
} from '@/types/canvas';

// ── Map device status strings → NodeStatus ──
function deviceStatusToNode(status: string): NodeStatus {
  switch (status) {
    case 'online':
      return 'active';
    case 'under_attack':
    case 'quarantined':
      return 'error';
    case 'offline':
      return 'disabled';
    default:
      return 'idle';
  }
}

export default function LiveDataSync() {
  const updateNodeData = useWorkspaceStore((s) => s.updateNodeData);
  const updateEdgeData = useWorkspaceStore((s) => s.updateEdgeData);
  const activeFlServerNodeId = useWorkspaceStore((s) => s.activeFlServerNodeId);
  const prevSyncRef = useRef<string>('');

  // Subscribe to all the live state we need
  const flGlobal = useLiveStore((s) => s.flGlobalProgress);
  const flClientProgress = useLiveStore((s) => s.flClientProgress);
  const attackRunStatuses = useLiveStore((s) => s.attackRunStatuses);
  const deviceStatuses = useLiveStore((s) => s.deviceStatuses);
  const latestPredictions = useLiveStore((s) => s.latestPredictions);

  // Read nodes/edges from workspace (we need to match by data props)
  const nodes = useWorkspaceStore((s) => s.nodes);
  const edges = useWorkspaceStore((s) => s.edges);

  useEffect(() => {
    // Build a compact fingerprint to avoid running when nothing changed
    const fingerprint = JSON.stringify({
      fl: flGlobal?.is_training,
      flRound: flGlobal?.current_round,
      flClients: Object.keys(flClientProgress).length,
      activeServer: activeFlServerNodeId,
      attacks: Object.keys(attackRunStatuses).length,
      devices: Object.keys(deviceStatuses).length,
      preds: latestPredictions.length,
    });

    if (fingerprint === prevSyncRef.current) return;
    prevSyncRef.current = fingerprint;

    const isTraining = flGlobal?.is_training === true || activeFlServerNodeId != null;

    // ── 1. FL Server nodes — only update the node that initiated training ──
    for (const node of nodes) {
      if (node.data.nodeType !== 'fl-server') continue;
      const d = node.data as FLServerNodeData;

      // Only mark the specific node that started training as "running".
      // Other fl-server nodes on the canvas remain unchanged.
      const isActiveServer = node.id === activeFlServerNodeId;
      const newStatus: NodeStatus = (isTraining && isActiveServer) ? 'running'
        : d.status === 'running' ? 'idle'
        : d.status;
      const updates: Partial<FLServerNodeData> = {
        status: newStatus,
      };

      if (flGlobal) {
        updates.currentRound = flGlobal.current_round;
        updates.totalRounds = flGlobal.total_rounds;
        if (flGlobal.use_he !== undefined) {
          updates.useHE = flGlobal.use_he;
        }
        if (flGlobal.aggregation_method) {
          updates.aggregationMethod = flGlobal.aggregation_method;
        }
        // Enable all security features during training (they are always on in production)
        if (isTraining) {
          updates.securityFeatures = {
            vss: true,
            mtls: true,
            gradientSigning: true,
            roundNonces: true,
            recess: true,
          };
        }
      }

      updateNodeData(node.id, updates as Partial<CanvasNodeData>);
    }

    // ── 2. Client nodes — map FL client progress to canvas ──
    // Build a set of "running" client node IDs for Device/TrafficSource cascade
    const runningClientNodeIds = new Set<string>();

    for (const node of nodes) {
      if (node.data.nodeType !== 'client') continue;
      const d = node.data as ClientNodeData;

      // Match by canvas node ID → derived client_id (node.id with hyphens → underscores)
      const derivedClientId = node.id.replace(/-/g, '_');
      const progress = flClientProgress[derivedClientId]
        ?? Object.values(flClientProgress).find((p) => p.client_id === d.label);

      let newStatus: NodeStatus = d.status;
      if (isTraining && progress) {
        const s = progress.status;
        if (s === 'training' || s === 'encrypting' || s === 'sending') {
          newStatus = 'running';
        } else if (s === 'done') {
          newStatus = 'success';
        } else if (s === 'waiting' || s === 'idle') {
          newStatus = 'active';
        }
      } else if (isTraining && !progress) {
        // Training is active but no WS progress yet — keep as running if already set
        if (d.status === 'running') newStatus = 'running';
      } else if (!isTraining && (d.status === 'running' || d.status === 'active')) {
        newStatus = 'idle';
      }

      if (newStatus === 'running' || newStatus === 'active') {
        runningClientNodeIds.add(node.id);
      }

      // We pass FL training progress as extra data on the client node
      // The ClientNode component reads these optional fields
      const updates: Partial<ClientNodeData> & Record<string, unknown> = {
        status: newStatus,
      };

      if (progress) {
        updates._flProgress = {
          status: progress.status,
          epoch: progress.current_epoch,
          totalEpochs: progress.total_epochs,
          progressPct: progress.progress_pct,
          loss: progress.local_loss,
          accuracy: progress.local_accuracy,
        };
      } else if (!isTraining) {
        updates._flProgress = undefined;
      }

      updateNodeData(node.id, updates as Partial<CanvasNodeData>);
    }

    // ── 3. Attack nodes — map active attack runs by attackId ──
    const activeAttackIds = new Set<number>();
    for (const run of Object.values(attackRunStatuses)) {
      if (run.status === 'running' || run.status === 'pending') {
        activeAttackIds.add(run.attack_id);
      }
    }

    for (const node of nodes) {
      if (node.data.nodeType !== 'attack') continue;
      const d = node.data as AttackNodeData;

      // Match attack node to live run via data.attackId
      const isActive = d.attackId != null
        ? activeAttackIds.has(d.attackId)
        : activeAttackIds.size > 0; // fallback: no attackId → match any active run
      const newStatus: NodeStatus = isActive ? 'running' : d.status === 'running' ? 'idle' : d.status;

      updateNodeData(node.id, { status: newStatus } as Partial<CanvasNodeData>);
    }

    // ── 4. Device nodes — map device statuses from WS + FL training cascade ──
    // Build a set of running device node IDs for traffic source cascade
    const runningDeviceNodeIds = new Set<string>();

    for (const node of nodes) {
      if (node.data.nodeType !== 'device') continue;
      const d = node.data as DeviceNodeData;

      // Check if this device is owned by a running client (ownership edge: client → device)
      const ownerClientEdge = edges.find(
        (e) => e.target === node.id && e.type === 'ownership' && runningClientNodeIds.has(e.source),
      );

      if (ownerClientEdge && isTraining) {
        updateNodeData(node.id, { status: 'active' } as Partial<CanvasNodeData>);
        runningDeviceNodeIds.add(node.id);
      } else if (d.deviceId && deviceStatuses[d.deviceId]) {
        const devStatus = deviceStatuses[d.deviceId];
        const newStatus = deviceStatusToNode(devStatus.status);
        updateNodeData(node.id, { status: newStatus } as Partial<CanvasNodeData>);
      } else if (!isTraining && (d.status === 'active' || d.status === 'running')) {
        updateNodeData(node.id, { status: 'idle' } as Partial<CanvasNodeData>);
      }
    }

    // ── 4b. Traffic Source nodes — cascade from running devices ──
    for (const node of nodes) {
      if (node.data.nodeType !== 'traffic-source') continue;
      const d = node.data as CanvasNodeData;

      // Check if this traffic source feeds a running device (traffic-feed edge: source → device)
      const feedsRunningDevice = edges.some(
        (e) => e.source === node.id && e.type === 'traffic-feed' && runningDeviceNodeIds.has(e.target),
      );

      if (feedsRunningDevice && isTraining) {
        updateNodeData(node.id, { status: 'active' } as Partial<CanvasNodeData>);
      } else if (!isTraining && (d.status === 'active' || d.status === 'running')) {
        updateNodeData(node.id, { status: 'idle' } as Partial<CanvasNodeData>);
      }
    }

    // ── 5. Monitor nodes — update prediction metrics ──
    if (latestPredictions.length > 0) {
      const totalPredictions = latestPredictions.length;
      const attacks = latestPredictions.filter((p) => p.label === 'attack');
      const attackRate = totalPredictions > 0 ? attacks.length / totalPredictions : 0;
      const avgLatency =
        latestPredictions.reduce((sum, p) => sum + (p.inference_latency_ms ?? 0), 0) /
        totalPredictions;
      const avgConfidence =
        latestPredictions.reduce((sum, p) => sum + p.confidence, 0) / totalPredictions;

      for (const node of nodes) {
        if (node.data.nodeType !== 'monitor') continue;
        updateNodeData(node.id, {
          status: 'active',
          metrics: {
            totalPredictions,
            attackRate: Math.round(attackRate * 100),
            avgLatency: Math.round(avgLatency * 10) / 10,
            avgConfidence: Math.round(avgConfidence * 100),
          },
        } as Partial<MonitorNodeData> as Partial<CanvasNodeData>);
      }
    }

    // ── 6. Edge data updates ──
    // FL communication edges: animated during training, mtls always on
    for (const edge of edges) {
      if (edge.type === 'fl-communication') {
        const shouldAnimate = isTraining;
        if (edge.data?.animated !== shouldAnimate || edge.data?.mtls !== true) {
          updateEdgeData(edge.id, { animated: shouldAnimate, mtls: true });
        }
      }

      // Attack vector edges: active when any attack run is running
      if (edge.type === 'attack-vector') {
        const shouldPulse = activeAttackIds.size > 0;
        if (edge.data?.active !== shouldPulse) {
          updateEdgeData(edge.id, { active: shouldPulse });
        }
      }
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flGlobal, flClientProgress, attackRunStatuses, deviceStatuses, latestPredictions]);

  return null;
}
