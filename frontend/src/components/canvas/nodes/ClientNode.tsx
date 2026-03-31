/**
 * ClientNode — Organization entity (bank, hospital, factory).
 * Shape: default (150x80 rounded rectangle)
 * Accent: #5b9bf5 (blue)
 *
 * When FL training is active, shows a compact progress indicator
 * (progress bar, epoch/status text) injected by LiveDataSync via _flProgress.
 *
 * When poison mode is active, shows a red "Compromised" badge.
 * When RECESS flags the client, shows "Flagged" or "Downweighted" badge.
 */

import { memo, useCallback, useState } from 'react';
import { ShieldAlert, ShieldOff } from 'lucide-react';
import type { NodeProps } from 'reactflow';
import { BaseCanvasNode } from './BaseCanvasNode';
import { flApi } from '@/api/fl';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import type { ClientNodeData } from '@/types/canvas';

/** Compact status label for FL training phase */
function phaseLabel(status: string): string {
  switch (status) {
    case 'training':
      return 'Training';
    case 'encrypting':
      return 'Encrypting';
    case 'sending':
      return 'Sending';
    case 'waiting':
      return 'Waiting';
    case 'done':
      return 'Done';
    default:
      return status;
  }
}

function ClientNode(props: NodeProps<ClientNodeData>) {
  const { data } = props;
  const fp = data._flProgress;
  const isPoisoned = data._poisonStrategy != null;
  const isTraining = fp != null;
  const updateNodeData = useWorkspaceStore((s) => s.updateNodeData);
  const [loading, setLoading] = useState(false);

  const handleTogglePoison = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!data.clientId) return;
    setLoading(true);
    try {
      const newStrategy = isPoisoned ? 'none' : 'direction_flip';
      const res = await flApi.togglePoison(data.clientId, newStrategy as 'direction_flip' | 'none');
      updateNodeData(props.id, {
        _poisonStrategy: res.active ? (res.strategy as ClientNodeData['_poisonStrategy']) : null,
      } as Partial<ClientNodeData>);
    } catch (err) {
      console.error('[ClientNode] Poison toggle failed:', err);
    } finally {
      setLoading(false);
    }
  }, [data.clientId, isPoisoned, props.id, updateNodeData]);

  return (
    <BaseCanvasNode {...props}>
      {/* Industry badge (when not training) */}
      {!fp && data.industry && data.industry !== 'general' && (
        <span
          className="canvas-node-chip"
          style={{
            color: '#5b9bf5',
            background: 'rgba(91, 155, 245, 0.12)',
            borderColor: 'rgba(91, 155, 245, 0.24)',
          }}
        >
          {data.industry}
        </span>
      )}

      {/* FL training progress (injected by LiveDataSync) */}
      {fp && (
        <div className="w-full flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="canvas-node-kpi font-semibold" style={{ color: '#5b9bf5' }}>
              {phaseLabel(fp.status)}
            </span>
            <span className="canvas-node-kpi" style={{ color: 'var(--n8n-text-muted)' }}>
              E{fp.epoch}/{fp.totalEpochs}
            </span>
          </div>

          <div className="canvas-node-progress">
            <div
              className="canvas-node-progress-fill"
              style={{
                width: `${Math.min(fp.progressPct, 100)}%`,
                background:
                  fp.status === 'done'
                    ? '#18a058'
                    : fp.status === 'training'
                    ? '#5b9bf5'
                    : '#f0a020',
              }}
            />
          </div>
        </div>
      )}

      {/* RECESS trust score badge (injected by LiveDataSync) */}
      {data._recessStatus && (
        <span
          className="canvas-node-chip"
          style={{
            color: data._recessStatus === 'flagged' ? '#d03050' : '#f0a020',
            background: data._recessStatus === 'flagged'
              ? 'rgba(208, 48, 80, 0.12)'
              : 'rgba(240, 160, 32, 0.10)',
            borderColor: data._recessStatus === 'flagged'
              ? 'rgba(208, 48, 80, 0.25)'
              : 'rgba(240, 160, 32, 0.20)',
            fontSize: 9,
          }}
        >
          {data._recessStatus === 'flagged' ? '⚠ Flagged' : '↓ Downwt'}
        </span>
      )}

      {/* Poison mode badge + toggle (only during training, requires clientId) */}
      {isTraining && data.clientId && (
        <button
          className="canvas-node-chip"
          onClick={handleTogglePoison}
          disabled={loading}
          title={isPoisoned ? 'Click to deactivate poison' : 'Click to compromise this client'}
          aria-label={isPoisoned ? 'Deactivate poison mode' : 'Activate poison mode'}
          style={{
            color: isPoisoned ? '#d03050' : 'var(--n8n-text-muted)',
            background: isPoisoned ? 'rgba(208, 48, 80, 0.12)' : 'transparent',
            borderColor: isPoisoned ? 'rgba(208, 48, 80, 0.25)' : 'var(--n8n-border)',
            fontSize: 9,
            cursor: loading ? 'wait' : 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '3px',
            opacity: loading ? 0.6 : 1,
          }}
        >
          {isPoisoned ? <ShieldAlert size={10} /> : <ShieldOff size={10} />}
          {isPoisoned ? 'Compromised' : 'Compromise'}
        </button>
      )}
    </BaseCanvasNode>
  );
}

export default memo(ClientNode);
