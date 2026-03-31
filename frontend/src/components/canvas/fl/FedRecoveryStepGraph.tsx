/**
 * FedRecoveryStepGraph — horizontal step pipeline for a FedRecovery run.
 *
 * Each corrected/skipped round is rendered as a connected chip.
 * A pulsing "running" ghost chip appears while status === 'running'.
 * Summary counters and an overall progress bar sit below the chain.
 */

import type { FedRecoveryRun, FedRecoveryStep } from '@/stores/fedRecoveryStore';
import { CheckCircle, SkipForward, Loader2 } from 'lucide-react';

// ── Step chip ─────────────────────────────────────────

interface ChipProps {
  step:    FedRecoveryStep;
  isLast:  boolean;
}

function StepChip({ step, isLast }: ChipProps) {
  const isCorrected = step.step === 'corrected';
  const color  = isCorrected ? 'var(--n8n-success)'        : 'var(--n8n-text-muted)';
  const bg     = isCorrected ? 'rgba(24,160,88,0.12)'      : 'rgba(255,255,255,0.04)';
  const border = isCorrected ? 'rgba(24,160,88,0.30)'      : 'rgba(255,255,255,0.09)';

  return (
    <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
      {/* Connector line (hidden for first chip) */}
      <div
        style={{
          width:      isLast ? 0 : 6,
          height:     1,
          background: isCorrected ? 'rgba(24,160,88,0.25)' : 'rgba(255,255,255,0.07)',
          flexShrink: 0,
        }}
      />

      {/* Chip */}
      <div
        style={{
          display:        'flex',
          flexDirection:  'column',
          alignItems:     'center',
          gap:            2,
          padding:        '4px 6px',
          borderRadius:   5,
          background:     bg,
          border:         `1px solid ${border}`,
          flexShrink:     0,
          minWidth:       36,
        }}
        title={step.detail ?? (isCorrected ? 'Corrected' : 'Skipped')}
      >
        {isCorrected
          ? <CheckCircle size={10} style={{ color }} />
          : <SkipForward size={10} style={{ color }} />
        }
        <span
          style={{
            fontSize:   9,
            fontFamily: 'ui-monospace, monospace',
            color,
            lineHeight: 1,
          }}
        >
          R{step.round}
        </span>
      </div>
    </div>
  );
}

// ── Running ghost chip ────────────────────────────────

function RunningChip() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
      <div style={{ width: 6, height: 1, background: 'rgba(96,165,250,0.2)', flexShrink: 0 }} />
      <div
        style={{
          display:        'flex',
          flexDirection:  'column',
          alignItems:     'center',
          gap:            2,
          padding:        '4px 6px',
          borderRadius:   5,
          background:     'rgba(96,165,250,0.08)',
          border:         '1px solid rgba(96,165,250,0.25)',
          flexShrink:     0,
          minWidth:       36,
          animation:      'pulse 1.4s ease-in-out infinite',
        }}
      >
        <Loader2 size={10} style={{ color: '#60a5fa', animation: 'spin 1s linear infinite' }} />
        <span style={{ fontSize: 9, fontFamily: 'ui-monospace, monospace', color: '#60a5fa', lineHeight: 1 }}>
          …
        </span>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────

interface FedRecoveryStepGraphProps {
  run: FedRecoveryRun;
}

export default function FedRecoveryStepGraph({ run }: FedRecoveryStepGraphProps) {
  const { steps, roundsCorrected, roundsSkipped, status } = run;
  const total   = roundsCorrected + roundsSkipped;
  const pctDone = total > 0 ? (roundsCorrected / total) * 100 : 0;
  const isRunning = status === 'running';

  if (steps.length === 0 && !isRunning) {
    return (
      <p style={{ fontSize: 11, color: 'var(--n8n-text-muted)', fontStyle: 'italic', margin: 0 }}>
        No steps recorded yet.
      </p>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* ── Chip chain ── */}
      <div
        style={{
          display:    'flex',
          alignItems: 'center',
          overflowX:  'auto',
          paddingBottom: 4,
          gap:        0,
        }}
      >
        {steps.map((step, i) => (
          <StepChip
            key={`${step.round}-${i}`}
            step={step}
            isLast={i === 0}
          />
        ))}
        {isRunning && <RunningChip />}
      </div>

      {/* ── Progress bar + counters ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {/* Bar */}
        <div
          style={{
            height:       4,
            borderRadius: 2,
            background:   'rgba(255,255,255,0.06)',
            overflow:     'hidden',
          }}
        >
          <div
            style={{
              height:     '100%',
              width:      `${pctDone}%`,
              background: 'var(--n8n-success)',
              borderRadius: 2,
              transition: 'width 0.3s ease',
            }}
          />
        </div>

        {/* Counters */}
        <div
          style={{
            display:    'flex',
            alignItems: 'center',
            gap:        12,
            fontSize:   10,
            fontFamily: 'ui-monospace, monospace',
            color:      'var(--n8n-text-muted)',
          }}
        >
          <span style={{ color: 'var(--n8n-success)' }}>
            ✓ {roundsCorrected} corrected
          </span>
          <span>
            ↷ {roundsSkipped} skipped
          </span>
          {total > 0 && (
            <span style={{ marginLeft: 'auto' }}>
              {pctDone.toFixed(0)}% success rate
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
