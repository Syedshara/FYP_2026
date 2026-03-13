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
    <div className="flex flex-col gap-4">
      {/* Security Features */}
      <div className="fl-panel-section">
        <div className="fl-section-header">
          <Shield size={13} style={{ color: 'var(--n8n-text-muted)', flexShrink: 0 }} />
          <span className="fl-section-header-title">Security</span>
        </div>

        <div className="flex flex-col gap-2">
          {SECURITY_ITEMS.map((item) => {
            const active = securityFeatures?.[item.key] ?? false;
            return (
              <div key={item.key} className="fl-security-item" title={item.description}>
                {active ? (
                  <ShieldCheck size={14} style={{ color: 'var(--n8n-success)', flexShrink: 0 }} />
                ) : (
                  <ShieldAlert size={14} style={{ color: 'var(--n8n-text-muted)', flexShrink: 0 }} />
                )}
                <span
                  className="flex-1 min-w-0 text-xs font-medium truncate"
                  style={{ color: active ? 'var(--n8n-text-primary)' : 'var(--n8n-text-muted)' }}
                >
                  {item.label}
                </span>
                <span className={`fl-status-badge ${active ? 'fl-status-badge--on' : 'fl-status-badge--off'}`}>
                  {active ? 'ON' : 'OFF'}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Trust Scores */}
      <div className="fl-panel-section">
        <div className="fl-section-header">
          <ShieldCheck size={13} style={{ color: 'var(--n8n-text-muted)', flexShrink: 0 }} />
          <span className="fl-section-header-title">Trust Scores</span>
        </div>

        <div className="flex flex-col gap-2">
          {Object.entries(trustScores).length === 0 ? (
            <div className="fl-empty-state">
              <ShieldCheck size={20} className="fl-empty-state-icon" />
              <p className="fl-empty-state-text">No trust data yet</p>
            </div>
          ) : (
            Object.entries(trustScores).map(([clientId, score]) => (
              <TrustScoreBar key={clientId} clientId={clientId} score={score} />
            ))
          )}
        </div>
      </div>

      {/* Flagged Events */}
      {flaggedEvents.length > 0 && (
        <div className="fl-panel-section">
          <div className="fl-section-header">
            <AlertTriangle size={13} style={{ color: 'var(--n8n-danger)', flexShrink: 0 }} />
            <span className="fl-section-header-title" style={{ color: 'var(--n8n-danger)' }}>
              Flagged ({flaggedEvents.length})
            </span>
          </div>

          <div className="flex flex-col gap-1.5 overflow-y-auto" style={{ maxHeight: 150 }}>
            {flaggedEvents.slice(0, 10).map((evt, i) => (
              <div
                key={i}
                className="flex items-center justify-between px-3 py-1.5 rounded-md"
                style={{
                  fontSize: 11,
                  background: 'rgba(208, 48, 80, 0.08)',
                  border: '1px solid rgba(208, 48, 80, 0.2)',
                }}
              >
                <span style={{ color: 'var(--n8n-text-primary)' }}>{evt.clientId}</span>
                <span style={{ color: 'var(--n8n-text-muted)' }}>R{evt.round}</span>
                <span className="font-mono" style={{ color: 'var(--n8n-danger)', fontWeight: 700 }}>
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
    <div className="fl-trust-bar">
      <div className="flex items-center justify-between">
        <span className="text-xs truncate" style={{ color: 'var(--n8n-text-primary)' }}>{clientId}</span>
        <span className="text-xs font-mono font-semibold" style={{ color }}>{score.toFixed(2)}</span>
      </div>
      <div className="fl-trust-bar-track">
        <div
          className="fl-trust-bar-fill"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
    </div>
  );
}
