/**
 * FLSecurityPanel — Security feature indicators + trust scores + flagged events.
 *
 * Shows the 5 production security features with active/inactive indicators,
 * live trust scores from WebSocket, and recent flagged client events.
 */

import { Shield, ShieldCheck, ShieldAlert, AlertTriangle } from 'lucide-react';
import { useTrustScores, useFlaggedEvents } from '@/stores/liveStore';
import type { FLServerNodeData } from '@/types/canvas';

interface Props {
  securityFeatures?: FLServerNodeData['securityFeatures'];
}

const SECURITY_ITEMS: Array<{
  key: keyof NonNullable<FLServerNodeData['securityFeatures']>;
  label: string;
  description: string;
}> = [
  { key: 'vss', label: 'VSS', description: 'Verifiable Secret Sharing' },
  { key: 'mtls', label: 'mTLS', description: 'Mutual TLS Authentication' },
  { key: 'gradientSigning', label: 'Grad Sign', description: 'Ed25519 Gradient Signing' },
  { key: 'roundNonces', label: 'Nonces', description: 'Round Replay Protection' },
  { key: 'recess', label: 'RECESS', description: 'Anomaly Detection & Trust' },
];

export default function FLSecurityPanel({ securityFeatures }: Props) {
  const trustScores = useTrustScores();
  const flaggedEvents = useFlaggedEvents();

  return (
    <div className="flex flex-col gap-5">
      {/* Security Features */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Shield size={14} style={{ color: 'var(--n8n-text-muted)' }} />
          <span
            className="text-xs font-semibold uppercase tracking-wider"
            style={{ color: 'var(--n8n-text-muted)' }}
          >
            Security
          </span>
        </div>

        <div className="flex flex-col gap-1.5">
          {SECURITY_ITEMS.map((item) => {
            const active = securityFeatures?.[item.key] ?? false;
            return (
              <div
                key={item.key}
                className="flex items-center gap-2.5 px-3 py-2 rounded-lg"
                style={{
                  background: 'var(--n8n-canvas-bg)',
                  border: '1px solid var(--n8n-card-border)',
                }}
              >
                {active ? (
                  <ShieldCheck size={14} style={{ color: 'var(--n8n-success)' }} />
                ) : (
                  <ShieldAlert size={14} style={{ color: 'var(--n8n-text-muted)' }} />
                )}
                <div className="flex-1 min-w-0">
                  <span
                    className="text-xs font-medium"
                    style={{ color: active ? 'var(--n8n-text-primary)' : 'var(--n8n-text-muted)' }}
                  >
                    {item.label}
                  </span>
                </div>
                <span
                  className="text-[10px] uppercase font-semibold"
                  style={{ color: active ? 'var(--n8n-success)' : 'var(--n8n-text-muted)' }}
                >
                  {active ? 'ON' : 'OFF'}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Trust Scores */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck size={14} style={{ color: 'var(--n8n-text-muted)' }} />
          <span
            className="text-xs font-semibold uppercase tracking-wider"
            style={{ color: 'var(--n8n-text-muted)' }}
          >
            Trust Scores
          </span>
        </div>

        <div className="flex flex-col gap-1.5">
          {Object.entries(trustScores).length === 0 ? (
            <p className="text-xs text-center py-2" style={{ color: 'var(--n8n-text-muted)' }}>
              No trust data yet
            </p>
          ) : (
            Object.entries(trustScores).map(([clientId, score]) => (
              <TrustScoreBar key={clientId} clientId={clientId} score={score} />
            ))
          )}
        </div>
      </div>

      {/* Flagged Events */}
      {flaggedEvents.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} style={{ color: 'var(--n8n-danger)' }} />
            <span
              className="text-xs font-semibold uppercase tracking-wider"
              style={{ color: 'var(--n8n-danger)' }}
            >
              Flagged ({flaggedEvents.length})
            </span>
          </div>

          <div className="flex flex-col gap-1.5 max-h-[150px] overflow-y-auto pr-1">
            {flaggedEvents.slice(0, 10).map((evt, i) => (
              <div
                key={i}
                className="flex items-center justify-between px-3 py-1.5 rounded-md text-[10px]"
                style={{
                  background: 'rgba(208, 48, 80, 0.08)',
                  border: '1px solid rgba(208, 48, 80, 0.2)',
                }}
              >
                <span style={{ color: 'var(--n8n-text-primary)' }}>{evt.clientId}</span>
                <span style={{ color: 'var(--n8n-text-muted)' }}>R{evt.round}</span>
                <span className="font-mono" style={{ color: 'var(--n8n-danger)' }}>
                  {evt.abnormality.toFixed(3)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Trust Score Bar ──

function TrustScoreBar({ clientId, score }: { clientId: string; score: number }) {
  const pct = Math.min(score * 100, 100);
  const color = score >= 0.8 ? 'var(--n8n-success)' : score >= 0.5 ? 'var(--n8n-warning)' : 'var(--n8n-danger)';

  return (
    <div
      className="flex flex-col gap-1 px-3 py-1.5 rounded-md"
      style={{
        background: 'var(--n8n-canvas-bg)',
        border: '1px solid var(--n8n-card-border)',
      }}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs" style={{ color: 'var(--n8n-text-primary)' }}>
          {clientId}
        </span>
        <span className="text-xs font-mono" style={{ color }}>
          {score.toFixed(2)}
        </span>
      </div>
      <div className="w-full h-1 rounded-full overflow-hidden" style={{ background: 'var(--n8n-card-border)' }}>
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
    </div>
  );
}
