/**
 * MonitorAttackBreakdown — Attack vs Benign ratio display.
 *
 * Shows the proportion of attack vs benign predictions as a horizontal
 * stacked bar with counts. The model is binary classification only
 * (attack/benign), so this replaces the former attack-type pie chart.
 */

import { ShieldAlert } from 'lucide-react';
import type { LivePrediction } from '@/stores/liveStore';

interface Props {
  predictions: LivePrediction[];
}

export default function MonitorAttackBreakdown({ predictions }: Props) {
  const attacks = predictions.filter((p) => p.label === 'attack').length;
  const benign = predictions.filter((p) => p.label === 'benign').length;
  const total = attacks + benign;
  const attackPct = total > 0 ? ((attacks / total) * 100).toFixed(1) : '0.0';
  const benignPct = total > 0 ? ((benign / total) * 100).toFixed(1) : '0.0';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <ShieldAlert size={14} style={{ color: 'var(--n8n-text-muted)' }} />
        <span
          className="text-xs font-semibold uppercase tracking-wider"
          style={{ color: 'var(--n8n-text-muted)' }}
        >
          Detection Ratio
        </span>
        {total > 0 && (
          <span className="text-xs font-mono ml-auto" style={{ color: 'var(--n8n-text-muted)' }}>
            {total} total
          </span>
        )}
      </div>

      {total === 0 ? (
        <div
          className="flex items-center justify-center h-[120px] rounded-lg"
          style={{
            background: 'var(--n8n-canvas-bg)',
            border: '1px solid var(--n8n-card-border)',
          }}
        >
          <span className="text-xs" style={{ color: 'var(--n8n-text-muted)' }}>
            No predictions recorded
          </span>
        </div>
      ) : (
        <div
          className="rounded-lg p-4 flex flex-col gap-3"
          style={{
            background: 'var(--n8n-canvas-bg)',
            border: '1px solid var(--n8n-card-border)',
          }}
        >
          {/* Stacked bar */}
          <div
            className="flex rounded overflow-hidden"
            style={{ height: 24 }}
          >
            {attacks > 0 && (
              <div
                style={{
                  width: `${attackPct}%`,
                  background: 'rgba(208, 48, 80, 0.7)',
                  minWidth: attacks > 0 ? 2 : 0,
                }}
              />
            )}
            {benign > 0 && (
              <div
                style={{
                  width: `${benignPct}%`,
                  background: 'rgba(24, 160, 88, 0.7)',
                  minWidth: benign > 0 ? 2 : 0,
                }}
              />
            )}
          </div>

          {/* Legend */}
          <div className="flex justify-between text-xs font-mono">
            <div className="flex items-center gap-1.5">
              <span
                className="inline-block w-2.5 h-2.5 rounded-sm"
                style={{ background: '#d03050' }}
              />
              <span style={{ color: '#d03050' }}>
                {attacks} attack{attacks !== 1 ? 's' : ''} ({attackPct}%)
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span
                className="inline-block w-2.5 h-2.5 rounded-sm"
                style={{ background: '#18a058' }}
              />
              <span style={{ color: '#18a058' }}>
                {benign} benign ({benignPct}%)
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
