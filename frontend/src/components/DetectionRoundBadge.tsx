import type { CSSProperties } from 'react';

interface DetectionRoundBadgeProps {
  round: number;
  isDetectionRound: boolean;
  flaggedClients?: string[];    // clientIds that were flagged in this round
}

const RECESS_STYLE: CSSProperties = {
  display: 'inline-block',
  background: 'rgba(240, 160, 32, 0.15)',
  color: 'var(--n8n-warning)',
  border: '1px solid var(--n8n-warning)',
  borderRadius: 4,
  padding: '1px 6px',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.05em',
  lineHeight: '16px',
};

const FLAGGED_STYLE: CSSProperties = {
  display: 'inline-block',
  background: 'rgba(208, 48, 80, 0.15)',
  color: 'var(--n8n-danger)',
  border: '1px solid var(--n8n-danger)',
  borderRadius: 4,
  padding: '1px 6px',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.05em',
  lineHeight: '16px',
};

export function DetectionRoundBadge({
  round,
  isDetectionRound,
  flaggedClients = [],
}: DetectionRoundBadgeProps) {
  if (!isDetectionRound) {
    return null;
  }

  const hasFlagged = flaggedClients.length > 0;

  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
      title={`Detection round ${round}`}
    >
      <span style={RECESS_STYLE}>RECESS</span>
      {hasFlagged && (
        <span style={FLAGGED_STYLE}>
          ⚠ {flaggedClients.length} flagged
        </span>
      )}
    </span>
  );
}

export default DetectionRoundBadge;
