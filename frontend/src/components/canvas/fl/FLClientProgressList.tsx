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

export default function FLClientProgressList({ clients }: Props) {
  const progressMap = useLiveStore((s) => s.flClientProgress);

  return (
    <div className="flex flex-col gap-3">
      {/* Section header */}
      <div className="flex items-center gap-2">
        <Users size={14} style={{ color: 'var(--n8n-text-muted)' }} />
        <span
          className="text-xs font-semibold uppercase tracking-wider"
          style={{ color: 'var(--n8n-text-muted)' }}
        >
          Clients ({clients.length})
        </span>
      </div>

      {/* Client cards */}
      <div className="flex flex-col gap-2 overflow-y-auto max-h-[300px] pr-1">
        {clients.length === 0 ? (
          <p className="text-xs text-center py-4" style={{ color: 'var(--n8n-text-muted)' }}>
            No FL clients registered
          </p>
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
  const pct = progress?.progress_pct ?? 0;

  return (
    <div
      className="flex flex-col gap-1.5 px-3 py-2.5 rounded-lg"
      style={{
        background: 'var(--n8n-canvas-bg)',
        border: '1px solid var(--n8n-card-border)',
      }}
    >
      {/* Header row */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium truncate" style={{ color: 'var(--n8n-text-primary)' }}>
          {client.name}
        </span>
        <span
          className="text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded"
          style={{
            color: statusColor,
            background: `color-mix(in srgb, ${statusColor} 12%, transparent)`,
          }}
        >
          {status}
        </span>
      </div>

      {/* Progress bar */}
      {status !== 'idle' && (
        <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--n8n-card-border)' }}>
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{
              width: `${Math.min(pct, 100)}%`,
              background: statusColor,
            }}
          />
        </div>
      )}

      {/* Metrics row */}
      {progress && status !== 'idle' && (
        <div className="flex gap-3 text-[10px]" style={{ color: 'var(--n8n-text-muted)' }}>
          {progress.current_epoch != null && progress.total_epochs != null && (
            <span>
              Epoch {progress.current_epoch}/{progress.total_epochs}
            </span>
          )}
          {progress.local_accuracy != null && (
            <span>Acc: {(progress.local_accuracy * 100).toFixed(1)}%</span>
          )}
          {progress.local_loss != null && (
            <span>Loss: {progress.local_loss.toFixed(3)}</span>
          )}
          {progress.eta_seconds != null && progress.eta_seconds > 0 && (
            <span>ETA: {Math.ceil(progress.eta_seconds)}s</span>
          )}
        </div>
      )}

      {/* Static info (when idle) */}
      {status === 'idle' && (
        <div className="flex gap-3 text-[10px]" style={{ color: 'var(--n8n-text-muted)' }}>
          <span>{client.total_samples ?? 0} samples</span>
          <span>{client.ip_address ?? 'no IP'}</span>
        </div>
      )}
    </div>
  );
}
