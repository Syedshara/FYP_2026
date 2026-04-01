/**
 * StepFunctionGraph — shared vertical node-graph renderer with SVG connectors.
 *
 * Renders a list of GraphRow items in order.  Each row is either:
 *   - 'sequential' : a single full-width StateNode
 *   - 'parallel'   : an array of StateNodes side-by-side
 *
 * Between rows, CSS connector gaps render directional arrows whose colour
 * reflects the status of the preceding node (AWS Step Functions convention:
 * green for succeeded, amber for warning, red for failed, orange for running).
 * Before/after parallel rows, SVG fork/join bars render horizontal branch
 * lines connecting the single-pipe to the N parallel branches.
 *
 * Connector routing rules:
 *   - Every connector starts/ends 6 px clear of the adjacent card border.
 *   - SVG markers use refY="6" so the arrow tip is exactly at the line endpoint.
 *   - Fork/join elbows are drawn as <path> elements with quadratic-bezier
 *     curves (Q command) so the corner where a tine meets the crossbar is
 *     smooth, not a sharp right angle.
 *   - Tine x-positions are computed in CSS pixels from the measured SVG width
 *     so they align precisely with the horizontal centre of each flex child.
 */

import { useRef, useState, useLayoutEffect } from 'react';
import StateNode, { type StateNodeProps, type NodeStatus } from './StateNode';

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

/** Priority order for "worst status" across parallel branches. */
const STATUS_PRIORITY: Record<NodeStatus, number> = {
  failed:    5,
  warning:   4,
  running:   3,
  succeeded: 2,
  pending:   1,
};

/** Return the highest-priority status from a set of parallel nodes. */
function worstStatus(nodes: StateNodeProps[]): NodeStatus {
  return nodes.reduce<NodeStatus>((worst, n) => {
    return STATUS_PRIORITY[n.status] > STATUS_PRIORITY[worst] ? n.status : worst;
  }, 'pending');
}

/** Extract the "outgoing" status from any row type. */
function rowOutgoingStatus(row: GraphRow): NodeStatus {
  if (row.kind === 'sequential') return row.node.status;
  return worstStatus(row.nodes);
}

// ── SVG connector stroke colour tokens ──────────────────────────────────────
const STROKE_BY_STATUS: Record<NodeStatus, string> = {
  succeeded: '#18a058',
  running:   '#ff6d5a',
  failed:    '#d03050',
  warning:   '#f0a020',
  pending:   '#4a4f5a',
};

/**
 * SVG <defs> block defining one arrowhead marker per status colour.
 *
 * The polygon points="0,0 0,6 6,3" is a RIGHT-pointing ▶ triangle whose tip
 * lies in the marker's +x direction.  orient="auto" rotates the marker so its
 * +x axis aligns with the path tangent — on any downward path this produces a
 * correctly downward-pointing ▼ arrowhead.  Using a ▼ polygon instead would
 * place the tip in the +y direction, which orient="auto" maps sideways (left)
 * for downward paths — the "bent arrowhead" bug.
 * refX="6" refY="3" puts the reference point at the ▶ tip so the path
 * endpoint coincides exactly with the arrowhead tip.
 */
function ArrowMarkers() {
  const statuses: NodeStatus[] = ['succeeded', 'running', 'failed', 'warning', 'pending'];
  return (
    <defs>
      {statuses.map((s) => (
        <marker
          key={s}
          id={`sfn-arrow-${s}`}
          markerWidth="6"
          markerHeight="6"
          refX="6"
          refY="3"
          orient="auto"
        >
          {/* ▶ in marker coords → ▼ after 90° CW rotation for downward paths */}
          <polygon points="0,0 0,6 6,3" fill={STROKE_BY_STATUS[s]} />
        </marker>
      ))}
    </defs>
  );
}

// ── Shared geometry constants ─────────────────────────────────────────────
/** SVG height of fork/join bars — MUST match .sfn-fork / .sfn-join { height }. */
const BAR_HEIGHT    = 36;
/** Half-height: where the horizontal crossbar lives. */
const BAR_MID       = BAR_HEIGHT / 2;            // 18
/** Corner radius for the quadratic-bezier elbows. */
const ELBOW_R       = 4;
/** Gap between parallel flex children — MUST match .sfn-parallel-row { gap }. */
const NODE_GAP_PX   = 24;
/** Shared stroke width for all SVG connector lines. */
const SW            = 1.5;

