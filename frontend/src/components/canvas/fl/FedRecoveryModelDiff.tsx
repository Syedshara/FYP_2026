/**
 * FedRecoveryModelDiff — before/after weight-norm comparison panel.
 *
 * Renders a table-with-inline-bars layout:
 *   Layer | Before norm (bar) | After norm (bar) | Δ%
 *
 * Each row shows the two norms as proportional fill bars so the
 * magnitude change is immediately visible.  Rows are sorted by
 * largest absolute change first.
 *
 * Also renders an accuracy/loss improvement row when that data is
 * available from the completed run payload.
 */

import type { FedRecoveryRun } from '@/stores/fedRecoveryStore';
import { TrendingDown, TrendingUp, Minus } from 'lucide-react';

// ── Helpers ───────────────────────────────────────────

function deltaPct(before: number, after: number): number {
  if (before === 0) return 0;
  return ((after - before) / before) * 100;
}

function deltaColor(pct: number): string {
  if (pct < -1)  return 'var(--n8n-success)';   // norm shrank  = good
  if (pct > 1)   return 'var(--n8n-danger)';    // norm grew    = bad
  return 'var(--n8n-text-muted)';
}

function DeltaIcon({ pct }: { pct: number }) {
  const size = 10;
  if (pct < -1)  return <TrendingDown size={size} style={{ color: 'var(--n8n-success)'  }} />;
  if (pct >  1)  return <TrendingUp   size={size} style={{ color: 'var(--n8n-danger)'   }} />;
  return               <Minus         size={size} style={{ color: 'var(--n8n-text-muted)'}} />;
}

/** Shorten layer names: lstm.weight_ih_l0 → lstm.ih_l0 */
function shortLayer(name: string): string {
  return name
    .replace(/weight_/g, '')
    .replace(/\.weight$/, '')
    .replace(/\.bias$/, '.b');
}

// ── Inline dual bar ───────────────────────────────────

