import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Loader2, ShieldCheck, AlertTriangle, Activity } from 'lucide-react';
import { useTrustScores, useFlaggedEvents } from '../stores/liveStore';
import TrustScorePanel from '../components/TrustScorePanel';
import type { SecurityStatus, DetectionRound } from '../types';
import { useAuthStore } from '../stores/authStore';

/* ── Animation variants ──────────────────────────────────────── */
const stagger = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
};
const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } };

/* ── Inline styles (n8n canvas design system) ────────────────── */
const S = {
  sectionCard: {
    background: 'var(--n8n-card-bg)',
    border: '1px solid var(--n8n-card-border)',
    borderRadius: 12,
    overflow: 'hidden',
  } as React.CSSProperties,

  sectionHeader: {
    padding: '14px 20px',
    background: 'var(--n8n-card-border)',
    borderBottom: '1px solid var(--n8n-card-border)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  } as React.CSSProperties,

  sectionTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: 'var(--n8n-text-primary)',
    letterSpacing: '0.02em',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  } as React.CSSProperties,

  tableContainer: {
    overflowX: 'auto' as const,
    overflowY: 'auto' as const,
    maxHeight: 320,
  },

  thead: {
    position: 'sticky' as const,
    top: 0,
    zIndex: 1,
  },

  th: {
    padding: '10px 14px',
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: '0.07em',
    textTransform: 'uppercase' as const,
    color: 'var(--n8n-text-muted)',
    background: 'var(--n8n-card-border)',
    borderBottom: '1px solid var(--n8n-card-border)',
    whiteSpace: 'nowrap' as const,
  },

  td: {
    padding: '10px 14px',
    fontSize: 12,
    color: 'var(--n8n-text-primary)',
    borderBottom: '1px solid rgba(60,60,60,0.5)',
    whiteSpace: 'nowrap' as const,
  },

  flaggedRow: {
    borderLeft: '3px solid var(--n8n-danger)',
    background: 'rgba(208, 48, 80, 0.07)',
  } as React.CSSProperties,

  normalRow: {
    borderLeft: '3px solid transparent',
  } as React.CSSProperties,

  successText: {
    color: 'var(--n8n-success)',
    fontWeight: 700,
  } as React.CSSProperties,

  dangerText: {
    color: 'var(--n8n-danger)',
    fontWeight: 700,
  } as React.CSSProperties,

  dot: (color: string): React.CSSProperties => ({
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: color,
    display: 'inline-block',
    flexShrink: 0,
  }),

  vssCard: {
    background: 'var(--n8n-card-bg)',
    border: '1px solid var(--n8n-card-border)',
    borderRadius: 12,
    padding: '16px 20px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
  } as React.CSSProperties,

  vssRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap' as const,
  } as React.CSSProperties,

  vssLabel: {
    fontSize: 12,
    color: 'var(--n8n-text-muted)',
  } as React.CSSProperties,

  vssValue: {
    fontSize: 12,
    color: 'var(--n8n-text-primary)',
    fontWeight: 600,
  } as React.CSSProperties,

  emptyCell: (colSpan: number): React.CSSProperties => ({
    padding: 32,
    textAlign: 'center' as const,
    color: 'var(--n8n-text-muted)',
    fontSize: 12,
  }),
} as const;