/**
 * Pixel x-position of the horizontal centre of flex child i.
 *
 * Formula: (2i+1) * (W - totalGap) / (2N)  +  i * G
 * where W = container width, G = NODE_GAP_PX, N = branchCount.
 */
function tineXpx(i: number, branchCount: number, svgWidth: number): number {
  if (branchCount === 1) return svgWidth / 2;
  const totalGap = (branchCount - 1) * NODE_GAP_PX;
  return ((2 * i + 1) * (svgWidth - totalGap)) / (2 * branchCount) + i * NODE_GAP_PX;
}

/**
 * SVG fork bar — vertical stem from the top, splitting into N downward tines.
 *
 * Structure drawn for each branch i:
 *   • Centre/straight branch (tineX ≈ centreX):
 *       M cx 0  L cx H          (straight vertical from stem top to tine bottom)
 *   • Left elbow (tineX < centreX):
 *       M cx 0  L cx barY       (stem down to crossbar)
 *       L (tx+R) barY           (bar goes left, stop R before corner)
 *       Q tx barY  tx (barY+R)  (smooth 90° elbow: horizontal → vertical)
 *       L tx H                  (tine straight down to arrowhead)
 *   • Right elbow (tineX > centreX): mirror of left
 *
 * Each path carries markerEnd so the arrowhead tip is exactly at y=H.
 * The stem portion (cx,0)→(cx,barY) is drawn once per non-straight branch;
 * paths overlap exactly so the stroke appears as one line.
 */
function ForkBar({ branchCount, status }: { branchCount: number; status: NodeStatus }) {
  if (branchCount < 2) return null;

  const containerRef             = useRef<HTMLDivElement>(null);
  const [svgWidth, setSvgWidth]  = useState<number>(0);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setSvgWidth(el.getBoundingClientRect().width);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const STROKE   = STROKE_BY_STATUS[status];
  const markerId = `sfn-arrow-${status}`;
  const cx       = svgWidth / 2;

  return (
    <div ref={containerRef} className="sfn-fork" aria-hidden="true">
      <svg
        width="100%"
        height={BAR_HEIGHT}
        style={{ display: 'block', overflow: 'visible' }}
      >
        <ArrowMarkers />

        {svgWidth > 0 && Array.from({ length: branchCount }, (_, i) => {
          const tx   = tineXpx(i, branchCount, svgWidth);
          const diff = tx - cx;

          let d: string;
          if (Math.abs(diff) < 0.5) {
            // Centre branch — straight vertical line, no elbow
            d = `M ${cx} 0 L ${cx} ${BAR_HEIGHT}`;
          } else if (diff < 0) {
            // Left branch: stem ↓, bar ←, smooth elbow ↓
            d = [
              `M ${cx} 0`,
              `L ${cx} ${BAR_MID}`,
              `L ${tx + ELBOW_R} ${BAR_MID}`,
              `Q ${tx} ${BAR_MID} ${tx} ${BAR_MID + ELBOW_R}`,
              `L ${tx} ${BAR_HEIGHT}`,
            ].join(' ');
          } else {
            // Right branch: stem ↓, bar →, smooth elbow ↓
            d = [
              `M ${cx} 0`,
              `L ${cx} ${BAR_MID}`,
              `L ${tx - ELBOW_R} ${BAR_MID}`,
              `Q ${tx} ${BAR_MID} ${tx} ${BAR_MID + ELBOW_R}`,
              `L ${tx} ${BAR_HEIGHT}`,
            ].join(' ');
          }

          return (
            <path
              key={i}
              d={d}
              fill="none"
              stroke={STROKE}
              strokeWidth={SW}
              strokeLinecap="round"
              markerEnd={`url(#${markerId})`}
            />
          );
        })}
      </svg>
    </div>
  );
}

