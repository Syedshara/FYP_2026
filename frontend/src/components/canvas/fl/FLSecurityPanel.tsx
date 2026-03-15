/**
 * FLSecurityPanel — Compact trust score cards + click-to-expand detail modal.
 *
 * Each client is shown as a compact row: name + score + enforcement badge + bar.
 * Clicking a card opens a full-screen modal with trust history charts, direction
 * vs magnitude graphs, abnormality trend, enforcement status, flagged events,
 * and a round-by-round history table.
 *
 * The panel height is constrained by its parent (max 50%) and scrolls internally,
 * giving equal space to the certificate panel below.
 */

import { useMemo, useState, useCallback } from 'react';
import {
  ShieldCheck,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Minus,
  Info,
  ChevronDown,
  X,
  BarChart2,
  Layers,
  RefreshCw,
  Maximize2,
} from 'lucide-react';
import {
  useTrustScores,
  useFlaggedEvents,
  useCurrentDetectionRound,
  useLiveStore,
  useClientEnforcementStatus,
  useTrustScoreHistory,
} from '@/stores/liveStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { flApi } from '@/api/fl';
import type { TrustScoreComponents, ClientEnforcementStatus } from '@/types';

// ── Helpers ───────────────────────────────────────────────

function useNodeLabelMap(): Map<string, string> {
  const nodes = useWorkspaceStore((s) => s.nodes);
  return useMemo(
    () => new Map(nodes.map((n) => [n.id, (n.data as { label?: string }).label ?? n.id])),
    [nodes],
  );
}

function resolveLabel(id: string, map: Map<string, string>): string {
  return map.get(id) ?? id;
}

