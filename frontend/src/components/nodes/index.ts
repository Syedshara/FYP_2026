/**
 * src/components/nodes/index.ts
 *
 * Barrel export for all custom React Flow node components.
 * Import `nodeTypes` and spread it into <ReactFlow nodeTypes={nodeTypes} />.
 */

export { ScenarioSourceNode, default as ScenarioSourceNodeDefault } from './ScenarioSourceNode';
export { AttackInjectNode,   default as AttackInjectNodeDefault   } from './AttackInjectNode';
export { RateFilterNode,     default as RateFilterNodeDefault     } from './RateFilterNode';
export { MonitorSinkNode,    default as MonitorSinkNodeDefault    } from './MonitorSinkNode';

import { ScenarioSourceNode } from './ScenarioSourceNode';
import { AttackInjectNode   } from './AttackInjectNode';
import { RateFilterNode     } from './RateFilterNode';
import { MonitorSinkNode    } from './MonitorSinkNode';

/**
 * Pass this object directly to <ReactFlow nodeTypes={nodeTypes} />.
 * Defined outside any component so the reference is stable across renders.
 */
export const nodeTypes = {
  source_scenario: ScenarioSourceNode,
  attack_inject:   AttackInjectNode,
  rate_filter:     RateFilterNode,
  monitor_sink:    MonitorSinkNode,
} as const;

export type NodeTypeKey = keyof typeof nodeTypes;
