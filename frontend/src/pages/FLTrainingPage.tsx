import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Loader2, Play, Pause,
  Square, Settings,
  X, ChevronDown, SkipBack, SkipForward,
} from 'lucide-react';
import {
  LineChart, Line, AreaChart, Area, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Legend, CartesianGrid,
} from 'recharts';
import { flApi } from '@/api/fl';
import { useLiveStore } from '@/stores/liveStore';
import type { FLRound, FLRoundDetail, FLStatus, FLClient } from '@/types';
import type { FLClientProgress } from '@/stores/liveStore';

/* ── Animations ───────────────────────────────── */
const stagger = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { staggerChildren: 0.06 } } };
const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } };
const tooltipStyle = {
  contentStyle: {
    background: 'var(--bg-secondary)', border: '1px solid var(--border)',
    borderRadius: 8, fontSize: 12, color: 'var(--text-primary)',
  },
};

/* ── Pipeline Steps ───────────────────────────── */
const PIPELINE_STEPS = [
  { key: 'distribute', label: 'Sending Weights', color: '#A855F7' },
  { key: 'training', label: 'Local Training', color: '#6366F1' },
  { key: 'encrypting', label: 'Encrypting', color: '#EF4444' },
  { key: 'aggregating', label: 'Aggregating', color: '#F59E0B' },
];

/* ── CKKS Config ──────────────────────────────── */
const CKKS_CONFIG = [
  { param: 'Library', value: 'TenSEAL' },
  { param: 'poly_modulus_degree', value: '16384' },
  { param: 'coeff_mod_bit_sizes', value: '[60,40,40,40,40,60]' },
  { param: 'global_scale', value: '2\u2074\u2070' },
  { param: 'Encrypted layers', value: 'LSTM + FC only' },
];

/* ── Per-client chart colors ─────────────────── */
const CLIENT_COLORS = [
  '#6366F1', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6',
  '#EC4899', '#14B8A6', '#F97316', '#06B6D4', '#84CC16',
];

/* ── Helpers ──────────────────────────────────── */
function statusToStep(status: string): string {
  if (status === 'training') return 'training';
  if (status === 'encrypting' || status === 'sending') return 'encrypting';
  if (status === 'done' || status === 'idle') return 'aggregating';
  return 'distribute';
}

function getClientStatusColor(s: string): string {
  if (s === 'training') return 'var(--accent)';
  if (s === 'encrypting' || s === 'sending') return 'var(--danger)';
  if (s === 'done') return 'var(--success)';
  if (s === 'error') return 'var(--danger)';
  if (s === 'waiting') return 'var(--warning)';
  return 'var(--text-muted)';
}

function getClientStatusBg(s: string): string {
  if (s === 'training') return 'var(--accent-light)';
  if (s === 'encrypting' || s === 'sending') return 'var(--danger-light)';
  if (s === 'done') return 'var(--success-light)';
  if (s === 'error') return 'var(--danger-light)';
  if (s === 'waiting') return 'var(--warning-light)';
  return 'var(--bg-secondary)';
}

/* ══════════════════════════════════════════════════
   Config Modal
   ══════════════════════════════════════════════════ */
