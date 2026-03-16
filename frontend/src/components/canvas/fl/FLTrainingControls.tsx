/**
 * FLTrainingControls — Training configuration form + start/stop buttons.
 *
 * Shows in the left panel of the FL drill-down view.
 * Reads live global progress from liveStore; sends start/stop via flApi.
 * Validates canvas topology before allowing training start.
 */

import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Play, Square, Loader2, Lock, AlertTriangle, CheckCircle2, RotateCcw } from 'lucide-react';
import { flApi, type FLStartConfig } from '@/api/fl';
import { useLiveStore } from '@/stores/liveStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { validateFLTopology } from '@/utils/topologyValidator';

export default function FLTrainingControls() {
  const flGlobal = useLiveStore((s) => s.flGlobalProgress);
  const isTraining = flGlobal?.is_training ?? false;

  const drilldownServerId = useWorkspaceStore((s) => s.drilldownServerId);
  const setActiveFlServerNodeId = useWorkspaceStore((s) => s.setActiveFlServerNodeId);
  const updateNodeData = useWorkspaceStore((s) => s.updateNodeData);
  const nodes = useWorkspaceStore((s) => s.nodes);
  const edges = useWorkspaceStore((s) => s.edges);
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);

  // Validate topology on every render (cheap, synchronous)
  const topologyResult = useMemo(() => {
    if (!drilldownServerId) {
      return {
        valid: false,
        errors: ['No FL Server selected.'],
        connectedClientNodeIds: [],
        incompleteClientNodeIds: [],
        deviceNodeIds: [],
        trafficSourceNodeIds: [],
      };
    }
    return validateFLTopology(drilldownServerId, nodes, edges);
  }, [drilldownServerId, nodes, edges]);

  // Config state — auto-set min_clients from connected topology
  const [numRounds, setNumRounds] = useState(5);
  const [localEpochs, setLocalEpochs] = useState(5);
  const [learningRate, setLearningRate] = useState(0.001);
  const [maxBatches, setMaxBatches] = useState(0);  // 0 = no cap (use all data)
  const [useHE, setUseHE] = useState(false); // Default off — HE is computationally heavy

  const autoMinClients = topologyResult.connectedClientNodeIds.length;

  // Action state
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Desync detection: optimistic state set but WS never confirmed training started
  const activeFlServerNodeId = useWorkspaceStore((s) => s.activeFlServerNodeId);
  const isDesyncStuck = activeFlServerNodeId != null && !isTraining;

  // ── Shared reset logic (used by manual Reset button + auto-timeout) ──
  const handleReset = useCallback(async () => {
    // Best-effort cleanup on backend (ignore errors — may already be stopped)
    try { await flApi.stop(); } catch { /* noop */ }
    setActiveFlServerNodeId(null);
    setError(null);
    // Revert all topology nodes back to idle
    if (drilldownServerId) {
      updateNodeData(drilldownServerId, { status: 'idle', currentRound: 0 });
    }
    for (const id of topologyResult.connectedClientNodeIds) {
      updateNodeData(id, { status: 'idle' });
    }
    for (const id of topologyResult.deviceNodeIds) {
      updateNodeData(id, { status: 'idle' });
    }
    for (const id of topologyResult.trafficSourceNodeIds) {
      updateNodeData(id, { status: 'idle' });
    }
  }, [drilldownServerId, setActiveFlServerNodeId, updateNodeData, topologyResult]);

  // ── Fix 2: Auto-recovery timeout (30s) ──
  // If activeFlServerNodeId was set (optimistic) but isTraining never becomes true,
  // auto-reset after 30s so the user isn't stuck permanently.
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isDesyncStuck) {
      timeoutRef.current = setTimeout(() => {
        console.warn('[FLTrainingControls] Training never confirmed by WS — auto-recovering');
        setError('Training failed to start — auto-recovered after 30s');
        handleReset();
      }, 30_000);
    } else {
      // Training confirmed or no active server — clear any pending timeout
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    }
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [isDesyncStuck, handleReset]);

  const handleStart = async () => {
    if (!topologyResult.valid) {
      setError('Fix topology errors before starting training.');
      return;
    }
    setError(null);
    setIsStarting(true);
    try {
      const config: FLStartConfig = {
        num_rounds: numRounds,
        min_clients: autoMinClients > 0 ? autoMinClients : 1,
        use_he: useHE,
        local_epochs: localEpochs,
        learning_rate: learningRate,
        max_batches: maxBatches,
        workspace_id: workspaceId ?? undefined,
        canvas_node_ids: topologyResult.connectedClientNodeIds,
      };
      await flApi.start(config);
      // Immediately cascade "running" to ALL topology nodes
      if (drilldownServerId) {
        setActiveFlServerNodeId(drilldownServerId);
        updateNodeData(drilldownServerId, {
          status: 'running',
          currentRound: 0,
          totalRounds: numRounds,
        });
      }
      for (const id of topologyResult.connectedClientNodeIds) {
        updateNodeData(id, { status: 'running' });
      }
      for (const id of topologyResult.deviceNodeIds) {
        updateNodeData(id, { status: 'running' });
      }
      for (const id of topologyResult.trafficSourceNodeIds) {
        updateNodeData(id, { status: 'running' });
      }
    } catch (err: unknown) {
      // Extract useful error detail from Axios responses
      const axiosDetail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(axiosDetail ?? (err instanceof Error ? err.message : 'Failed to start training'));
    } finally {
      setIsStarting(false);
    }
  };

  const handleStop = async () => {
    setError(null);
    setIsStopping(true);
    try {
      await flApi.stop();
      setActiveFlServerNodeId(null);
      // Reset all topology nodes back to idle
      if (drilldownServerId) {
        updateNodeData(drilldownServerId, { status: 'idle', currentRound: 0 });
      }
      for (const id of topologyResult.connectedClientNodeIds) {
        updateNodeData(id, { status: 'idle' });
      }
      for (const id of topologyResult.deviceNodeIds) {
        updateNodeData(id, { status: 'idle' });
      }
      for (const id of topologyResult.trafficSourceNodeIds) {
        updateNodeData(id, { status: 'idle' });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop training');
    } finally {
      setIsStopping(false);
    }
  };

  return (
    <div className="fl-panel-section">
      {/* Section header */}
      <div className="fl-section-header">
        <Lock size={13} style={{ color: 'var(--n8n-text-muted)', flexShrink: 0 }} />
        <span className="fl-section-header-title">Training Config</span>
      </div>

      {/* Topology validation status */}
      {!isTraining && (
        <div
          className="flex flex-col gap-1.5 px-3 py-2 rounded-lg text-xs"
          style={{
            background: topologyResult.valid
              ? 'rgba(28, 200, 138, 0.07)'
              : 'rgba(208, 48, 80, 0.07)',
            border: topologyResult.valid
              ? '1px solid rgba(28, 200, 138, 0.2)'
              : '1px solid rgba(208, 48, 80, 0.2)',
          }}
        >
          <div className="flex items-center gap-1.5">
            {topologyResult.valid ? (
              <>
                <CheckCircle2 size={12} style={{ color: 'var(--n8n-success)', flexShrink: 0 }} />
                <span style={{ color: 'var(--n8n-success)' }}>
                  Topology valid — {autoMinClients} client{autoMinClients !== 1 ? 's' : ''} ready
                </span>
              </>
            ) : (
              <>
                <AlertTriangle size={12} style={{ color: 'var(--n8n-danger)', flexShrink: 0 }} />
                <span style={{ color: 'var(--n8n-danger)', fontWeight: 600 }}>
                  Configuration incomplete
                </span>
              </>
            )}
          </div>
          {!topologyResult.valid &&
            topologyResult.errors.map((e, i) => (
              <div key={i} style={{ color: 'var(--n8n-text-muted)', paddingLeft: 18 }}>
                • {e}
              </div>
            ))}
        </div>
      )}

      {/* Config fields */}
      <div className="flex flex-col gap-2">
        <ConfigField label="Rounds" value={numRounds} onChange={setNumRounds} min={1} max={100} disabled={isTraining} />
        <ConfigField label="Local Epochs" value={localEpochs} onChange={setLocalEpochs} min={1} max={20} disabled={isTraining} />
        <ConfigField label="Learning Rate" value={learningRate} onChange={setLearningRate} min={0.0001} max={1} step={0.0001} disabled={isTraining} />
        <ConfigField
          label="Max Batches"
          value={maxBatches}
          onChange={setMaxBatches}
          min={0}
          max={10000}
          disabled={isTraining}
          hint="0 = no cap (all data)"
        />
        <ConfigField
          label="Min Clients"
          value={autoMinClients > 0 ? autoMinClients : 1}
          onChange={() => {}} // auto-controlled from topology
          min={1}
          max={20}
          disabled={true}
        />

        {/* HE toggle */}
        <div className="fl-toggle-row">
          <span className="fl-config-label">
            Homomorphic Encryption
            <span style={{ color: 'var(--n8n-text-muted)', fontSize: 10, marginLeft: 4 }}>
              (slow)
            </span>
          </span>
          <button
            type="button"
            disabled={isTraining}
            onClick={() => setUseHE(!useHE)}
            className="relative rounded-full transition-colors"
            style={{
              width: 36,
              height: 20,
              flexShrink: 0,
              background: useHE ? 'var(--n8n-accent)' : 'var(--n8n-card-border)',
              opacity: isTraining ? 0.5 : 1,
              cursor: isTraining ? 'not-allowed' : 'pointer',
              border: 'none',
              padding: 0,
            }}
            aria-pressed={useHE}
          >
            <div
              className="absolute top-0.5 rounded-full transition-all duration-200"
              style={{
                width: 16,
                height: 16,
                background: '#fff',
                boxShadow: '0 1px 3px rgba(0,0,0,0.35)',
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

      {/* Desync warning — optimistic state set but WS never confirmed training */}
      {isDesyncStuck && (
        <div
          className="flex flex-col gap-1.5 px-3 py-2 rounded-lg text-xs"
          style={{
            background: 'rgba(245, 158, 11, 0.08)',
            border: '1px solid rgba(245, 158, 11, 0.25)',
          }}
        >
          <div className="flex items-center gap-1.5">
            <AlertTriangle size={12} style={{ color: '#f59e0b', flexShrink: 0 }} />
            <span style={{ color: '#f59e0b', fontWeight: 600 }}>
              Training may have failed to start
            </span>
          </div>
          <div style={{ color: 'var(--n8n-text-muted)', paddingLeft: 18 }}>
            Waiting for confirmation... Auto-reset in 30s.
          </div>
          <button
            type="button"
            onClick={handleReset}
            className="flex items-center gap-1 self-start mt-1 px-2.5 py-1 rounded text-xs font-semibold"
            style={{
              color: '#f59e0b',
              background: 'rgba(245, 158, 11, 0.12)',
              border: '1px solid rgba(245, 158, 11, 0.3)',
              cursor: 'pointer',
              marginLeft: 18,
            }}
          >
            <RotateCcw size={11} />
            Reset Now
          </button>
        </div>
      )}

      {/* Action button */}
      {!isTraining ? (
        <button
          type="button"
          onClick={handleStart}
          disabled={isStarting || !topologyResult.valid}
          className="fl-action-btn fl-action-btn--start"
          title={!topologyResult.valid ? topologyResult.errors[0] : undefined}
        >
          {isStarting ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          {isStarting ? 'Starting…' : 'Start Training'}
        </button>
      ) : (
        <button
          type="button"
          onClick={handleStop}
          disabled={isStopping}
          className="fl-action-btn fl-action-btn--stop"
        >
          {isStopping ? <Loader2 size={14} className="animate-spin" /> : <Square size={14} />}
          {isStopping ? 'Stopping…' : 'Stop Training'}
        </button>
      )}

      {/* Live progress summary */}
      {isTraining && flGlobal && (
        <div
          className="flex flex-col gap-1.5 px-3 py-2.5 rounded-lg"
          style={{
            background: 'rgba(255, 109, 90, 0.07)',
            border: '1px solid rgba(255, 109, 90, 0.18)',
          }}
        >
          {[
            { label: 'Round', value: `${flGlobal.current_round}/${flGlobal.total_rounds}` },
            ...(flGlobal.global_accuracy != null ? [{ label: 'Accuracy', value: `${(flGlobal.global_accuracy * 100).toFixed(1)}%` }] : []),
            ...(flGlobal.global_loss != null ? [{ label: 'Loss', value: flGlobal.global_loss.toFixed(4) }] : []),
          ].map((m) => (
            <div key={m.label} className="flex justify-between items-center" style={{ fontSize: 11 }}>
              <span style={{ color: 'var(--n8n-text-muted)' }}>{m.label}</span>
              <span className="font-mono" style={{ color: 'var(--n8n-text-primary)', fontWeight: 700 }}>{m.value}</span>
            </div>
          ))}
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
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  disabled: boolean;
  hint?: string;
}) {
  return (
    <div className="fl-config-field">
      <div className="fl-config-label">
        <span>{label}</span>
        {hint && (
          <span
            className="fl-config-hint"
            style={{ color: 'var(--n8n-text-muted)', fontSize: 10 }}
          >
            {hint}
          </span>
        )}
      </div>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        className="fl-config-input"
      />
    </div>
  );
}

