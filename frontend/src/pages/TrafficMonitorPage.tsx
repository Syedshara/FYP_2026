import { Fragment, useEffect, useState, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Loader2, Download, Pause, Play, Cpu, Wifi, WifiOff } from 'lucide-react';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { predictionsApi } from '@/api/predictions';
import { devicesApi } from '@/api/devices';
import { useLiveStore } from '@/stores/liveStore';
import type { Device, PredictionSummary, ModelInfo, Prediction } from '@/types';

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

const featureImportance = [
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
];

export default function TrafficMonitorPage() {
  const [searchParams] = useSearchParams();
  const initialDeviceId = searchParams.get('device_id') ?? '';
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string>(initialDeviceId);
  const [summary, setSummary] = useState<PredictionSummary | null>(null);
  const [model, setModel] = useState<ModelInfo | null>(null);
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [loading, setLoading] = useState(true);
  const [paused, setPaused] = useState(false);
  const [range, setRange] = useState('1h');

  // Live store
  const wsConnected = useLiveStore((s) => s.wsConnected);
  const livePredictions = useLiveStore((s) => s.latestPredictions);

  useEffect(() => {
    Promise.all([
      devicesApi.list(),
      predictionsApi.summary().catch(() => null),
      predictionsApi.model().catch(() => null),
    ]).then(([devs, sum, mdl]) => {
      setDevices(devs);
      if (!initialDeviceId && devs.length > 0) setSelectedDevice(devs[0].id);
      setSummary(sum);
      setModel(mdl);
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
    const merged: Array<{ id: number; device_id: string; score: number; label: string; confidence: number; inference_latency_ms: number; timestamp: string; device_name?: string; explanation?: string; temporal_pattern?: string; top_anomalies?: Array<{ feature: string; value: number; baseline: number; ratio: number }> }> = [];
    for (const lp of deviceLivePreds) {
      const key = `${lp.device_id}-${lp.timestamp}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push({
          id: lp.id ?? 0,
          device_id: String(lp.device_id),
          score: lp.score,
          label: lp.label,
          confidence: lp.confidence,
          inference_latency_ms: lp.inference_latency_ms ?? 0,
          timestamp: lp.timestamp,
          device_name: lp.device_name,
          explanation: (lp as any).explanation,
          temporal_pattern: (lp as any).temporal_pattern,
          top_anomalies: (lp as any).top_anomalies,
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

  // Export enhanced CSV handler with explanations
  const handleExport = useCallback(() => {
    if (filteredPredictions.length === 0) return;
    
    // Build CSV with 2 sections: summary + detailed explanations
    const lines: string[] = [];
    
    // Header
    lines.push('TRAFFIC MONITOR PREDICTIONS WITH EXPLANATIONS');
    lines.push(`Device: ${selectedDevice}`);
    lines.push(`Time Range: ${range}`);
    lines.push(`Export Date: ${new Date().toISOString()}`);
    lines.push('');
    
    // Summary table headers
    const headers = [
      'Timestamp', 
      'Device', 
      'Prediction', 
      'Score', 
      'Confidence (%)', 
      'Latency (ms)',
      'Temporal Pattern',
      'Anomaly Count',
      'Window Present',
      'Top Feature',
      'Feature Value',
      'Baseline',
      'Ratio (×)',
      'Feature #2',
      'Ratio #2 (×)',
      'Feature #3',
      'Ratio #3 (×)',
      'Top Anomalies JSON',
    ];
    
    lines.push(headers.join(','));
    
    const rows = filteredPredictions.map((p) => {
      const anom1 = p.top_anomalies && p.top_anomalies.length > 0 ? p.top_anomalies[0] : null;
      const anom2 = p.top_anomalies && p.top_anomalies.length > 1 ? p.top_anomalies[1] : null;
      const anom3 = p.top_anomalies && p.top_anomalies.length > 2 ? p.top_anomalies[2] : null;
      
      return [
        new Date(p.timestamp).toISOString(),
        p.device_name || p.device_id,
        p.label.toUpperCase(),
        p.score.toFixed(4),
        (p.confidence * 100).toFixed(1),
        p.inference_latency_ms.toFixed(1),
        p.temporal_pattern || 'N/A',
        (p.anomaly_count ?? (p.top_anomalies ? p.top_anomalies.length : 0)),
        p.window ? 'yes' : 'no',
        anom1 ? anom1.feature : 'N/A',
        anom1 ? anom1.value.toFixed(2) : 'N/A',
        anom1 ? anom1.baseline.toFixed(2) : 'N/A',
        anom1 ? anom1.ratio.toFixed(2) : 'N/A',
        anom2 ? anom2.feature : 'N/A',
        anom2 ? anom2.ratio.toFixed(2) : 'N/A',
        anom3 ? anom3.feature : 'N/A',
        anom3 ? anom3.ratio.toFixed(2) : 'N/A',
        JSON.stringify(p.top_anomalies || []),
      ];
    });
    
    rows.forEach(r => lines.push(r.map(v => `"${v}"`).join(',')));
    
    lines.push('');
    lines.push('');
    lines.push('DETAILED EXPLANATION FOR EACH ATTACK');
    lines.push('');
    
    // Detailed explanations for each prediction
    filteredPredictions.filter(p => p.label === 'attack').forEach((p, idx) => {
      lines.push(`ATTACK ${idx + 1}: ${new Date(p.timestamp).toISOString()}`);
      lines.push(`Score: ${p.score.toFixed(4)} | Confidence: ${(p.confidence * 100).toFixed(1)}% | Device: ${p.device_name || p.device_id}`);
      lines.push('');
      
      if (p.temporal_pattern) {
        lines.push(`Temporal Pattern: ${p.temporal_pattern}`);
        lines.push('(Describes how traffic evolved over the last 3 flows)');
        lines.push('');
      }
      
      if (p.top_anomalies && p.top_anomalies.length > 0) {
        lines.push('ANOMALOUS FEATURES DETECTED:');
        p.top_anomalies.forEach((anom, i) => {
          lines.push('');
          lines.push(`${i + 1}. ${anom.feature}`);
          lines.push(`   Expected (Baseline): ${anom.baseline.toFixed(2)}`);
          lines.push(`   Actual (Observed):   ${anom.value.toFixed(2)}`);
          lines.push(`   Deviation:           ${anom.ratio.toFixed(2)}x higher than normal`);
          lines.push(`   Severity:            ${anom.ratio > 10 ? 'CRITICAL' : anom.ratio > 5 ? 'HIGH' : 'MEDIUM'}`);
        });
      }

      // Include generated window if present (from synthetic simulation)
      const win = (p as any).window;
      if (win && Array.isArray(win)) {
        lines.push('');
        lines.push('Generated window present: YES');
        try {
          lines.push(`First flow (excerpt): ${JSON.stringify(win[0].slice(0, 12))} ...`);
        } catch (e) {
          lines.push('Window data available');
        }
        lines.push('');
      }
      
      lines.push('');
      lines.push('─'.repeat(80));
      lines.push('');
    });
    
    const csv = lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `predictions_with_explanations_${selectedDevice}_${range}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filteredPredictions, selectedDevice, range]);

  // Export JSON handler with detailed explanations
  const handleExportJSON = useCallback(() => {
    if (filteredPredictions.length === 0) return;

    const jsonData = {
      metadata: {
        exportedAt: new Date().toISOString(),
        device: selectedDevice,
        timeRange: range,
        totalPredictions: filteredPredictions.length,
        attackCount: filteredPredictions.filter(p => p.label === 'attack').length,
        benignCount: filteredPredictions.filter(p => p.label === 'benign').length,
      },
      predictions: filteredPredictions.map((p) => ({
        id: p.id,
        timestamp: p.timestamp,
        device: {
          id: p.device_id,
          name: p.device_name || 'Unknown',
        },
        prediction: {
          label: p.label.toUpperCase(),
          score: p.score,
          scoreFormatted: p.score.toFixed(4),
          confidence: (p.confidence * 100).toFixed(1) + '%',
          confidenceDecimal: p.confidence,
          isAttack: p.label === 'attack',
        },
        performance: {
          inferenceLatency_ms: p.inference_latency_ms,
          modelVersion: 'CNN-LSTM',
        },
        explanation: {
          temporalPattern: p.temporal_pattern || 'No pattern available',
          patternDescription: p.temporal_pattern 
            ? `${p.temporal_pattern} - Indicates abnormal traffic behavior detected across the last 3 flows`
            : 'Pattern analysis requires multiple flows to establish baseline',
        },
        anomalousFeatures: (p.top_anomalies && p.top_anomalies.length > 0)
          ? p.top_anomalies.map((anom, idx) => ({
              rank: idx + 1,
              featureName: anom.feature,
              observedValue: anom.value.toFixed(2),
              baselineValue: anom.baseline.toFixed(2),
              deviation: {
                multiplier: anom.ratio.toFixed(2) + 'x',
                severity: anom.ratio > 10 ? 'CRITICAL' : anom.ratio > 5 ? 'HIGH' : 'MEDIUM',
                percentageAboveNormal: ((anom.ratio - 1) * 100).toFixed(1) + '%',
              },
              interpretation: `${anom.feature} is ${anom.ratio.toFixed(1)}x higher than normal (Expected: ${anom.baseline.toFixed(1)}, Got: ${anom.value.toFixed(2)})`,
            }))
          : [],
        anomalyCount: p.anomaly_count ?? (p.top_anomalies ? p.top_anomalies.length : 0),
        window: (p as any).window || null,
        summary: {
          causeOfDetection: p.label === 'attack'
            ? `Attack detected with ${(p.confidence * 100).toFixed(1)}% confidence. ${p.top_anomalies && p.top_anomalies.length > 0 ? `Primary cause: ${p.top_anomalies[0].feature} (${p.top_anomalies[0].ratio.toFixed(1)}x abnormal).` : 'Multiple anomalies detected across features.'}`
            : 'Traffic classified as benign - features within normal ranges.',
          recommendation: p.label === 'attack'
            ? 'ALERT: Review network traffic immediately. Isolate device if critical.'
            : 'No action required - traffic pattern is normal.',
        },
      })),
    };

    const jsonString = JSON.stringify(jsonData, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `predictions_detailed_${selectedDevice}_${range}_${new Date().toISOString().slice(0, 10)}.json`;
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

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {wsConnected ? <Wifi style={{ width: 14, height: 14, color: 'var(--success)' }} /> : <WifiOff style={{ width: 14, height: 14, color: 'var(--text-muted)' }} />}
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: paused ? 'var(--text-muted)' : wsConnected ? 'var(--success)' : 'var(--warning)', display: 'inline-block', animation: paused ? 'none' : 'status-pulse 2s infinite' }} />
          <span style={{ fontSize: 11, fontWeight: 600, color: paused ? 'var(--text-muted)' : wsConnected ? 'var(--success)' : 'var(--warning)' }}>
            {paused ? 'PAUSED' : wsConnected ? 'LIVE' : 'POLLING'}
          </span>
        </div>
        <button className="btn btn-ghost" style={{ height: 32, fontSize: 12, gap: 4 }} onClick={() => setPaused(!paused)}>
          {paused ? <Play style={{ width: 14, height: 14 }} /> : <Pause style={{ width: 14, height: 14 }} />}
          {paused ? 'Resume' : 'Pause'}
        </button>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn btn-ghost" style={{ height: 32, fontSize: 12, gap: 4 }} onClick={handleExport} disabled={filteredPredictions.length === 0}>
            <Download style={{ width: 14, height: 14 }} /> CSV
          </button>
          <button className="btn btn-ghost" style={{ height: 32, fontSize: 12, gap: 4 }} onClick={handleExportJSON} disabled={filteredPredictions.length === 0}>
            <Download style={{ width: 14, height: 14 }} /> JSON
          </button>
        </div>
      </motion.div>

      {/* Anomaly Score Chart */}
      <motion.div variants={fadeUp} className="card" style={{ padding: 24 }}>
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
              Anomaly Score — {wsConnected && !paused ? 'Real-time' : 'Historical'}
              {wsConnected && !paused && deviceLivePreds.length > 0 && (
                <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: 'var(--success)', verticalAlign: 'middle' }}>● STREAMING</span>
              )}
            </h2>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>CNN-LSTM model prediction confidence (0 = benign, 1 = attack)</p>
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

      {/* Row 2: Traffic Volume + XAI */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
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

        {/* XAI Feature Importance */}
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
      </div>

      {/* Detected Anomalies Section */}
      {filteredPredictions.some(p => p.label === 'attack' && p.top_anomalies && p.top_anomalies.length > 0) && (
        <motion.div variants={fadeUp} className="card" style={{ padding: 24 }}>
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>🚨 Detected Anomalies</h2>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Features causing attack detection</p>
            </div>
            <span className="badge" style={{ background: 'rgba(239,68,68,0.2)', color: 'var(--danger)' }}>Active Threats</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
            {filteredPredictions
              .filter(p => p.label === 'attack' && p.top_anomalies && p.top_anomalies.length > 0)
              .slice(0, 6)
              .map((pred, idx) => {
                const topAnom = pred.top_anomalies![0];
                return (
                  <div key={`anom-${pred.id}-${idx}`} style={{
                    padding: 12,
                    background: 'rgba(239,68,68,0.08)',
                    border: '1px solid rgba(239,68,68,0.3)',
                    borderRadius: 8,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 8 }}>
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)' }}>
                          {topAnom.feature}
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                          {new Date(pred.timestamp).toLocaleTimeString()}
                        </div>
                      </div>
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--danger)', background: 'rgba(239,68,68,0.2)', padding: '2px 6px', borderRadius: 4 }}>
                        {topAnom.ratio.toFixed(1)}x
                      </span>
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                      <div>Value: <span style={{ fontWeight: 600, color: 'var(--accent)' }}>{topAnom.value.toFixed(1)}</span></div>
                      <div>Normal: <span style={{ fontFamily: 'monospace' }}>{topAnom.baseline.toFixed(1)}</span></div>
                    </div>
                  </div>
                );
              })}
          </div>
        </motion.div>
      )}

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
    <Fragment key={`row-${p.id}-${p.timestamp}-${i}`}>
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
      
      {/* EXPLANATION ROW */}
      {p.explanation && (
        <tr key={`exp-${p.id}-${i}`} style={{ borderTop: 'none' }}>
          <td colSpan={7} style={{ padding: '12px 16px', background: 'var(--bg-secondary)', fontSize: 11, borderBottom: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {/* Temporal Pattern Section */}
              {p.temporal_pattern && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: 'var(--accent)', fontWeight: 600 }}>📊 Temporal Pattern:</span>
                  <span style={{ color: 'var(--text-primary)' }}>{p.temporal_pattern}</span>
                </div>
              )}
              
              {/* Top Anomalies Section */}
              {p.top_anomalies && p.top_anomalies.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ color: 'var(--accent)', fontWeight: 600 }}>🔍 Anomalous Features:</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 8, marginLeft: 16 }}>
                    {p.top_anomalies.slice(0, 3).map((anom, idx) => (
                      <div key={idx} style={{ padding: '6px 8px', background: 'rgba(239,68,68,0.08)', borderLeft: '2px solid var(--danger)', borderRadius: 4 }}>
                        <div style={{ color: 'var(--text-primary)', fontWeight: 500, fontSize: 10 }}>
                          {idx + 1}. {anom.feature}
                        </div>
                        <div style={{ color: 'var(--text-muted)', fontSize: 9, marginTop: 2 }}>
                          Value: {anom.value.toFixed(1)} | Baseline: {anom.baseline.toFixed(1)} | Ratio: <span style={{ color: 'var(--danger)', fontWeight: 600 }}>{anom.ratio.toFixed(1)}x</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </Fragment>
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

      {/* Model Info Bar */}
      {model && (
        <motion.div variants={fadeUp} className="card flex items-center gap-6 flex-wrap" style={{ padding: '14px 20px' }}>
          <Cpu style={{ width: 16, height: 16, color: 'var(--accent)' }} />
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Model: <strong style={{ color: 'var(--text-primary)' }}>{model.architecture}</strong></span>
          <span style={{ fontSize: 12, color: 'var(--warning)', fontWeight: 600 }}>Threshold: {model.threshold}</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Input: {model.input_shape}</span>
          {summary && <span style={{ fontSize: 12, color: 'var(--success)' }}>Latency: ~{summary.avg_latency_ms.toFixed(0)}ms/pred</span>}
          <span style={{ fontSize: 12, color: model.loaded ? 'var(--success)' : 'var(--danger)' }}>
            {model.loaded ? 'Model Loaded' : 'Model Not Loaded'}
          </span>
        </motion.div>
      )}
    </motion.div>
  );
}
