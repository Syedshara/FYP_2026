/**
 * ClientNode — Organization entity (bank, hospital, factory).
 * Shape: default (150x80 rounded rectangle)
 * Accent: #5b9bf5 (blue)
 *
 * When FL training is active, shows a compact progress indicator
 * (progress bar, epoch/status text) injected by LiveDataSync via _flProgress.
 */

import { memo } from 'react';
import type { NodeProps } from 'reactflow';
import { BaseCanvasNode } from './BaseCanvasNode';
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

  return (
    <BaseCanvasNode {...props}>
      {/* Industry badge (when not training) */}
      {!fp && data.industry && data.industry !== 'general' && (
        <span className="text-[10px]" style={{ color: '#5b9bf5' }}>
          {data.industry}
        </span>
      )}

      {/* FL training progress (injected by LiveDataSync) */}
      {fp && (
        <div className="w-full flex flex-col gap-0.5 px-1">
          {/* Phase + epoch */}
          <div className="flex items-center justify-between">
            <span className="text-[9px] font-semibold" style={{ color: '#5b9bf5' }}>
              {phaseLabel(fp.status)}
            </span>
            <span className="text-[9px]" style={{ color: 'var(--n8n-text-muted)' }}>
              E{fp.epoch}/{fp.totalEpochs}
            </span>
          </div>
          {/* Progress bar */}
          <div
            className="w-full h-[3px] rounded-full overflow-hidden"
            style={{ background: 'var(--n8n-card-border)' }}
          >
            <div
              className="h-full rounded-full transition-all duration-300"
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
    </BaseCanvasNode>
  );
}

export default memo(ClientNode);
