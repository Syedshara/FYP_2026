/**
 * StateNode — individual AWS Step Functions-style rectangular state node.
 *
 * Renders a status-coloured bordered card with label, metric lines, status
 * badge and optional duration.  Click/keyboard-activates to select.
 */

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

  const statusClass = `sfn-node--${status}`;
  const badgeClass  = `sfn-node__badge sfn-node__badge--${status}`;
  const nodeClass   = `sfn-node ${statusClass}${selected ? ' sfn-node--selected' : ''}`;

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
      <span className="sfn-node__label">{label}</span>

      {metrics.length > 0 && (
        <div className="sfn-node__metrics">
          {metrics.map((m) => (
            <span key={m}>{m}</span>
          ))}
        </div>
      )}

      <div className="sfn-node__status-row">
        <span className={badgeClass}>{STATUS_LABELS[status]}</span>
        {duration && <span className="sfn-node__duration">{duration}</span>}
      </div>
    </div>
  );
}
