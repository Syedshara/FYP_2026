/**
 * FLTrainingControls — Training configuration form + start/stop buttons.
 *
 * Shows in the left panel of the FL drill-down view.
 * Reads live global progress from liveStore; sends start/stop via flApi.
 */

import { useState } from 'react';
import { Play, Square, Loader2, Settings } from 'lucide-react';
import { flApi, type FLStartConfig } from '@/api/fl';
import { useLiveStore } from '@/stores/liveStore';

export default function FLTrainingControls() {
  const flGlobal = useLiveStore((s) => s.flGlobalProgress);
  const isTraining = flGlobal?.is_training ?? false;

  // Config state
  const [numRounds, setNumRounds] = useState(5);
  const [localEpochs, setLocalEpochs] = useState(3);
  const [learningRate, setLearningRate] = useState(0.001);
  const [minClients, setMinClients] = useState(2);
  const [useHE, setUseHE] = useState(true);

  // Action state
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleStart = async () => {
    setError(null);
    setIsStarting(true);
    try {
      const config: FLStartConfig = {
        num_rounds: numRounds,
        min_clients: minClients,
        use_he: useHE,
        local_epochs: localEpochs,
        learning_rate: learningRate,
      };
      await flApi.start(config);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start training');
    } finally {
      setIsStarting(false);
    }
  };

  const handleStop = async () => {
    setError(null);
    setIsStopping(true);
    try {
      await flApi.stop();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop training');
    } finally {
      setIsStopping(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Section header */}
      <div className="flex items-center gap-2">
        <Settings size={14} style={{ color: 'var(--n8n-text-muted)' }} />
        <span
          className="text-xs font-semibold uppercase tracking-wider"
          style={{ color: 'var(--n8n-text-muted)' }}
        >
          Training Config
        </span>
      </div>

      {/* Config fields */}
      <div className="flex flex-col gap-3">
        <ConfigField label="Rounds" value={numRounds} onChange={setNumRounds} min={1} max={100} disabled={isTraining} />
        <ConfigField label="Local Epochs" value={localEpochs} onChange={setLocalEpochs} min={1} max={20} disabled={isTraining} />
        <ConfigField label="Learning Rate" value={learningRate} onChange={setLearningRate} min={0.0001} max={1} step={0.0001} disabled={isTraining} />
        <ConfigField label="Min Clients" value={minClients} onChange={setMinClients} min={1} max={20} disabled={isTraining} />

        {/* HE toggle */}
        <div className="flex items-center justify-between">
          <span className="text-xs" style={{ color: 'var(--n8n-text-muted)' }}>
            Homomorphic Encryption
          </span>
          <button
            type="button"
            disabled={isTraining}
            onClick={() => setUseHE(!useHE)}
            className="relative w-9 h-5 rounded-full transition-colors"
            style={{
              background: useHE ? 'var(--n8n-accent)' : 'var(--n8n-card-border)',
              opacity: isTraining ? 0.5 : 1,
              cursor: isTraining ? 'not-allowed' : 'pointer',
            }}
          >
            <div
              className="absolute top-0.5 w-4 h-4 rounded-full transition-transform"
              style={{
                background: '#fff',
                left: useHE ? '18px' : '2px',
              }}
            />
          </button>
        </div>
      </div>

      {/* Error message */}
      {error && (
        <div
          className="text-xs px-3 py-2 rounded-md"
          style={{
            background: 'rgba(208, 48, 80, 0.1)',
            color: 'var(--n8n-danger)',
            border: '1px solid rgba(208, 48, 80, 0.3)',
          }}
        >
          {error}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex flex-col gap-2 pt-1">
        {!isTraining ? (
          <button
            type="button"
            onClick={handleStart}
            disabled={isStarting}
            className="flex items-center justify-center gap-2 w-full py-2 rounded-lg text-xs font-medium transition-colors"
            style={{
              background: 'var(--n8n-success)',
              color: '#fff',
              opacity: isStarting ? 0.7 : 1,
              cursor: isStarting ? 'not-allowed' : 'pointer',
            }}
          >
            {isStarting ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            {isStarting ? 'Starting...' : 'Start Training'}
          </button>
        ) : (
          <button
            type="button"
            onClick={handleStop}
            disabled={isStopping}
            className="flex items-center justify-center gap-2 w-full py-2 rounded-lg text-xs font-medium transition-colors"
            style={{
              background: 'var(--n8n-danger)',
              color: '#fff',
              opacity: isStopping ? 0.7 : 1,
              cursor: isStopping ? 'not-allowed' : 'pointer',
            }}
          >
            {isStopping ? <Loader2 size={14} className="animate-spin" /> : <Square size={14} />}
            {isStopping ? 'Stopping...' : 'Stop Training'}
          </button>
        )}
      </div>

      {/* Live progress summary */}
      {isTraining && flGlobal && (
        <div
          className="flex flex-col gap-1 px-3 py-2 rounded-lg text-xs"
          style={{
            background: 'rgba(255, 109, 90, 0.08)',
            border: '1px solid rgba(255, 109, 90, 0.2)',
          }}
        >
          <div className="flex justify-between" style={{ color: 'var(--n8n-text-primary)' }}>
            <span>Round</span>
            <span className="font-mono">
              {flGlobal.current_round}/{flGlobal.total_rounds}
            </span>
          </div>
          {flGlobal.global_accuracy != null && (
            <div className="flex justify-between" style={{ color: 'var(--n8n-text-primary)' }}>
              <span>Accuracy</span>
              <span className="font-mono">{(flGlobal.global_accuracy * 100).toFixed(1)}%</span>
            </div>
          )}
          {flGlobal.global_loss != null && (
            <div className="flex justify-between" style={{ color: 'var(--n8n-text-primary)' }}>
              <span>Loss</span>
              <span className="font-mono">{flGlobal.global_loss.toFixed(4)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Config Field ──

function ConfigField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs" style={{ color: 'var(--n8n-text-muted)' }}>
        {label}
      </span>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        className="w-20 px-2 py-1 text-xs text-right rounded-md outline-none"
        style={{
          background: 'var(--n8n-canvas-bg)',
          border: '1px solid var(--n8n-card-border)',
          color: 'var(--n8n-text-primary)',
          fontFamily: 'var(--n8n-font)',
          opacity: disabled ? 0.5 : 1,
          cursor: disabled ? 'not-allowed' : 'text',
        }}
      />
    </div>
  );
}
