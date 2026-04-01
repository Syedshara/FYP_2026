/**
 * StateDetailPanel — right-side detail inspector for the Step Function graph.
 *
 * Accepts an array of named sections, each with key-value rows, and renders
 * them in bordered cards with an uppercase title.  When no node is selected
 * it shows an empty-state prompt.
 */

import type { NodeStatus } from './StateNode';

export interface KVRow {
  key: string;
  value: string | number | null | undefined;
  /** Optional colour override for the value (CSS colour string). */
  valueColor?: string;
}

export interface DetailSection {
  title: string;
  rows: KVRow[];
}

export interface StateDetailPanelProps {
  /** Node label shown in the panel header. Null means nothing selected. */
  nodeLabel: string | null;
  nodeStatus?: NodeStatus;
  nodeDuration?: string;
  sections: DetailSection[];
}

const STATUS_BADGE_CLASS: Record<NodeStatus, string> = {
  succeeded: 'sfn-node__badge sfn-node__badge--succeeded',
  running:   'sfn-node__badge sfn-node__badge--running',
  failed:    'sfn-node__badge sfn-node__badge--failed',
  warning:   'sfn-node__badge sfn-node__badge--warning',
  pending:   'sfn-node__badge sfn-node__badge--pending',
};

const STATUS_LABELS: Record<NodeStatus, string> = {
  succeeded: 'Succeeded',
  running:   'Running',
  failed:    'Failed',
  warning:   'Warning',
  pending:   'Pending',
};

export default function StateDetailPanel({
  nodeLabel,
  nodeStatus,
  nodeDuration,
  sections,
}: StateDetailPanelProps) {
  if (nodeLabel === null) {
    return (
      <div className="sfn-detail">
        <div className="sfn-detail__empty">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="3" />
            <path d="M9 9h6M9 12h6M9 15h4" strokeLinecap="round" />
          </svg>
          <span>Click any state to inspect its data</span>
        </div>
      </div>
    );
  }

  return (
    <div className="sfn-detail">
      {/* Header */}
      <div className="sfn-detail__header">
        <span className="sfn-detail__title">{nodeLabel}</span>
        <div className="sfn-detail__meta">
          {nodeStatus && (
            <span className={STATUS_BADGE_CLASS[nodeStatus]}>
              {STATUS_LABELS[nodeStatus]}
            </span>
          )}
          {nodeDuration && (
            <span style={{ fontSize: 10, color: 'var(--n8n-text-muted)', fontFamily: 'var(--n8n-font-mono)' }}>
              {nodeDuration}
            </span>
          )}
        </div>
      </div>

      {/* Sections */}
      {sections.map((sec) => (
        <div key={sec.title} className="sfn-detail__section">
          <div className="sfn-detail__section-title">{sec.title}</div>
          <div className="sfn-detail__kv">
            {sec.rows.map((row, i) => (
              row.value !== null && row.value !== undefined ? (
                <div key={i} className="sfn-detail__kv-row">
                  <span className="sfn-detail__key">{row.key}</span>
                  <span
                    className="sfn-detail__val"
                    style={row.valueColor ? { color: row.valueColor } : undefined}
                  >
                    {String(row.value)}
                  </span>
                </div>
              ) : null
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
