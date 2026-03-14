/**
 * FLRoundLog — Scrollable list of completed FL training rounds.
 *
 * Combines historical rounds (from REST) with live rounds (from WebSocket).
 */

import { useEffect, useState } from 'react';
import { List, History } from 'lucide-react';
import { useLiveStore } from '@/stores/liveStore';
import { flApi } from '@/api/fl';
import type { FLRound } from '@/types';

export default function FLRoundLog() {
  const [historicalRounds, setHistoricalRounds] = useState<FLRound[]>([]);
  const liveRounds = useLiveStore((s) => s.flRoundResults);

  useEffect(() => {
    flApi.rounds().then(setHistoricalRounds).catch(() => {});
  }, []);

  // When a new training session starts, clear stale historical data so old
  // round numbers don't filter out incoming live rounds via deduplication.
  // Uses Zustand subscribe (external-system sync pattern) to avoid setState-in-effect.
  useEffect(() => {
    let prev = useLiveStore.getState().flGlobalProgress?.is_training;
    const unsub = useLiveStore.subscribe((state) => {
      const cur = state.flGlobalProgress?.is_training;
      if (cur && !prev) setHistoricalRounds([]);
      prev = cur;
    });
    return unsub;
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
    <div className="fl-vis-card">
      {/* Card header — title lives inside the card, same as Topology */}
      <div className="fl-vis-card-header">
        <List size={13} style={{ color: 'var(--n8n-text-muted)', flexShrink: 0 }} />
        <span className="fl-section-header-title">Round History ({allRounds.length})</span>
      </div>

      {/* Content */}
      {allRounds.length === 0 ? (
        <div className="fl-empty-state">
          <History size={24} className="fl-empty-state-icon" />
          <p className="fl-empty-state-text">No rounds completed yet</p>
        </div>
      ) : (
        <div style={{ maxHeight: 220, overflowY: 'auto' }}>
          {/* Sticky column header */}
          <div
            className="grid gap-2 text-[10px] font-semibold uppercase tracking-wider"
            style={{
              gridTemplateColumns: '48px 1fr 88px 66px',
              padding: '10px 16px',
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

          {/* Data rows */}
          {allRounds.map((r) => (
            <div
              key={r.round_number}
              className="fl-round-row"
              style={{
                background: r.isLive ? 'rgba(255, 109, 90, 0.04)' : 'var(--n8n-canvas-bg)',
              }}
            >
              <span className="flex items-center gap-1.5" style={{ color: 'var(--n8n-accent)', fontWeight: 700 }}>
                R{r.round_number}
                {r.isLive && (
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ background: 'var(--n8n-accent)', flexShrink: 0, animation: 'pulse-dot 2s ease-in-out infinite' }}
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
