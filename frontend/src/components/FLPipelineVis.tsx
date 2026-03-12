import { useMemo, type CSSProperties } from 'react';
import ReactFlow, { Background, BackgroundVariant } from 'reactflow';
import 'reactflow/dist/style.css';
import type { FLClientProgress } from '@/stores/liveStore';
import { clientStatusColor, PIPELINE_COLORS, pipelineNodeTypes } from './flPipelineNodes';

interface FLPipelineVisProps {
  activeStep: string;
  clients: Record<string, FLClientProgress>;
}

function edgeStyle(active: boolean, color: string): CSSProperties {
  return {
    stroke: color,
    strokeWidth: active ? 2.5 : 1.5,
    strokeOpacity: active ? 1 : 0.45,
    transition: 'stroke-opacity 0.4s, stroke-width 0.4s',
  };
}

export default function FLPipelineVis({ activeStep, clients }: FLPipelineVisProps) {
  const clientEntries = useMemo(
    () => Object.values(clients).sort((a, b) => a.client_id.localeCompare(b.client_id)),
    [clients],
  );

  const clientCount = clientEntries.length;
  const height = Math.min(560, Math.max(320, clientCount * 88 + 120));
  const xServer = 80;
  const xClient = 420;
  const xAggregate = 760;
  const serverY = height / 2 - 42;
  const aggregateY = height / 2 - 42;
  const clientSpacing = clientCount > 1 ? Math.min(92, (height - 140) / (clientCount - 1)) : 0;
  const clientStartY = (height - clientSpacing * Math.max(clientCount - 1, 0)) / 2 - 42;

  const { nodes, edges } = useMemo(() => {
    const isDistribute = activeStep === 'distribute';
    const isTrainOrEncrypt = activeStep === 'training' || activeStep === 'encrypting';
    const isAggregating = activeStep === 'aggregating';

    const nodes = [
      {
        id: 'server',
        type: 'serverPipe',
        position: { x: xServer, y: serverY },
        data: { label: 'FL Server', subtitle: 'FedAvg + CKKS', color: PIPELINE_COLORS.server },
      },
      {
        id: 'aggregate',
        type: 'aggregatePipe',
        position: { x: xAggregate, y: aggregateY },
        data: { label: 'Aggregator', subtitle: 'Secure Merge', color: PIPELINE_COLORS.aggregate },
      },
      ...clientEntries.map((client, i) => {
        const color = clientStatusColor(client.status);
        return {
          id: `client-${client.client_id}`,
          type: 'clientPipe',
          position: { x: xClient, y: clientCount === 1 ? height / 2 - 42 : clientStartY + i * clientSpacing },
          data: {
            label: client.client_id,
            subtitle: 'Local train + encrypt',
            color,
            status: client.status,
            progressPct: client.progress_pct,
          },
        };
      }),
    ];

    const edges = [
      ...clientEntries.map((client) => ({
        id: `srv-to-${client.client_id}`,
        source: 'server',
        target: `client-${client.client_id}`,
        sourceHandle: 'src',
        targetHandle: 'in',
        type: 'smoothstep',
        animated: true,
        style: edgeStyle(isDistribute, PIPELINE_COLORS.server),
      })),
      ...clientEntries.map((client) => {
        const color = clientStatusColor(client.status);
        return {
          id: `${client.client_id}-to-agg`,
          source: `client-${client.client_id}`,
          target: 'aggregate',
          sourceHandle: 'out',
          targetHandle: 'in',
          type: 'smoothstep',
          animated: true,
          style: edgeStyle(isTrainOrEncrypt, color),
        };
      }),
      {
        id: 'agg-to-srv',
        source: 'aggregate',
        target: 'server',
        sourceHandle: 'retOut',
        targetHandle: 'retIn',
        type: 'smoothstep',
        animated: true,
        style: edgeStyle(isAggregating, PIPELINE_COLORS.aggregate),
      },
    ];

    return { nodes, edges };
  }, [
    activeStep,
    clientCount,
    clientEntries,
    clientSpacing,
    clientStartY,
    height,
    serverY,
    aggregateY,
    xServer,
    xClient,
    xAggregate,
  ]);

  if (clientCount === 0) {
    return (
      <div style={{
        height: 220,
        width: '100%',
        borderRadius: 10,
        border: '1px solid #313150',
        background: PIPELINE_COLORS.canvas,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: PIPELINE_COLORS.textMuted,
        fontSize: 13,
      }}>
        No clients connected
      </div>
    );
  }

  return (
    <div style={{ height, width: '100%', borderRadius: 10, border: '1px solid #313150', overflow: 'hidden', background: PIPELINE_COLORS.canvas }}>
      <ReactFlow
        style={{ background: PIPELINE_COLORS.canvas }}
        nodes={nodes}
        edges={edges}
        nodeTypes={pipelineNodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
        onInit={(inst) => {
          setTimeout(() => inst.fitView({ padding: 0.2, maxZoom: 1.1 }), 350);
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color={PIPELINE_COLORS.dot} />
      </ReactFlow>
    </div>
  );
}
