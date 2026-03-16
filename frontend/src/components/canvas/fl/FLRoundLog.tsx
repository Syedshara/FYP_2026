/**
 * FLRoundLog — Scrollable list of completed FL training rounds.
 *
 * Each row is click-to-expand, revealing the full gradient pipeline story:
 *   Phase 1 — Dispatch     : per-layer ‖W‖₂ of weights sent to clients
 *   Phase 2 — Client Training : per-client local loss / accuracy / samples
 *   Phase 3 — Aggregation  : per-layer ‖Δ‖₂ and mean(Δ) of the aggregated delta
 *   Phase 4 — Global Update : before→after weight norms and convergence delta
 *
 * Combines historical rounds (from REST) with live rounds (from WebSocket).
 * Historical rounds show only basic metrics; live rounds include gradient detail.
 */

import { useEffect, useState } from 'react';
import { List, History, ChevronDown, ChevronRight } from 'lucide-react';
import { useLiveStore } from '@/stores/liveStore';
import { flApi } from '@/api/fl';
import type { FLRound, GradientStats } from '@/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Shorten long layer names: "lstm.weight_ih_l0" → "lstm.wt_ih" */
function shortLayer(name: string): string {
  const map: Record<string, string> = {
    'lstm.weight_ih_l0': 'lstm.wt_ih',
    'lstm.weight_hh_l0': 'lstm.wt_hh',
    'fc.weight':         'fc.weight',
    'fc.bias':           'fc.bias',
  };
  return map[name] ?? name;
}

function fmt(n: number | undefined, decimals = 4): string {
  if (n == null) return '—';
  return n.toFixed(decimals);
}

