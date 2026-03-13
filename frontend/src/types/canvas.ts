/**
 * Workspace canvas types — node data, edge data, workspace state.
 *
 * These types define the data model for the unified canvas workspace.
 * They map to ReactFlow's Node<T> and Edge<T> generic types.
 */

// ── Node Categories (drives shape + accent color) ──

export type CanvasNodeType =
  | 'client'
  | 'device'
  | 'fl-server'
  | 'attack'
  | 'traffic-source'
  | 'rate-filter'
  | 'monitor';

// ── Node shape variants (matching n8n's visual vocabulary) ──

export type NodeShape = 'default' | 'trigger' | 'pill' | 'wide';

// ── Status for any node ──

export type NodeStatus = 'idle' | 'active' | 'running' | 'error' | 'disabled' | 'success';

// ── Per-type node data payloads ──

export interface ClientNodeData {
  nodeType: 'client';
  label: string;
  subtitle?: string;
  clientId?: number;          // linked backend client id
  status: NodeStatus;
  industry?: string;          // bank, hospital, factory, etc.
  deviceCount?: number;
  /** Injected by LiveDataSync during FL training — NOT persisted. */
  _flProgress?: {
    status: string;
    epoch: number;
    totalEpochs: number;
    progressPct: number;
    loss: number;
    accuracy: number;
  };
}

export interface DeviceNodeData {
  nodeType: 'device';
  label: string;
  subtitle?: string;
  deviceId?: string;          // linked backend device id
  status: NodeStatus;
  deviceType?: string;        // sensor, actuator, gateway, camera
  ipAddress?: string;
  protocol?: string;
  port?: number;
  parentClientId?: number;
}

export interface FLServerNodeData {
  nodeType: 'fl-server';
  label: string;
  subtitle?: string;
  status: NodeStatus;
  totalRounds?: number;
  currentRound?: number;
  aggregationMethod?: string;
  useHE?: boolean;
  securityFeatures?: {
    vss: boolean;
    mtls: boolean;
    gradientSigning: boolean;
    roundNonces: boolean;
    recess: boolean;
  };
}

export interface AttackNodeData {
  nodeType: 'attack';
  label: string;
  subtitle?: string;
  status: NodeStatus;
  attackId?: number;          // linked backend attack id (for live status matching)
  attackCategory?: string;    // ddos, mitm, port-scan, replay, malformed, botnet, iot-protocol
  attackType?: string;        // specific: syn-flood, arp-spoof, etc.
  targetIp?: string;          // target IP address for the attack
  intensity?: number;         // 1-10
  duration?: number;          // seconds
  targetDeviceIds?: string[];
}

export interface TrafficSourceNodeData {
  nodeType: 'traffic-source';
  label: string;
  subtitle?: string;
  status: NodeStatus;
  trafficType?: string;       // benign, mixed
  rate?: number;              // packets per second
  protocol?: string;
  dataSource?: 'cic-ids2017' | 'synthetic'; // training data source
}

export interface RateFilterNodeData {
  nodeType: 'rate-filter';
  label: string;
  subtitle?: string;
  status: NodeStatus;
  maxRate?: number;           // max packets per second
  burstSize?: number;
  dropPolicy?: 'tail' | 'random';
}

export interface MonitorNodeData {
  nodeType: 'monitor';
  label: string;
  subtitle?: string;
  status: NodeStatus;
  metrics?: {
    totalPredictions?: number;
    attackRate?: number;
    avgLatency?: number;
    avgConfidence?: number;
  };
}

// ── Union type for all node data ──

export type CanvasNodeData =
  | ClientNodeData
  | DeviceNodeData
  | FLServerNodeData
  | AttackNodeData
  | TrafficSourceNodeData
  | RateFilterNodeData
  | MonitorNodeData;

// ── Edge types ──

export type CanvasEdgeType =
  | 'ownership'        // Client → Device
  | 'fl-communication' // FL Server → Client
  | 'traffic-feed'     // Traffic Source → Device
  | 'attack-vector'    // Attack → Device
  | 'observation';     // Device → Monitor

// ── Node config (shape, color, icon mapping) ──

export interface NodeTypeConfig {
  type: CanvasNodeType;
  label: string;
  shape: NodeShape;
  accent: string;
  accentLight: string;
  icon: string;           // lucide icon name
  description: string;
  width: number;
  height: number;
}

// ── Workspace persistence ──

export interface WorkspaceState {
  id?: string;
  name: string;
  nodes: Array<{
    id: string;
    type: CanvasNodeType;
    position: { x: number; y: number };
    data: CanvasNodeData;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    type: CanvasEdgeType;
  }>;
  viewport?: {
    x: number;
    y: number;
    zoom: number;
  };
}

// ── Palette category for grouped display ──

export type PaletteCategory = 'Entities' | 'Federated Learning' | 'Generators' | 'Utilities';

// ── Node palette item (for drag-to-add) ──

export interface PaletteItem {
  type: CanvasNodeType;
  label: string;
  icon: string;
  accent: string;
  shape: NodeShape;
  description: string;
  category: PaletteCategory;
}