/* ── VSS Status card ─────────────────────────────────────────── */
function VssStatusCard({
  vss,
}: {
  vss: SecurityStatus['vss'] | null;
}) {
  const loading = vss === null;

  return (
    <motion.div variants={fadeUp} style={S.sectionCard}>
      <div style={S.sectionHeader}>
        <span style={S.sectionTitle}>
          <ShieldCheck style={{ width: 14, height: 14, color: 'var(--n8n-success)' }} />
          VSS Status
        </span>
      </div>
      <div style={{ padding: '14px 20px' }}>
        {loading ? (
          <span style={S.vssLabel}>Loading…</span>
        ) : (
          <div style={S.vssCard}>
            <div style={S.vssRow}>
              <span style={S.vssLabel}>Commitments Held:</span>
              <span style={vss.commitmentsHeld ? S.successText : S.dangerText}>
                {vss.commitmentsHeld ? '✓' : '✗'}
              </span>
              <span style={{ ...S.vssLabel, marginLeft: 16 }}>Clients:</span>
              {vss.clients.map((c, i) => (
                <span key={c} style={S.vssValue}>
                  {c}
                  {i < vss.clients.length - 1 && (
                    <span style={{ color: 'var(--n8n-text-muted)', margin: '0 4px' }}>·</span>
                  )}
                </span>
              ))}
            </div>
            <div style={S.vssRow}>
              <span style={S.vssLabel}>Last Refresh Round:</span>
              <span style={S.vssValue}>{vss.lastRefreshRound}</span>
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}

/* ── Detection Rounds table ──────────────────────────────────── */
function DetectionRoundsTable({ rounds }: { rounds: DetectionRound[] }) {
  return (
    <motion.div variants={fadeUp} style={S.sectionCard}>
      <div style={S.sectionHeader}>
        <span style={S.sectionTitle}>
          <Activity style={{ width: 14, height: 14, color: 'var(--n8n-accent)' }} />
          Detection Rounds
        </span>
        <span style={{ fontSize: 11, color: 'var(--n8n-text-muted)' }}>
          {rounds.length} round{rounds.length !== 1 ? 's' : ''}
        </span>
      </div>
      <div style={S.tableContainer}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead style={S.thead}>
            <tr>
              <th style={S.th}>Round</th>
              <th style={S.th}>Timestamp</th>
              <th style={S.th}>Flagged</th>
              <th style={S.th}>Scores</th>
            </tr>
          </thead>
          <tbody>
            {rounds.length > 0 ? (
              [...rounds]
                .sort((a, b) => b.round - a.round)
                .map((r) => {
                  const hasFlagged = r.flagged.length > 0;
                  return (
                    <tr
                      key={`${r.round}-${r.timestamp}`}
                      style={hasFlagged ? S.flaggedRow : S.normalRow}
                    >
                      <td style={{ ...S.td, fontWeight: 700 }}>#{r.round}</td>
                      <td style={{ ...S.td, fontFamily: 'inherit' }}>
                        {new Date(r.timestamp).toLocaleString([], {
                          year: 'numeric',
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </td>
                      <td style={S.td}>
                        {hasFlagged ? (
                          <span style={S.dangerText}>{r.flagged.join(', ')}</span>
                        ) : (
                          <span style={{ color: 'var(--n8n-text-muted)', fontSize: 11 }}>—</span>
                        )}
                      </td>
                      <td style={{ ...S.td, fontFamily: 'inherit', color: 'var(--n8n-text-muted)' }}>
                        {Object.entries(r.scores)
                          .map(([k, v]) => `${k}:${(v as number).toFixed(2)}`)
                          .join(', ')}
                      </td>
                    </tr>
                  );
                })
            ) : (
              <tr>
                <td colSpan={4} style={S.emptyCell(4)}>
                  No detection rounds recorded yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </motion.div>
  );
}

/* ── Flagged Clients table ───────────────────────────────────── */
function FlaggedClientsTable({
  flaggedEvents,
}: {
  flaggedEvents: Array<{ clientId: string; round: number; abnormality: number; timestamp: string }>;
}) {
  return (
    <motion.div variants={fadeUp} style={S.sectionCard}>
      <div style={S.sectionHeader}>
        <span style={S.sectionTitle}>
          <AlertTriangle style={{ width: 14, height: 14, color: 'var(--n8n-danger)' }} />
          Flagged Clients
        </span>
        <span style={{ fontSize: 11, color: 'var(--n8n-text-muted)' }}>
          {flaggedEvents.length} event{flaggedEvents.length !== 1 ? 's' : ''}
        </span>
      </div>
      <div style={S.tableContainer}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead style={S.thead}>
            <tr>
              <th style={S.th}>Client</th>
              <th style={S.th}>Round</th>
              <th style={S.th}>Abnormality</th>
              <th style={S.th}>Timestamp</th>
            </tr>
          </thead>
          <tbody>
            {flaggedEvents.length > 0 ? (
              [...flaggedEvents]
                .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
                .map((ev, i) => (
                  <tr key={`${ev.clientId}-${ev.round}-${i}`} style={S.flaggedRow}>
                    <td style={{ ...S.td, fontWeight: 600 }}>{ev.clientId}</td>
                    <td style={S.td}>#{ev.round}</td>
                    <td style={{ ...S.td, fontWeight: 700 }}>
                      <span style={S.dangerText}>{ev.abnormality.toFixed(2)}</span>
                    </td>
                    <td style={{ ...S.td, fontFamily: 'inherit', color: 'var(--n8n-text-muted)' }}>
                      {new Date(ev.timestamp).toLocaleString([], {
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </td>
                  </tr>
                ))
            ) : (
              <tr>
                <td colSpan={4} style={S.emptyCell(4)}>
                  No flagged clients — all clients appear normal
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </motion.div>
  );
}

/* ══════════════════════════════════════════════════════════════
   Main Page
   ══════════════════════════════════════════════════════════════ */
export default function SecurityMonitorPage() {
  const trustScores = useTrustScores();
  const flaggedEvents = useFlaggedEvents();

  const [securityStatus, setSecurityStatus] = useState<SecurityStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* Fetch GET /api/v1/security/status on mount */
  useEffect(() => {
    const token = useAuthStore.getState().token;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    fetch('/api/v1/security/status', { headers })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => res.statusText);
          throw new Error(`${res.status}: ${text}`);
        }
        return res.json() as Promise<SecurityStatus>;
      })
      .then((data) => {
        setSecurityStatus(data);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  /* ── Loading state ── */
  if (loading) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: 256,
        }}
      >
        <Loader2
          style={{
            width: 32,
            height: 32,
            color: 'var(--n8n-accent)',
            animation: 'spin 1s linear infinite',
          }}
        />
      </div>
    );
  }

  /* ── Error state ── */
  if (error) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          height: 256,
          gap: 12,
        }}
      >
        <AlertTriangle
          style={{ width: 32, height: 32, color: 'var(--n8n-danger)' }}
        />
        <p
          style={{
            fontSize: 14,
            color: 'var(--n8n-danger)',
            fontWeight: 600,
            textAlign: 'center',
          }}
        >
          Failed to load security status
        </p>
        <p
          style={{
            fontSize: 12,
            color: 'var(--n8n-text-muted)',
            fontFamily: 'inherit',
            maxWidth: 400,
            textAlign: 'center',
          }}
        >
          {error}
        </p>
      </div>
    );
  }

  /* Derive detection rounds and VSS from fetched status (fallback to empty) */
  const vss = securityStatus?.vss ?? null;
  const detectionRounds: DetectionRound[] =
    securityStatus?.recentDetectionRounds ?? [];

  return (
    <motion.div variants={stagger} initial="hidden" animate="show" className="page-stack">

      {/* ── Page header ── */}
      <motion.div variants={fadeUp}>
        <h1
          style={{
            fontSize: 22,
            fontWeight: 700,
            color: 'var(--n8n-text-primary)',
          }}
        >
          Security Monitor
        </h1>
        <p style={{ fontSize: 13, color: 'var(--n8n-text-muted)', marginTop: 2 }}>
          VSS commitments, client trust scores, and detection round history
        </p>
      </motion.div>

      {/* ── VSS Status ── */}
      <VssStatusCard vss={vss} />

      {/* ── Client Trust Scores ── */}
      <motion.div variants={fadeUp} style={S.sectionCard}>
        <div style={S.sectionHeader}>
          <span style={S.sectionTitle}>
            <span
              style={{
                ...S.dot('var(--n8n-accent)'),
                marginRight: 0,
              }}
            />
            Client Trust Scores
          </span>
        </div>
        <div style={{ padding: '14px 20px' }}>
          <TrustScorePanel
            trustScores={trustScores}
            flaggedEvents={flaggedEvents}
          />
        </div>
      </motion.div>

      {/* ── Detection Rounds ── */}
      <DetectionRoundsTable rounds={detectionRounds} />

      {/* ── Flagged Clients ── */}
      <FlaggedClientsTable flaggedEvents={flaggedEvents} />

    </motion.div>
  );
}
