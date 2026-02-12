import { useEffect, useState, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Loader2, Download /* , Pause, Play */ } from 'lucide-react';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { predictionsApi } from '@/api/predictions';
import { devicesApi } from '@/api/devices';
import { useLiveStore } from '@/stores/liveStore';
import type { Device, Prediction } from '@/types';

const stagger = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { staggerChildren: 0.06 } } };
const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } };

const tooltipStyle = { contentStyle: { background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, color: 'var(--text-primary)' }, itemStyle: { color: 'var(--accent)' } };

/* ---------- Time range helper ---------- */
function rangeToMs(range: string): number {
  switch (range) {
    case '15m': return 15 * 60 * 1000;
    case '1h': return 60 * 60 * 1000;
    case '6h': return 6 * 60 * 60 * 1000;
    case '24h': return 24 * 60 * 60 * 1000;
    default: return 60 * 60 * 1000;
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

/* const featureImportance = [
  { name: 'Fwd Pkt Len Max', value: 0.34 },
  { name: 'Flow Duration', value: 0.28 },
  { name: 'Bwd Pkt Len Mean', value: 0.19 },
  { name: 'Tot Fwd Packets', value: 0.15 },
  { name: 'Pkt Size Avg', value: 0.12 },
  { name: 'Flow IAT Mean', value: 0.09 },
  { name: 'Bwd IAT Total', value: 0.07 },
  { name: 'SYN Flag Count', value: 0.05 },
  { name: 'Init Win Bytes Fwd', value: 0.04 },
  { name: 'Subflow Fwd Bytes', value: 0.03 },
]; */

export default function TrafficMonitorPage() {
  const [searchParams] = useSearchParams();
  const initialDeviceId = searchParams.get('device_id') ?? '';
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string>(initialDeviceId);
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [loading, setLoading] = useState(true);
  const paused = false; // const [paused, setPaused] = useState(false);
  const [range, setRange] = useState('1h');

  // Live store
  const wsConnected = useLiveStore((s) => s.wsConnected);
  const livePredictions = useLiveStore((s) => s.latestPredictions);

  useEffect(() => {
    Promise.all([
      devicesApi.list(),
    ]).then(([devs]) => {
      setDevices(devs);
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
    const merged: Array<{ id: number; score: number; label: string; confidence: number; inference_latency_ms: number; timestamp: string; device_name?: string }> = [];
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

  if (loading) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin" style={{ color: 'var(--accent)' }} /></div>;
  }

  return (
    <motion.div variants={stagger} initial="hidden" animate="show" className="page-stack">
      {/* Toolbar */}
      <motion.div variants={fadeUp} className="flex items-center gap-4 flex-wrap" style={{
        padding: '14px 20px',
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        boxShadow: 'var(--shadow-sm)',
      }}>
        <div className="flex items-center gap-2">
          <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Device:</span>
          <select
            value={selectedDevice}
            onChange={(e) => setSelectedDevice(e.target.value)}
            style={{
              width: 200, height: 36, fontSize: 13,
              padding: '6px 12px',
              borderRadius: 6, border: '1.5px solid var(--border)',
              background: 'var(--bg-input)', color: 'var(--text-primary)',
              outline: 'none', cursor: 'pointer',
            }}
          >
            {devices.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Range:</span>
          <select
            value={range}
            onChange={(e) => setRange(e.target.value)}
            style={{
              width: 150, height: 36, fontSize: 13,
              padding: '6px 12px',
              borderRadius: 6, border: '1.5px solid var(--border)',
              background: 'var(--bg-input)', color: 'var(--text-primary)',
              outline: 'none', cursor: 'pointer',
            }}
          >
            <option value="15m">Last 15 min</option>
            <option value="1h">Last 1 Hour</option>
            <option value="6h">Last 6 Hours</option>
            <option value="24h">Last 24 Hours</option>
          </select>
        </div>

        <div className="flex-1" />

        {/* <button className="btn btn-ghost" style={{ height: 32, fontSize: 12, gap: 4 }} onClick={() => setPaused(!paused)}>
          {paused ? <Play style={{ width: 14, height: 14 }} /> : <Pause style={{ width: 14, height: 14 }} />}
          {paused ? 'Resume' : 'Pause'}
        </button> */}
        <button className="btn btn-ghost" style={{ height: 32, fontSize: 12, gap: 4 }} onClick={handleExport} disabled={filteredPredictions.length === 0}>
          <Download style={{ width: 14, height: 14 }} /> Export
        </button>
      </motion.div>

      {/* Anomaly Score Chart */}
      <motion.div variants={fadeUp} className="card" style={{ padding: 24 }}>
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
              Anomaly Score
              {wsConnected && !paused && deviceLivePreds.length > 0 && (
                <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: 'var(--success)', verticalAlign: 'middle' }}>● STREAMING</span>
              )}
            </h2>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>(0 = benign, 1 = attack)</p>
          </div>
          <div className="card" style={{ padding: '10px 16px', textAlign: 'right' }}>
            <span style={{ fontSize: 10, color: 'var(--text-muted)', display: 'block' }}>Current Score</span>
            <div className="flex items-baseline gap-3">
              <span style={{ fontSize: 24, fontWeight: 700, color: isBenign ? 'var(--success)' : 'var(--danger)' }}>
                {currentScore.toFixed(2)}
              </span>
              <span style={{ fontSize: 12, fontWeight: 600, color: isBenign ? 'var(--success)' : 'var(--danger)' }}>
                {isBenign ? 'BENIGN' : 'ATTACK'}
              </span>
            </div>
          </div>
        </div>

        <div style={{ height: 260 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={timeline}>
              <defs>
                <linearGradient id="scoreGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="time" tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis domain={[0, 1]} tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
              <Tooltip {...tooltipStyle} />
              <ReferenceLine y={0.7} stroke="var(--danger)" strokeDasharray="6 4" label={{ value: '0.7 HIGH', fill: 'var(--danger)', fontSize: 9, position: 'right' }} />
              <ReferenceLine y={0.5} stroke="var(--warning)" strokeDasharray="8 4" label={{ value: '0.5 DETECT', fill: 'var(--warning)', fontSize: 9, position: 'right' }} />
              <Area type="monotone" dataKey="score" stroke="var(--accent)" strokeWidth={2} fill="url(#scoreGrad)" dot={false} animationDuration={600} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </motion.div>

      {/* Row 2: Traffic Volume */}
      <div className="grid grid-cols-1 gap-6">
        {/* Traffic Volume */}
        <motion.div variants={fadeUp} className="card" style={{ padding: 24 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>Traffic Volume</h2>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, marginBottom: 16 }}>Packets per second</p>
          <div style={{ height: 200 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={timeline.slice(0, 12)}>
                <XAxis dataKey="time" tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} />
                <Tooltip {...tooltipStyle} />
                <Bar dataKey="score" radius={[4, 4, 0, 0]} fill="var(--accent)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </motion.div>

        {/* XAI Feature Importance — commented out for now
        <motion.div variants={fadeUp} className="card" style={{ padding: 24 }}>
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>Feature Importance (XAI)</h2>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>SHAP values for latest prediction</p>
            </div>
            <span className="badge" style={{ background: 'var(--accent-light)', color: 'var(--accent)' }}>Top 10</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {featureImportance.map((f, i) => {
              const maxVal = featureImportance[0].value;
              const pct = (f.value / maxVal) * 100;
              const opacity = 1 - i * 0.07;
              return (
                <div key={f.name} className="flex items-center gap-3">
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', width: 16, textAlign: 'right', flexShrink: 0 }}>
                    {i + 1}.
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--text-primary)', width: 130, textAlign: 'right', flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {f.name}
                  </span>
                  <div style={{ flex: 1, height: 18, borderRadius: 4, background: 'var(--bg-secondary)', overflow: 'hidden', position: 'relative' }}>
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${pct}%` }}
                      transition={{ duration: 0.6, delay: 0.1 + i * 0.04 }}
                      style={{ height: '100%', borderRadius: 4, background: 'var(--accent)', opacity, maxWidth: '100%' }}
                    />
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)', width: 38, textAlign: 'right', fontFamily: 'monospace' }}>
                    {f.value.toFixed(2)}
                  </span>
                </div>
              );
            })}
          </div>
        </motion.div>
        */}
      </div>

      {/* Live Event Log */}
      <motion.div variants={fadeUp} className="card" style={{ padding: 24 }}>
        <div className="flex items-center justify-between mb-4">
          <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
            Live Event Log
            {wsConnected && !paused && deviceLivePreds.length > 0 && (
              <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: 'var(--success)', verticalAlign: 'middle' }}>● LIVE ({deviceLivePreds.length})</span>
            )}
          </h2>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr className="table-header">
                <th style={{ width: 60 }}>#</th>
                <th style={{ textAlign: 'left' }}>TIMESTAMP</th>
                <th style={{ textAlign: 'left' }}>DEVICE</th>
                <th style={{ textAlign: 'left' }}>PREDICTION</th>
                <th style={{ textAlign: 'center' }}>SCORE</th>
                <th style={{ textAlign: 'center' }}>CONFIDENCE</th>
                <th style={{ textAlign: 'center' }}>LATENCY</th>
              </tr>
            </thead>
            <tbody>
              {filteredPredictions.length > 0 ? [...filteredPredictions].reverse().slice(0, 20).map((p, i) => {
                const isAttack = p.label.toLowerCase() === 'attack';
                return (
                  <tr key={`${p.id}-${p.timestamp}-${i}`} className="table-row" style={isAttack ? { background: 'rgba(239,68,68,0.06)' } : undefined}>
                    <td style={{ textAlign: 'center', fontSize: 12 }}>{i + 1}</td>
                    <td style={{ fontSize: 12 }}>{new Date(p.timestamp).toLocaleTimeString()}</td>
                    <td style={{ fontSize: 12, fontWeight: 500 }}>
                      {p.device_name ?? devices.find((d) => d.id === selectedDevice)?.name ?? (
                        <span title={`ID: ${selectedDevice}`} style={{ color: 'var(--text-muted)', fontFamily: 'monospace' }}>⚠ {selectedDevice.slice(0, 8)}…</span>
                      )}
                    </td>
                    <td>
                      <span style={{ fontSize: 12, fontWeight: 600, color: isAttack ? 'var(--danger)' : 'var(--success)' }}>
                        {isAttack ? 'ATTACK' : 'BENIGN'}
                      </span>
                    </td>
                    <td style={{ textAlign: 'center', fontSize: 13, fontWeight: 600, color: isAttack ? 'var(--danger)' : 'var(--success)' }}>
                      {p.score.toFixed(2)}
                    </td>
                    <td style={{ textAlign: 'center', fontSize: 12 }}>{(p.confidence * 100).toFixed(0)}%</td>
                    <td style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>{p.inference_latency_ms.toFixed(0)}ms</td>
                  </tr>
                );
              }) : (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 13 }}>
                    No predictions yet — select a device and run traffic analysis
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </motion.div>
    </motion.div>
  );
}