function scoreColor(score: number): string {
  return score >= 0.8
    ? 'var(--n8n-success)'
    : score >= 0.5
      ? 'var(--n8n-warning)'
      : 'var(--n8n-danger)';
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function componentDescription(c: TrustScoreComponents | undefined, score: number): string {
  if (!c) {
    if (score >= 0.8) return 'Gradient within normal range';
    if (score >= 0.5) return 'Moderate gradient deviation detected';
    if (score >= 0.3) return 'Significant deviation — monitoring';
    return 'High deviation — possible poisoning';
  }
  const { abnormality, direction_score, magnitude_score } = c;
  let prefix = '';
  const diff = direction_score - magnitude_score;
  if (direction_score > 0.4 && magnitude_score > 0.4) {
    prefix = 'Direction + magnitude anomaly. ';
  } else if (diff >= 0.2) {
    prefix = 'Direction anomaly. ';
  } else if (-diff >= 0.2) {
    prefix = 'Magnitude amplification. ';
  }
  if (abnormality < 0.2) return `${prefix}Gradient within normal range`.trim();
  if (abnormality < 0.5) return `${prefix}Moderate gradient deviation detected`.trim();
  if (abnormality < 0.7) return `${prefix}Significant deviation — monitoring`.trim();
  return `${prefix}High deviation — possible poisoning`.trim();
}

function enforcementFromScore(score: number): ClientEnforcementStatus {
  if (score >= 0.5) return 'included';
  if (score >= 0.3) return 'downweighted';
  return 'excluded';
}

// ── Enforcement badge ─────────────────────────────────────

const ENFORCEMENT_META: Record<ClientEnforcementStatus, { label: string; modifier: string }> = {
  included: { label: '✓ Included', modifier: 'fl-enforcement-badge--included' },
  downweighted: { label: '↓ Downweighted', modifier: 'fl-enforcement-badge--downweighted' },
  excluded: { label: '✗ Excluded', modifier: 'fl-enforcement-badge--excluded' },
};

function EnforcementBadge({ status }: { status: ClientEnforcementStatus }) {
  const { label, modifier } = ENFORCEMENT_META[status];
  return <span className={`fl-enforcement-badge ${modifier}`}>{label}</span>;
}

// ── SVG Mini-Chart ────────────────────────────────────────
// Generic reusable SVG line chart for the client detail modal.

interface ChartLine {
  values: number[];
  color: string;
  label: string;
  dashed?: boolean;
}

interface ThresholdLine {
  value: number;
  color: string;
  label: string;
}

interface MiniChartProps {
  lines: ChartLine[];
  xLabels: string[];
  yMin?: number;
  yMax?: number;
  thresholds?: ThresholdLine[];
  height?: number;
}

/** Chart constants */
const CHART_PAD = { top: 10, right: 14, bottom: 26, left: 38 };

function MiniChart({
  lines,
  xLabels,
  yMin: yMinProp,
  yMax: yMaxProp,
  thresholds,
  height: heightProp,
}: MiniChartProps) {
  const W = 520;
  const H = heightProp ?? 180;
  const plotW = W - CHART_PAD.left - CHART_PAD.right;
  const plotH = H - CHART_PAD.top - CHART_PAD.bottom;

  // Y range
  const allVals = lines.flatMap((l) => l.values).concat(thresholds?.map((t) => t.value) ?? []);
  const dataMin = Math.min(...allVals);
  const dataMax = Math.max(...allVals);
  const yMin = yMinProp ?? Math.max(0, dataMin - 0.05);
  const yMax = yMaxProp ?? Math.min(1, dataMax + 0.05);
  const yRange = yMax - yMin || 0.01;

  const n = xLabels.length;
  const toX = (i: number) => CHART_PAD.left + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const toY = (v: number) => CHART_PAD.top + plotH - ((v - yMin) / yRange) * plotH;

  // Y-axis grid: 5 ticks
  const yTicks: number[] = [];
  for (let t = 0; t <= 4; t++) yTicks.push(yMin + (t / 4) * yRange);

  // Only show every Nth x-label to avoid overlap
  const xStep = Math.max(1, Math.ceil(n / 10));

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
      {/* Grid lines */}
      {yTicks.map((v, i) => (
        <line
          key={`g${i}`}
          x1={CHART_PAD.left}
          x2={W - CHART_PAD.right}
          y1={toY(v)}
          y2={toY(v)}
          stroke="rgba(255,255,255,0.06)"
          strokeWidth={0.5}
        />
      ))}

      {/* Y-axis labels */}
      {yTicks.map((v, i) => (
        <text
          key={`yl${i}`}
          x={CHART_PAD.left - 5}
          y={toY(v) + 4}
          textAnchor="end"
          fontSize={10}
          fill="var(--n8n-text-muted)"
          fontFamily="ui-monospace, monospace"
        >
          {v.toFixed(2)}
        </text>
      ))}

      {/* X-axis labels */}
      {xLabels.map((lbl, i) =>
        i % xStep === 0 || i === n - 1 ? (
          <text
            key={`xl${i}`}
            x={toX(i)}
            y={H - 5}
            textAnchor="middle"
            fontSize={10}
            fill="var(--n8n-text-muted)"
            fontFamily="ui-monospace, monospace"
          >
            {lbl}
          </text>
        ) : null,
      )}

      {/* Threshold lines */}
      {thresholds?.map((t, i) => (
        <g key={`th${i}`}>
          <line
            x1={CHART_PAD.left}
            x2={W - CHART_PAD.right}
            y1={toY(t.value)}
            y2={toY(t.value)}
            stroke={t.color}
            strokeWidth={1}
            strokeDasharray="5,3"
            opacity={0.5}
          />
          <text
            x={W - CHART_PAD.right + 3}
            y={toY(t.value) + 4}
            fontSize={9}
            fill={t.color}
            opacity={0.7}
          >
            {t.label}
          </text>
        </g>
      ))}

      {/* Data lines */}
      {lines.map((line, li) => {
        if (line.values.length < 2) return null;
        const d = line.values
          .map((v, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(v).toFixed(1)}`)
          .join(' ');
        return (
          <path
            key={`l${li}`}
            d={d}
            fill="none"
            stroke={line.color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={line.dashed ? '4,3' : undefined}
            opacity={0.9}
          />
        );
      })}

      {/* Data points (dots) for the last entry */}
      {lines.map((line, li) => {
        if (line.values.length === 0) return null;
        const last = line.values.length - 1;
        return (
          <circle
            key={`d${li}`}
            cx={toX(last)}
            cy={toY(line.values[last])}
            r={3}
            fill={line.color}
          />
        );
      })}
    </svg>
  );
}

/** Animated skeleton placeholder shown before training data arrives */
function SkeletonChart() {
  const heights = [38, 55, 48, 72, 52, 80, 62];
  return (
    <div className="fl-chart-skeleton">
      <div className="fl-chart-skeleton__bars">
        {heights.map((h, i) => (
          <div key={i} className="fl-chart-skeleton__bar" style={{ height: `${h}%` }} />
        ))}
      </div>
      <span className="fl-chart-skeleton__label">Waiting for training data…</span>
    </div>
  );
}

/** Legend row below a chart */
function ChartLegend({ lines }: { lines: ChartLine[] }) {
  return (
    <div className="flex items-center gap-3 flex-wrap" style={{ paddingLeft: 2 }}>
      {lines.map((l, i) => (
        <span
          key={i}
          className="flex items-center gap-1.5"
          style={{ fontSize: 11, color: 'var(--n8n-text-muted)' }}
        >
          <span
            style={{
              display: 'inline-block',
              width: 14,
              height: 2.5,
              borderRadius: 1,
              background: l.color,
              opacity: 0.9,
            }}
          />
          {l.label}
        </span>
      ))}
    </div>
  );
}

// ── Compact Trust Score Card ──────────────────────────────

interface TrustScoreBarProps {
  clientId: string;
  score: number;
  labelMap: Map<string, string>;
  enforcement?: ClientEnforcementStatus;
  onClick: () => void;
}

function TrustScoreBar({ clientId, score, labelMap, enforcement, onClick }: TrustScoreBarProps) {
  const history = useTrustScoreHistory(clientId);
  const pct = Math.min(score * 100, 100);
  const color = scoreColor(score);
  const lastRound = history[history.length - 1]?.round;

  // Trend
  let TrendIcon = Minus;
  let trendColor = 'var(--n8n-text-muted)';
  if (history.length >= 2) {
    const prev = history[history.length - 2].score;
    const delta = score - prev;
    if (delta > 0.005) {
      TrendIcon = TrendingUp;
      trendColor = 'var(--n8n-success)';
    } else if (delta < -0.005) {
      TrendIcon = TrendingDown;
      trendColor = 'var(--n8n-danger)';
    }
  }

  const displayName = resolveLabel(clientId, labelMap);

  return (
    <div
      className="fl-trust-bar"
      style={{ cursor: 'pointer' }}
      onClick={onClick}
      title={`${displayName} — click for details`}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); }}
    >
      <div className="flex items-center gap-1.5">
        <span
          className="text-xs truncate"
          style={{ color: 'var(--n8n-text-primary)', minWidth: 0, flex: '1 1 40px' }}
        >
          {displayName}
        </span>
        <TrendIcon size={10} style={{ color: trendColor, flexShrink: 0 }} />
        <span className="text-xs font-mono font-semibold" style={{ color, flexShrink: 0 }}>
          {score.toFixed(2)}
        </span>
        {lastRound != null && (
          <span className="text-xs" style={{ color: 'var(--n8n-text-muted)', flexShrink: 0 }}>
            R{lastRound}
          </span>
        )}
        {enforcement && <EnforcementBadge status={enforcement} />}
        <Maximize2
          size={10}
          style={{ color: 'var(--n8n-text-muted)', flexShrink: 0, opacity: 0.5 }}
        />
      </div>

      <div className="fl-trust-bar-track">
        <div className="fl-trust-bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

// ── Client Detail Modal ───────────────────────────────────

interface ClientDetailModalProps {
  clientId: string;
  score: number;
  labelMap: Map<string, string>;
  enforcement?: ClientEnforcementStatus;
  onClose: () => void;
}

function ClientDetailModal({
  clientId,
  score,
  labelMap,
  enforcement,
  onClose,
}: ClientDetailModalProps) {
  const history = useTrustScoreHistory(clientId);
  const allFlagged = useFlaggedEvents();
  const displayName = resolveLabel(clientId, labelMap);
  const color = scoreColor(score);
  const latestComponents = history[history.length - 1]?.components;
  const desc = componentDescription(latestComponents, score);
  const effectiveEnforcement = enforcement ?? enforcementFromScore(score);

  // Filter flagged events for this client
  const clientFlagged = useMemo(
    () =>
      allFlagged
        .filter((e) => e.clientId === clientId)
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()),
    [allFlagged, clientId],
  );

  // Build chart data from history
  const xLabels = history.map((h) => `R${h.round}`);
  const trustValues = history.map((h) => h.score);
  const dirValues = history.map((h) => h.components?.direction_score ?? 0);
  const magValues = history.map((h) => h.components?.magnitude_score ?? 0);
  const abnValues = history.map((h) => h.components?.abnormality ?? 0);
  const hasComponents = history.some((h) => h.components);

  const trustLines: ChartLine[] = [
    { values: trustValues, color: 'var(--n8n-accent, #ff6d5a)', label: 'Trust Score' },
  ];
  const trustThresholds: ThresholdLine[] = [
    { value: 0.5, color: 'var(--n8n-warning, #f59e0b)', label: '0.5' },
    { value: 0.3, color: 'var(--n8n-danger, #d03050)', label: '0.3' },
  ];

  const dirMagLines: ChartLine[] = [
    { values: dirValues, color: '#38bdf8', label: 'Direction' },
    { values: magValues, color: '#a78bfa', label: 'Magnitude' },
  ];

  const abnLines: ChartLine[] = [
    { values: abnValues, color: 'var(--n8n-danger, #d03050)', label: 'Abnormality' },
  ];

  // Number of rounds tracked
  const totalRounds = history.length;
  const latestRound = history[totalRounds - 1]?.round;

  return (
    <div
      className="fl-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`${displayName} details`}
      onClick={onClose}
    >
      <div
        className="fl-modal fl-detail-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="fl-modal__header">
          <div className="fl-modal__title">
            <ShieldCheck size={18} style={{ color }} />
            <span>{displayName}</span>
            <span
              className="font-mono"
              style={{ color, fontSize: 18, fontWeight: 700, marginLeft: 2 }}
            >
              {score.toFixed(3)}
            </span>
            <EnforcementBadge status={effectiveEnforcement} />
          </div>
          <button className="fl-modal__close" onClick={onClose} aria-label="Close modal">
            <X size={16} />
          </button>
        </div>

        {/* ── Body ── */}
        <div className="fl-modal__body">
          {/* ── Summary stat cards ── */}
          <div className="fl-detail-stats">
            <div className="fl-detail-stat">
              <div className="fl-detail-stat__label">Trust Score</div>
              <div className="fl-detail-stat__value" style={{ color }}>
                {score.toFixed(3)}
              </div>
            </div>
            <div className="fl-detail-stat">
              <div className="fl-detail-stat__label">Direction</div>
              <div
                className="fl-detail-stat__value"
                style={{ color: latestComponents ? '#38bdf8' : 'var(--n8n-text-muted)' }}
              >
                {latestComponents ? latestComponents.direction_score.toFixed(3) : '—'}
              </div>
            </div>
            <div className="fl-detail-stat">
              <div className="fl-detail-stat__label">Magnitude</div>
              <div
                className="fl-detail-stat__value"
                style={{ color: latestComponents ? '#a78bfa' : 'var(--n8n-text-muted)' }}
              >
                {latestComponents ? latestComponents.magnitude_score.toFixed(3) : '—'}
              </div>
            </div>
            <div className="fl-detail-stat">
              <div className="fl-detail-stat__label">Abnormality</div>
              <div
                className="fl-detail-stat__value"
                style={{ color: latestComponents ? 'var(--n8n-danger)' : 'var(--n8n-text-muted)' }}
              >
                {latestComponents ? latestComponents.abnormality.toFixed(3) : '—'}
              </div>
            </div>
            <div className="fl-detail-stat">
              <div className="fl-detail-stat__label">Enforcement</div>
              <div style={{ marginTop: 2, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <EnforcementBadge status={effectiveEnforcement} />
                {effectiveEnforcement === 'included' &&
                  latestComponents &&
                  latestComponents.abnormality > 0.7 && (
                    <span style={{ fontSize: 10, color: 'var(--n8n-warning)', fontStyle: 'italic' }}>
                      ⚠ High abnormality — score decaying
                    </span>
                  )}
              </div>
            </div>
            <div className="fl-detail-stat">
              <div className="fl-detail-stat__label">Rounds</div>
              <div className="fl-detail-stat__value" style={{ color: 'var(--n8n-text-primary)' }}>
                {totalRounds}
                {latestRound != null && (
                  <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--n8n-text-muted)', marginLeft: 4 }}>
                    (latest R{latestRound})
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Description */}
          <p style={{ fontSize: 12, color: 'var(--n8n-text-muted)', fontStyle: 'italic', margin: 0 }}>
            {desc}
          </p>

          {/* ── Chart grid — always visible, skeleton until data ── */}
          <div className="fl-detail-chart-grid">
            {/* Trust Score History */}
            <div className="fl-detail-chart-card">
              <div className="fl-detail-chart-card__title">
                <TrendingUp size={14} />
                Trust Score History
              </div>
              {history.length >= 2 ? (
                <>
                  <MiniChart
                    lines={trustLines}
                    xLabels={xLabels}
                    yMin={0}
                    yMax={1}
                    thresholds={trustThresholds}
                  />
                  <ChartLegend lines={trustLines} />
                </>
              ) : (
                <SkeletonChart />
              )}
            </div>

            {/* Direction vs Magnitude */}
            <div className="fl-detail-chart-card">
              <div className="fl-detail-chart-card__title">
                <BarChart2 size={14} />
                Direction vs Magnitude
              </div>
              {history.length >= 2 && hasComponents ? (
                <>
                  <MiniChart lines={dirMagLines} xLabels={xLabels} yMin={0} yMax={1} />
                  <ChartLegend lines={dirMagLines} />
                </>
              ) : (
                <SkeletonChart />
              )}
            </div>

            {/* Abnormality Trend */}
            <div className="fl-detail-chart-card">
              <div className="fl-detail-chart-card__title">
                <AlertTriangle size={14} />
                Abnormality Trend
              </div>
              {history.length >= 2 && hasComponents ? (
                <>
                  <MiniChart lines={abnLines} xLabels={xLabels} yMin={0} yMax={1} />
                  <ChartLegend lines={abnLines} />
                </>
              ) : (
                <SkeletonChart />
              )}
            </div>
          </div>

          {/* ── Two-column: Breakdown + Flagged Events ── */}
          {(latestComponents || clientFlagged.length > 0) && (
            <div className="fl-detail-tables-grid">
              {/* Latest Component Breakdown */}
              {latestComponents && (
                <div className="fl-detail-section">
                  <div className="fl-detail-section__title">
                    <Layers size={14} />
                    Latest Round Breakdown
                  </div>
                  <table className="fl-modal-score-table">
                    <thead>
                      <tr>
                        <th>Metric</th>
                        <th>Value</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td><strong style={{ color: '#38bdf8' }}>Direction</strong></td>
                        <td className="font-mono">{latestComponents.direction_score.toFixed(3)}</td>
                        <td>{latestComponents.direction_score > 0.4 ? 'Anomalous' : 'Normal'}</td>
                      </tr>
                      <tr>
                        <td><strong style={{ color: '#a78bfa' }}>Magnitude</strong></td>
                        <td className="font-mono">{latestComponents.magnitude_score.toFixed(3)}</td>
                        <td>{latestComponents.magnitude_score > 0.4 ? 'Anomalous' : 'Normal'}</td>
                      </tr>
                      <tr>
                        <td><strong style={{ color: 'var(--n8n-danger)' }}>Abnormality</strong></td>
                        <td className="font-mono">{latestComponents.abnormality.toFixed(3)}</td>
                        <td>
                          {latestComponents.abnormality < 0.2
                            ? 'Low'
                            : latestComponents.abnormality < 0.5
                              ? 'Moderate'
                              : latestComponents.abnormality < 0.7
                                ? 'High'
                                : 'Critical'}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}

              {/* Flagged Events */}
              {clientFlagged.length > 0 && (
                <div className="fl-detail-section">
                  <div className="fl-detail-section__title fl-detail-section__title--danger">
                    <AlertTriangle size={14} />
                    Flagged Events ({clientFlagged.length})
                  </div>
                  <div
                    className="flex flex-col gap-1.5"
                    style={{ maxHeight: 180, overflowY: 'auto' }}
                  >
                    {clientFlagged.map((evt, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-3 px-3 py-1.5 rounded"
                        style={{
                          fontSize: 12,
                          background: 'rgba(208,48,80,0.08)',
                          border: '1px solid rgba(208,48,80,0.15)',
                        }}
                      >
                        <span className="font-mono font-semibold" style={{ color: 'var(--n8n-danger)' }}>
                          {evt.abnormality.toFixed(3)}
                        </span>
                        <span style={{ color: 'var(--n8n-text-muted)' }}>Round {evt.round}</span>
                        <span style={{ color: 'var(--n8n-text-muted)', marginLeft: 'auto' }}>
                          {relativeTime(evt.timestamp)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Round-by-round history table (full width) ── */}
          {history.length > 0 && (
            <div className="fl-detail-section">
              <div className="fl-detail-section__title">
                <RefreshCw size={14} />
                Round History
              </div>
              <div style={{ maxHeight: 240, overflowY: 'auto' }}>
                <table className="fl-modal-score-table">
                  <thead>
                    <tr>
                      <th>Round</th>
                      <th>Score</th>
                      {hasComponents && <th>Direction</th>}
                      {hasComponents && <th>Magnitude</th>}
                      {hasComponents && <th>Abnormality</th>}
                      <th>Tier</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...history]
                      .reverse()
                      .filter((entry) => !hasComponents || entry.components)
                      .map((entry, i) => {
                        const tier = enforcementFromScore(entry.score);
                        const tierMeta = ENFORCEMENT_META[tier];
                        return (
                          <tr key={i}>
                            <td className="font-mono">R{entry.round}</td>
                            <td className="font-mono" style={{ color: scoreColor(entry.score) }}>
                              {entry.score.toFixed(3)}
                            </td>
                            {hasComponents && (
                              <td className="font-mono">
                                {entry.components?.direction_score.toFixed(3) ?? '—'}
                              </td>
                            )}
                            {hasComponents && (
                              <td className="font-mono">
                                {entry.components?.magnitude_score.toFixed(3) ?? '—'}
                              </td>
                            )}
                            {hasComponents && (
                              <td className="font-mono">
                                {entry.components?.abnormality.toFixed(3) ?? '—'}
                              </td>
                            )}
                            <td>
                              <span className={`fl-enforcement-badge ${tierMeta.modifier}`}>
                                {tierMeta.label}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Enforcement threshold legend ──────────────────────────

function EnforcementLegend() {
  return (
    <div className="fl-enforcement-threshold">
      <span className="fl-enforcement-threshold__item">
        <span className="fl-enforcement-badge fl-enforcement-badge--included">✓ Included</span>
        <span>≥ 0.5</span>
      </span>
      <span className="fl-enforcement-threshold__item">
        <span className="fl-enforcement-badge fl-enforcement-badge--downweighted">↓ Downweighted</span>
        <span>0.3–0.49</span>
      </span>
      <span className="fl-enforcement-threshold__item">
        <span className="fl-enforcement-badge fl-enforcement-badge--excluded">✗ Excluded</span>
        <span>&lt; 0.3</span>
      </span>
    </div>
  );
}

// ── RECESS Info Modal ─────────────────────────────────────

function RECESSInfoModal({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const toggle = (i: number) => setOpen((prev) => ({ ...prev, [i]: !prev[i] }));

  const sections: Array<{
    title: string;
    icon: React.ComponentType<{ size?: number }>;
    content: React.ReactNode;
  }> = [
    {
      title: 'What is RECESS?',
      icon: ShieldCheck,
      content: (
        <>
          <p>
            <strong style={{ color: 'var(--n8n-text-primary)' }}>RECESS</strong> analyses each
            client's gradient update every round and assigns a{' '}
            <em>trust score</em> from 0.0 to 1.0.
          </p>
          <p>
            It decomposes each gradient into direction and magnitude signals to detect clients
            nudging the model the wrong way or amplifying parameters to unusual extremes.
          </p>
          <p>
            Scores decay exponentially toward 1.0, so a single suspicious round does not
            permanently penalise a client.
          </p>
        </>
      ),
    },
    {
      title: 'Abnormality Score Breakdown',
      icon: BarChart2,
      content: (
        <table className="fl-modal-score-table">
          <thead>
            <tr><th>Metric</th><th>Measures</th><th>High value</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><strong style={{ color: 'var(--n8n-text-primary)' }}>Direction</strong></td>
              <td>Cosine divergence from aggregated gradient</td>
              <td>Wrong direction</td>
            </tr>
            <tr>
              <td><strong style={{ color: 'var(--n8n-text-primary)' }}>Magnitude</strong></td>
              <td>L2-norm deviation from median</td>
              <td>Amplification</td>
            </tr>
            <tr>
              <td><strong style={{ color: 'var(--n8n-text-primary)' }}>Abnormality</strong></td>
              <td>Weighted combination</td>
              <td>Suspicious</td>
            </tr>
          </tbody>
        </table>
      ),
    },
    {
      title: 'Enforcement Tiers',
      icon: Layers,
      content: (
        <>
          <table className="fl-modal-tier-table">
            <thead><tr><th>Tier</th><th>Range</th><th>Effect</th></tr></thead>
            <tbody>
              <tr>
                <td><span className="fl-enforcement-badge fl-enforcement-badge--included">✓ Included</span></td>
                <td>≥ 0.5</td><td>Full weight</td>
              </tr>
              <tr>
                <td><span className="fl-enforcement-badge fl-enforcement-badge--downweighted">↓ Downweighted</span></td>
                <td>0.3–0.49</td><td>Scaled by trust</td>
              </tr>
              <tr>
                <td><span className="fl-enforcement-badge fl-enforcement-badge--excluded">✗ Excluded</span></td>
                <td>&lt; 0.3</td><td>Dropped</td>
              </tr>
            </tbody>
          </table>
          <p>If all clients excluded, the global model is not updated.</p>
        </>
      ),
    },
    {
      title: 'Why Training Continues',
      icon: RefreshCw,
      content: (
        <>
          <p>
            RECESS uses exponential decay rather than permanent bans — excluded clients
            recover toward 1.0 if subsequent gradients appear normal.
          </p>
          <ul style={{ paddingLeft: 14 }}>
            <li><strong style={{ color: 'var(--n8n-text-primary)' }}>False positives</strong> — temporarily suppressed, then reinstated.</li>
            <li><strong style={{ color: 'var(--n8n-text-primary)' }}>Persistent attackers</strong> — sustained anomalies keep the score low.</li>
          </ul>
        </>
      ),
    },
  ];

  return (
    <div className="fl-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="fl-modal" style={{ width: 460 }} onClick={(e) => e.stopPropagation()}>
        <div className="fl-modal__header">
          <div className="fl-modal__title">
            <ShieldCheck size={14} style={{ color: 'var(--n8n-success)' }} />
            RECESS — Gradient Anomaly Detection
          </div>
          <button className="fl-modal__close" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <div className="fl-modal__body">
          {sections.map((sec, i) => {
            const Icon = sec.icon;
            const isOpen = !!open[i];
            return (
              <div key={i} className="fl-modal-section">
                <button
                  className="fl-modal-section__trigger"
                  onClick={() => toggle(i)}
                  aria-expanded={isOpen}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Icon size={11} />
                    {sec.title}
                  </span>
                  <ChevronDown
                    size={12}
                    className={`fl-modal-section__chevron${isOpen ? ' fl-modal-section__chevron--open' : ''}`}
                  />
                </button>
                {isOpen && <div className="fl-modal-section__content">{sec.content}</div>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────

export default function FLSecurityPanel() {
  const trustScores = useTrustScores();
  const flaggedEvents = useFlaggedEvents();
  const currentRound = useCurrentDetectionRound();
  const labelMap = useNodeLabelMap();
  const clientEnforcement = useClientEnforcementStatus();

  const [showRECESSModal, setShowRECESSModal] = useState(false);
  const [selectedClient, setSelectedClient] = useState<string | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);

  const isTraining = useLiveStore((s) => s.flGlobalProgress?.is_training ?? false);

  const handleReset = useCallback(async () => {
    setResetting(true);
    try {
      await flApi.resetTrustScores();
    } catch {
      // Backend error — silently ignore; WebSocket update will confirm success
    } finally {
      setResetting(false);
      setShowResetConfirm(false);
    }
  }, []);

  const hasScores = Object.keys(trustScores).length > 0;

  // Flagged badge count for the header
  const flaggedCount = flaggedEvents.length;

  const headerSuffix =
    currentRound != null ? `R${currentRound}` : hasScores ? 'Cached' : null;

  const handleCardClick = useCallback((clientId: string) => {
    setSelectedClient(clientId);
  }, []);

  return (
    <>
      {/* Modals render above everything via portal-like fixed positioning */}
      {showRECESSModal && <RECESSInfoModal onClose={() => setShowRECESSModal(false)} />}
      {showResetConfirm && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 10000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.55)',
          }}
        >
          <div
            style={{
              background: 'var(--n8n-canvas-background)',
              border: '1px solid var(--n8n-border)',
              borderRadius: 8,
              padding: '20px 24px',
              width: 340,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <AlertTriangle size={16} style={{ color: 'var(--n8n-warning)', flexShrink: 0 }} />
              <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--n8n-text-primary)' }}>
                Reset Trust Scores?
              </span>
            </div>
            <p style={{ fontSize: 12, color: 'var(--n8n-text-muted)', margin: 0, lineHeight: 1.5 }}>
              All client trust scores will be set back to 1.0 and history will be cleared.
              Use this to start a fresh experiment. This action cannot be undone.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                style={{
                  background: 'transparent',
                  border: '1px solid var(--n8n-border)',
                  borderRadius: 4,
                  padding: '4px 12px',
                  fontSize: 12,
                  cursor: 'pointer',
                  color: 'var(--n8n-text-primary)',
                }}
                onClick={() => setShowResetConfirm(false)}
                disabled={resetting}
              >
                Cancel
              </button>
              <button
                style={{
                  background: 'var(--n8n-danger)',
                  border: 'none',
                  borderRadius: 4,
                  padding: '4px 12px',
                  fontSize: 12,
                  cursor: resetting ? 'not-allowed' : 'pointer',
                  color: '#fff',
                  opacity: resetting ? 0.6 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
                onClick={handleReset}
                disabled={resetting}
              >
                {resetting && <RefreshCw size={10} style={{ animation: 'spin 1s linear infinite' }} />}
                Reset
              </button>
            </div>
          </div>
        </div>
      )}
      {selectedClient != null && trustScores[selectedClient] != null && (
        <ClientDetailModal
          clientId={selectedClient}
          score={trustScores[selectedClient]}
          labelMap={labelMap}
          enforcement={clientEnforcement[selectedClient]}
          onClose={() => setSelectedClient(null)}
        />
      )}

      <div className="flex flex-col gap-3">
        {/* ── Trust Scores ── */}
        <div className="fl-panel-section">
          <div className="fl-section-header">
            <ShieldCheck size={13} style={{ color: 'var(--n8n-text-muted)', flexShrink: 0 }} />
            <span className="fl-section-header-title">Trust Scores</span>
            {headerSuffix && (
              <span
                className="text-xs font-mono"
                style={{ color: 'var(--n8n-text-muted)' }}
              >
                {headerSuffix}
              </span>
            )}
            {flaggedCount > 0 && (
              <span
                className="text-xs font-semibold px-1.5 py-0.5 rounded"
                style={{
                  color: 'var(--n8n-danger)',
                  background: 'rgba(208,48,80,0.12)',
                  flexShrink: 0,
                }}
              >
                {flaggedCount} flagged
              </span>
            )}
            <button
              className="ml-auto flex items-center gap-1"
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--n8n-text-muted)',
                padding: '2px 4px',
                borderRadius: 4,
                fontSize: 10,
                flexShrink: 0,
              }}
              onClick={() => setShowRECESSModal(true)}
              title="How RECESS works"
            >
              <Info size={10} />
              Info
            </button>
            <button
              className="flex items-center gap-1"
              style={{
                background: 'transparent',
                border: 'none',
                cursor: isTraining ? 'not-allowed' : 'pointer',
                color: isTraining ? 'var(--n8n-text-disabled)' : 'var(--n8n-text-muted)',
                padding: '2px 4px',
                borderRadius: 4,
                fontSize: 10,
                flexShrink: 0,
                opacity: isTraining ? 0.4 : 1,
              }}
              onClick={() => !isTraining && setShowResetConfirm(true)}
              title={isTraining ? 'Cannot reset while training is in progress' : 'Reset all trust scores to 1.0'}
              disabled={isTraining}
            >
              <RefreshCw size={10} />
              Reset
            </button>
          </div>

          <div className="flex flex-col gap-1.5">
            {!hasScores ? (
              <div className="fl-empty-state">
                <ShieldCheck size={20} className="fl-empty-state-icon" />
                <p className="fl-empty-state-text">
                  No detection data yet — RECESS runs every 5 rounds
                </p>
              </div>
            ) : (
              Object.entries(trustScores).map(([clientId, score]) => (
                <TrustScoreBar
                  key={clientId}
                  clientId={clientId}
                  score={score}
                  labelMap={labelMap}
                  enforcement={clientEnforcement[clientId]}
                  onClick={() => handleCardClick(clientId)}
                />
              ))
            )}
          </div>

          {hasScores && <EnforcementLegend />}
        </div>
      </div>
    </>
  );
}
