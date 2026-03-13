import type { CSSProperties } from 'react';

interface FlaggedEvent {
  clientId: string;
  round: number;
  abnormality: number;
  timestamp: string;
}

interface TrustScorePanelProps {
  trustScores: Record<string, number>;   // clientId → 0.0–1.0
  flaggedEvents?: FlaggedEvent[];
  compact?: boolean;  // if true, show as a small horizontal strip
}

const pct = (score: number): string => `${Math.round(score * 100)}%`;

const barColor = (score: number): string =>
  score >= 0.5 ? 'var(--n8n-accent)' : 'var(--n8n-danger)';

// ── Full-mode single client row ────────────────────────────────────────────────
function ClientRow({ clientId, score }: { clientId: string; score: number }) {
  const percent = Math.round(score * 100);
  const isRisk = score < 0.5;

  const labelStyle: CSSProperties = {
    width: 72,
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--n8n-text-primary)',
    flexShrink: 0,
    letterSpacing: '0.02em',
  };

  const trackStyle: CSSProperties = {
    flex: 1,
    height: 8,
    borderRadius: 4,
    background: 'var(--n8n-card-border)',
    overflow: 'hidden',
  };

  const fillStyle: CSSProperties = {
    height: '100%',
    width: `${percent}%`,
    borderRadius: 4,
    background: barColor(score),
    transition: 'width 0.4s ease',
  };

  const pctStyle: CSSProperties = {
    width: 36,
    textAlign: 'right',
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--n8n-text-primary)',
    flexShrink: 0,
  };

  const statusStyle: CSSProperties = {
    width: 56,
    textAlign: 'right',
    fontSize: 12,
    fontWeight: 700,
    color: isRisk ? 'var(--n8n-danger)' : 'var(--n8n-success)',
    flexShrink: 0,
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
      <span style={labelStyle}>{clientId}</span>
      <div style={trackStyle}>
        <div style={fillStyle} />
      </div>
      <span style={pctStyle}>{pct(score)}</span>
      <span style={statusStyle}>
        {isRisk ? '● RISK' : '● OK'}
      </span>
    </div>
  );
}

// ── Full-mode panel ────────────────────────────────────────────────────────────
function FullPanel({ trustScores }: { trustScores: Record<string, number> }) {
  const entries = Object.entries(trustScores).sort(([a], [b]) => a.localeCompare(b));

  const cardStyle: CSSProperties = {
    background: 'var(--n8n-card-bg)',
    border: '1px solid var(--n8n-card-border)',
    borderRadius: 12,
    padding: '14px 18px',
  };

  const headingStyle: CSSProperties = {
    fontSize: 12,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: 'var(--n8n-text-muted)',
    marginBottom: 10,
  };

  return (
    <div style={cardStyle}>
      <div style={headingStyle}>Client Trust Scores</div>
      {entries.map(([clientId, score]) => (
        <ClientRow key={clientId} clientId={clientId} score={score} />
      ))}
    </div>
  );
}

// ── Compact strip ──────────────────────────────────────────────────────────────
function CompactStrip({ trustScores }: { trustScores: Record<string, number> }) {
  const entries = Object.entries(trustScores).sort(([a], [b]) => a.localeCompare(b));

  const stripStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    color: 'var(--n8n-text-muted)',
    flexWrap: 'wrap',
  };

  const labelStyle: CSSProperties = {
    fontWeight: 600,
    color: 'var(--n8n-text-muted)',
    marginRight: 4,
  };

  return (
    <div style={stripStyle}>
      <span style={labelStyle}>Trust:</span>
      {entries.map(([clientId, score], idx) => {
        const isRisk = score < 0.5;
        const itemStyle: CSSProperties = {
          color: isRisk ? 'var(--n8n-danger)' : 'var(--n8n-text-primary)',
          fontWeight: isRisk ? 700 : 400,
        };
        return (
          <span key={clientId}>
            <span style={itemStyle}>
              {isRisk ? '⚠' : ''}{clientId} {pct(score)}
            </span>
            {idx < entries.length - 1 && (
              <span style={{ color: 'var(--n8n-card-border)', margin: '0 4px' }}>·</span>
            )}
          </span>
        );
      })}
    </div>
  );
}

// ── Main export ────────────────────────────────────────────────────────────────
export function TrustScorePanel({
  trustScores,
  compact = false,
}: TrustScorePanelProps) {
  if (compact) {
    return <CompactStrip trustScores={trustScores} />;
  }
  return <FullPanel trustScores={trustScores} />;
}

export default TrustScorePanel;
