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
      flClients: Object.entries(flClientProgress).map(([k, v]) => `${k}:${v.status}`).join(','),
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
    // Map FL client string ID (e.g. "client_abc123") → canvas node ID for device linking
    const clientStringToNodeId = new Map<string, string>();

    for (const node of nodes) {
      if (node.data.nodeType !== 'client') continue;
      const d = node.data as ClientNodeData;

      // Match by canvas node ID → derived client_id (node.id with hyphens → underscores)
      const derivedClientId = node.id.replace(/-/g, '_');
      const progress = flClientProgress[derivedClientId]
        ?? Object.values(flClientProgress).find((p) => p.client_id === d.label);

      // Track the mapping from FL client string ID → canvas node ID
      if (progress) {
        clientStringToNodeId.set(progress.client_id, node.id);
      } else {
        // Even without progress, register the derived ID so device linking works at rest
        clientStringToNodeId.set(derivedClientId, node.id);
      }

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

    // Build reverse mapping: FL client string ID → Set of device UUIDs from predictions
    // This lets us auto-link canvas Device nodes to backend Device records
    const clientDevices = new Map<string, Set<string>>();
    for (const pred of latestPredictions) {
      if (pred.client_string_id) {
        let devSet = clientDevices.get(pred.client_string_id);
        if (!devSet) {
          devSet = new Set();
          clientDevices.set(pred.client_string_id, devSet);
        }
        devSet.add(pred.device_id);
      }
    }

    // Also build reverse: canvas node ID → FL client string ID
    const nodeIdToClientString = new Map<string, string>();
    for (const [clientStr, nodeId] of clientStringToNodeId) {
      nodeIdToClientString.set(nodeId, clientStr);
    }

    // Track resolved device UUIDs so Monitor section can read them (updateNodeData is async)
    const deviceNodeResolvedIds = new Map<string, string>();

    for (const node of nodes) {
      if (node.data.nodeType !== 'device') continue;
      const d = node.data as DeviceNodeData;

      // Check if this device is owned by a running client (ownership edge: client → device)
      const ownerClientEdge = edges.find(
        (e) => e.target === node.id && e.type === 'ownership' && runningClientNodeIds.has(e.source),
      );

      // Auto-populate deviceId from predictions if not already set
      let resolvedDeviceId = d.deviceId;
      if (!resolvedDeviceId) {
        // Find the owning Client node (any ownership edge, not just running)
        const anyOwnerEdge = ownerClientEdge ?? edges.find(
          (e) => e.target === node.id && e.type === 'ownership',
        );
        if (anyOwnerEdge) {
          const ownerClientStringId = nodeIdToClientString.get(anyOwnerEdge.source);
          if (ownerClientStringId) {
            const deviceUuids = clientDevices.get(ownerClientStringId);
            if (deviceUuids && deviceUuids.size > 0) {
              // Pick the first device UUID (most common: 1 client → 1 device)
              resolvedDeviceId = deviceUuids.values().next().value;
            }
          }
        }
      }

      const deviceUpdates: Partial<DeviceNodeData> = {};
      if (resolvedDeviceId && resolvedDeviceId !== d.deviceId) {
        deviceUpdates.deviceId = resolvedDeviceId;
      }

      // Track resolved ID for downstream Monitor section (store update is async)
      if (resolvedDeviceId) {
        deviceNodeResolvedIds.set(node.id, resolvedDeviceId);
      }

      if (ownerClientEdge && isTraining) {
        deviceUpdates.status = 'running';
        runningDeviceNodeIds.add(node.id);
      } else if (resolvedDeviceId && deviceStatuses[resolvedDeviceId]) {
        const devStatus = deviceStatuses[resolvedDeviceId];
        deviceUpdates.status = deviceStatusToNode(devStatus.status);
      } else if (!isTraining && (d.status === 'active' || d.status === 'running')) {
        deviceUpdates.status = 'idle';
      }

      if (Object.keys(deviceUpdates).length > 0) {
        updateNodeData(node.id, deviceUpdates as Partial<CanvasNodeData>);
      }
    }

    // ── 4b. Monitor nodes — cascade from devices + resolve observed device ──
    // Track resolved deviceId per monitor node so section 5 doesn't read stale node.data
    const monitorResolvedDeviceIds = new Map<string, string>(); // monitorNodeId → deviceUUID

    for (const node of nodes) {
      if (node.data.nodeType !== 'monitor') continue;

      // Find the observation edge targeting this Monitor (Device → Monitor)
      const observationEdge = edges.find(
        (e) => e.target === node.id && e.type === 'observation',
      );

      if (!observationEdge) {
        // Monitor not connected to any device — mark disabled
        updateNodeData(node.id, { status: 'disabled', deviceId: undefined, deviceLabel: undefined } as Partial<MonitorNodeData> as Partial<CanvasNodeData>);
        continue;
      }

      const sourceNode = nodes.find((n) => n.id === observationEdge.source);
      if (!sourceNode) continue;

      let connectedDeviceId: string | undefined;
      let connectedDeviceLabel: string | undefined;
      let deviceNodeId: string | undefined; // canvas node ID of the device (for status check)

      if (sourceNode.data.nodeType === 'device') {
        const deviceData = sourceNode.data as DeviceNodeData;
        // Prefer resolved ID (computed this tick) over stale node data
        connectedDeviceId = deviceNodeResolvedIds.get(sourceNode.id) ?? deviceData.deviceId;
        connectedDeviceLabel = deviceData.label;
        deviceNodeId = sourceNode.id;
      } else if (sourceNode.data.nodeType === 'rate-filter') {
        // Rate-filter sits between Device and Monitor — trace back to Device
        const rfSourceEdge = edges.find(
          (e) => e.target === sourceNode.id && e.type === 'observation',
        );
        if (rfSourceEdge) {
          const rfSourceNode = nodes.find((n) => n.id === rfSourceEdge.source);
          if (rfSourceNode?.data.nodeType === 'device') {
            const deviceData = rfSourceNode.data as DeviceNodeData;
            connectedDeviceId = deviceNodeResolvedIds.get(rfSourceNode.id) ?? deviceData.deviceId;
            connectedDeviceLabel = deviceData.label;
            deviceNodeId = rfSourceNode.id;
          }
        }
      }

      // Store resolved ID so section 5 can use it without re-reading stale node.data
      if (connectedDeviceId) {
        monitorResolvedDeviceIds.set(node.id, connectedDeviceId);
      }

      // Cascade status from connected Device
      let monitorStatus: NodeStatus = 'idle';
      if (deviceNodeId && runningDeviceNodeIds.has(deviceNodeId) && isTraining) {
        monitorStatus = 'running';
      } else if (!isTraining && ((node.data as MonitorNodeData).status === 'running' || (node.data as MonitorNodeData).status === 'active')) {
        monitorStatus = 'idle';
      }

      updateNodeData(node.id, {
        status: monitorStatus,
        deviceId: connectedDeviceId,
        deviceLabel: connectedDeviceLabel,
      } as Partial<MonitorNodeData> as Partial<CanvasNodeData>);
    }

    // ── 4c. Traffic Source nodes — cascade from running devices ──
    for (const node of nodes) {
      if (node.data.nodeType !== 'traffic-source') continue;
      const d = node.data as CanvasNodeData;

      // Check if this traffic source feeds a running device (traffic-feed edge: source → device)
      const feedsRunningDevice = edges.some(
        (e) => e.source === node.id && e.type === 'traffic-feed' && runningDeviceNodeIds.has(e.target),
      );

      if (feedsRunningDevice && isTraining) {
        updateNodeData(node.id, { status: 'running' } as Partial<CanvasNodeData>);
      } else if (!isTraining && (d.status === 'active' || d.status === 'running')) {
        updateNodeData(node.id, { status: 'idle' } as Partial<CanvasNodeData>);
      }
    }

    // ── 5. Monitor nodes — update device-scoped prediction metrics ──
    for (const node of nodes) {
      if (node.data.nodeType !== 'monitor') continue;
      const d = node.data as MonitorNodeData;

      // Prefer the device ID resolved this tick (avoids stale node.data from previous tick)
      const effectiveDeviceId = monitorResolvedDeviceIds.get(node.id) ?? d.deviceId;

      // Filter predictions by this Monitor's connected device
      const devicePredictions = effectiveDeviceId
        ? latestPredictions.filter((p) => p.device_id === effectiveDeviceId)
        : [];

      const updates: Partial<MonitorNodeData> = {};

      if (devicePredictions.length > 0) {
        const attacks = devicePredictions.filter((p) => p.label === 'attack');
        const attackRate = attacks.length / devicePredictions.length;
        const avgLatency =
          devicePredictions.reduce((sum, p) => sum + (p.inference_latency_ms ?? 0), 0) /
          devicePredictions.length;
        const avgConfidence =
          devicePredictions.reduce((sum, p) => sum + p.confidence, 0) /
          devicePredictions.length;

        updates.metrics = {
          totalPredictions: devicePredictions.length,
          attackRate: Math.round(attackRate * 100),
          avgLatency: Math.round(avgLatency * 10) / 10,
          avgConfidence: Math.round(avgConfidence * 100),
        };

        // If metrics are flowing, ensure the Monitor shows as active at minimum
        if (d.status === 'idle' || d.status === 'disabled') {
          updates.status = 'active';
        }
      } else {
        updates.metrics = undefined;
      }

      updateNodeData(node.id, updates as Partial<CanvasNodeData>);
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

      // Traffic feed edges: animated when training + target device is running
      if (edge.type === 'traffic-feed') {
        const shouldAnimate = isTraining && runningDeviceNodeIds.has(edge.target);
        if (edge.data?.animated !== shouldAnimate) {
          updateEdgeData(edge.id, { animated: shouldAnimate });
        }
      }
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flGlobal, flClientProgress, attackRunStatuses, deviceStatuses, latestPredictions]);

  return null;
}
