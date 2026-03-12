/**
 * FLRoundLog — Scrollable list of completed FL training rounds.
 *
 * Combines historical rounds (from REST) with live rounds (from WebSocket).
 */

import { useEffect, useState } from 'react';
import { List } from 'lucide-react';
import { useLiveStore } from '@/stores/liveStore';
import { flApi } from '@/api/fl';
import type { FLRound } from '@/types';

export default function FLRoundLog() {
  const [historicalRounds, setHistoricalRounds] = useState<FLRound[]>([]);
  const liveRounds = useLiveStore((s) => s.flRoundResults);

  useEffect(() => {
    flApi.rounds().then(setHistoricalRounds).catch(() => {});
  }, []);

  // Build merged list: historical first, then any live rounds not in historical
  const historicalNums = new Set(historicalRounds.map((r) => r.round_number));
  const newLiveRounds = liveRounds.filter((lr) => !historicalNums.has(lr.round));

  // Display list (newest first)
  const allRounds = [
    ...newLiveRounds.map((lr) => ({
      round_number: lr.round,
      global_accuracy: lr.accuracy,
      global_loss: lr.loss,
      num_clients: 0,
      duration_seconds: 0,
      isLive: true,
    })),
    ...historicalRounds.map((r) => ({
      round_number: r.round_number,
      global_accuracy: r.global_accuracy,
      global_loss: r.global_loss,
      num_clients: r.num_clients,
      duration_seconds: r.duration_seconds,
      isLive: false,
    })),
  ].sort((a, b) => b.round_number - a.round_number);

  return (
    <div className="flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <List size={14} style={{ color: 'var(--n8n-text-muted)' }} />
        <span
          className="text-xs font-semibold uppercase tracking-wider"
          style={{ color: 'var(--n8n-text-muted)' }}
        >
          Round History ({allRounds.length})
        </span>
      </div>

      {/* Rounds list */}
      {allRounds.length === 0 ? (
        <p className="text-xs text-center py-4" style={{ color: 'var(--n8n-text-muted)' }}>
          No rounds completed
        </p>
      ) : (
        <div
          className="flex flex-col gap-0 rounded-lg overflow-hidden max-h-[200px] overflow-y-auto"
          style={{
            border: '1px solid var(--n8n-card-border)',
          }}
        >
          {/* Header row */}
          <div
            className="grid grid-cols-4 gap-2 px-3 py-1.5 text-[10px] font-semibold uppercase"
            style={{
              background: 'var(--n8n-card-bg)',
              color: 'var(--n8n-text-muted)',
              borderBottom: '1px solid var(--n8n-card-border)',
              position: 'sticky',
              top: 0,
              zIndex: 1,
            }}
          >
            <span>Round</span>
            <span>Accuracy</span>
            <span>Loss</span>
            <span>Clients</span>
          </div>

          {allRounds.map((r) => (
            <div
              key={r.round_number}
              className="grid grid-cols-4 gap-2 px-3 py-1.5 text-xs font-mono"
              style={{
                background: r.isLive ? 'rgba(255, 109, 90, 0.05)' : 'var(--n8n-canvas-bg)',
                borderBottom: '1px solid var(--n8n-card-border)',
                color: 'var(--n8n-text-primary)',
              }}
            >
              <span className="flex items-center gap-1">
                R{r.round_number}
                {r.isLive && (
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ background: 'var(--n8n-accent)' }}
                  />
                )}
              </span>
              <span style={{ color: 'var(--n8n-success)' }}>
                {r.global_accuracy != null ? `${(r.global_accuracy * 100).toFixed(1)}%` : '—'}
              </span>
              <span style={{ color: 'var(--n8n-danger)' }}>
                {r.global_loss != null ? r.global_loss.toFixed(4) : '—'}
              </span>
              <span style={{ color: 'var(--n8n-text-muted)' }}>
                {r.num_clients || '—'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
