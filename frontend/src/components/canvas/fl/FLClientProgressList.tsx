/**
 * FLClientProgressList — Per-client training progress cards.
 *
 * Reads live per-client progress from liveStore.
 * Shows: client name, status badge, progress bar, epoch/batch info.
 */

import { Users } from 'lucide-react';
import { useLiveStore } from '@/stores/liveStore';
import type { FLClient } from '@/types';

interface Props {
  clients: FLClient[];
}

const STATUS_COLORS: Record<string, string> = {
  training: 'var(--n8n-accent)',
  encrypting: '#a78bfa',
  sending: '#38bdf8',
  idle: 'var(--n8n-text-muted)',
  done: 'var(--n8n-success)',
  waiting: 'var(--n8n-warning)',
  sending_weights: '#38bdf8',
  aggregating: '#f0a020',
};

const STATUS_BG: Record<string, string> = {
  training: 'rgba(255, 109, 90, 0.12)',
  encrypting: 'rgba(167, 139, 250, 0.12)',
  sending: 'rgba(56, 189, 248, 0.12)',
  idle: 'rgba(136, 136, 136, 0.1)',
  done: 'rgba(24, 160, 88, 0.12)',
  waiting: 'rgba(240, 160, 32, 0.12)',
  sending_weights: 'rgba(56, 189, 248, 0.12)',
  aggregating: 'rgba(240, 160, 32, 0.12)',
};

const STATUS_BORDER: Record<string, string> = {
  training: 'rgba(255, 109, 90, 0.26)',
  encrypting: 'rgba(167, 139, 250, 0.24)',
  sending: 'rgba(56, 189, 248, 0.24)',
  idle: 'rgba(136, 136, 136, 0.18)',
  done: 'rgba(24, 160, 88, 0.24)',
  waiting: 'rgba(240, 160, 32, 0.24)',
  sending_weights: 'rgba(56, 189, 248, 0.24)',
  aggregating: 'rgba(240, 160, 32, 0.24)',
};

export default function FLClientProgressList({ clients }: Props) {
  const progressMap = useLiveStore((s) => s.flClientProgress);

  return (
    <div className="fl-panel-section">
      {/* Section header */}
      <div className="fl-section-header">
        <Users size={13} style={{ color: 'var(--n8n-text-muted)', flexShrink: 0 }} />
        <span className="fl-section-header-title">Clients ({clients.length})</span>
      </div>

      {/* Client cards */}
      <div className="flex flex-col gap-2 overflow-y-auto" style={{ maxHeight: 320 }}>
        {clients.length === 0 ? (
          <div className="fl-empty-state">
            <Users size={22} className="fl-empty-state-icon" />
            <p className="fl-empty-state-text">No FL clients registered</p>
          </div>
        ) : (
          clients.map((client) => {
            const progress = progressMap[client.client_id];
            return (
              <ClientCard key={client.id} client={client} progress={progress} />
            );
          })
        )}
      </div>
    </div>
  );
}

// ── Individual client card ──

function ClientCard({
  client,
  progress,
}: {
  client: FLClient;
  progress?: {
    status: string;
    current_epoch?: number;
    total_epochs?: number;
    progress_pct?: number;
    local_loss?: number;
    local_accuracy?: number;
    num_samples?: number;
    throughput?: number;
    eta_seconds?: number;
  };
}) {
  const status = progress?.status ?? client.status ?? 'idle';
  const statusColor = STATUS_COLORS[status] ?? 'var(--n8n-text-muted)';
  const statusBg = STATUS_BG[status] ?? 'rgba(136,136,136,0.1)';
  const statusBorder = STATUS_BORDER[status] ?? 'rgba(136,136,136,0.18)';
  const pct = progress?.progress_pct ?? 0;

  return (
    <div className="fl-client-card">
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold truncate" style={{ color: 'var(--n8n-text-primary)' }}>
          {client.name}
        </span>
        <span
          className="fl-status-badge"
          style={{
            color: statusColor,
            background: statusBg,
            borderColor: statusBorder,
          }}
        >
          {status}
        </span>
      </div>

      {/* Progress bar */}
      {status !== 'idle' && (
        <div className="fl-trust-bar-track">
          <div
            className="fl-trust-bar-fill transition-all duration-300"
            style={{
              width: `${Math.min(pct, 100)}%`,
              background: statusColor,
            }}
          />
        </div>
      )}

      {/* Metrics row */}
      {progress && status !== 'idle' && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5" style={{ fontSize: 10, color: 'var(--n8n-text-muted)' }}>
          {progress.current_epoch != null && progress.total_epochs != null && (
            <span>Epoch {progress.current_epoch}/{progress.total_epochs}</span>
          )}
          {progress.local_accuracy != null && (
            <span>Acc: <span style={{ color: 'var(--n8n-success)' }}>{(progress.local_accuracy * 100).toFixed(1)}%</span></span>
          )}
          {progress.local_loss != null && (
            <span>Loss: <span style={{ color: statusColor }}>{progress.local_loss.toFixed(3)}</span></span>
          )}
          {progress.eta_seconds != null && progress.eta_seconds > 0 && (
            <span>ETA: {Math.ceil(progress.eta_seconds)}s</span>
          )}
        </div>
      )}

      {/* Static info (when idle) */}
      {status === 'idle' && (
        <div className="flex gap-3" style={{ fontSize: 10, color: 'var(--n8n-text-muted)' }}>
          <span>{client.total_samples ?? 0} samples</span>
          <span>{client.ip_address ?? 'no IP'}</span>
        </div>
      )}
    </div>
  );
}
