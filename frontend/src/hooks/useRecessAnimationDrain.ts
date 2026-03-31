/**
 * useRecessAnimationDrain — drives the RECESS event animation loop.
 *
 * Calls drainNextEvent() every DRAIN_INTERVAL_MS milliseconds.
 * The store itself is timer-free; all pacing logic lives here.
 * Mount this inside the component that renders the RECESS visualization.
 */

import { useEffect } from 'react';
import { useRecessStore, useRecessQueueLength } from '@/stores/recessStore';

/** Gap between rendered events — long enough for the user to read each step. */
const DRAIN_INTERVAL_MS = 400;

/**
 * Activates the RECESS animation drain loop.
 *
 * @returns Current pending event queue length (useful for a "buffering" indicator).
 */
export function useRecessAnimationDrain(): number {
  const queueLength = useRecessQueueLength();

  useEffect(() => {
    const id = setInterval(() => {
      useRecessStore.getState().drainNextEvent();
    }, DRAIN_INTERVAL_MS);

    return () => clearInterval(id);
  }, []); // constant interval — no deps needed

  return queueLength;
}
