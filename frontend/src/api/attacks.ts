/**
 * Attack API client — fetches the attack catalog from the backend.
 */

const API_BASE = import.meta.env.VITE_API_URL ?? '/api/v1';

export interface AttackSubType {
  sub_type: string;
  label: string;
  description: string;
  default_params: Record<string, unknown>;
}

export type AttackCatalog = Record<string, AttackSubType[]>;

let _cachedCatalog: AttackCatalog | null = null;

/**
 * Fetch the attack catalog (7 categories x 21 sub-types).
 * Caches the result in memory after the first successful fetch.
 */
export async function fetchAttackCatalog(): Promise<AttackCatalog> {
  if (_cachedCatalog) return _cachedCatalog;

  const res = await fetch(`${API_BASE}/attacks/catalog`);
  if (!res.ok) {
    throw new Error(`Failed to fetch attack catalog: ${res.status}`);
  }

  const data: AttackCatalog = await res.json();
  _cachedCatalog = data;
  return data;
}
