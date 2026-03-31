/**
 * recessStore — Zustand store for RECESS detection round animation.
 *
 * Implements a two-level state machine:
 *   Outer: current detection round (probe_built → dispatched → responses → complete)
 *   Inner: per-client state (idle → waiting → responding → analyzing → decided)
 *
 * Incoming security events are queued and drained one-at-a-time at 400ms/event
 * by the useRecessAnimationDrain hook (Sprint 4) for legible animated playback.
 * The store itself is timer-free — drainNextEvent() is called by the hook.
 */

import { create } from 'zustand';

// ── Event kinds ────────────────────────────────────────

export type RecessEventKind =
  | 'recess_probe_built'
  | 'recess_probe_dispatched'
  | 'recess_response_received'
  | 'recess_vss_decrypt'
  | 'recess_score_computed'
  | 'recess_decision'
  | 'recess_round_complete';

export const RECESS_EVENT_KINDS = new Set<string>([
  'recess_probe_built',
  'recess_probe_dispatched',
  'recess_response_received',
  'recess_vss_decrypt',
  'recess_score_computed',
  'recess_decision',
  'recess_round_complete',
]);

// ── Data structures ────────────────────────────────────

export interface RecessEvent {
  kind: RecessEventKind;
  round: number;
  clientId?: string;
  detail?: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

export type RecessClientStatus = 'idle' | 'waiting' | 'responding' | 'analyzing' | 'decided';
export type RecessClientDecision = 'trusted' | 'downweighted' | 'flagged';

export interface RecessClientState {
  clientId: string;
  status: RecessClientStatus;
  decision?: RecessClientDecision;
  abnormality?: number;
  directionScore?: number;
  magnitudeScore?: number;
  cosSim?: number;
  magRatio?: number;
  trustBefore?: number;
  trustAfter?: number;
}

export interface RecessDetectionRound {
  round: number;
  probeBuilt: boolean;
  probeDispatched: boolean;
  isComplete: boolean;
  flaggedClients: string[];
  trustScores: Record<string, number>;
  clientStates: Record<string, RecessClientState>;
  /** All events applied so far — used to replay / re-render the sequence diagram. */
  events: RecessEvent[];
}

// ── Ring buffer limits ─────────────────────────────────

const MAX_COMPLETED_ROUNDS = 10;

// ── State machine reducer ──────────────────────────────

/** Pure function — returns updated round after applying one event. */
function applyEvent(
  round: RecessDetectionRound,
  event: RecessEvent,
): RecessDetectionRound {
  const next: RecessDetectionRound = {
    ...round,
    events: [...round.events, event],
    clientStates: { ...round.clientStates },
  };

  switch (event.kind) {
    case 'recess_probe_built':
      next.probeBuilt = true;
      break;

    case 'recess_probe_dispatched': {
      next.probeDispatched = true;
      // Transition all known clients to 'waiting'
      for (const cid of Object.keys(next.clientStates)) {
        next.clientStates[cid] = { ...next.clientStates[cid], status: 'waiting' };
      }
      break;
    }

    case 'recess_response_received': {
      if (event.clientId) {
        const prev = next.clientStates[event.clientId] ?? {
          clientId: event.clientId,
          status: 'idle' as RecessClientStatus,
        };
        next.clientStates[event.clientId] = { ...prev, status: 'responding' };
      }
      break;
    }

    case 'recess_vss_decrypt': {
      if (event.clientId) {
        const prev = next.clientStates[event.clientId] ?? {
          clientId: event.clientId,
          status: 'idle' as RecessClientStatus,
        };
        next.clientStates[event.clientId] = { ...prev, status: 'analyzing' };
      }
      break;
    }

    case 'recess_score_computed': {
      if (event.clientId) {
        const prev = next.clientStates[event.clientId] ?? {
          clientId: event.clientId,
          status: 'idle' as RecessClientStatus,
        };
        const d = event.data ?? {};
        next.clientStates[event.clientId] = {
          ...prev,
          status: 'analyzing',
          abnormality: d.abnormality as number | undefined,
          directionScore: d.direction_score as number | undefined,
          magnitudeScore: d.magnitude_score as number | undefined,
          cosSim: d.cos_sim as number | undefined,
          magRatio: d.mag_ratio as number | undefined,
        };
      }
      break;
    }

    case 'recess_decision': {
      if (event.clientId) {
        const prev = next.clientStates[event.clientId] ?? {
          clientId: event.clientId,
          status: 'idle' as RecessClientStatus,
        };
        const d = event.data ?? {};
        next.clientStates[event.clientId] = {
          ...prev,
          status: 'decided',
          decision: (d.decision as RecessClientDecision) ?? 'trusted',
          trustBefore: d.trust_before as number | undefined,
          trustAfter: d.trust_after as number | undefined,
          abnormality: d.abnormality as number | undefined,
        };
      }
      break;
    }

    case 'recess_round_complete': {
      const d = event.data ?? {};
      next.isComplete = true;
      next.flaggedClients = (d.flagged_clients as string[]) ?? [];
      next.trustScores = (d.trust_scores as Record<string, number>) ?? {};
      break;
    }
  }

  return next;
}

// ── Store interface ────────────────────────────────────

interface RecessState {
  /** Raw incoming event queue — drained by useRecessAnimationDrain. */
  eventQueue: RecessEvent[];
  /** The detection round currently being rendered / animated. */
  currentRound: RecessDetectionRound | null;
  /** Ring buffer of fully-completed rounds for history display. */
  completedRounds: RecessDetectionRound[];

