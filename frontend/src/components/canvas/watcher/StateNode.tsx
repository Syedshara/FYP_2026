/**
 * StateNode — individual AWS Step Functions-style rectangular state node.
 *
 * Renders a status-coloured bordered card with a status icon, label, metric
 * lines, status badge and optional duration.  The badge is visually separated
 * from the metadata by a faint divider line, mirroring AWS Step Functions.
 * Click/keyboard-activates to select.
 */

import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Loader2,
  Clock,
} from 'lucide-react';

export type NodeStatus = 'succeeded' | 'running' | 'failed' | 'warning' | 'pending';

export interface StateNodeProps {
  id: string;
  label: string;
  /** Up to 3 short metric strings rendered in mono below the label. */
  metrics?: string[];
  status: NodeStatus;
  /** Human-readable duration string (e.g. "1.4s", "320ms"). */
  duration?: string;
  selected?: boolean;
  onClick?: (id: string) => void;
}

const STATUS_LABELS: Record<NodeStatus, string> = {
  succeeded: 'Succeeded',
  running:   'Running',
  failed:    'Failed',
  warning:   'Warning',
  pending:   'Pending',
};

const STATUS_ICONS: Record<NodeStatus, typeof CheckCircle2> = {
  succeeded: CheckCircle2,
  running:   Loader2,
  failed:    XCircle,
  warning:   AlertTriangle,
  pending:   Clock,
};

export default function StateNode({
  id,
  label,
  metrics = [],
  status,
  duration,
  selected = false,
  onClick,
}: StateNodeProps) {
  const handleClick = () => onClick?.(id);
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick?.(id);
    }
  };

  const StatusIcon = STATUS_ICONS[status];
  const statusClass = `sfn-node--${status}`;
  const badgeClass  = `sfn-node__badge sfn-node__badge--${status}`;
  const nodeClass   = `sfn-node ${statusClass}${selected ? ' sfn-node--selected' : ''}`;
  const isSpinning  = status === 'running';

  return (
    <div
      role="button"
      tabIndex={0}
      className={nodeClass}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      aria-pressed={selected}
      aria-label={`State: ${label}, status: ${STATUS_LABELS[status]}`}
      data-node-id={id}
    >
      {/* ── Header: icon + label ── */}
      <div className="sfn-node__header">
        <span className="sfn-node__icon">
          <StatusIcon
            size={14}
            style={isSpinning ? { animation: 'spin 1s linear infinite' } : undefined}
          />
        </span>
        <span className="sfn-node__label">{label}</span>
      </div>

      {/* ── Metadata ── */}
      {metrics.length > 0 && (
        <div className="sfn-node__metrics">
          {metrics.map((m, i) => (
            <span key={`${i}-${m}`}>{m}</span>
          ))}
        </div>
      )}

      {/* ── Status row (badge + duration) — pushed to bottom by separator ── */}
      <div className="sfn-node__status-row">
        <span className={badgeClass}>{STATUS_LABELS[status]}</span>
        {duration && <span className="sfn-node__duration">{duration}</span>}
      </div>
    </div>
  );
}
