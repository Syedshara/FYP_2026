/**
 * FL Topology Validator
 *
 * Checks that the canvas topology meets requirements for FL training:
 *   FL Server → (fl-communication) → Client → (ownership) → Device → (traffic-feed) → Traffic Source
 *
 * Returns a validation result with a list of errors and the set of connected client canvas node IDs.
 */

import type { Node, Edge } from 'reactflow';

export interface TopologyValidationResult {
  valid: boolean;
  errors: string[];
  /** Canvas node IDs of Client nodes connected to this FL Server via fl-communication edges */
  connectedClientNodeIds: string[];
  /** Client node IDs that are missing a Device or Traffic Source */
  incompleteClientNodeIds: string[];
}

export function validateFLTopology(
  serverNodeId: string,
  nodes: Node[],
  edges: Edge[],
): TopologyValidationResult {
  const errors: string[] = [];
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // Step 1: Find Clients connected to this FL Server via fl-communication edges
  const connectedClientNodeIds = edges
    .filter((e) => e.source === serverNodeId && e.type === 'fl-communication')
    .map((e) => e.target)
    .filter((id) => {
      const n = nodeMap.get(id);
      return n?.type === 'client';
    });

  if (connectedClientNodeIds.length === 0) {
    errors.push('FL Server has no Client nodes connected. Connect at least one Client node.');
    return { valid: false, errors, connectedClientNodeIds: [], incompleteClientNodeIds: [] };
  }

  // Step 2: For each connected Client, check it has a Device (ownership edge)
  const incompleteClientNodeIds: string[] = [];

  for (const clientId of connectedClientNodeIds) {
    const clientNode = nodeMap.get(clientId);
    const clientLabel = (clientNode?.data as { label?: string })?.label ?? clientId;

    // Find Devices owned by this client (client → device, type ownership)
    const ownedDeviceIds = edges
      .filter((e) => e.source === clientId && e.type === 'ownership')
      .map((e) => e.target)
      .filter((id) => nodeMap.get(id)?.type === 'device');

    if (ownedDeviceIds.length === 0) {
      errors.push(
        `Client "${clientLabel}" has no Device connected. ` +
          'Connect a Device node (draw an edge from Client → Device).',
      );
      incompleteClientNodeIds.push(clientId);
      continue;
    }

    // Step 3: For each Device, check it has a Traffic Source (traffic-feed edge)
    let hasTrafficSource = false;
    for (const deviceId of ownedDeviceIds) {
      const hasSource = edges.some(
        (e) =>
          e.target === deviceId &&
          e.type === 'traffic-feed' &&
          nodeMap.get(e.source)?.type === 'traffic-source',
      );
      if (hasSource) {
        hasTrafficSource = true;
        break;
      }
    }

    if (!hasTrafficSource) {
      const deviceNode = nodeMap.get(ownedDeviceIds[0]);
      const deviceLabel = (deviceNode?.data as { label?: string })?.label ?? ownedDeviceIds[0];
      errors.push(
        `Client "${clientLabel}" → Device "${deviceLabel}" has no Traffic Source connected. ` +
          'Connect a Traffic Source node to the Device to provide training data.',
      );
      incompleteClientNodeIds.push(clientId);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    connectedClientNodeIds,
    incompleteClientNodeIds,
  };
}
