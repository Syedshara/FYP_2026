import { useEffect, useState, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Loader2, Download, Network, BarChart2, Activity, AlertTriangle, Gauge } from 'lucide-react';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { predictionsApi } from '@/api/predictions';
import { devicesApi } from '@/api/devices';
import { clientsApi } from '@/api/clients';
import { useLiveStore } from '@/stores/liveStore';
import TrafficTopology from '@/components/TrafficTopology';
import type { Device, Prediction, FLClient } from '@/types';

const stagger = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { staggerChildren: 0.06 } } };
const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } };

const tooltipStyle = {
  contentStyle: {
    background: 'var(--n8n-card-bg)',
    border: '1px solid var(--n8n-card-border)',
    borderRadius: 8,
    fontSize: 12,
    color: 'var(--n8n-text-primary)',
  },
  itemStyle: { color: 'var(--n8n-accent)' },
};

/* ---------- Time range helper ---------- */
function rangeToMs(range: string): number {
  switch (range) {
    case '15m': return 15 * 60 * 1000;
    case '1h':  return 60 * 60 * 1000;
    case '6h':  return 6 * 60 * 60 * 1000;
    case '24h': return 24 * 60 * 60 * 1000;
    default:    return 60 * 60 * 1000;
  }
}

/* ---------- synthetic helpers ---------- */
function generateTimeline(predictions: Prediction[]) {
  if (predictions.length > 0) {
    return predictions.slice(0, 30).map((p) => ({
      time: new Date(p.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      score: p.score,
      label: p.label,
    }));
  }
  return Array.from({ length: 24 }, (_, i) => ({
    time: `${String(i).padStart(2, '0')}:00`,
    score: +(Math.random() * 0.4 + (i >= 10 && i <= 14 ? 0.4 : 0)).toFixed(2),
    label: i >= 10 && i <= 14 ? 'Attack' : 'Benign',
  }));
}

/* ---------- Inline styles (n8n canvas design system) ---------- */
const S = {
  kpiRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 16,
  } as React.CSSProperties,

  kpiCard: (accentColor: string): React.CSSProperties => ({
    background: 'var(--n8n-card-bg)',
    border: '1px solid var(--n8n-card-border)',
    borderRadius: 12,
    padding: '18px 22px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    position: 'relative',
    overflow: 'hidden',
  }),

  kpiAccentBar: (color: string): React.CSSProperties => ({
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 3,
    background: color,
    borderRadius: '12px 12px 0 0',
  }),

  kpiLabel: {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase' as const,
    color: 'var(--n8n-text-muted)',
  } as React.CSSProperties,

  kpiValue: (color: string): React.CSSProperties => ({
    fontSize: 28,
    fontWeight: 700,
    lineHeight: 1.1,
    color,
    fontFamily: 'inherit',
  }),

  kpiSubtext: {
    fontSize: 11,
    color: 'var(--n8n-text-muted)',
    marginTop: 2,
  } as React.CSSProperties,

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

  alertRow: {
    borderLeft: '3px solid var(--n8n-danger)',
    background: 'rgba(208, 48, 80, 0.07)',
  } as React.CSSProperties,

  normalRow: {
    borderLeft: '3px solid transparent',
  } as React.CSSProperties,

  alertLog: {
    overflowY: 'auto' as const,
    maxHeight: 180,
    fontFamily: 'inherit',
    padding: '12px 16px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
  },

  alertLogEntry: (isAlert: boolean): React.CSSProperties => ({
    fontSize: 11,
    fontFamily: 'inherit',
    color: isAlert ? 'var(--n8n-danger)' : 'var(--n8n-text-muted)',
    lineHeight: 1.5,
  }),

  tabBar: {
    display: 'flex',
    gap: 4,
  } as React.CSSProperties,

  tab: (active: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '7px 16px',
    borderRadius: 8,
    border: `1.5px solid ${active ? 'var(--n8n-accent)' : 'var(--n8n-card-border)'}`,
    background: active ? 'var(--n8n-accent-light)' : 'var(--n8n-card-bg)',
    color: active ? 'var(--n8n-accent)' : 'var(--n8n-text-muted)',
    fontSize: 13,
    fontWeight: active ? 700 : 500,
    cursor: 'pointer',
    transition: 'all 0.2s',
    fontFamily: 'inherit',
  }),

  toolbar: {
    padding: '12px 16px',
    background: 'var(--n8n-card-bg)',
    border: '1px solid var(--n8n-card-border)',
    borderRadius: 12,
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    flexWrap: 'wrap' as const,
  },

  select: {
    height: 34,
    fontSize: 12,
    padding: '0 10px',
    borderRadius: 6,
    border: '1px solid var(--n8n-card-border)',
    background: '#1e1f22',
    color: 'var(--n8n-text-primary)',
    outline: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
  } as React.CSSProperties,

  exportBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    height: 34,
    padding: '0 14px',
    borderRadius: 6,
    border: '1px solid var(--n8n-card-border)',
    background: 'transparent',
    color: 'var(--n8n-text-muted)',
    fontSize: 12,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'color 0.15s, border-color 0.15s',
  } as React.CSSProperties,

  liveTag: {
    marginLeft: 8,
    fontSize: 9,
    fontWeight: 700,
    color: 'var(--n8n-success)',
    verticalAlign: 'middle',
    letterSpacing: '0.05em',
  },

  streamingTag: {
    marginLeft: 8,
    fontSize: 9,
    fontWeight: 700,
    color: 'var(--n8n-accent)',
    verticalAlign: 'middle',
    letterSpacing: '0.05em',
  },
} as const;