function fmtPct(before: number | undefined, after: number | undefined): string {
  if (before == null || after == null || before === 0) return '';
  const pct = ((after - before) / before) * 100;
  const sign = pct >= 0 ? '+' : '';
  return `(${sign}${pct.toFixed(2)}%)`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface PhaseRowProps {
  label: string;
  children: React.ReactNode;
}

function PhaseSection({ label, children }: PhaseRowProps) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div
        className="text-[9px] font-bold uppercase tracking-widest"
        style={{ color: 'var(--n8n-accent)', marginBottom: 4, opacity: 0.75 }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function LayerRow({ name, values }: { name: string; values: string }) {
  return (
    <div
      className="flex items-baseline gap-2 text-[10px] font-mono"
      style={{ color: 'var(--n8n-text-primary)', lineHeight: 1.6 }}
    >
      <span style={{ color: 'var(--n8n-text-muted)', minWidth: 76, flexShrink: 0 }}>
        {shortLayer(name)}
      </span>
      <span>{values}</span>
    </div>
  );
}

interface GradientDetailProps {
  gradientStats: GradientStats;
  clientMetrics?: Array<{ client_id: string; local_loss: number; local_accuracy: number; num_samples: number }>;
}

function GradientDetail({ gradientStats: gs, clientMetrics }: GradientDetailProps) {
  const dispatchKeys = Object.keys(gs.dispatch_norms ?? {});
  const deltaKeys    = Object.keys(gs.delta_norms ?? {});
  const postKeys     = Object.keys(gs.post_norms ?? {});

  return (
    <div
      style={{
        borderTop: '1px solid var(--n8n-card-border)',
        margin: '8px 16px 10px',
        paddingTop: 10,
      }}
    >
      {/* Phase 1: Dispatch */}
      {dispatchKeys.length > 0 && (
        <PhaseSection label="1 · Dispatch — weights sent to clients">
          {dispatchKeys.map((layer) => (
            <LayerRow
              key={layer}
              name={layer}
              values={`‖W‖ = ${fmt(gs.dispatch_norms?.[layer], 4)}`}
            />
          ))}
        </PhaseSection>
      )}

      {/* Phase 2: Client Training */}
      {clientMetrics && clientMetrics.length > 0 && (
        <PhaseSection label="2 · Client Training — local updates">
          {clientMetrics.map((cm) => (
            <div
              key={cm.client_id}
              className="flex items-baseline gap-2 text-[10px] font-mono"
              style={{ color: 'var(--n8n-text-primary)', lineHeight: 1.6 }}
            >
              <span style={{ color: 'var(--n8n-text-muted)', minWidth: 76, flexShrink: 0 }}>
                {cm.client_id.replace(/^client_/i, '').slice(0, 8)}
              </span>
              <span>
                loss=<span style={{ color: 'var(--n8n-danger)' }}>{fmt(cm.local_loss, 4)}</span>
                {'  '}
                acc=<span style={{ color: 'var(--n8n-success)' }}>{(cm.local_accuracy * 100).toFixed(1)}%</span>
                {'  '}
                <span style={{ color: 'var(--n8n-text-muted)' }}>
                  {cm.num_samples.toLocaleString()} samples
                </span>
              </span>
            </div>
          ))}
        </PhaseSection>
      )}

      {/* Phase 3: Aggregation delta */}
      {deltaKeys.length > 0 && (
        <PhaseSection label="3 · Aggregation — delta per layer">
          {deltaKeys.map((layer) => {
            const norm = gs.delta_norms?.[layer];
            const mean = gs.delta_means?.[layer];
            const meanStr = mean != null
              ? `  mean=${mean >= 0 ? '+' : ''}${fmt(mean, 6)}`
              : '';
            return (
              <LayerRow
                key={layer}
                name={layer}
                values={`‖Δ‖ = ${fmt(norm, 4)}${meanStr}`}
              />
            );
          })}
        </PhaseSection>
      )}

      {/* Phase 4: Global model update */}
      {postKeys.length > 0 && (
        <PhaseSection label="4 · Global Update — before → after">
          {postKeys.map((layer) => {
            const before = gs.dispatch_norms?.[layer];
            const after  = gs.post_norms?.[layer];
            const pct    = fmtPct(before, after);
            return (
              <LayerRow
                key={layer}
                name={layer}
                values={`${fmt(before, 4)} → ${fmt(after, 4)}  ${pct}`}
              />
            );
          })}
          {gs.total_delta != null && (
            <div
              className="text-[10px] font-mono font-semibold"
              style={{ color: 'var(--n8n-accent)', marginTop: 4 }}
            >
              total Δ = {fmt(gs.total_delta, 4)}
            </div>
          )}
        </PhaseSection>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function FLRoundLog() {
  const [historicalRounds, setHistoricalRounds] = useState<FLRound[]>([]);
  const [expandedRound, setExpandedRound] = useState<number | null>(null);
  const liveRounds = useLiveStore((s) => s.flRoundResults);

  useEffect(() => {
    flApi.rounds().then(setHistoricalRounds).catch(() => {});
  }, []);

  // When a new training session starts, clear stale historical data so old
  // round numbers don't filter out incoming live rounds via deduplication.
  useEffect(() => {
    let prev = useLiveStore.getState().flGlobalProgress?.is_training;
    const unsub = useLiveStore.subscribe((state) => {
      const cur = state.flGlobalProgress?.is_training;
      if (cur && !prev) setHistoricalRounds([]);
      prev = cur;
    });
    return unsub;
  }, []);

  // Build merged list: prefer live rounds (they carry gradient_stats).
  // Historical rounds only fill in rounds that have NO live counterpart.
  const liveNums       = new Set(liveRounds.map((lr) => lr.round));
  const historicalOnly = historicalRounds.filter((r) => !liveNums.has(r.round_number));

  interface DisplayRound {
    round_number: number;
    global_accuracy: number | null;
    global_loss: number | null;
    num_clients: number;
    duration_seconds: number;
    isLive: boolean;
    gradient_stats?: GradientStats;
    client_metrics?: Array<{ client_id: string; local_loss: number; local_accuracy: number; num_samples: number }>;
  }

  // Display list (newest first)
  const allRounds: DisplayRound[] = [
    ...liveRounds.map((lr) => ({
      round_number:     lr.round,
      global_accuracy:  lr.accuracy,
      global_loss:      lr.loss,
      num_clients:      lr.client_metrics?.length ?? 0,
      duration_seconds: 0,
      isLive:           true,
      gradient_stats:   lr.gradient_stats,
      client_metrics:   lr.client_metrics,
    })),
    ...historicalOnly.map((r) => ({
      round_number:    r.round_number,
      global_accuracy: r.global_accuracy,
      global_loss:     r.global_loss,
      num_clients:     r.num_clients,
      duration_seconds: r.duration_seconds ?? 0,
      isLive:          false,
    })),
  ].sort((a, b) => b.round_number - a.round_number);

  function handleToggle(roundNum: number) {
    setExpandedRound((prev) => (prev === roundNum ? null : roundNum));
  }

  return (
    <div className="fl-vis-card shrink-0">
      {/* Card header */}
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
        <div style={{ overflowY: 'auto', scrollbarWidth: 'thin', scrollbarColor: 'var(--n8n-card-border) transparent' }}>
          {/* Sticky column header */}
          <div
            className="grid gap-2 text-[10px] font-semibold uppercase tracking-wider"
            style={{
              gridTemplateColumns: '28px 1fr 80px 60px 52px',
              padding: '10px 16px',
              background: 'var(--n8n-card-bg)',
              color: 'var(--n8n-text-muted)',
              borderBottom: '1px solid var(--n8n-card-border)',
              position: 'sticky',
              top: 0,
              zIndex: 1,
            }}
          >
            <span />
            <span>Round</span>
            <span>Accuracy</span>
            <span>Loss</span>
            <span>Δ</span>
          </div>

          {/* Data rows */}
          {allRounds.map((r) => {
            const isExpanded = expandedRound === r.round_number;
            const hasDetail  = r.isLive && (r.gradient_stats != null || (r.client_metrics && r.client_metrics.length > 0));
            const totalDelta = r.gradient_stats?.total_delta;

            return (
              <div
                key={r.round_number}
                style={{
                  background: isExpanded
                    ? 'rgba(255, 109, 90, 0.06)'
                    : r.isLive
                      ? 'rgba(255, 109, 90, 0.03)'
                      : 'var(--n8n-canvas-bg)',
                  borderBottom: '1px solid var(--n8n-card-border)',
                }}
              >
                {/* Compact row */}
                <div
                  className="fl-round-row"
                  style={{
                    gridTemplateColumns: '28px 1fr 80px 60px 52px',
                    cursor: hasDetail ? 'pointer' : 'default',
                    userSelect: 'none',
                    background: 'transparent',
                  }}
                  onClick={() => hasDetail && handleToggle(r.round_number)}
                  role={hasDetail ? 'button' : undefined}
                  aria-expanded={hasDetail ? isExpanded : undefined}
                >
                  {/* Expand chevron */}
                  <span style={{ color: 'var(--n8n-text-muted)', display: 'flex', alignItems: 'center' }}>
                    {hasDetail
                      ? isExpanded
                        ? <ChevronDown size={11} />
                        : <ChevronRight size={11} />
                      : null}
                  </span>

                  {/* Round number + live dot */}
                  <span className="flex items-center gap-1.5" style={{ color: 'var(--n8n-accent)', fontWeight: 700 }}>
                    R{r.round_number}
                    {r.isLive && (
                      <span
                        className="w-1.5 h-1.5 rounded-full"
                        style={{ background: 'var(--n8n-accent)', flexShrink: 0, animation: 'pulse-dot 2s ease-in-out infinite' }}
                      />
                    )}
                  </span>

                  {/* Accuracy */}
                  <span style={{ color: 'var(--n8n-success)' }}>
                    {r.global_accuracy != null ? `${(r.global_accuracy * 100).toFixed(1)}%` : '—'}
                  </span>

                  {/* Loss */}
                  <span style={{ color: 'var(--n8n-danger)' }}>
                    {r.global_loss != null ? r.global_loss.toFixed(4) : '—'}
                  </span>

                  {/* Total delta badge */}
                  <span
                    className="text-[9px] font-mono"
                    style={{ color: totalDelta != null ? 'var(--n8n-text-muted)' : 'transparent' }}
                    title="Sum of per-layer delta norms (convergence proxy)"
                  >
                    {totalDelta != null ? totalDelta.toFixed(3) : '—'}
                  </span>
                </div>

                {/* Expanded gradient detail */}
                {isExpanded && hasDetail && (
                  <GradientDetail
                    gradientStats={r.gradient_stats!}
                    clientMetrics={r.client_metrics}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
