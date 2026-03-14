/**
 * WebSocketProvider — mounts at app level inside authenticated layout.
 * Bridges useWebSocket hook → liveStore so all pages share live data.
 */

import { useEffect } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useLiveStore } from '@/stores/liveStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { flApi } from '@/api/fl';
import type { WSMessage } from '@/hooks/useWebSocket';

export function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const { isConnected, subscribe } = useWebSocket();
  const {
    addPrediction,
    setFLClientProgress,
    setFLGlobalProgress,
    addFLRoundResult,
    addFLClientRoundEntry,
    clearFLProgress,
    setClientStatus,
    setDeviceStatus,
    setWsConnected,
    setTrustScores,
    addFlaggedEvent,
    setAttackRunStatus,
    addAttackResult,
  } = useLiveStore();
  const addSecurityEvent = useLiveStore((s) => s.addSecurityEvent);

  // Sync connection state
  useEffect(() => {
    setWsConnected(isConnected);
  }, [isConnected, setWsConnected]);

  // ── Fallback polling when WS is disconnected ──────────────────────────────
  useEffect(() => {
    if (isConnected) return; // WS is up — no polling needed

    const interval = setInterval(async () => {
      try {
        const status = await flApi.status();
        const existing = useLiveStore.getState().flGlobalProgress;
        if (status.is_training || existing?.is_training) {
          setFLGlobalProgress({
            is_training: status.is_training,
            current_round: status.current_round ?? existing?.current_round ?? 0,
            total_rounds: status.total_rounds ?? existing?.total_rounds ?? 0,
            global_loss: existing?.global_loss ?? null,
            global_accuracy: existing?.global_accuracy ?? null,
            aggregation_method: existing?.aggregation_method,
            use_he: existing?.use_he,
            expected_clients: existing?.expected_clients,
          });
        }
      } catch {
        // Backend unreachable — silently ignore
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [isConnected, setFLGlobalProgress]);

  // Subscribe to all message types and dispatch to store
  useEffect(() => {
    const unsubs: Array<() => void> = [];

    // ── Prediction ──
    unsubs.push(subscribe('prediction', (msg: WSMessage) => {
      const d = msg.data;
      addPrediction({
        id: d.id as number | undefined,
        device_id: d.device_id as string,
        device_name: d.device_name as string | undefined,
        client_id: d.client_id as number | undefined,
        client_string_id: d.client_string_id as string | undefined,
        score: d.score as number,
        label: d.label as string,
        confidence: d.confidence as number,
        attack_type: d.attack_type as string | undefined,
        inference_latency_ms: d.inference_latency_ms as number | undefined,
        model_version: d.model_version as string | undefined,
        timestamp: msg.timestamp,
      });
    }));

    // ── FL per-client progress ──
    unsubs.push(subscribe('fl_progress', (msg: WSMessage) => {
      const d = msg.data;
      const clientId = d.client_id as string;
      if (!clientId) return; // Server-side progress (no client_id) — skip per-client update

      // Map FL server/client fields → FLClientProgress store fields
      const phase = (d.phase as string) || 'idle';
      const epoch = (d.epoch ?? 0) as number;
      const totalEpochs = (d.total_epochs ?? 0) as number;
      const epochLoss = (d.epoch_loss ?? d.loss ?? 0) as number;

      // Map phase → status for UI
      let status = 'idle';
      if (phase === 'training') status = 'training';
      else if (phase === 'sending_weights') status = 'sending';
      else if (phase === 'encrypting') status = 'encrypting';
      else if (phase === 'aggregating') status = 'done';

      // Calculate progress percentage — prefer fine-grained batch progress
      let progressPct = 0;
      const batchesProcessed = (d.batches_processed ?? 0) as number;
      const grandTotalBatches = (d.grand_total_batches ?? 0) as number;
      if (grandTotalBatches > 0 && batchesProcessed > 0) {
        progressPct = Math.min(100, (batchesProcessed / grandTotalBatches) * 100);
      } else if (totalEpochs > 0 && epoch > 0) {
        progressPct = Math.min(100, (epoch / totalEpochs) * 100);
      }
      if (phase === 'sending_weights') progressPct = 100;

      setFLClientProgress(clientId, {
        client_id: clientId,
        status,
        current_epoch: epoch,
        total_epochs: totalEpochs,
        local_loss: epochLoss,
        local_accuracy: (d.local_accuracy ?? d.accuracy ?? 0) as number,
        num_samples: (d.num_samples ?? 0) as number,
        progress_pct: progressPct,
        // Per-batch detailed fields
        batch: (d.batch ?? undefined) as number | undefined,
        total_batches: (d.total_batches ?? undefined) as number | undefined,
        batches_processed: batchesProcessed || undefined,
        grand_total_batches: grandTotalBatches || undefined,
        samples_processed: (d.samples_processed ?? undefined) as number | undefined,
        total_samples: (d.total_samples ?? undefined) as number | undefined,
        throughput: (d.throughput ?? undefined) as number | undefined,
        eta_seconds: (d.eta_seconds ?? undefined) as number | undefined,
        current_loss: (d.current_loss ?? undefined) as number | undefined,
        current_accuracy: (d.current_accuracy ?? undefined) as number | undefined,
        last_update_time: (d.last_update_time ?? undefined) as string | undefined,
      });

      // Also update global progress if round info is present
      if (d.round != null) {
        const existing = useLiveStore.getState().flGlobalProgress;
        setFLGlobalProgress({
          is_training: true,
          current_round: d.round as number,
          total_rounds: (d.total_rounds ?? existing?.total_rounds ?? 0) as number,
          global_loss: existing?.global_loss ?? null,
          global_accuracy: existing?.global_accuracy ?? null,
          use_he: existing?.use_he,
        });
      }
    }));

    // ── FL completed round ──
    unsubs.push(subscribe('fl_round', (msg: WSMessage) => {
      const d = msg.data;
      addFLRoundResult(
        d.round_number as number,
        d.global_loss as number | null,
        d.global_accuracy as number | null,
      );
      // Update global progress
      const totalRounds = (d.total_rounds ?? d.round_number) as number;
      const currentRound = d.round_number as number;
      setFLGlobalProgress({
        is_training: currentRound < totalRounds,
        current_round: currentRound,
        total_rounds: totalRounds,
        global_loss: d.global_loss as number | null,
        global_accuracy: d.global_accuracy as number | null,
        aggregation_method: d.aggregation_method as string | undefined,
      });

      // Update per-client statuses from round metrics
      const clientMetrics = d.client_metrics as Array<{
        client_id: string; local_loss: number; local_accuracy: number;
        num_samples: number;
      }> | undefined;
      if (clientMetrics && Array.isArray(clientMetrics)) {
        for (const cm of clientMetrics) {
          setFLClientProgress(cm.client_id, {
            client_id: cm.client_id,
            status: 'done',
            current_epoch: 0,
            total_epochs: 0,
            local_loss: cm.local_loss,
            local_accuracy: cm.local_accuracy,
            num_samples: cm.num_samples,
            progress_pct: 100,
          });
          // Accumulate per-client round history for charts
          addFLClientRoundEntry(
            cm.client_id,
            d.round_number as number,
            cm.local_loss,
            cm.local_accuracy,
          );
        }
      }
    }));

    // ── Training started ──
    unsubs.push(subscribe('training_start', (msg: WSMessage) => {
      // Clear stale round data from any previous session before updating state
      useLiveStore.getState().clearFLRoundResults();
      useLiveStore.getState().clearFLClientRoundHistory();
      const d = msg.data;
      const totalRounds = (d.total_rounds ?? d.num_rounds ?? 0) as number;
      const clientIds = d.client_ids as string[] | undefined;
      setFLGlobalProgress({
        is_training: true,
        current_round: 0,
        total_rounds: totalRounds,
        global_loss: null,
        global_accuracy: null,
        use_he: d.use_he as boolean | undefined,
        expected_clients: clientIds?.length ?? useLiveStore.getState().flGlobalProgress?.expected_clients,
      });

      // Create initial client progress entries from client_ids if provided
      if (clientIds && Array.isArray(clientIds)) {
        for (const cid of clientIds) {
          setFLClientProgress(cid, {
            client_id: cid,
            status: 'idle',
            current_epoch: 0,
            total_epochs: 0,
            local_loss: 0,
            local_accuracy: 0,
            num_samples: 0,
            progress_pct: 0,
          });
        }
      }
    }));

    // ── Training complete ──
    unsubs.push(subscribe('training_complete', (msg: WSMessage) => {
      const d = msg.data;
      const totalRounds = (d.total_rounds ?? d.rounds_completed ?? 0) as number;
      setFLGlobalProgress({
        is_training: false,
        current_round: totalRounds,
        total_rounds: totalRounds,
        global_loss: (d.global_loss ?? null) as number | null,
        global_accuracy: (d.global_accuracy ?? null) as number | null,
      });
      // Clear the active server flag so LiveDataSync resets nodes to idle.
      // Progress data (rounds, accuracy) is preserved in flGlobalProgress for review.
      useWorkspaceStore.getState().setActiveFlServerNodeId(null);
    }));

    // ── Client status change ──
    unsubs.push(subscribe('client_status', (msg: WSMessage) => {
      const d = msg.data;
      setClientStatus(d.client_id as number, {
        client_id: d.client_id as number,
        client_name: d.client_name as string | undefined,
        status: d.status as string,
        container_status: (d.container_status ?? 'not_found') as string,
      });
    }));

    // ── Device status change ──
    unsubs.push(subscribe('device_status', (msg: WSMessage) => {
      const d = msg.data;
      setDeviceStatus(d.device_id as string, {
        device_id: d.device_id as string,
        device_name: d.device_name as string | undefined,
        status: d.status as string,
      });
    }));

    // ── Client trust scores updated ──
    unsubs.push(subscribe('client_trust_update', (msg: WSMessage) => {
      const d = msg.data;
      setTrustScores({
        scores: d.scores as Record<string, number>,
        round: d.round as number,
      });
    }));

    // ── Client flagged by RECESS detection ──
    unsubs.push(subscribe('client_flagged', (msg: WSMessage) => {
      const d = msg.data;
      addFlaggedEvent({
        clientId: d.client_id as string,
        round: d.round as number,
        abnormality: d.abnormality as number,
      });
    }));

    // ── Attack run status change (running, progress updates) ──
    unsubs.push(subscribe('attack_status', (msg: WSMessage) => {
      const d = msg.data;
      setAttackRunStatus({
        run_id: d.run_id as number,
        attack_id: d.attack_id as number,
        status: d.status as string,
        packets_sent: d.packets_sent as number | undefined,
        duration_seconds: d.duration_seconds as number | undefined,
        error_message: d.error_message as string | undefined,
        results: d.results as Record<string, unknown> | undefined,
      });
    }));

    // ── Attack run completed / failed / cancelled ──
    unsubs.push(subscribe('attack_result', (msg: WSMessage) => {
      const d = msg.data;
      const result = {
        run_id: d.run_id as number,
        attack_id: d.attack_id as number,
        status: d.status as string,
        packets_sent: d.packets_sent as number | undefined,
        duration_seconds: d.duration_seconds as number | undefined,
        error_message: d.error_message as string | undefined,
        results: d.results as Record<string, unknown> | undefined,
      };
      setAttackRunStatus(result);
      addAttackResult(result);
    }));

    // ── Security pipeline event (Phase 3) ──
    unsubs.push(subscribe('security_event', (msg: WSMessage) => {
      const d = msg.data;
      addSecurityEvent({
        kind: d.kind as import('@/stores/liveStore').SecurityEventKind,
        round: d.round as number,
        clientId: d.client_id as string | undefined,
        detail: d.detail as string | undefined,
        timestamp: msg.timestamp ?? new Date().toISOString(),
      });
    }));

    return () => { unsubs.forEach((u) => u()); };
  }, [
    subscribe, addPrediction, setFLClientProgress, setFLGlobalProgress,
    addFLRoundResult, addFLClientRoundEntry, clearFLProgress, setClientStatus, setDeviceStatus,
    setTrustScores, addFlaggedEvent, setAttackRunStatus, addAttackResult, addSecurityEvent,
  ]);

  return <>{children}</>;
}