/**
 * SVG join bar — N upward tines merging into a horizontal crossbar,
 * then a single downward stem with arrowhead.
 *
 * Structure drawn:
 *   • Per tine i — path WITHOUT arrowhead:
 *       Centre/straight: M cx 0  L cx barY
 *       Left tine:  M tx 0  L tx (barY−R)  Q tx barY  (tx+R) barY  L cx barY
 *       Right tine: M tx 0  L tx (barY−R)  Q tx barY  (tx−R) barY  L cx barY
 *   • Centre stem — single path WITH arrowhead:
 *       M cx barY  L cx H
 */
function JoinBar({ branchCount, status }: { branchCount: number; status: NodeStatus }) {
  if (branchCount < 2) return null;

  const containerRef             = useRef<HTMLDivElement>(null);
  const [svgWidth, setSvgWidth]  = useState<number>(0);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setSvgWidth(el.getBoundingClientRect().width);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const STROKE   = STROKE_BY_STATUS[status];
  const markerId = `sfn-arrow-${status}`;
  const cx       = svgWidth / 2;

  return (
    <div ref={containerRef} className="sfn-join" aria-hidden="true">
      <svg
        width="100%"
        height={BAR_HEIGHT}
        style={{ display: 'block', overflow: 'visible' }}
      >
        <ArrowMarkers />

        {svgWidth > 0 && (
          <>
            {/* ── Tine paths (no arrowhead) ── */}
            {Array.from({ length: branchCount }, (_, i) => {
              const tx   = tineXpx(i, branchCount, svgWidth);
              const diff = tx - cx;

              let d: string;
              if (Math.abs(diff) < 0.5) {
                // Centre tine — straight vertical to crossbar
                d = `M ${cx} 0 L ${cx} ${BAR_MID}`;
              } else if (diff < 0) {
                // Left tine: down, smooth elbow →, bar to centre
                d = [
                  `M ${tx} 0`,
                  `L ${tx} ${BAR_MID - ELBOW_R}`,
                  `Q ${tx} ${BAR_MID} ${tx + ELBOW_R} ${BAR_MID}`,
                  `L ${cx} ${BAR_MID}`,
                ].join(' ');
              } else {
                // Right tine: down, smooth elbow ←, bar to centre
                d = [
                  `M ${tx} 0`,
                  `L ${tx} ${BAR_MID - ELBOW_R}`,
                  `Q ${tx} ${BAR_MID} ${tx - ELBOW_R} ${BAR_MID}`,
                  `L ${cx} ${BAR_MID}`,
                ].join(' ');
              }

              return (
                <path
                  key={i}
                  d={d}
                  fill="none"
                  stroke={STROKE}
                  strokeWidth={SW}
                  strokeLinecap="round"
                />
              );
            })}

            {/* ── Centre stem with arrowhead ── */}
            <path
              d={`M ${cx} ${BAR_MID} L ${cx} ${BAR_HEIGHT}`}
              fill="none"
              stroke={STROKE}
              strokeWidth={SW}
              strokeLinecap="round"
              markerEnd={`url(#${markerId})`}
            />
          </>
        )}
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
        const prevRow        = rowIdx > 0 ? rows[rowIdx - 1] : null;
        const isParallel     = row.kind === 'parallel';
        const prevIsParallel = prevRow?.kind === 'parallel';

        // Determine the outgoing status of the previous row for connector colouring
        const connectorStatus: NodeStatus = prevRow ? rowOutgoingStatus(prevRow) : 'pending';

        return (
          <div key={rowIdx} style={{ width: '100%' }}>
            {/* ── Connector between rows ── */}
            {rowIdx > 0 && (
              prevIsParallel ? (
                // Join bar: parallel → sequential
                <JoinBar
                  branchCount={(prevRow as ParallelRow).nodes.length}
                  status={connectorStatus}
                />
              ) : isParallel ? (
                // Fork bar: sequential → parallel
                <ForkBar
                  branchCount={(row as ParallelRow).nodes.length}
                  status={connectorStatus}
                />
              ) : (
                // Simple vertical connector: sequential → sequential
                <div
                  className={`sfn-connector-gap sfn-connector-gap--${connectorStatus}`}
                  aria-hidden="true"
                />
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
