/**
 * MonitorPredictionStream — Live scrolling table of recent predictions.
 *
 * Shows the most recent predictions first (reverse chronological).
 * Rows are colour-coded by label: red for attack, green for benign.
 */

import { Radio } from 'lucide-react';
import type { LivePrediction } from '@/stores/liveStore';

interface Props {
  predictions: LivePrediction[];
}

// 6-column grid — override fl-round-row's default 4-col template
const GRID = '72px 72px 88px 48px 48px 56px';

export default function MonitorPredictionStream({ predictions }: Props) {
  // Reverse to show newest first
  const rows = [...predictions].reverse();

  return (
    <div className="fl-vis-card">
      {/* Card header */}
      <div className="fl-vis-card-header">
        <Radio size={13} style={{ color: 'var(--n8n-text-muted)', flexShrink: 0 }} />
        <span className="fl-section-header-title">Live Predictions</span>
        {predictions.length > 0 && (
          <span
            className="text-[10px] font-mono ml-auto"
            style={{ color: 'var(--n8n-text-muted)' }}
          >
            {predictions.length} total
          </span>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="fl-empty-state">
          <Radio size={24} className="fl-empty-state-icon" />
          <p className="fl-empty-state-text">Waiting for predictions...</p>
        </div>
      ) : (
        <div style={{ maxHeight: 300, overflowY: 'auto' }}>
          {/* Sticky column header */}
          <div
            className="grid gap-2 text-[10px] font-semibold uppercase tracking-wider"
            style={{
              gridTemplateColumns: GRID,
              padding: '10px 16px',
              background: 'var(--n8n-card-bg)',
              color: 'var(--n8n-text-muted)',
              borderBottom: '1px solid var(--n8n-card-border)',
              position: 'sticky',
              top: 0,
              zIndex: 1,
            }}
          >
            <span>Time</span>
            <span>Label</span>
            <span>Attack Type</span>
            <span>Score</span>
            <span>Conf</span>
            <span>Latency</span>
          </div>

          {/* Data rows */}
          {rows.map((p, i) => {
            const isAttack = p.label === 'attack';
            const time = new Date(p.timestamp).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            });

            return (
              <div
                key={`${p.timestamp}-${i}`}
                className="fl-round-row"
                style={{ gridTemplateColumns: GRID }}
              >
                <span style={{ color: '#888' }}>{time}</span>

                <span>
                  <span
                    className="inline-block px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase"
                    style={{
                      background: isAttack
                        ? 'rgba(208, 48, 80, 0.15)'
                        : 'rgba(24, 160, 88, 0.15)',
                      color: isAttack ? '#d03050' : '#18a058',
                    }}
                  >
                    {p.label}
                  </span>
                </span>

                <span
                  className="truncate"
                  style={{ color: isAttack ? '#f0a020' : 'var(--n8n-text-muted)' }}
                >
                  {isAttack ? (p.attack_type ?? 'unknown') : '—'}
                </span>

                <span>{(p.score * 100).toFixed(0)}%</span>

                <span style={{ color: '#18a058' }}>
                  {(p.confidence * 100).toFixed(0)}%
                </span>

                <span style={{ color: '#f0a020' }}>
                  {p.inference_latency_ms != null
                    ? `${p.inference_latency_ms.toFixed(0)}ms`
                    : '—'}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