function ConfigModal({
  open, onClose, onStart, starting, clients,
}: {
  open: boolean; onClose: () => void;
  onStart: (cfg: { num_rounds: number; local_epochs: number; learning_rate: number; min_clients: number; use_he: boolean; client_ids?: string[] }) => void;
  starting: boolean;
  clients: FLClient[];
}) {
  const [rounds, setRounds] = useState(5);
  const [epochs, setEpochs] = useState(3);
  const [lr, setLr] = useState(0.001);
  const [minClients, setMinClients] = useState(2);
  const [useHE, setUseHE] = useState(true);
  const [selectedClients, setSelectedClients] = useState<Set<string>>(() => new Set(clients.map((c) => c.client_id)));
  const [selectAll, setSelectAll] = useState(true);

  const toggleClient = (id: string) => {
    setSelectedClients((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      setSelectAll(next.size === clients.length);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectAll) {
      setSelectedClients(new Set());
    } else {
      setSelectedClients(new Set(clients.map((c) => c.client_id)));
    }
    setSelectAll(!selectAll);
  };

  if (!open) return null;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.45)' }} onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
        className="card" style={{ position: 'relative', zIndex: 101, width: 440, maxWidth: '95vw', padding: 28 }}
      >
        <div className="flex items-center justify-between" style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>Start FL Training</h2>
          <button className="btn btn-ghost" onClick={onClose} style={{ width: 32, height: 32, padding: 0 }}>
            <X style={{ width: 16, height: 16 }} />
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Rounds */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
              Number of Rounds
            </label>
            <input type="number" min={1} max={100} value={rounds} onChange={(e) => setRounds(+e.target.value)}
              className="input" style={{ width: '100%' }} />
          </div>
          {/* Local Epochs */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
              Local Epochs per Round
            </label>
            <input type="number" min={1} max={50} value={epochs} onChange={(e) => setEpochs(+e.target.value)}
              className="input" style={{ width: '100%' }} />
          </div>
          {/* Learning Rate */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
              Learning Rate
            </label>
            <input type="number" min={0.0001} max={1} step={0.0001} value={lr} onChange={(e) => setLr(+e.target.value)}
              className="input" style={{ width: '100%' }} />
          </div>
          {/* Min Clients */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
              Minimum Clients
            </label>
            <input type="number" min={1} max={10} value={minClients} onChange={(e) => setMinClients(+e.target.value)}
              className="input" style={{ width: '100%' }} />
          </div>
          {/* Use HE */}
          <label className="flex items-center gap-3" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={useHE} onChange={(e) => setUseHE(e.target.checked)}
              style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />
            <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>Enable CKKS Homomorphic Encryption</span>
          </label>

          {/* Client Picker */}
          {clients.length > 0 && (
            <div>
              <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
                  Select Clients ({selectedClients.size} / {clients.length})
                </label>
                <button type="button" className="btn btn-ghost" style={{ fontSize: 11, padding: '2px 8px', height: 22 }}
                  onClick={toggleAll}>
                  {selectAll ? 'Deselect All' : 'Select All'}
                </button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 160, overflowY: 'auto',
                padding: 8, borderRadius: 8, background: 'var(--bg-primary)', border: '1px solid var(--border)' }}>
                {clients.map((c) => (
                  <label key={c.client_id} className="flex items-center gap-3" style={{ cursor: 'pointer', padding: '4px 6px', borderRadius: 6 }}>
                    <input type="checkbox" checked={selectedClients.has(c.client_id)}
                      onChange={() => toggleClient(c.client_id)}
                      style={{ width: 14, height: 14, accentColor: 'var(--accent)' }} />
                    <span style={{ fontSize: 12, color: 'var(--text-primary)', flex: 1 }}>{c.name || c.client_id}</span>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{c.client_id}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3" style={{ marginTop: 28 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={starting || selectedClients.size === 0}
            onClick={() => onStart({
              num_rounds: rounds, local_epochs: epochs, learning_rate: lr,
              min_clients: Math.min(minClients, selectedClients.size), use_he: useHE,
              client_ids: selectAll ? undefined : [...selectedClients],
            })}
          >
            {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play style={{ width: 14, height: 14 }} />}
            {starting ? 'Starting\u2026' : 'Start Training'}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

/* ══════════════════════════════════════════════════
   Pipeline Visualization
   ══════════════════════════════════════════════════ */
function PipelineVis({ activeStep, clients }: { activeStep: string; clients: Record<string, FLClientProgress> }) {
  const clientEntries = Object.values(clients);
  const activeIdx = PIPELINE_STEPS.findIndex((s) => s.key === activeStep);

  return (
    <div style={{ padding: '24px 0' }}>
      {/* Server Node */}
      <div className="flex justify-center" style={{ marginBottom: 24 }}>
        <div className="card flex items-center gap-3" style={{
          padding: '12px 24px', borderColor: '#A855F7', borderWidth: 2,
        }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#A855F7', fontFamily: 'inherit' }}>&gt;</span>
          <div>
            <p style={{ fontSize: 14, fontWeight: 700, color: '#A855F7' }}>FL Server</p>
            <p style={{ fontSize: 10, color: 'var(--text-muted)' }}>FedAvg + CKKS Aggregation</p>
          </div>
        </div>
      </div>

      {/* Connection Lines + Step Pills */}
      <div className="flex items-center justify-center gap-2 flex-wrap" style={{ marginBottom: 24 }}>
        {PIPELINE_STEPS.map((step, i) => {
          const isActive = i === activeIdx;
          const isPast = i < activeIdx;
          return (
            <div key={step.key} className="flex items-center">
              <motion.div
                animate={{
                  scale: isActive ? 1.08 : 1,
                }}
                transition={{ duration: 0.5, repeat: isActive ? Infinity : 0, repeatType: 'reverse' }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 16px', borderRadius: 3,
                  background: isActive ? step.color : isPast ? `${step.color}22` : 'var(--bg-secondary)',
                  color: isActive ? '#fff' : isPast ? step.color : 'var(--text-muted)',
                  border: `1.5px solid ${isActive || isPast ? step.color : 'var(--border)'}`,
                  fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
                  fontFamily: 'inherit',
                }}
              >
                {step.label}
              </motion.div>
              {i < PIPELINE_STEPS.length - 1 && (
                <div style={{ position: 'relative', width: 32, height: 2, background: 'var(--border)', margin: '0 2px' }}>
                  {isPast && (
                    <motion.div
                      initial={{ width: 0 }} animate={{ width: '100%' }}
                      style={{ position: 'absolute', top: 0, left: 0, height: '100%', background: step.color, borderRadius: 1 }}
                    />
                  )}
                  {isActive && (
                    <motion.div
                      animate={{ left: ['0%', '80%'] }}
                      transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
                      style={{ position: 'absolute', top: -2, width: 6, height: 6, borderRadius: '50%', background: step.color }}
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Client Nodes */}
      {clientEntries.length > 0 && (
        <div className="flex justify-center gap-4 flex-wrap">
          {clientEntries.map((c) => {
            const color = getClientStatusColor(c.status);
            return (
              <div key={c.client_id} className="card" style={{
                padding: 14, minWidth: 140, textAlign: 'center',
                borderColor: color, borderWidth: 1.5,
              }}>
                <span style={{ fontSize: 14, fontWeight: 700, color, display: 'block', marginBottom: 6, fontFamily: 'inherit' }}>&gt;</span>
                <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{c.client_id}</p>
                <span className="badge" style={{
                  background: getClientStatusBg(c.status), color, fontSize: 10,
                  marginTop: 6, display: 'inline-block', textTransform: 'capitalize',
                }}>
                  {c.status}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════
   Client Progress Card
   ══════════════════════════════════════════════════ */
/** Format seconds into human-readable "Xm Ys" or "Xs" */
function fmtEta(sec: number | undefined): string {
  if (sec == null || sec <= 0) return '—';
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/** Format "last update" relative time */
function fmtAgo(iso: string | undefined): string {
  if (!iso) return '';
  const diff = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  return `${Math.floor(diff / 60)}m ${diff % 60}s ago`;
}

function ClientProgressCard({ progress, lossHistory }: { progress: FLClientProgress; lossHistory: number[] }) {
  const color = getClientStatusColor(progress.status);
  const pct = Math.min(100, Math.max(0, progress.progress_pct));

  const hasBatchDetail = progress.batch != null && progress.total_batches != null;
  const hasThroughput = progress.throughput != null && progress.throughput > 0;
  const hasSampleDetail = progress.samples_processed != null && progress.total_samples != null;

  // Build mini loss curve data
  const lossCurve = lossHistory.map((v, i) => ({ epoch: i + 1, loss: v }));

  // Rerender every 5s to keep "ago" fresh
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!progress.last_update_time) return;
    const iv = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(iv);
  }, [progress.last_update_time]);

  return (
    <motion.div layout className="card" style={{ padding: 16, borderLeft: `3px solid ${color}` }}>
      {/* Header */}
      <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
        <div className="flex items-center gap-2">
          <span style={{ fontSize: 12, fontWeight: 700, color, fontFamily: 'inherit' }}>&gt;</span>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{progress.client_id}</span>
        </div>
        <span className="badge" style={{ background: getClientStatusBg(progress.status), color, textTransform: 'capitalize' }}>
          {progress.status}
        </span>
      </div>

      {/* Progress Bar */}
      <div style={{ marginBottom: 8 }}>
        <div className="flex items-center justify-between" style={{ marginBottom: 4 }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            {hasBatchDetail
              ? `Batch ${progress.batch}/${progress.total_batches} · Epoch ${progress.current_epoch}/${progress.total_epochs}`
              : `Epoch ${progress.current_epoch} / ${progress.total_epochs}`}
          </span>
          <span style={{ fontSize: 11, fontWeight: 700, color }}>{pct.toFixed(0)}%</span>
        </div>
        <div style={{ width: '100%' }}>
          <span style={{ fontSize: 11, fontFamily: 'inherit', color }}>
            {(() => { const total = 20; const filled = Math.round((pct / 100) * total); return `[${'█'.repeat(filled)}${'░'.repeat(total - filled)}]`; })()}
          </span>
        </div>
      </div>

      {/* Sample / throughput / ETA line */}
      {(hasSampleDetail || hasThroughput) && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.6 }}>
          {hasSampleDetail && (
            <span>
              {progress.samples_processed!.toLocaleString()} / {progress.total_samples!.toLocaleString()} samples
            </span>
          )}
          {hasThroughput && (
            <span style={{ marginLeft: hasSampleDetail ? 8 : 0 }}>
              · {progress.throughput!.toLocaleString()} samp/s
            </span>
          )}
          {progress.eta_seconds != null && progress.eta_seconds > 0 && (
            <span style={{ marginLeft: 8 }}>
              · ETA {fmtEta(progress.eta_seconds)}
            </span>
          )}
        </div>
      )}

      {/* Metrics Grid */}
      <div className="grid grid-cols-3 gap-2" style={{ marginBottom: 8 }}>
        <div style={{ padding: '6px 8px', borderRadius: 6, background: 'var(--bg-primary)', textAlign: 'center' }}>
          <p style={{ fontSize: 9, color: 'var(--text-muted)' }}>Loss</p>
          <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
            {(progress.current_loss ?? progress.local_loss).toFixed(4)}
          </p>
        </div>
        <div style={{ padding: '6px 8px', borderRadius: 6, background: 'var(--bg-primary)', textAlign: 'center' }}>
          <p style={{ fontSize: 9, color: 'var(--text-muted)' }}>Accuracy</p>
          <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--success)' }}>
            {((progress.current_accuracy ?? progress.local_accuracy) * 100).toFixed(1)}%
          </p>
        </div>
        <div style={{ padding: '6px 8px', borderRadius: 6, background: 'var(--bg-primary)', textAlign: 'center' }}>
          <p style={{ fontSize: 9, color: 'var(--text-muted)' }}>Samples</p>
          <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
            {(progress.samples_processed ?? progress.num_samples).toLocaleString()}
          </p>
        </div>
      </div>

      {/* Last update */}
      {progress.last_update_time && (
        <p style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: lossCurve.length > 1 ? 8 : 0 }}>
          Last update: {fmtAgo(progress.last_update_time)}
        </p>
      )}

      {/* Mini Loss Curve */}
      {lossCurve.length > 1 && (
        <div style={{ height: 60 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={lossCurve}>
              <Line type="monotone" dataKey="loss" stroke={color} strokeWidth={1.5} dot={false} />
              <YAxis hide domain={['dataMin', 'dataMax']} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </motion.div>
  );
}

/* ══════════════════════════════════════════════════
   Main Page
   ══════════════════════════════════════════════════ */
export default function FLTrainingPage() {
  // ── API state ──
  const [status, setStatus] = useState<FLStatus | null>(null);
  const [rounds, setRounds] = useState<FLRound[]>([]);
  const [clients, setClients] = useState<FLClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false);

  // ── Replay state ──
  const [replayIdx, setReplayIdx] = useState<number | null>(null);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState(1);
  const replayTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Metrics & Analytics state ──
  const [selectedMetricsClient, setSelectedMetricsClient] = useState<string>('');
  const [clientRoundDetails, setClientRoundDetails] = useState<FLRoundDetail[]>([]);
  const [loadingClientMetrics, setLoadingClientMetrics] = useState(false);

  // ── Live store ──
  const flGlobal = useLiveStore((s) => s.flGlobalProgress);
  const flClientProgress = useLiveStore((s) => s.flClientProgress);
  const liveRoundResults = useLiveStore((s) => s.flRoundResults);
  const flClientRoundHistory = useLiveStore((s) => s.flClientRoundHistory);
  const clearFLProgress = useLiveStore((s) => s.clearFLProgress);
  const clearFLRoundResults = useLiveStore((s) => s.clearFLRoundResults);
  const clearFLClientRoundHistory = useLiveStore((s) => s.clearFLClientRoundHistory);

  // ── Loss history per client (for mini sparklines) ──
  const clientLossHistoryRef = useRef<Record<string, number[]>>({});
  useEffect(() => {
    Object.entries(flClientProgress).forEach(([clientId, p]) => {
      if (p.local_loss > 0) {
        const hist = clientLossHistoryRef.current[clientId] ?? [];
        if (hist.length === 0 || hist[hist.length - 1] !== p.local_loss) {
          clientLossHistoryRef.current[clientId] = [...hist, p.local_loss].slice(-30);
        }
      }
    });
  }, [flClientProgress]);

  // ── Determine mode ──
  const isLive = flGlobal?.is_training === true;

  // ── Fetch initial data ──
  const fetchData = useCallback(() => {
    Promise.all([
      flApi.status().catch(() => null),
      flApi.rounds().catch(() => []),
      flApi.clients().catch(() => []),
    ]).then(([s, r, c]) => {
      setStatus(s);
      setRounds(r);
      setClients(c);
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Refresh rounds when a live round completes ──
  useEffect(() => {
    if (liveRoundResults.length > 0) {
      flApi.rounds().then(setRounds).catch(() => {});
    }
  }, [liveRoundResults.length]);

  // ── Refresh status + clients when training stops ──
  const prevIsTraining = useRef(false);
  useEffect(() => {
    const wasTraining = prevIsTraining.current;
    const nowTraining = flGlobal?.is_training === true;
    prevIsTraining.current = nowTraining;

    // When transitioning from training → not training, refresh everything
    if (wasTraining && !nowTraining) {
      // Small delay to let backend reset client statuses
      setTimeout(() => fetchData(), 500);
    }
    // Also handle legacy check
    if (flGlobal && !flGlobal.is_training && status?.is_training) {
      setTimeout(() => fetchData(), 500);
    }
  }, [flGlobal, status, fetchData]);

  // ── Fetch per-round client metrics when a client is selected ──
  useEffect(() => {
    if (!selectedMetricsClient || rounds.length === 0) {
      setClientRoundDetails([]);
      return;
    }
    let cancelled = false;
    setLoadingClientMetrics(true);
    // Fetch all round details (they include client_metrics)
    Promise.all(
      rounds.map((r) => flApi.round(r.round_number).catch(() => null))
    ).then((details) => {
      if (cancelled) return;
      setClientRoundDetails(details.filter((d): d is FLRoundDetail => d !== null));
    }).finally(() => {
      if (!cancelled) setLoadingClientMetrics(false);
    });
    return () => { cancelled = true; };
  }, [selectedMetricsClient, rounds]);

  // ── Start training ──
  const handleStart = useCallback(async (cfg: {
    num_rounds: number; local_epochs: number; learning_rate: number;
    min_clients: number; use_he: boolean; client_ids?: string[];
  }) => {
    setStarting(true);
    setError(null);
    try {
      clearFLProgress();
      clearFLRoundResults();
      clearFLClientRoundHistory();
      clientLossHistoryRef.current = {};

      // Determine optimistic client list: explicit selection, or all registered clients
      const optimisticClientIds = cfg.client_ids ?? clients.map((c) => c.client_id);

      // Set initial live state immediately so widgets aren't blank (Fix 3)
      useLiveStore.getState().setFLGlobalProgress({
        is_training: true,
        current_round: 0,
        total_rounds: cfg.num_rounds,
        global_loss: null,
        global_accuracy: null,
        use_he: cfg.use_he,
        expected_clients: optimisticClientIds.length,
      });

      // Pre-populate client progress cards so they render instantly
      for (const cid of optimisticClientIds) {
        useLiveStore.getState().setFLClientProgress(cid, {
          client_id: cid,
          status: 'waiting',
          current_epoch: 0,
          total_epochs: 0,
          local_loss: 0,
          local_accuracy: 0,
          num_samples: 0,
          progress_pct: 0,
        });
      }

      const resp = await flApi.start(cfg);
      setConfigOpen(false);

      // Refine client list from API response (authoritative)
      if (resp.client_ids && Array.isArray(resp.client_ids)) {
        const currentProgress = useLiveStore.getState().flClientProgress;
        // Remove any optimistic clients NOT in the actual response
        const responseSet = new Set(resp.client_ids);
        for (const cid of Object.keys(currentProgress)) {
          if (!responseSet.has(cid)) {
            const updated = { ...useLiveStore.getState().flClientProgress };
            delete updated[cid];
            useLiveStore.setState({ flClientProgress: updated });
          }
        }
        // Add any response clients missing from optimistic set
        for (const cid of resp.client_ids) {
          if (!currentProgress[cid]) {
            useLiveStore.getState().setFLClientProgress(cid, {
              client_id: cid,
              status: 'waiting',
              current_epoch: 0,
              total_epochs: 0,
              local_loss: 0,
              local_accuracy: 0,
              num_samples: 0,
              progress_pct: 0,
            });
          }
        }
      }

      fetchData();
    } catch (e: unknown) {
      // Revert optimistic live state on error
      useLiveStore.getState().clearFLProgress();
      const msg = e instanceof Error ? e.message : 'Failed to start training';
      setError(msg);
    } finally {
      setStarting(false);
    }
  }, [clearFLProgress, clearFLRoundResults, clearFLClientRoundHistory, fetchData, clients]);

  // ── Stop training ──
  const handleStop = useCallback(async () => {
    setStopping(true);
    setError(null);
    try {
      await flApi.stop();
      fetchData();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to stop training';
      setError(msg);
    } finally {
      setStopping(false);
    }
  }, [fetchData]);

  // ── Chart data: all training sessions with session labels ──
  const chartData = useMemo(() => {
    // Detect session boundaries: round_number resets to 1
    let sessionNum = 0;
    const data: Array<{ round: string; roundNum: number; accuracy: number | null; loss: number | null; session: number; id: number }> = [];
    for (let i = 0; i < rounds.length; i++) {
      const r = rounds[i];
      if (r.round_number === 1) sessionNum++;
      data.push({
        round: `S${sessionNum}·R${r.round_number}`,
        roundNum: r.round_number,
        accuracy: r.global_accuracy ? +(r.global_accuracy * 100).toFixed(1) : null,
        loss: r.global_loss ? +r.global_loss.toFixed(4) : null,
        session: sessionNum,
        id: r.id,
      });
    }
    // Append live results not yet in API
    const seenIds = new Set(rounds.map((r) => r.round_number + '_' + sessionNum));
    for (const lr of liveRoundResults) {
      const key = lr.round + '_' + (sessionNum || 1);
      if (!seenIds.has(key)) {
        data.push({
          round: sessionNum > 0 ? `S${sessionNum}·R${lr.round}` : `R${lr.round}`,
          roundNum: lr.round,
          accuracy: lr.accuracy ? +(lr.accuracy * 100).toFixed(1) : null,
          loss: lr.loss ? +lr.loss.toFixed(4) : null,
          session: sessionNum || 1,
          id: 0,
        });
      }
    }
    return data;
  }, [rounds, liveRoundResults]);

  // ── Per-client chart data (multi-line) ──
  const clientChartData = useMemo(() => {
    // Collect all unique round numbers
    const roundSet = new Set<number>();
    for (const entries of Object.values(flClientRoundHistory)) {
      for (const e of entries) roundSet.add(e.round);
    }
    const sortedRounds = [...roundSet].sort((a, b) => a - b);
    const clientIds = Object.keys(flClientRoundHistory);
    // Build [{round: 'R1', bank_a_acc: 95.2, bank_a_loss: 0.12, bank_b_acc: ...}, ...]
    return sortedRounds.map((r) => {
      const row: Record<string, string | number | null> = { round: `R${r}` };
      for (const cid of clientIds) {
        const entry = flClientRoundHistory[cid]?.find((e) => e.round === r);
        row[`${cid}_acc`] = entry ? +(entry.accuracy * 100).toFixed(1) : null;
        row[`${cid}_loss`] = entry ? +entry.loss.toFixed(4) : null;
      }
      return row;
    });
  }, [flClientRoundHistory]);

  const clientChartIds = useMemo(() => Object.keys(flClientRoundHistory), [flClientRoundHistory]);

  // ── Selected client metrics from API round details ──
  const selectedClientMetrics = useMemo(() => {
    if (!selectedMetricsClient || clientRoundDetails.length === 0) return [];
    return clientRoundDetails
      .map((rd) => {
        const cm = rd.client_metrics.find((m) => m.client_id === selectedMetricsClient);
        if (!cm) return null;
        return {
          round: `R${rd.round_number}`,
          roundNum: rd.round_number,
          accuracy: +(cm.local_accuracy * 100).toFixed(1),
          loss: +cm.local_loss.toFixed(4),
          samples: cm.num_samples,
          training_time: +cm.training_time_sec.toFixed(1),
          encrypted: cm.encrypted,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => a.roundNum - b.roundNum);
  }, [selectedMetricsClient, clientRoundDetails]);

  // ── Global metrics summary from historical rounds ──
  const globalMetricsSummary = useMemo(() => {
    if (rounds.length === 0) return null;
    const latest = rounds[rounds.length - 1];
    const avgDuration = rounds.reduce((sum, r) => sum + (r.duration_seconds ?? 0), 0) / rounds.length;
    const bestAccRound = rounds.reduce((best, r) =>
      (r.global_accuracy ?? 0) > (best.global_accuracy ?? 0) ? r : best, rounds[0]);
    const bestLossRound = rounds.reduce((best, r) => {
      if (r.global_loss == null) return best;
      if (best.global_loss == null) return r;
      return r.global_loss < best.global_loss ? r : best;
    }, rounds[0]);
    return { latest, avgDuration, bestAccRound, bestLossRound, totalRounds: rounds.length };
  }, [rounds]);

  // ── Replay controls ──
  const replayRound = replayIdx !== null && replayIdx < chartData.length
    ? chartData[replayIdx] : null;

  useEffect(() => {
    if (replayPlaying && chartData.length > 0) {
      replayTimerRef.current = setInterval(() => {
        setReplayIdx((prev) => {
          const next = (prev ?? -1) + 1;
          if (next >= chartData.length) {
            setReplayPlaying(false);
            return chartData.length - 1;
          }
          return next;
        });
      }, 1500 / replaySpeed);
    }
    return () => {
      if (replayTimerRef.current) clearInterval(replayTimerRef.current);
    };
  }, [replayPlaying, replaySpeed, chartData.length]);

  // ── Derived values ──
  const globalProgress = flGlobal
    ? Math.min(100, ((flGlobal.current_round ?? 0) / Math.max(flGlobal.total_rounds, 1)) * 100)
    : 0;

  // Filter out phantom clients (Flower UUIDs like "ipv4:...") — only show registered client_ids
  const registeredClientIds = useMemo(() => new Set(clients.map((c) => c.client_id)), [clients]);
  const clientProgressEntries = useMemo(() => {
    const entries = Object.values(flClientProgress);
    // If we have registered clients, filter to only those
    if (registeredClientIds.size > 0) {
      return entries.filter((cp) => registeredClientIds.has(cp.client_id));
    }
    return entries;
  }, [flClientProgress, registeredClientIds]);
  const activeStep = clientProgressEntries.length > 0
    ? statusToStep(clientProgressEntries[0].status)
    : 'distribute';

  const latestApiRound = rounds.length > 0 ? rounds[rounds.length - 1] : null;

  // ── Loading ──
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin" style={{ color: 'var(--accent)' }} />
      </div>
    );
  }

  return (
    <motion.div variants={stagger} initial="hidden" animate="show" className="page-stack">
      {/* Config Modal */}
      <ConfigModal key={clients.map(c => c.client_id).join(',')} open={configOpen} onClose={() => setConfigOpen(false)} onStart={handleStart} starting={starting} clients={clients} />

      {/* ════════════════════════════════════════════════════
         HEADER
         ════════════════════════════════════════════════════ */}
      <motion.div variants={fadeUp} className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>
            Federated Learning
            {isLive && (
              <span style={{ marginLeft: 10, fontSize: 12, fontWeight: 700, color: 'var(--success)', verticalAlign: 'middle' }}>
                ● TRAINING
              </span>
            )}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          {/* Action buttons */}
          {isLive ? (
            <button className="btn" onClick={handleStop} disabled={stopping} style={{
              background: 'var(--danger)', color: '#fff', border: 'none',
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              {stopping ? <Loader2 className="w-4 h-4 animate-spin" /> : <Square style={{ width: 14, height: 14 }} />}
              {stopping ? 'Stopping\u2026' : 'Stop Training'}
            </button>
          ) : (
            <button className="btn btn-primary" onClick={() => setConfigOpen(true)} style={{
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <Settings style={{ width: 14, height: 14 }} />
              Start Training
            </button>
          )}
        </div>
      </motion.div>

      {/* Error */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            className="card" style={{ padding: '12px 16px', borderColor: 'var(--danger)', borderWidth: 1.5, background: 'var(--danger-light)' }}
          >
            <div className="flex items-center gap-2">
              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--danger)' }}>!</span>
              <span style={{ fontSize: 13, color: 'var(--danger)', fontWeight: 600 }}>{error}</span>
              <button className="btn btn-ghost" style={{ marginLeft: 'auto', height: 24, width: 24, padding: 0 }} onClick={() => setError(null)}>
                <X style={{ width: 14, height: 14 }} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ════════════════════════════════════════════════════
         KPI STRIP
         ════════════════════════════════════════════════════ */}
      <div className="grid grid-cols-2 sm:grid-cols-2 gap-5">
        {[
          {
            label: 'Rounds',
            value: isLive
              ? `${flGlobal?.current_round ?? 0} / ${flGlobal?.total_rounds ?? 0}`
              : `${status?.total_rounds_completed ?? rounds.length}`,
            color: 'var(--accent)',
          },
          {
            label: 'Clients',
            value: isLive
              ? (clientProgressEntries.length || flGlobal?.expected_clients || clients.length)
              : (status?.active_clients ?? clients.length),
            color: 'var(--warning)',
          },
        ].map((kpi) => (
            <motion.div key={kpi.label} variants={fadeUp} className="card" style={{ padding: 16 }}>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{kpi.label}</p>
              <p style={{ fontSize: 20, fontWeight: 700, color: kpi.color }}>{kpi.value}</p>
            </motion.div>
        ))}
      </div>

      {/* ════════════════════════════════════════════════════
         MODE 1: LIVE TRAINING
         ════════════════════════════════════════════════════ */}
      {isLive && (
        <>
          {/* Global Progress Bar */}
          <motion.div variants={fadeUp} className="card" style={{ padding: 20 }}>
            <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
                Global Training Progress
              </h3>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--accent)' }}>
                Round {flGlobal?.current_round ?? 0} / {flGlobal?.total_rounds ?? 0}
              </span>
            </div>
            <div style={{ width: '100%', height: 10, borderRadius: 5, background: 'var(--bg-secondary)' }}>
              <motion.div
                initial={{ width: 0 }} animate={{ width: `${globalProgress}%` }}
                transition={{ duration: 0.8 }}
                style={{
                  height: '100%', borderRadius: 5,
                  background: 'linear-gradient(90deg, var(--accent), #A855F7)',
                }}
              />
            </div>
            {flGlobal?.global_accuracy != null && (
              <div className="flex gap-6" style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)' }}>
                <span>
                  Loss: <strong style={{ color: 'var(--text-primary)' }}>{flGlobal.global_loss?.toFixed(4) ?? '\u2014'}</strong>
                </span>
                <span>
                  Accuracy: <strong style={{ color: 'var(--success)' }}>{(flGlobal.global_accuracy * 100).toFixed(1)}%</strong>
                </span>
              </div>
            )}
          </motion.div>

          {/* Pipeline Visualization */}
          <motion.div variants={fadeUp} className="card" style={{ padding: 20 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>Training Pipeline</h3>
            <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>Live data flow between server and clients</p>
            <PipelineVis activeStep={activeStep} clients={flClientProgress} />
          </motion.div>

          {/* Per-Client Progress Cards */}
          {clientProgressEntries.length > 0 ? (
            <motion.div variants={fadeUp}>
              <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 12 }}>
                Client Training Progress
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {clientProgressEntries.map((cp) => (
                  <ClientProgressCard
                    key={cp.client_id}
                    progress={cp}
                    lossHistory={clientLossHistoryRef.current[cp.client_id] ?? []}
                  />
                ))}
              </div>
            </motion.div>
          ) : (
            <motion.div variants={fadeUp}>
              <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 12 }}>
                Client Training Progress
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {Array.from({ length: flGlobal?.expected_clients ?? 2 }).map((_, i) => (
                  <div key={`skeleton-${i}`} className="card" style={{ padding: 16 }}>
                    <div className="flex items-center gap-3" style={{ marginBottom: 12 }}>
                      <div style={{
                        width: 10, height: 10, borderRadius: '50%',
                        background: 'var(--text-muted)', opacity: 0.3,
                        animation: 'pulse 1.5s ease-in-out infinite',
                      }} />
                      <div style={{
                        height: 14, width: 80, borderRadius: 4,
                        background: 'var(--bg-secondary)',
                        animation: 'pulse 1.5s ease-in-out infinite',
                      }} />
                    </div>
                    <div style={{
                      height: 8, borderRadius: 4, background: 'var(--bg-secondary)',
                      marginBottom: 8, animation: 'pulse 1.5s ease-in-out infinite',
                    }} />
                    <div style={{
                      height: 12, width: '60%', borderRadius: 4,
                      background: 'var(--bg-secondary)',
                      animation: 'pulse 1.5s ease-in-out infinite',
                    }} />
                    <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10, textAlign: 'center' }}>
                      Waiting for client to connect…
                    </p>
                  </div>
                ))}
              </div>
            </motion.div>
          )}

          {/* Global Metrics Summary — always visible when we have data */}
          {flGlobal && (flGlobal.global_accuracy != null || flGlobal.aggregation_method) && (
            <motion.div variants={fadeUp} className="card" style={{ padding: 20 }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 12 }}>
                Global Metrics
              </h3>
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: 'Accuracy', value: flGlobal.global_accuracy != null ? `${(flGlobal.global_accuracy * 100).toFixed(1)}%` : '—', color: 'var(--success)' },
                  { label: 'Loss', value: flGlobal.global_loss != null ? flGlobal.global_loss.toFixed(4) : '—', color: 'var(--danger)' },
                  { label: 'Round', value: `${flGlobal.current_round} / ${flGlobal.total_rounds}`, color: 'var(--accent)' },
                ].map((m) => (
                  <div key={m.label} style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--bg-primary)', textAlign: 'center' }}>
                    <p style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>{m.label}</p>
                    <p style={{ fontSize: 16, fontWeight: 700, color: m.color }}>{m.value}</p>
                  </div>
                ))}
              </div>
            </motion.div>
          )}

          {/* Live Accuracy & Loss Charts — shown as soon as any round data exists */}
          {chartData.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <motion.div variants={fadeUp} className="card" style={{ padding: 24 }}>
                <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 16 }}>
                  Global Accuracy
                  <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: 'var(--success)' }}>● LIVE</span>
                </h3>
                <div style={{ height: 220 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                      <XAxis dataKey="round" tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
                      <YAxis domain={[0, 100]} tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
                      <Tooltip {...tooltipStyle} />
                      <Line type="monotone" dataKey="accuracy" stroke="var(--accent)" strokeWidth={2} dot={{ r: 3 }} name="Accuracy %" animationDuration={400} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </motion.div>

              <motion.div variants={fadeUp} className="card" style={{ padding: 24 }}>
                <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 16 }}>
                  Global Loss
                  <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: 'var(--success)' }}>● LIVE</span>
                </h3>
                <div style={{ height: 220 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData}>
                      <defs>
                        <linearGradient id="liveGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#EF4444" stopOpacity={0.3} />
                          <stop offset="100%" stopColor="#EF4444" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                      <XAxis dataKey="round" tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
                      <Tooltip {...tooltipStyle} />
                      <Area type="monotone" dataKey="loss" stroke="#EF4444" strokeWidth={2} fill="url(#liveGrad)" dot={{ r: 3 }} name="Loss" animationDuration={400} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </motion.div>
            </div>
          )}

          {/* Per-Client Multi-line Charts — accuracy & loss per client over rounds */}
          {clientChartData.length > 0 && clientChartIds.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <motion.div variants={fadeUp} className="card" style={{ padding: 24 }}>
                <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 16 }}>
                  Per-Client Accuracy
                  <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: 'var(--success)' }}>● LIVE</span>
                </h3>
                <div style={{ height: 220 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={clientChartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                      <XAxis dataKey="round" tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
                      <YAxis domain={[0, 100]} tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
                      <Tooltip {...tooltipStyle} />
                      <Legend wrapperStyle={{ fontSize: 10 }} />
                      {clientChartIds.map((cid, i) => (
                        <Line
                          key={cid}
                          type="monotone"
                          dataKey={`${cid}_acc`}
                          stroke={CLIENT_COLORS[i % CLIENT_COLORS.length]}
                          strokeWidth={2}
                          dot={{ r: 3 }}
                          name={cid}
                          animationDuration={400}
                          connectNulls
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </motion.div>

              <motion.div variants={fadeUp} className="card" style={{ padding: 24 }}>
                <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 16 }}>
                  Per-Client Loss
                  <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: 'var(--success)' }}>● LIVE</span>
                </h3>
                <div style={{ height: 220 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={clientChartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                      <XAxis dataKey="round" tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
                      <Tooltip {...tooltipStyle} />
                      <Legend wrapperStyle={{ fontSize: 10 }} />
                      {clientChartIds.map((cid, i) => (
                        <Line
                          key={cid}
                          type="monotone"
                          dataKey={`${cid}_loss`}
                          stroke={CLIENT_COLORS[i % CLIENT_COLORS.length]}
                          strokeWidth={2}
                          dot={{ r: 3 }}
                          name={cid}
                          animationDuration={400}
                          connectNulls
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </motion.div>
            </div>
          )}
        </>
      )}

      {/* ════════════════════════════════════════════════════
         MODE 2: REPLAY / HISTORY (when NOT training)
         ════════════════════════════════════════════════════ */}
      {!isLive && chartData.length > 0 && (
        <>
          {/* Replay Controls */}
          <motion.div variants={fadeUp} className="card" style={{ padding: '14px 20px' }}>
            <div className="flex items-center gap-4 flex-wrap">
              <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>Training History</h3>
              <div className="flex-1" />

              {/* Playback controls */}
              <div className="flex items-center gap-2">
                <button className="btn btn-ghost" style={{ width: 32, height: 32, padding: 0 }}
                  onClick={() => setReplayIdx((p) => Math.max(0, (p ?? 0) - 1))}
                >
                  <SkipBack style={{ width: 14, height: 14 }} />
                </button>
                <button className="btn btn-ghost" style={{ width: 36, height: 36, padding: 0 }}
                  onClick={() => {
                    if (replayPlaying) {
                      setReplayPlaying(false);
                    } else {
                      if (replayIdx === null || replayIdx >= chartData.length - 1) setReplayIdx(0);
                      setReplayPlaying(true);
                    }
                  }}
                >
                  {replayPlaying
                    ? <Pause style={{ width: 16, height: 16 }} />
                    : <Play style={{ width: 16, height: 16 }} />}
                </button>
                <button className="btn btn-ghost" style={{ width: 32, height: 32, padding: 0 }}
                  onClick={() => setReplayIdx((p) => Math.min(chartData.length - 1, (p ?? 0) + 1))}
                >
                  <SkipForward style={{ width: 14, height: 14 }} />
                </button>
              </div>

              {/* Speed */}
              <div className="flex items-center gap-2">
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Speed:</span>
                {[0.5, 1, 2, 4].map((s) => (
                  <button key={s} className="btn btn-ghost" onClick={() => setReplaySpeed(s)} style={{
                    fontSize: 10, padding: '2px 8px', height: 24,
                    background: replaySpeed === s ? 'var(--accent)' : 'var(--bg-secondary)',
                    color: replaySpeed === s ? '#fff' : 'var(--text-muted)',
                    border: 'none', borderRadius: 4,
                  }}>
                    {s}x
                  </button>
                ))}
              </div>

              {/* Slider */}
              <input
                type="range" min={0} max={Math.max(0, chartData.length - 1)}
                value={replayIdx ?? 0}
                onChange={(e) => { setReplayPlaying(false); setReplayIdx(+e.target.value); }}
                style={{ width: 200, accentColor: 'var(--accent)' }}
              />
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)', minWidth: 50 }}>
                {replayRound?.round ?? '\u2014'}
              </span>
            </div>
          </motion.div>

          {/* Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Accuracy */}
            <motion.div variants={fadeUp} className="card" style={{ padding: 24 }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 16 }}>
                Training Accuracy
              </h3>
              <div style={{ height: 240 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={replayIdx !== null ? chartData.slice(0, replayIdx + 1) : chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="round" tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis domain={[0, 100]} tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
                    <Tooltip {...tooltipStyle} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="accuracy" stroke="var(--accent)" strokeWidth={2} dot={{ r: 3 }} name="Accuracy %" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </motion.div>

            {/* Loss */}
            <motion.div variants={fadeUp} className="card" style={{ padding: 24 }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 16 }}>
                Training Loss
              </h3>
              <div style={{ height: 240 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={replayIdx !== null ? chartData.slice(0, replayIdx + 1) : chartData}>
                    <defs>
                      <linearGradient id="lossGrad2" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#EF4444" stopOpacity={0.3} />
                        <stop offset="100%" stopColor="#EF4444" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="round" tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
                    <Tooltip {...tooltipStyle} />
                    <Area type="monotone" dataKey="loss" stroke="#EF4444" strokeWidth={2} fill="url(#lossGrad2)" dot={{ r: 3 }} name="Loss" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </motion.div>
          </div>

          {/* Round Detail — Selected round or latest */}
          {(() => {
            const displayRound = replayRound ?? (latestApiRound ? {
              round: `R${latestApiRound.round_number}`,
              roundNum: latestApiRound.round_number,
              accuracy: latestApiRound.global_accuracy ? +(latestApiRound.global_accuracy * 100).toFixed(1) : null,
              loss: latestApiRound.global_loss ? +latestApiRound.global_loss.toFixed(4) : null,
              id: latestApiRound.id,
            } : null);
            if (!displayRound) return null;
            const matchedRound = displayRound.id
              ? rounds.find((r) => r.id === displayRound.id)
              : rounds.find((r) => r.round_number === displayRound.roundNum);
            return (
              <motion.div variants={fadeUp} className="card" style={{ padding: 24 }}>
                <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 12 }}>
                  {replayRound ? `Replaying: ${displayRound.round}` : `Latest Round: ${displayRound.round}`}
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
                  {[
                    { label: 'Accuracy', value: displayRound.accuracy != null ? `${displayRound.accuracy}%` : '\u2014' },
                    { label: 'Loss', value: displayRound.loss?.toFixed(4) ?? '\u2014' },
                    { label: 'F1 Score', value: matchedRound?.global_f1 ? `${(matchedRound.global_f1 * 100).toFixed(1)}%` : '\u2014' },
                    { label: 'Precision', value: matchedRound?.global_precision ? `${(matchedRound.global_precision * 100).toFixed(1)}%` : '\u2014' },
                    { label: 'Clients', value: matchedRound?.num_clients ?? '\u2014' },
                    { label: 'Duration', value: matchedRound?.duration_seconds ? `${matchedRound.duration_seconds.toFixed(1)}s` : '\u2014' },
                  ].map((m) => (
                    <div key={m.label} style={{ padding: 12, borderRadius: 8, background: 'var(--bg-primary)', textAlign: 'center' }}>
                      <p style={{ fontSize: 10, color: 'var(--text-muted)' }}>{m.label}</p>
                      <p style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', marginTop: 2 }}>{m.value}</p>
                    </div>
                  ))}
                </div>
              </motion.div>
            );
          })()}
        </>
      )}

      {/* ════════════════════════════════════════════════════
         METRICS & ANALYTICS (always visible when data exists)
         ════════════════════════════════════════════════════ */}
      {(chartData.length > 0 || globalMetricsSummary) && (
        <>
          {/* Section Header */}
          <motion.div variants={fadeUp} style={{ marginTop: 8 }}>
            <div className="flex items-center gap-3" style={{ marginBottom: 16 }}>
              <div>
                <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>
                  Metrics &amp; Analytics
                </h2>
                <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  Global performance overview and per-client breakdown
                </p>
              </div>
            </div>
          </motion.div>

          {/* ── Global Metrics Overview Card ── */}
          {globalMetricsSummary && (
            <motion.div variants={fadeUp} className="card" style={{ padding: 24, borderLeft: '3px solid var(--accent)' }}>
              <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 16 }}>
                Global Model Performance
              </h3>

              {/* Primary metrics row */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3" style={{ marginBottom: 16 }}>
                {[
                  {
                    label: 'Accuracy',
                    value: globalMetricsSummary.latest.global_accuracy != null
                      ? `${(globalMetricsSummary.latest.global_accuracy * 100).toFixed(1)}%` : '—',
                    color: 'var(--success)',
                    sub: globalMetricsSummary.bestAccRound.global_accuracy != null
                      ? `Best: ${(globalMetricsSummary.bestAccRound.global_accuracy * 100).toFixed(1)}% (R${globalMetricsSummary.bestAccRound.round_number})`
                      : undefined,
                  },
                  {
                    label: 'Loss',
                    value: globalMetricsSummary.latest.global_loss != null
                      ? globalMetricsSummary.latest.global_loss.toFixed(4) : '—',
                    color: 'var(--danger)',
                    sub: globalMetricsSummary.bestLossRound.global_loss != null
                      ? `Best: ${globalMetricsSummary.bestLossRound.global_loss.toFixed(4)} (R${globalMetricsSummary.bestLossRound.round_number})`
                      : undefined,
                  },
                  {
                    label: 'F1 Score',
                    value: globalMetricsSummary.latest.global_f1 != null
                      ? `${(globalMetricsSummary.latest.global_f1 * 100).toFixed(1)}%` : '—',
                    color: '#8B5CF6',
                  },
                  {
                    label: 'Precision',
                    value: globalMetricsSummary.latest.global_precision != null
                      ? `${(globalMetricsSummary.latest.global_precision * 100).toFixed(1)}%` : '—',
                    color: '#F59E0B',
                  },
                  {
                    label: 'Recall',
                    value: globalMetricsSummary.latest.global_recall != null
                      ? `${(globalMetricsSummary.latest.global_recall * 100).toFixed(1)}%` : '—',
                    color: '#EC4899',
                  },
                  {
                    label: 'Total Rounds',
                    value: globalMetricsSummary.totalRounds,
                    color: 'var(--accent)',
                  },
                ].map((m) => (
                  <div key={m.label} style={{
                    padding: '12px 14px', borderRadius: 10,
                    background: 'var(--bg-primary)', textAlign: 'center',
                    border: '1px solid var(--border)',
                  }}>
                    <p style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      {m.label}
                    </p>
                    <p style={{ fontSize: 22, fontWeight: 800, color: m.color }}>{m.value}</p>
                    {m.sub && (
                      <p style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 4 }}>{m.sub}</p>
                    )}
                  </div>
                ))}
              </div>


            </motion.div>
          )}

          {/* ── Per-Client Metrics Section ── */}
          <motion.div variants={fadeUp} className="card" style={{ padding: 24, borderLeft: '3px solid #8B5CF6' }}>
            <div className="flex items-center justify-between flex-wrap gap-3" style={{ marginBottom: 16 }}>
              <div className="flex items-center gap-2">
                <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
                  Per-Client Analytics
                </h3>
              </div>

              {/* Client Selector Dropdown */}
              <div style={{ position: 'relative' }}>
                <select
                  value={selectedMetricsClient}
                  onChange={(e) => setSelectedMetricsClient(e.target.value)}
                  style={{
                    appearance: 'none',
                    padding: '8px 36px 8px 14px',
                    borderRadius: 8,
                    border: '1px solid var(--border)',
                    background: 'var(--bg-primary)',
                    color: 'var(--text-primary)',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: 'pointer',
                    minWidth: 200,
                    outline: 'none',
                  }}
                >
                  <option value="">Select a client…</option>
                  {clients.map((c) => (
                    <option key={c.client_id} value={c.client_id}>
                      {c.name || c.client_id}
                    </option>
                  ))}
                </select>
                <ChevronDown style={{
                  position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                  width: 16, height: 16, color: 'var(--text-muted)', pointerEvents: 'none',
                }} />
              </div>
            </div>

            {!selectedMetricsClient ? (
              <div style={{ textAlign: 'center', padding: '32px 16px' }}>
                <span style={{ fontSize: 24, color: 'var(--text-muted)', display: 'block', margin: '0 auto 12px', opacity: 0.3 }}>[ ]</span>
                <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                  Select a client from the dropdown to view its per-round training metrics.
                </p>
              </div>
            ) : loadingClientMetrics ? (
              <div className="flex items-center justify-center" style={{ padding: 32 }}>
                <Loader2 className="w-6 h-6 animate-spin" style={{ color: '#8B5CF6' }} />
                <span style={{ marginLeft: 8, fontSize: 13, color: 'var(--text-muted)' }}>Loading client metrics…</span>
              </div>
            ) : selectedClientMetrics.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '24px 16px' }}>
                <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                  No metric data found for <strong>{selectedMetricsClient}</strong>.
                </p>
              </div>
            ) : (
              <>
                {/* Client Summary Stats */}
                {(() => {
                  const latestCM = selectedClientMetrics[selectedClientMetrics.length - 1];
                  const bestAcc = selectedClientMetrics.reduce((best, m) => m.accuracy > best.accuracy ? m : best);
                  const avgLoss = selectedClientMetrics.reduce((sum, m) => sum + m.loss, 0) / selectedClientMetrics.length;
                  const totalSamples = selectedClientMetrics.reduce((sum, m) => sum + m.samples, 0);
                  const avgTrainTime = selectedClientMetrics.reduce((sum, m) => sum + m.training_time, 0) / selectedClientMetrics.length;

                  return (
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3" style={{ marginBottom: 20 }}>
                      {[
                        { label: 'Latest Accuracy', value: `${latestCM.accuracy}%`, color: 'var(--success)' },
                        { label: 'Best Accuracy', value: `${bestAcc.accuracy}% (${bestAcc.round})`, color: '#10B981' },
                        { label: 'Latest Loss', value: latestCM.loss.toFixed(4), color: 'var(--danger)' },
                        { label: 'Avg Loss', value: avgLoss.toFixed(4), color: '#F59E0B' },
                        { label: 'Total Samples', value: totalSamples.toLocaleString(), color: 'var(--accent)' },
                        { label: 'Avg Train Time', value: `${avgTrainTime.toFixed(1)}s`, color: '#8B5CF6' },
                      ].map((m) => (
                        <div key={m.label} style={{
                          padding: '10px 12px', borderRadius: 8,
                          background: 'var(--bg-primary)', textAlign: 'center',
                          border: '1px solid var(--border)',
                        }}>
                          <p style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                            {m.label}
                          </p>
                          <p style={{ fontSize: 16, fontWeight: 700, color: m.color, marginTop: 2 }}>{m.value}</p>
                        </div>
                      ))}
                    </div>
                  );
                })()}

                {/* Per-round detail table */}
                <div style={{ marginTop: 16, overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid var(--border)' }}>
                        {['Round', 'Accuracy', 'Loss', 'Samples', 'Train Time', 'Encrypted'].map((h) => (
                          <th key={h} style={{
                            padding: '8px 12px', textAlign: 'left',
                            color: 'var(--text-muted)', fontWeight: 600, fontSize: 11,
                            textTransform: 'uppercase', letterSpacing: 0.5,
                          }}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {selectedClientMetrics.map((m) => (
                        <tr key={m.round} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--accent)' }}>{m.round}</td>
                          <td style={{ padding: '8px 12px', color: 'var(--success)', fontWeight: 600 }}>{m.accuracy}%</td>
                          <td style={{ padding: '8px 12px', color: 'var(--danger)' }}>{m.loss.toFixed(4)}</td>
                          <td style={{ padding: '8px 12px', color: 'var(--text-primary)' }}>{m.samples.toLocaleString()}</td>
                          <td style={{ padding: '8px 12px', color: 'var(--text-primary)' }}>{m.training_time}s</td>
                          <td style={{ padding: '8px 12px' }}>
                            <span style={{
                              padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600,
                              background: m.encrypted ? 'var(--success-light)' : 'var(--bg-secondary)',
                              color: m.encrypted ? 'var(--success)' : 'var(--text-muted)',
                            }}>
                              {m.encrypted ? 'Yes' : 'No'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </motion.div>
        </>
      )}

      {/* ════════════════════════════════════════════════════
         BOTTOM ROW: Strategy + CKKS + Clients (hidden)
         ════════════════════════════════════════════════════ */}
      {/* eslint-disable-next-line no-constant-binary-expression */}
      {false && <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* FedAvg Strategy */}
        <motion.div variants={fadeUp} className="card" style={{ padding: 24, borderLeft: '3px solid #A855F7' }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: '#A855F7' }}>FedAvg Aggregation</h3>
          <p style={{
            fontSize: 12, color: 'var(--text-primary)', fontFamily: 'monospace',
            marginTop: 10, padding: '8px 12px', borderRadius: 6, background: 'var(--bg-primary)',
          }}>
            w_global = \u03A3(n_k / n) \u00B7 w_k
          </p>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 }}>
            Weighted average of client model updates, proportional to each client's sample count.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 12, fontSize: 11, color: 'var(--text-muted)' }}>
            <span>1. Wait for all clients</span>
            <span style={{ color: 'var(--danger)' }}>2. Decrypt CKKS ciphertexts</span>
            <span>3. Compute weighted average</span>
            <span>4. Update global state_dict</span>
          </div>
        </motion.div>

        {/* CKKS Encryption */}
        <motion.div variants={fadeUp} className="card" style={{ padding: 24, borderLeft: '3px solid var(--danger)' }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--danger)' }}>CKKS Homomorphic Encryption</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
            {CKKS_CONFIG.map((c) => (
              <div key={c.param} className="flex items-center justify-between">
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{c.param}</span>
                <span style={{ fontSize: 11, color: 'var(--text-primary)', fontFamily: 'monospace' }}>{c.value}</span>
              </div>
            ))}
          </div>
          <div style={{
            marginTop: 12, padding: '8px 12px', borderRadius: 6,
            background: 'var(--bg-primary)', fontFamily: 'monospace', fontSize: 10, color: 'var(--danger)',
          }}>
            secret_key.decrypt(encrypted_update)
          </div>
          <p style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6, fontStyle: 'italic' }}>
            Decrypts LSTM + FC layer weights only
          </p>
        </motion.div>

        {/* FL Clients */}
        <motion.div variants={fadeUp} className="card" style={{ padding: 24, borderLeft: '3px solid var(--accent)' }}>
          <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--accent)' }}>FL Clients</h3>
          </div>

          {clients.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {clients.map((c) => {
                const liveP = flClientProgress[c.client_id];
                const dispStatus = isLive && liveP ? liveP.status : c.status;
                const statusColor = getClientStatusColor(dispStatus);
                return (
                  <div key={c.id} style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 14px', borderRadius: 8,
                    background: 'var(--bg-primary)', border: '1px solid var(--border)',
                  }}>
                    <span style={{
                      width: 8, height: 8, borderRadius: '50%', background: statusColor,
                      display: 'inline-block', flexShrink: 0,
                      animation: isLive && liveP ? 'status-pulse 2s infinite' : 'none',
                    }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{c.name || c.client_id}</p>
                      <p style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{c.data_path}</p>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <span className="badge" style={{
                        background: getClientStatusBg(dispStatus), color: statusColor,
                        textTransform: 'capitalize',
                      }}>
                        {dispStatus}
                      </span>
                      {isLive && liveP && (
                        <p style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2 }}>
                          E{liveP.current_epoch}/{liveP.total_epochs}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: 20 }}>
              No FL clients registered
            </p>
          )}
        </motion.div>
      </div>}

      {/* Empty state if no training history and not live */}
      {!isLive && chartData.length === 0 && (
        <motion.div variants={fadeUp} className="card" style={{
          padding: 48, textAlign: 'center',
        }}>
          <span style={{ fontSize: 32, color: 'var(--accent)', display: 'block', margin: '0 auto 16px', opacity: 0.4 }}>&gt;_</span>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>
            No Training History
          </h3>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 400, margin: '0 auto' }}>
            Start a Federated Learning training session to see real-time progress,
            per-client metrics, and live accuracy & loss charts.
          </p>
          <button className="btn btn-primary" style={{ marginTop: 20 }} onClick={() => setConfigOpen(true)}>
            <Settings style={{ width: 14, height: 14 }} /> Start Training
          </button>
        </motion.div>
      )}
    </motion.div>
  );
}
