/**
 * Shared hooks and helpers for the Watcher pipeline tabs.
 *
 * Consolidates useClientIdLabelMap, formatTime, and formatDuration so they
 * are defined once and imported by EventsPipelineTab, TrustPipelineTab, and
 * RecoveryPipelineTab.
 */

import { useMemo } from 'react';
import { useWorkspaceStore } from '@/stores/workspaceStore';

// ── Client label resolution ────────────────────────────────────────────────

/**
 * Derive a Map<flClientId, humanLabel> from the workspace canvas nodes.
 * Maps both the raw node ID ("bank-a") and the underscore-derived FL ID
 * ("bank_a") to the human-readable label.
 */
export function useClientIdLabelMap(): Map<string, string> {
  const nodes = useWorkspaceStore((s) => s.nodes);
  return useMemo(() => {
    const m = new Map<string, string>();
    for (const n of nodes) {
      if ((n.data as { nodeType?: string }).nodeType !== 'client') continue;
      const label = (n.data as { label?: string }).label ?? n.id;
      const derivedId = n.id.replace(/-/g, '_');
      m.set(derivedId, label);
      m.set(n.id, label);
    }
    return m;
  }, [nodes]);
}

// ── Time formatting ────────────────────────────────────────────────────────

export function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

/**
 * Human-readable duration between two ISO timestamps.
 * Returns "—" if either timestamp is invalid or the duration is negative
 * (which can happen if events from different sessions are accidentally mixed).
 */
export function formatDuration(startIso: string, endIso: string): string {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}