function DualBar({
  before,
  after,
  maxVal,
}: {
  before: number;
  after:  number;
  maxVal: number;
}) {
  const beforePct = maxVal > 0 ? (before / maxVal) * 100 : 0;
  const afterPct  = maxVal > 0 ? (after  / maxVal) * 100 : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, width: 80 }}>
      {/* Before bar */}
      <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${beforePct}%`, background: 'rgba(255,255,255,0.20)', borderRadius: 2 }} />
      </div>
      {/* After bar */}
      <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
        <div
          style={{
            height:     '100%',
            width:      `${afterPct}%`,
            background: afterPct < beforePct ? 'var(--n8n-success)' : 'var(--n8n-danger)',
            borderRadius: 2,
          }}
        />
      </div>
    </div>
  );
}

// ── Accuracy/loss improvement row ─────────────────────

function MetricImprovement({
  label,
  before,
  after,
  higherIsBetter,
}: {
  label:          string;
  before:         number;
  after:          number;
  higherIsBetter: boolean;
}) {
  const delta     = after - before;
  const improved  = higherIsBetter ? delta > 0 : delta < 0;
  const color     = improved ? 'var(--n8n-success)' : 'var(--n8n-danger)';
  const sign      = delta >= 0 ? '+' : '';

  return (
    <div
      style={{
        display:    'flex',
        alignItems: 'center',
        gap:        8,
        fontSize:   11,
        fontFamily: 'ui-monospace, monospace',
        padding:    '4px 8px',
        borderRadius: 4,
        background: improved ? 'rgba(24,160,88,0.07)' : 'rgba(208,48,80,0.07)',
      }}
    >
      <span style={{ color: 'var(--n8n-text-muted)', minWidth: 80 }}>{label}</span>
      <span style={{ color: 'var(--n8n-text-muted)' }}>{before.toFixed(4)}</span>
      <span style={{ color: 'var(--n8n-text-muted)' }}>→</span>
      <span style={{ color: 'var(--n8n-text-primary)', fontWeight: 600 }}>{after.toFixed(4)}</span>
      <span style={{ color, marginLeft: 'auto', fontWeight: 600 }}>
        {sign}{delta.toFixed(4)}
      </span>
    </div>
  );
}

// ── Main component ────────────────────────────────────

interface FedRecoveryModelDiffProps {
  run: FedRecoveryRun;
}

export default function FedRecoveryModelDiff({ run }: FedRecoveryModelDiffProps) {
  const { beforeNorms, afterNorms, accuracyBefore, accuracyAfter, lossBefore, lossAfter } = run;

  const hasNorms  = beforeNorms != null && afterNorms != null;
  const hasMetrics =
    accuracyBefore != null && accuracyAfter != null &&
    lossBefore     != null && lossAfter     != null;

  if (!hasNorms && !hasMetrics) {
    return (
      <p style={{ fontSize: 11, color: 'var(--n8n-text-muted)', fontStyle: 'italic', margin: 0 }}>
        Weight norm data not yet available.
      </p>
    );
  }

  // Build sorted layer rows (largest |Δ%| first)
  type LayerRow = { name: string; before: number; after: number; pct: number };
  const rows: LayerRow[] = [];

  if (hasNorms) {
    for (const [name, before] of Object.entries(beforeNorms!)) {
      const after = afterNorms![name] ?? before;
      rows.push({ name, before, after, pct: deltaPct(before, after) });
    }
    rows.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
  }

  const maxVal = rows.length > 0
    ? Math.max(...rows.flatMap((r) => [r.before, r.after]))
    : 1;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* ── Accuracy / Loss improvement ── */}
      {hasMetrics && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <MetricImprovement
            label="Accuracy"
            before={accuracyBefore!}
            after={accuracyAfter!}
            higherIsBetter
          />
          <MetricImprovement
            label="Loss"
            before={lossBefore!}
            after={lossAfter!}
            higherIsBetter={false}
          />
        </div>
      )}

      {/* ── Layer norm table ── */}
      {rows.length > 0 && (
        <div>
          {/* Legend */}
          <div
            style={{
              display:    'flex',
              gap:        12,
              marginBottom: 6,
              fontSize:   10,
              color:      'var(--n8n-text-muted)',
              fontFamily: 'ui-monospace, monospace',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ display: 'inline-block', width: 24, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.20)' }} />
              Before
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ display: 'inline-block', width: 24, height: 4, borderRadius: 2, background: 'var(--n8n-success)' }} />
              After
            </span>
          </div>

          <table className="fl-modal-score-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Layer</th>
                <th>Before</th>
                <th>After</th>
                <th style={{ width: 88 }}>Δ bars</th>
                <th>Δ%</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.name}>
                  <td
                    style={{
                      fontFamily:   'ui-monospace, monospace',
                      fontSize:     10,
                      color:        'var(--n8n-text-muted)',
                      maxWidth:     120,
                      overflow:     'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace:   'nowrap',
                    }}
                    title={row.name}
                  >
                    {shortLayer(row.name)}
                  </td>
                  <td className="font-mono" style={{ fontSize: 11 }}>
                    {row.before.toFixed(3)}
                  </td>
                  <td className="font-mono" style={{ fontSize: 11, color: deltaColor(row.pct) }}>
                    {row.after.toFixed(3)}
                  </td>
                  <td>
                    <DualBar before={row.before} after={row.after} maxVal={maxVal} />
                  </td>
                  <td style={{ fontSize: 10, fontFamily: 'ui-monospace, monospace' }}>
                    <span
                      style={{
                        display:    'flex',
                        alignItems: 'center',
                        gap:        3,
                        color:      deltaColor(row.pct),
                      }}
                    >
                      <DeltaIcon pct={row.pct} />
                      {row.pct >= 0 ? '+' : ''}{row.pct.toFixed(1)}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
