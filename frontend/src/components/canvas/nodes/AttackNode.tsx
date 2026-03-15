/**
 * AttackNode — CVAE attack generator with play/stop controls.
 * Shape: trigger / D-shape (150x80, border-radius: 36px 12px 12px 36px)
 * Accent: #d03050 (red)
 *
 * Play button: resolves target devices via edges, calls attackNodeApi.start(),
 * then cascades status to connected MonitorNodes (auto drill-down if single).
 */

import { memo, useCallback, useState } from 'react';
import { Play, Square } from 'lucide-react';
import type { NodeProps } from 'reactflow';
import { BaseCanvasNode } from './BaseCanvasNode';
import { attackNodeApi } from '@/api/nodeSimulation';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import type { AttackNodeData, DeviceNodeData, MonitorNodeData } from '@/types/canvas';

function AttackNode(props: NodeProps<AttackNodeData>) {
  const { id, data } = props;
  const [loading, setLoading] = useState(false);

  const nodes = useWorkspaceStore((s) => s.nodes);
  const edges = useWorkspaceStore((s) => s.edges);
  const updateNodeData = useWorkspaceStore((s) => s.updateNodeData);
  const setViewMode = useWorkspaceStore((s) => s.setViewMode);
  const setDrilldownMonitorId = useWorkspaceStore((s) => s.setDrilldownMonitorId);

  const isRunning = data.status === 'running';

  /** Resolve all device IDs connected via attack-vector edges from this node */
  const resolveTargetDevices = useCallback((): string[] => {
    const targetNodeIds = edges
      .filter((e) => e.source === id && e.type === 'attack-vector')
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

  /** Find all monitor nodes observing the given device node IDs */
  const findChainedMonitors = useCallback(
    (targetNodeIds: string[]): string[] => {
      const monitorNodeIds: string[] = [];
      for (const deviceNodeId of targetNodeIds) {
        const obsEdges = edges.filter(
          (e) => e.source === deviceNodeId && e.type === 'observation',
        );
        for (const e of obsEdges) {
          if (!monitorNodeIds.includes(e.target)) {
            monitorNodeIds.push(e.target);
          }
        }
      }
      return monitorNodeIds;
    },
    [edges],
  );

  const handlePlay = useCallback(async () => {
    if (!data.attackCategory) return;
    setLoading(true);

    try {
      const targetDeviceIds = resolveTargetDevices();
      if (targetDeviceIds.length === 0) {
        console.warn('[AttackNode] No target devices connected via attack-vector edges');
        return;
      }

      // Resolve target device node IDs (for monitor chaining)
      const targetDeviceNodeIds = edges
        .filter((e) => e.source === id && e.type === 'attack-vector')
        .map((e) => e.target);

      // Intensity: data.intensity is 1-10 scale → normalize to 0.0-1.0
      const intensity = data.intensity != null ? data.intensity / 10 : 0.8;

      await attackNodeApi.start({
        attack_node_id: id,
        attack_category: data.attackCategory,
        target_device_ids: targetDeviceIds,
        intensity,
      });

      // Set this node to running
      updateNodeData(id, { status: 'running' } as Partial<AttackNodeData>);

      // Set target devices to running
      for (const nodeId of targetDeviceNodeIds) {
        updateNodeData(nodeId, { status: 'running' } as Partial<DeviceNodeData>);
      }

      // Cascade to monitors: find all observation edges from target devices
      const monitorNodeIds = findChainedMonitors(targetDeviceNodeIds);
      for (const monitorId of monitorNodeIds) {
        updateNodeData(monitorId, { status: 'running' } as Partial<MonitorNodeData>);
      }

      // Auto drill-down if exactly one monitor
      if (monitorNodeIds.length === 1) {
        setDrilldownMonitorId(monitorNodeIds[0]);
        setViewMode('monitor-drilldown');
      }
    } catch (err) {
      console.error('[AttackNode] Failed to start:', err);
      updateNodeData(id, { status: 'error' } as Partial<AttackNodeData>);
    } finally {
      setLoading(false);
    }
  }, [
    id, data.attackCategory, data.intensity, edges,
    resolveTargetDevices, findChainedMonitors,
    updateNodeData, setViewMode, setDrilldownMonitorId,
  ]);

  const handleStop = useCallback(async () => {
    setLoading(true);
    try {
      await attackNodeApi.stop(id);

      // Revert this node to idle
      updateNodeData(id, { status: 'idle' } as Partial<AttackNodeData>);

      // Revert target devices
      const targetDeviceNodeIds = edges
        .filter((e) => e.source === id && e.type === 'attack-vector')
        .map((e) => e.target);

      for (const nodeId of targetDeviceNodeIds) {
        updateNodeData(nodeId, { status: 'idle' } as Partial<DeviceNodeData>);
      }

      // Revert chained monitors
      const monitorNodeIds = findChainedMonitors(targetDeviceNodeIds);
      for (const monitorId of monitorNodeIds) {
        updateNodeData(monitorId, { status: 'idle' } as Partial<MonitorNodeData>);
      }
    } catch (err) {
      console.error('[AttackNode] Failed to stop:', err);
      // On error (e.g. 409 "no containers"), still revert to idle
      // because the attack is not actually running
      updateNodeData(id, { status: 'idle' } as Partial<AttackNodeData>);

      const targetDeviceNodeIds = edges
        .filter((e) => e.source === id && e.type === 'attack-vector')
        .map((e) => e.target);

      for (const nodeId of targetDeviceNodeIds) {
        updateNodeData(nodeId, { status: 'idle' } as Partial<DeviceNodeData>);
      }

      const monitorNodeIds = findChainedMonitors(targetDeviceNodeIds);
      for (const monitorId of monitorNodeIds) {
        updateNodeData(monitorId, { status: 'idle' } as Partial<MonitorNodeData>);
      }
    } finally {
      setLoading(false);
    }
  }, [id, edges, findChainedMonitors, updateNodeData]);

  return (
    <BaseCanvasNode {...props}>
      {/* Category chip */}
      {data.attackCategory && (
        <span
          className="canvas-node-chip"
          style={{
            color: '#d03050',
            background: 'rgba(208, 48, 80, 0.12)',
            borderColor: 'rgba(208, 48, 80, 0.24)',
          }}
        >
          {data.attackCategory}
        </span>
      )}

      {/* Play / Stop button */}
      {data.attackCategory && (
        <button
          className="canvas-node-play-btn"
          onClick={(e) => {
            e.stopPropagation();
            if (isRunning) handleStop();
            else handlePlay();
          }}
          disabled={loading}
          aria-label={isRunning ? 'Stop attack' : 'Start attack'}
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

export default memo(AttackNode);
