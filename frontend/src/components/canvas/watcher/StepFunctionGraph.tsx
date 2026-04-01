/**
 * StepFunctionGraph — shared vertical node-graph renderer with SVG connectors.
 *
 * Renders a list of GraphRow items in order.  Each row is either:
 *   - 'sequential' : a single full-width StateNode
 *   - 'parallel'   : an array of StateNodes side-by-side
 *
 * Between rows, CSS connector gaps render vertical lines + arrowheads.
 * Before/after parallel rows, SVG fork/join bars render horizontal branch
 * lines connecting the single-pipe to the N parallel branches.
 */

import StateNode, { type StateNodeProps } from './StateNode';

export interface SequentialRow {
  kind: 'sequential';
  node: StateNodeProps;
}

export interface ParallelRow {
  kind: 'parallel';
  nodes: StateNodeProps[];
}

export type GraphRow = SequentialRow | ParallelRow;

interface StepFunctionGraphProps {
  rows: GraphRow[];
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
}

/**
 * SVG fork bar — draws a horizontal bar with N downward tines.
 * Used between a sequential row and the parallel row that follows.
 */
function ForkBar({ branchCount }: { branchCount: number }) {
  if (branchCount < 2) return null;

  const GAP = 28;       // vertical space consumed (matches .sfn-connector-gap)
  const MARGIN = 24;    // left/right inset so tines don't hit the edges
  const STROKE = 'var(--n8n-card-border, #333)';
  const SW = 1.5;

  return (
    <div className="sfn-fork" aria-hidden="true">
      <svg
        width="100%"
        height={GAP}
        preserveAspectRatio="none"
        style={{ display: 'block', overflow: 'visible' }}
      >
        {/* Vertical stem from top center down to midpoint */}
        <line x1="50%" y1="0" x2="50%" y2={GAP / 2} stroke={STROKE} strokeWidth={SW} />
        {/* Horizontal bar across all branches */}
        <line
          x1={MARGIN}
          y1={GAP / 2}
          x2={`calc(100% - ${MARGIN}px)`}
          y2={GAP / 2}
          stroke={STROKE}
          strokeWidth={SW}
        />
        {/* Tines down from bar to each branch */}
        {Array.from({ length: branchCount }, (_, i) => {
          // Distribute tines evenly across the bar
          // We use percentages for horizontal positioning
          const xPct = branchCount === 1
            ? '50%'
            : `${(MARGIN / 3) + (i / (branchCount - 1)) * (100 - 2 * (MARGIN / 3))}%`;
          return (
            <line
              key={i}
              x1={xPct}
              y1={GAP / 2}
              x2={xPct}
              y2={GAP}
              stroke={STROKE}
              strokeWidth={SW}
            />
          );
        })}
      </svg>
    </div>
  );
}

/**
 * SVG join bar — draws N upward tines merging into a single horizontal bar
 * then a single downward stem.  Mirror image of ForkBar.
 */
function JoinBar({ branchCount }: { branchCount: number }) {
  if (branchCount < 2) return null;

  const GAP = 28;
  const MARGIN = 24;
  const STROKE = 'var(--n8n-card-border, #333)';
  const SW = 1.5;

  return (
    <div className="sfn-join" aria-hidden="true">
      <svg
        width="100%"
        height={GAP}
        preserveAspectRatio="none"
        style={{ display: 'block', overflow: 'visible' }}
      >
        {/* Tines up from each branch to midpoint bar */}
        {Array.from({ length: branchCount }, (_, i) => {
          const xPct = branchCount === 1
            ? '50%'
            : `${(MARGIN / 3) + (i / (branchCount - 1)) * (100 - 2 * (MARGIN / 3))}%`;
          return (
            <line
              key={i}
              x1={xPct}
              y1="0"
              x2={xPct}
              y2={GAP / 2}
              stroke={STROKE}
              strokeWidth={SW}
            />
          );
        })}
        {/* Horizontal bar */}
        <line
          x1={MARGIN}
          y1={GAP / 2}
          x2={`calc(100% - ${MARGIN}px)`}
          y2={GAP / 2}
          stroke={STROKE}
          strokeWidth={SW}
        />
        {/* Single stem down to the next row */}
        <line x1="50%" y1={GAP / 2} x2="50%" y2={GAP} stroke={STROKE} strokeWidth={SW} />
        {/* Arrowhead */}
        <polygon
          points={`${-4},${GAP} ${4},${GAP} ${0},${GAP + 5}`}
          fill={STROKE}
          transform={`translate(0, 0)`}
          style={{ transform: 'translateX(50%)' }}
        />
      </svg>
    </div>
  );
}

export default function StepFunctionGraph({
  rows,
  selectedNodeId,
  onSelectNode,
}: StepFunctionGraphProps) {
  return (
    <div className="sfn-graph">
      {rows.map((row, rowIdx) => {
        const prevRow = rowIdx > 0 ? rows[rowIdx - 1] : null;
        const isParallel = row.kind === 'parallel';
        const prevIsParallel = prevRow?.kind === 'parallel';

        return (
          <div key={rowIdx} style={{ width: '100%' }}>
            {/* ── Connector between rows ── */}
            {rowIdx > 0 && (
              prevIsParallel ? (
                // Join bar: parallel → sequential
                <JoinBar branchCount={(prevRow as ParallelRow).nodes.length} />
              ) : isParallel ? (
                // Fork bar: sequential → parallel
                <ForkBar branchCount={(row as ParallelRow).nodes.length} />
              ) : (
                // Simple vertical connector: sequential → sequential
                <div className="sfn-connector-gap" aria-hidden="true" />
              )
            )}

            {/* ── Row content ── */}
            {row.kind === 'sequential' ? (
              <StateNode
                {...row.node}
                selected={row.node.id === selectedNodeId}
                onClick={onSelectNode}
              />
            ) : (
              <div className="sfn-parallel-row">
                {row.nodes.map((node) => (
                  <StateNode
                    key={node.id}
                    {...node}
                    selected={node.id === selectedNodeId}
                    onClick={onSelectNode}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