  enqueueEvent: (event: RecessEvent) => void;
  /**
   * Pop one event from the queue and apply it to currentRound.
   * Returns true if an event was processed, false if the queue was empty.
   */
  drainNextEvent: () => boolean;
  clearRecess: () => void;
}

// ── Store implementation ───────────────────────────────

export const useRecessStore = create<RecessState>()((set, get) => ({
  eventQueue: [],
  currentRound: null,
  completedRounds: [],

  enqueueEvent: (event) =>
    set((state) => ({ eventQueue: [...state.eventQueue, event] })),

  drainNextEvent: () => {
    const { eventQueue, currentRound, completedRounds } = get();
    if (eventQueue.length === 0) return false;

    const [next, ...rest] = eventQueue;

    // Start a new round when probe_built arrives OR when round number changes
    const needsNewRound =
      next.kind === 'recess_probe_built' ||
      currentRound === null ||
      currentRound.round !== next.round;

    if (needsNewRound) {
      // Archive the previous round if it exists and isn't already archived
      const archived =
        currentRound && !completedRounds.some((r) => r.round === currentRound.round)
          ? [currentRound, ...completedRounds].slice(0, MAX_COMPLETED_ROUNDS)
          : completedRounds;

      const freshRound: RecessDetectionRound = {
        round: next.round,
        probeBuilt: false,
        probeDispatched: false,
        isComplete: false,
        flaggedClients: [],
        trustScores: {},
        clientStates: {},
        events: [],
      };

      set({
        eventQueue: rest,
        currentRound: applyEvent(freshRound, next),
        completedRounds: archived,
      });
      return true;
    }

    // Apply event to the existing round
    set({
      eventQueue: rest,
      currentRound: applyEvent(currentRound, next),
    });
    return true;
  },

  clearRecess: () =>
    set({ eventQueue: [], currentRound: null, completedRounds: [] }),
}));

// ── Selectors ──────────────────────────────────────────

export const useRecessCurrentRound = () => useRecessStore((s) => s.currentRound);
export const useRecessQueueLength = () => useRecessStore((s) => s.eventQueue.length);
export const useRecessCompletedRounds = () => useRecessStore((s) => s.completedRounds);
export const useRecessClientState = (clientId: string) =>
  useRecessStore((s) => s.currentRound?.clientStates[clientId] ?? null);
