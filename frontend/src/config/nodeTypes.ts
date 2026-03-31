/**
 * Node type configuration registry.
 *
 * Single source of truth for node shapes, colors, icons, and dimensions.
 * Maps n8n's visual vocabulary to our 7 IoT IDS node types.
 *
 * Dimensions updated to match n8n's larger, wider node proportions.
 */

import type { CanvasNodeData, NodeTypeConfig, CanvasNodeType, PaletteItem } from '@/types/canvas';

// ── Node Type Configs ──

export const NODE_TYPE_CONFIGS: Record<CanvasNodeType, NodeTypeConfig> = {
  client: {
    type: 'client',
    label: 'Client',
    shape: 'default',
    accent: '#5b9bf5',
    accentLight: 'rgba(91, 155, 245, 0.12)',
    icon: 'Building2',
    description: 'Organization entity (bank, hospital, factory)',
    width: 176,
    height: 104,
  },
  device: {
    type: 'device',
    label: 'Device',
    shape: 'default',
    accent: '#18a058',
    accentLight: 'rgba(24, 160, 88, 0.12)',
    icon: 'Cpu',
    description: 'IoT sensor, actuator, or gateway',
    width: 176,
    height: 104,
  },
  'fl-server': {
    type: 'fl-server',
    label: 'FL Server',
    shape: 'wide',
    accent: '#ff6d5a',
    accentLight: 'rgba(255, 109, 90, 0.12)',
    icon: 'BrainCircuit',
    description: 'Federated learning aggregation server',
    width: 320,
    height: 116,
  },
  attack: {
    type: 'attack',
    label: 'Attack',
    shape: 'trigger',
    accent: '#d03050',
    accentLight: 'rgba(208, 48, 80, 0.12)',
    icon: 'Zap',
    description: 'Real attack generator (Scapy)',
    width: 176,
    height: 104,
  },
  'traffic-source': {
    type: 'traffic-source',
    label: 'Traffic Source',
    shape: 'trigger',
    accent: '#a78bfa',
    accentLight: 'rgba(167, 139, 250, 0.12)',
    icon: 'Radio',
    description: 'Synthetic benign traffic generator',
    width: 176,
    height: 104,
  },
  'rate-filter': {
    type: 'rate-filter',
    label: 'Rate Filter',
    shape: 'pill',
    accent: '#888888',
    accentLight: 'rgba(136, 136, 136, 0.12)',
    icon: 'Filter',
    description: 'Throttle / shape traffic',
    width: 72,
    height: 72,
  },
  monitor: {
    type: 'monitor',
    label: 'Monitor',
    shape: 'default',
    accent: '#38bdf8',
    accentLight: 'rgba(56, 189, 248, 0.12)',
    icon: 'Activity',
    description: 'Live analytics collector',
    width: 176,
    height: 104,
  },
  watcher: {
    type: 'watcher',
    label: 'Watcher',
    shape: 'wide',
    accent: '#38bdf8',
    accentLight: 'rgba(56, 189, 248, 0.12)',
    icon: 'Eye',
    description: 'Security audit & event monitor',
    width: 320,
    height: 116,
  },
};

// ── Palette Items (ordered for UX) ──

export const PALETTE_ITEMS: PaletteItem[] = [
  // Entities
  { type: 'client',          label: 'Client',          icon: 'Building2',     accent: '#5b9bf5', shape: 'default', description: 'Organization entity',      category: 'Entities' },
  { type: 'device',          label: 'Device',          icon: 'Cpu',           accent: '#18a058', shape: 'default', description: 'IoT sensor / actuator',    category: 'Entities' },
  // Federated Learning
  { type: 'fl-server',       label: 'FL Server',       icon: 'BrainCircuit',  accent: '#ff6d5a', shape: 'wide',    description: 'FL aggregation server',    category: 'Federated Learning' },
  // Generators
  { type: 'traffic-source',  label: 'Traffic Source',  icon: 'Radio',         accent: '#a78bfa', shape: 'trigger', description: 'Benign traffic generator', category: 'Generators' },
  { type: 'attack',          label: 'Attack',          icon: 'Zap',           accent: '#d03050', shape: 'trigger', description: 'Scapy attack generator',   category: 'Generators' },
  // Utilities
  { type: 'rate-filter',     label: 'Rate Filter',     icon: 'Filter',        accent: '#888888', shape: 'pill',    description: 'Traffic throttle / shape', category: 'Utilities' },
  { type: 'monitor',         label: 'Monitor',         icon: 'Activity',      accent: '#38bdf8', shape: 'default', description: 'Live IDS analytics',       category: 'Utilities' },
  // Security
  { type: 'watcher',         label: 'Watcher',         icon: 'Eye',           accent: '#38bdf8', shape: 'wide',    description: 'Security audit monitor',   category: 'Security' },
];

// ── Default node data factories ──

export function createDefaultNodeData(type: CanvasNodeType): CanvasNodeData {
  const config = NODE_TYPE_CONFIGS[type];
  const base = {
    nodeType: type,
    label: config.label,
    subtitle: config.description,
    status: 'idle' as const,
  };

  switch (type) {
    case 'client':
      return { ...base, industry: 'general', deviceCount: 0 };
    case 'device':
      return { ...base, deviceType: 'sensor', protocol: 'MQTT', port: 1883 };
    case 'fl-server':
      return {
        ...base,
        totalRounds: 10,
        currentRound: 0,
        aggregationMethod: 'FedAvg',
        useHE: true,
        securityFeatures: { vss: true, mtls: true, gradientSigning: true, roundNonces: true, recess: true },
      };
    case 'attack':
      return { ...base, attackCategory: 'ddos', attackType: 'syn-flood', intensity: 9, duration: 30 };
    case 'traffic-source':
      return { ...base, trafficType: 'benign', rate: 100, protocol: 'TCP' };
    case 'rate-filter':
      return { ...base, maxRate: 1000, burstSize: 100, dropPolicy: 'tail' };
    case 'monitor':
      return { ...base, metrics: { totalPredictions: 0, attackRate: 0, avgLatency: 0, avgConfidence: 0 } };
    case 'watcher':
      return { ...base };
    default:
      return base;
  }
}
