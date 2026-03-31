/**
 * fedRecoveryStore — Zustand store for FedRecovery correction pipeline state.
 *
 * Tracks one active run at a time plus a ring buffer of completed runs.
 * Modal open/close state is co-located so the run trigger can auto-open
 * the modal without prop drilling.
 *
 * Event flow:
 *   fedrecovery_event {kind:'started'}   → startRun()   → isModalOpen=true
 *   fedrecovery_event {kind:'step'}      → appendStep()
 *   fedrecovery_event {kind:'complete'|'partial'|'failed'|'cancelled'}
 *                                        → completeRun()
 */

import { create } from 'zustand';

// ── Types ──────────────────────────────────────────────

export type FedRecoveryStatus = 'running' | 'complete' | 'partial' | 'failed' | 'cancelled';

export interface FedRecoveryStep {
  round: number;
  step: 'corrected' | 'skipped';
  detail?: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

export interface FedRecoveryRun {
  runId: string;
  flaggedClientId: string;
  flagRound: number;
  status: FedRecoveryStatus;
  steps: FedRecoveryStep[];
  roundsCorrected: number;
  roundsSkipped: number;
  beforeNorms?: Record<string, number>;
  afterNorms?: Record<string, number>;
  epsilon?: number;
  sigma?: number;
  accuracyBefore?: number;
  accuracyAfter?: number;
  lossBefore?: number;
  lossAfter?: number;
  startedAt: string;
  completedAt?: string;
}

// ── Ring buffer limit ──────────────────────────────────

const MAX_COMPLETED_RUNS = 20;

// ── Store interface ────────────────────────────────────

interface FedRecoveryState {
  /** The currently executing run, or null when idle. */
  activeRun: FedRecoveryRun | null;
  /** Ring buffer of completed runs for history / audit panel. */
  completedRuns: FedRecoveryRun[];
  /** Controls FedRecoveryModal visibility. */
  isModalOpen: boolean;

  startRun: (
    runId: string,
    flaggedClientId: string,
    flagRound: number,
    timestamp: string,
  ) => void;

  appendStep: (runId: string, step: FedRecoveryStep) => void;

  completeRun: (
    runId: string,
    status: string,
    payload: Record<string, unknown>,
    timestamp: string,
  ) => void;

  openModal: () => void;
  closeModal: () => void;
  clearCompleted: () => void;
  /** Full reset — call on drilldown exit to prevent stale state leaking across sessions. */
  clearAll: () => void;
}

// ── Store implementation ───────────────────────────────

export const useFedRecoveryStore = create<FedRecoveryState>()((set, get) => ({
  activeRun: null,
  completedRuns: [],
  isModalOpen: false,

  startRun: (runId, flaggedClientId, flagRound, timestamp) => {
    const run: FedRecoveryRun = {
      runId,
      flaggedClientId,
      flagRound,
      status: 'running',
      steps: [],
      roundsCorrected: 0,
      roundsSkipped: 0,
      startedAt: timestamp,
    };
    set({ activeRun: run, isModalOpen: true });
  },

  appendStep: (runId, step) =>
    set((state) => {
      if (state.activeRun?.runId !== runId) return state;
      const updated: FedRecoveryRun = {
        ...state.activeRun,
        steps: [...state.activeRun.steps, step],
        roundsCorrected:
          state.activeRun.roundsCorrected + (step.step === 'corrected' ? 1 : 0),
        roundsSkipped:
          state.activeRun.roundsSkipped + (step.step === 'skipped' ? 1 : 0),
      };
      return { activeRun: updated };
    }),

  completeRun: (runId, status, payload, timestamp) =>
    set((state) => {
      // Accept completion for the active run OR for an already-archived run (late message)
      const run =
        state.activeRun?.runId === runId
          ? state.activeRun
          : state.completedRuns.find((r) => r.runId === runId) ?? null;

      if (!run) return state;

      const completed: FedRecoveryRun = {
        ...run,
        status: status as FedRecoveryStatus,
        roundsCorrected:
          (payload.rounds_corrected as number | undefined) ?? run.roundsCorrected,
        roundsSkipped:
          (payload.rounds_skipped as number | undefined) ?? run.roundsSkipped,
        beforeNorms: payload.before_norms as Record<string, number> | undefined,
        afterNorms: payload.after_norms as Record<string, number> | undefined,
        epsilon: payload.epsilon as number | undefined,
        sigma: payload.sigma as number | undefined,
        accuracyBefore: payload.accuracy_before as number | undefined,
        accuracyAfter: payload.accuracy_after as number | undefined,
        lossBefore: payload.loss_before as number | undefined,
        lossAfter: payload.loss_after as number | undefined,
        completedAt: timestamp,
      };

      // Remove from completedRuns if it was there already (avoid duplicates)
      const withoutStale = state.completedRuns.filter((r) => r.runId !== runId);

      return {
        activeRun: state.activeRun?.runId === runId ? null : state.activeRun,
        completedRuns: [completed, ...withoutStale].slice(0, MAX_COMPLETED_RUNS),
      };
    }),

  openModal: () => set({ isModalOpen: true }),
  closeModal: () => set({ isModalOpen: false }),
  clearCompleted: () => set({ completedRuns: [] }),
  clearAll: () => set({ activeRun: null, completedRuns: [], isModalOpen: false }),

  // Expose getter for external non-hook access
  ...({} as object),
}));

// ── Selectors ──────────────────────────────────────────

export const useFedRecoveryActiveRun = () => useFedRecoveryStore((s) => s.activeRun);
export const useFedRecoveryCompletedRuns = () => useFedRecoveryStore((s) => s.completedRuns);
export const useFedRecoveryModalOpen = () => useFedRecoveryStore((s) => s.isModalOpen);
export const useFedRecoveryIsRunning = () =>
  useFedRecoveryStore((s) => s.activeRun?.status === 'running');