/* ---------- KPI card component ---------- */
function KpiCard({
  label,
  value,
  subtext,
  color,
  icon: Icon,
}: {
  label: string;
  value: string;
  subtext?: string;
  color: string;
  icon: React.ElementType;
}) {
  return (
    <div style={S.kpiCard(color)}>
      <div style={S.kpiAccentBar(color)} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={S.kpiLabel}>{label}</span>
        <Icon style={{ width: 16, height: 16, color, opacity: 0.7 }} />
      </div>
      <span style={S.kpiValue(color)}>{value}</span>
      {subtext && <span style={S.kpiSubtext}>{subtext}</span>}
    </div>
  );
}

export default function TrafficMonitorPage() {
  const [searchParams] = useSearchParams();
  const initialDeviceId = searchParams.get('device_id') ?? '';
  const [devices, setDevices] = useState<Device[]>([]);
  const [clients, setClients] = useState<FLClient[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string>(initialDeviceId);
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [loading, setLoading] = useState(true);
  const paused = false;
  const [range, setRange] = useState('1h');
  const [activeTab, setActiveTab] = useState<'charts' | 'topology'>('charts');

  // Live store
  const wsConnected = useLiveStore((s) => s.wsConnected);
  const livePredictions = useLiveStore((s) => s.latestPredictions);

  useEffect(() => {
    Promise.all([
      devicesApi.list(),
      clientsApi.list(),
    ]).then(([devs, cls]) => {
      setDevices(devs);
      setClients(cls);
      if (!initialDeviceId && devs.length > 0) setSelectedDevice(devs[0].id);
    }).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedDevice) return;
    predictionsApi.deviceHistory(selectedDevice, 50).then(setPredictions).catch(() => setPredictions([]));
  }, [selectedDevice]);

  // Filter live predictions for selected device (when not paused)
  const deviceLivePreds = useMemo(() => {
    if (paused || !selectedDevice) return [];
    return livePredictions.filter((p) => String(p.device_id) === String(selectedDevice));
  }, [paused, selectedDevice, livePredictions]);

  // Merge API predictions with live predictions (live first, dedup by timestamp)
  const mergedPredictions = useMemo(() => {
    const seen = new Set<string>();
    const merged: Array<{
      id: number;
      score: number;
      label: string;
      confidence: number;
      inference_latency_ms: number;
      timestamp: string;
      device_name?: string;
    }> = [];
    for (const lp of deviceLivePreds) {
      const key = `${lp.device_id}-${lp.timestamp}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push({
          id: lp.id ?? 0,
          score: lp.score,
          label: lp.label,
          confidence: lp.confidence,
          inference_latency_ms: lp.inference_latency_ms ?? 0,
          timestamp: lp.timestamp,
          device_name: lp.device_name,
        });
      }
    }
    for (const p of predictions) {
      const key = `${selectedDevice}-${p.timestamp}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push({ ...p, device_name: (p as Prediction).device_name });
      }
    }
    return merged.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }, [predictions, deviceLivePreds, selectedDevice]);

  // Apply time range filter
  const filteredPredictions = useMemo(() => {
    const now = Date.now();
    const windowMs = rangeToMs(range);
    return mergedPredictions.filter((p) => now - new Date(p.timestamp).getTime() <= windowMs);
  }, [mergedPredictions, range]);

  // Export CSV handler
  const handleExport = useCallback(() => {
    if (filteredPredictions.length === 0) return;
    const headers = ['Timestamp', 'Prediction', 'Score', 'Confidence', 'Latency (ms)'];
    const rows = filteredPredictions.map((p) => [
      new Date(p.timestamp).toISOString(),
      p.label,
      p.score.toFixed(4),
      (p.confidence * 100).toFixed(1),
      p.inference_latency_ms.toFixed(1),
    ]);
    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `predictions_${selectedDevice}_${range}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filteredPredictions, selectedDevice, range]);

  const timeline = generateTimeline(filteredPredictions as Prediction[]);
  const currentScore = timeline.length > 0 ? timeline[timeline.length - 1].score : 0;
  const isBenign = currentScore < 0.5;

  // KPI derivations
  const recentPreds = filteredPredictions.slice(-20);
  const alertCount = recentPreds.filter((p) => p.label.toLowerCase() === 'attack').length;
  const anomalyRate = recentPreds.length > 0
    ? ((alertCount / recentPreds.length) * 100).toFixed(1)
    : '0.0';
  const packetsPerSecond = recentPreds.length > 0
    ? Math.round(recentPreds.length / Math.max(1, rangeToMs(range) / 1000 / 60))
    : 0;

  // Alert log entries (latest attacks, most recent first)
  const alertLogEntries = useMemo(() => {
    return [...filteredPredictions]
      .reverse()
      .filter((p) => p.label.toLowerCase() === 'attack')
      .slice(0, 20)
      .map((p) => ({
        time: new Date(p.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        message: `Attack detected from device ${p.device_name ?? selectedDevice.slice(0, 8)} — score ${p.score.toFixed(2)}`,
        score: p.score,
      }));
  }, [filteredPredictions, selectedDevice]);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 256 }}>
        <Loader2 style={{ width: 32, height: 32, color: 'var(--n8n-accent)', animation: 'spin 1s linear infinite' }} />
      </div>
    );
  }

  return (
    <motion.div variants={stagger} initial="hidden" animate="show" className="page-stack">

      {/* ── Tab bar ── */}
      <motion.div variants={fadeUp} style={S.tabBar}>
        {(['charts', 'topology'] as const).map((tab) => {
          const Icon = tab === 'charts' ? BarChart2 : Network;
          const label = tab === 'charts' ? 'Charts' : 'Topology';
          return (
            <button key={tab} onClick={() => setActiveTab(tab)} style={S.tab(activeTab === tab)}>
              <Icon style={{ width: 14, height: 14 }} />
              {label}
            </button>
          );
        })}
      </motion.div>

      {/* ── Topology tab ── */}
      {activeTab === 'topology' && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          style={S.sectionCard}
        >
          <div style={S.sectionHeader}>
            <span style={S.sectionTitle}>
              <Network style={{ width: 14, height: 14, color: 'var(--n8n-accent)' }} />
              Network Topology
              {wsConnected && (
                <span style={S.liveTag}>● LIVE</span>
              )}
            </span>
            <span style={{ fontSize: 11, color: 'var(--n8n-text-muted)' }}>
              Real-time FL server · clients · IoT devices
            </span>
          </div>
          <div style={{ padding: 20 }}>
            <TrafficTopology clients={clients} devices={devices} />
          </div>
        </motion.div>
      )}

      {/* ── Charts tab ── */}
      {activeTab === 'charts' && (
        <>
          {/* ── Toolbar ── */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25 }}
            style={S.toolbar}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, color: 'var(--n8n-text-muted)', whiteSpace: 'nowrap' }}>Device</span>
              <select
                value={selectedDevice}
                onChange={(e) => setSelectedDevice(e.target.value)}
                style={{ ...S.select, width: 200 }}
              >
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, color: 'var(--n8n-text-muted)', whiteSpace: 'nowrap' }}>Range</span>
              <select
                value={range}
                onChange={(e) => setRange(e.target.value)}
                style={{ ...S.select, width: 140 }}
              >
                <option value="15m">Last 15 min</option>
                <option value="1h">Last 1 Hour</option>
                <option value="6h">Last 6 Hours</option>
                <option value="24h">Last 24 Hours</option>
              </select>
            </div>

            <div style={{ flex: 1 }} />

            <button
              style={S.exportBtn}
              onClick={handleExport}
              disabled={filteredPredictions.length === 0}
            >
              <Download style={{ width: 13, height: 13 }} />
              Export CSV
            </button>
          </motion.div>

          {/* ── KPI Row ── */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: 0.06 }}
            style={S.kpiRow}
          >
            <KpiCard
              label="Packets / s"
              value={packetsPerSecond.toLocaleString()}
              subtext={`${filteredPredictions.length} records in window`}
              color="var(--n8n-accent)"
              icon={Activity}
            />
            <KpiCard
              label="Active Alerts"
              value={String(alertCount)}
              subtext={alertCount === 0 ? 'All clear' : 'Attack events detected'}
              color={alertCount > 0 ? 'var(--n8n-danger)' : 'var(--n8n-success)'}
              icon={AlertTriangle}
            />
            <KpiCard
              label="Anomaly Rate"
              value={`${anomalyRate}%`}
              subtext={`Current score: ${currentScore.toFixed(2)} — ${isBenign ? 'BENIGN' : 'ATTACK'}`}
              color={parseFloat(anomalyRate) > 5 ? 'var(--n8n-danger)' : 'var(--n8n-success)'}
              icon={Gauge}
            />
          </motion.div>

          {/* ── Anomaly Score Chart ── */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: 0.12 }}
            style={S.sectionCard}
          >
            <div style={S.sectionHeader}>
              <span style={S.sectionTitle}>
                <Activity style={{ width: 14, height: 14, color: 'var(--n8n-accent)' }} />
                Anomaly Score
                {wsConnected && !paused && deviceLivePreds.length > 0 && (
                  <span style={S.streamingTag}>● STREAMING</span>
                )}
              </span>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 11, color: 'var(--n8n-text-muted)' }}>Current</span>
                <span style={{
                  fontSize: 20,
                  fontWeight: 700,
                  color: isBenign ? 'var(--n8n-success)' : 'var(--n8n-danger)',
                }}>
                  {currentScore.toFixed(2)}
                </span>
                <span style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.05em',
                  color: isBenign ? 'var(--n8n-success)' : 'var(--n8n-danger)',
                }}>
                  {isBenign ? 'BENIGN' : 'ATTACK'}
                </span>
              </div>
            </div>
            <div style={{ padding: '16px 16px 8px', height: 260 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={timeline}>
                  <defs>
                    <linearGradient id="scoreGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--n8n-accent)" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="var(--n8n-accent)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="time" tick={{ fill: 'var(--n8n-text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis domain={[0, 1]} tick={{ fill: 'var(--n8n-text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
                  <Tooltip {...tooltipStyle} />
                  <ReferenceLine y={0.7} stroke="var(--n8n-danger)" strokeDasharray="6 4" label={{ value: '0.7 HIGH', fill: 'var(--n8n-danger)', fontSize: 9, position: 'right' }} />
                  <ReferenceLine y={0.5} stroke="var(--n8n-warning)" strokeDasharray="8 4" label={{ value: '0.5 DETECT', fill: 'var(--n8n-warning)', fontSize: 9, position: 'right' }} />
                  <Area type="monotone" dataKey="score" stroke="var(--n8n-accent)" strokeWidth={2} fill="url(#scoreGrad)" dot={false} animationDuration={600} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </motion.div>

          {/* ── Traffic Volume ── */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: 0.18 }}
            style={S.sectionCard}
          >
            <div style={S.sectionHeader}>
              <span style={S.sectionTitle}>
                <BarChart2 style={{ width: 14, height: 14, color: 'var(--n8n-accent)' }} />
                Traffic Volume
              </span>
              <span style={{ fontSize: 11, color: 'var(--n8n-text-muted)' }}>Packets per second</span>
            </div>
            <div style={{ padding: '16px 16px 8px', height: 200 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={timeline.slice(0, 12)}>
                  <XAxis dataKey="time" tick={{ fill: 'var(--n8n-text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: 'var(--n8n-text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
                  <Tooltip {...tooltipStyle} />
                  <Bar dataKey="score" radius={[4, 4, 0, 0]} fill="var(--n8n-accent)" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </motion.div>

          {/* ── Live Traffic Table ── */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: 0.24 }}
            style={S.sectionCard}
          >
            <div style={S.sectionHeader}>
              <span style={S.sectionTitle}>
                <Activity style={{ width: 14, height: 14, color: 'var(--n8n-accent)' }} />
                Live Traffic Table
                {wsConnected && !paused && deviceLivePreds.length > 0 && (
                  <span style={S.liveTag}>● LIVE ({deviceLivePreds.length})</span>
                )}
              </span>
              <span style={{ fontSize: 11, color: 'var(--n8n-text-muted)' }}>
                Latest {Math.min(filteredPredictions.length, 20)} records
              </span>
            </div>

            <div style={S.tableContainer}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead style={S.thead}>
                  <tr>
                    <th style={{ ...S.th, textAlign: 'center', width: 48 }}>#</th>
                    <th style={S.th}>Timestamp</th>
                    <th style={S.th}>Device</th>
                    <th style={S.th}>Label</th>
                    <th style={{ ...S.th, textAlign: 'center' }}>Score</th>
                    <th style={{ ...S.th, textAlign: 'center' }}>Confidence</th>
                    <th style={{ ...S.th, textAlign: 'center' }}>Latency</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPredictions.length > 0 ? (
                    [...filteredPredictions].reverse().slice(0, 20).map((p, i) => {
                      const isAttack = p.label.toLowerCase() === 'attack';
                      const highScore = p.score > 0.8;
                      return (
                        <tr
                          key={`${p.id}-${p.timestamp}-${i}`}
                          style={isAttack ? S.alertRow : S.normalRow}
                        >
                          <td style={{ ...S.td, textAlign: 'center', color: 'var(--n8n-text-muted)', fontSize: 11 }}>{i + 1}</td>
                          <td style={{ ...S.td, fontFamily: 'inherit' }}>
                            {new Date(p.timestamp).toLocaleTimeString([], {
                              hour: '2-digit', minute: '2-digit', second: '2-digit',
                            })}
                          </td>
                          <td style={{ ...S.td, fontWeight: 500 }}>
                            {p.device_name ?? devices.find((d) => d.id === selectedDevice)?.name ?? (
                              <span style={{ color: 'var(--n8n-text-muted)', fontFamily: 'inherit' }}>
                                {selectedDevice.slice(0, 8)}…
                              </span>
                            )}
                          </td>
                          <td style={S.td}>
                            <span style={{
                              fontSize: 11,
                              fontWeight: 700,
                              letterSpacing: '0.04em',
                              color: isAttack ? 'var(--n8n-danger)' : 'var(--n8n-success)',
                            }}>
                              {isAttack ? 'ALERT' : 'Normal'}
                            </span>
                          </td>
                          <td style={{ ...S.td, textAlign: 'center', fontWeight: 600 }}>
                            <span style={{ color: highScore ? 'var(--n8n-danger)' : isAttack ? 'var(--n8n-warning)' : 'var(--n8n-success)' }}>
                              {p.score.toFixed(2)}
                              {highScore && ' ⚠'}
                            </span>
                          </td>
                          <td style={{ ...S.td, textAlign: 'center' }}>
                            {(p.confidence * 100).toFixed(0)}%
                          </td>
                          <td style={{ ...S.td, textAlign: 'center', color: 'var(--n8n-text-muted)' }}>
                            {p.inference_latency_ms.toFixed(0)}ms
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td
                        colSpan={7}
                        style={{ ...S.td, textAlign: 'center', padding: 32, color: 'var(--n8n-text-muted)' }}
                      >
                        No predictions yet — select a device and run traffic analysis
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </motion.div>

          {/* ── Alert Log ── */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: 0.30 }}
            style={S.sectionCard}
          >
            <div style={S.sectionHeader}>
              <span style={S.sectionTitle}>
                <AlertTriangle style={{ width: 14, height: 14, color: 'var(--n8n-danger)' }} />
                Alert Log
              </span>
              <span style={{ fontSize: 11, color: 'var(--n8n-text-muted)' }}>
                {alertLogEntries.length} alert{alertLogEntries.length !== 1 ? 's' : ''} in range
              </span>
            </div>
            <div style={S.alertLog}>
              {alertLogEntries.length > 0 ? (
                alertLogEntries.map((entry, i) => (
                  <div key={i} style={S.alertLogEntry(true)}>
                    <span style={{ color: 'var(--n8n-text-muted)', marginRight: 10 }}>{entry.time}</span>
                    {entry.message}
                  </div>
                ))
              ) : (
                <div style={S.alertLogEntry(false)}>
                  No alerts in the selected time range — network traffic appears normal.
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}

    </motion.div>
  );
}
