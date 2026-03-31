/**
 * TrafficSourceNode — CVAE benign traffic generator with play/stop controls.
 * Shape: trigger / D-shape (150x80, border-radius: 36px 12px 12px 36px)
 * Accent: #a78bfa (purple)
 *
 * Play button: resolves target devices via edges, calls trafficNodeApi.start(),
 * generates benign CVAE traffic (class_id=0) indefinitely until stopped.
 */

import { memo, useCallback, useState } from 'react';
import { Play, Square, Zap } from 'lucide-react';
import type { NodeProps } from 'reactflow';
import { BaseCanvasNode } from './BaseCanvasNode';
import { trafficNodeApi } from '@/api/nodeSimulation';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import type { TrafficSourceNodeData, DeviceNodeData } from '@/types/canvas';

function TrafficSourceNode(props: NodeProps<TrafficSourceNodeData>) {
  const { id, data } = props;
  const [loading, setLoading] = useState(false);

  const nodes = useWorkspaceStore((s) => s.nodes);
  const edges = useWorkspaceStore((s) => s.edges);
  const updateNodeData = useWorkspaceStore((s) => s.updateNodeData);
  const activeFlServerNodeId = useWorkspaceStore((s) => s.activeFlServerNodeId);

  const isRunning = data.status === 'running';
  const isFlTraining = activeFlServerNodeId != null;

  /** Resolve all device IDs connected via traffic-feed edges from this node */
  const resolveTargetDevices = useCallback((): string[] => {
    const targetNodeIds = edges
      .filter((e) => e.source === id && e.type === 'traffic-feed')
      .map((e) => e.target);

    const deviceIds: string[] = [];
    for (const nodeId of targetNodeIds) {
      const node = nodes.find((n) => n.id === nodeId);
      if (node && node.data.nodeType === 'device') {
        const devData = node.data as DeviceNodeData;
        if (devData.deviceId) {
          deviceIds.push(devData.deviceId);
        }
      }
    }
    return deviceIds;
  }, [id, edges, nodes]);

  const handlePlay = useCallback(async () => {
    setLoading(true);
    try {
      const targetDeviceIds = resolveTargetDevices();
      if (targetDeviceIds.length === 0) {
        console.warn('[TrafficSourceNode] No target devices connected via traffic-feed edges');
        return;
      }

      const flowRate = data.rate ?? 5.0;

      await trafficNodeApi.start({
        traffic_node_id: id,
        target_device_ids: targetDeviceIds,
        flow_rate: flowRate,
        traffic_type: (data.trafficType as 'benign' | 'mixed') ?? 'benign',
      });

      // Set this node to running
      updateNodeData(id, { status: 'running' } as Partial<TrafficSourceNodeData>);

      // Set target devices to active (benign traffic, not attack)
      const targetDeviceNodeIds = edges
        .filter((e) => e.source === id && e.type === 'traffic-feed')
        .map((e) => e.target);

      for (const nodeId of targetDeviceNodeIds) {
        updateNodeData(nodeId, { status: 'active' } as Partial<DeviceNodeData>);
      }
    } catch (err) {
      console.error('[TrafficSourceNode] Failed to start:', err);
      updateNodeData(id, { status: 'error' } as Partial<TrafficSourceNodeData>);
    } finally {
      setLoading(false);
    }
  }, [id, data.rate, edges, resolveTargetDevices, updateNodeData]);

  const handleStop = useCallback(async () => {
    setLoading(true);
    try {
      await trafficNodeApi.stop(id);

      // Revert this node to idle
      updateNodeData(id, { status: 'idle' } as Partial<TrafficSourceNodeData>);

      // Revert target devices
      const targetDeviceNodeIds = edges
        .filter((e) => e.source === id && e.type === 'traffic-feed')
        .map((e) => e.target);

      for (const nodeId of targetDeviceNodeIds) {
        updateNodeData(nodeId, { status: 'idle' } as Partial<DeviceNodeData>);
      }
    } catch (err) {
      console.error('[TrafficSourceNode] Failed to stop:', err);
    } finally {
      setLoading(false);
    }
  }, [id, edges, updateNodeData]);

  return (
    <BaseCanvasNode {...props}>
      {/* Rate chip */}
      {data.rate != null && (
        <span
          className="canvas-node-chip"
          style={{
            color: '#a78bfa',
            background: 'rgba(167, 139, 250, 0.12)',
            borderColor: 'rgba(167, 139, 250, 0.26)',
          }}
        >
          {data.rate} pps
        </span>
      )}

      {/* Play / Stop button — disabled during FL training (no real containers) */}
      {isFlTraining ? (
        <span
          className="canvas-node-play-btn"
          style={{
            color: '#a78bfa',
            background: 'rgba(167, 139, 250, 0.12)',
            border: '1px solid rgba(167, 139, 250, 0.24)',
            borderRadius: '4px',
            padding: '2px 6px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '3px',
            fontSize: '10px',
            fontWeight: 600,
            marginLeft: '4px',
            opacity: 0.7,
            cursor: 'default',
          }}
        >
          <Zap size={10} />
          FL Active
        </span>
      ) : (
        <button
          className="canvas-node-play-btn"
          onClick={(e) => {
            e.stopPropagation();
            if (isRunning) handleStop();
            else handlePlay();
          }}
          disabled={loading}
          aria-label={isRunning ? 'Stop traffic' : 'Start traffic'}
          style={{
            color: isRunning ? '#d03050' : '#18a058',
            background: isRunning
              ? 'rgba(208, 48, 80, 0.12)'
              : 'rgba(24, 160, 88, 0.12)',
            border: `1px solid ${isRunning ? 'rgba(208, 48, 80, 0.24)' : 'rgba(24, 160, 88, 0.24)'}`,
            borderRadius: '4px',
            padding: '2px 6px',
            cursor: loading ? 'wait' : 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '3px',
            fontSize: '10px',
            fontWeight: 600,
            marginLeft: '4px',
            opacity: loading ? 0.6 : 1,
          }}
        >
          {isRunning ? (
            <>
              <Square size={10} />
              Stop
            </>
          ) : (
            <>
              <Play size={10} />
              Run
            </>
          )}
        </button>
      )}
    </BaseCanvasNode>
  );
}

export default memo(TrafficSourceNode);
