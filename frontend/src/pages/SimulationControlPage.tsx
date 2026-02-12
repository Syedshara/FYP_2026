import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Loader2, Play, Square, Radio, Zap, Activity, Server,
  RefreshCw, Clock, AlertTriangle, CheckCircle2, XCircle,
  ChevronDown, Shuffle, Repeat, Gauge, Settings2, Cpu,
} from 'lucide-react';
import { simulationApi } from '@/api/simulation';
import { clientsApi } from '@/api/clients';
import { devicesApi } from '@/api/devices';
import { useLiveStore } from '@/stores/liveStore';
import type { Scenario, SimulationStatus, SimulationStartConfig } from '@/api/simulation';
import type { FLClient, Device, DeviceBrief } from '@/types';

/* ── Animations ───────────────────────────────── */
const stagger = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { staggerChildren: 0.06 } } };
const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } };

/* ── State badge colors ──────────────────────── */
function stateColor(state: string): { bg: string; fg: string; dot: string } {
  switch (state) {
    case 'running': return { bg: 'var(--success-light)', fg: 'var(--success)', dot: 'var(--success)' };
    case 'starting': return { bg: 'var(--warning-light)', fg: 'var(--warning)', dot: 'var(--warning)' };
    case 'stopping': return { bg: 'var(--warning-light)', fg: 'var(--warning)', dot: 'var(--warning)' };
    case 'error': return { bg: 'var(--danger-light)', fg: 'var(--danger)', dot: 'var(--danger)' };
    case 'paused': return { bg: 'var(--accent-light)', fg: 'var(--accent)', dot: 'var(--accent)' };
    default: return { bg: 'var(--bg-secondary)', fg: 'var(--text-muted)', dot: 'var(--text-muted)' };
  }
}

function stateIcon(state: string) {
  switch (state) {
    case 'running': return <Activity style={{ width: 14, height: 14 }} />;
    case 'starting': return <Loader2 style={{ width: 14, height: 14 }} className="animate-spin" />;
    case 'stopping': return <Loader2 style={{ width: 14, height: 14 }} className="animate-spin" />;
    case 'error': return <XCircle style={{ width: 14, height: 14 }} />;
    default: return <Square style={{ width: 14, height: 14 }} />;
  }
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

/* ── Speed presets ────────────────────────────── */
const SPEED_PRESETS = [
  { label: '0.5×', value: 0.5 },
  { label: '1×', value: 1.0 },
  { label: '2×', value: 2.0 },
  { label: '5×', value: 5.0 },
  { label: '10×', value: 10.0 },
];

/* ── Available clients ────────────────────────── */
const ALL_CLIENTS = ['bank_a', 'bank_b', 'bank_c'];

/* ══════════════════════════════════════════════════
   Main Component
   ══════════════════════════════════════════════════ */
export default function SimulationControlPage() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [status, setStatus] = useState<SimulationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Client & Device selection
  const [flClients, setFlClients] = useState<FLClient[]>([]);
  const [selectedClient, setSelectedClient] = useState<number | null>(null);
  const [clientDevices, setClientDevices] = useState<DeviceBrief[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string | null>(null);

  // Config state
  const [selectedScenario, setSelectedScenario] = useState('client_data');
  const [replaySpeed, setReplaySpeed] = useState(1.0);
  const [monitorInterval, setMonitorInterval] = useState(3.0);
  const [replayLoop, setReplayLoop] = useState(true);
  const [replayShuffle, setReplayShuffle] = useState(false);
  const [attackRatio, setAttackRatio] = useState(0.2);
  const [selectedAttackType, setSelectedAttackType] = useState<string | null>(null);
  const [selectedClients, setSelectedClients] = useState<Set<string>>(new Set(ALL_CLIENTS));

  // Live predictions from WS
  const livePredictions = useLiveStore((s) => s.latestPredictions);

  // Polling for status updates when running
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Initial load ──────────────────────────────
  useEffect(() => {
    Promise.all([
      simulationApi.scenarios().catch(() => []),
      simulationApi.status().catch(() => null),
      clientsApi.list().catch(() => []),
      devicesApi.list().catch(() => []),
    ]).then(([scens, stat, clients, devices]) => {
      setScenarios(scens);
      if (stat) setStatus(stat);
      setFlClients(clients);
      if (clients.length > 0) {
        setSelectedClient(clients[0].id);
      }
    }).finally(() => setLoading(false));
  }, []);

  // ── Status polling ────────────────────────────
  useEffect(() => {
    if (status?.state === 'running' || status?.state === 'starting') {
      pollRef.current = setInterval(async () => {
        try {
          const s = await simulationApi.status();
          setStatus(s);
        } catch { /* ignore */ }
      }, 3000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [status?.state]);

  // ── Load devices for selected client ────────
  useEffect(() => {
    if (!selectedClient) return;
    clientsApi.devices(selectedClient)
      .then(setClientDevices)
      .catch(() => setClientDevices([]));
  }, [selectedClient]);

  // ── Live prediction stats ─────────────────────
  const liveStats = useMemo(() => {
    if (livePredictions.length === 0) return { 
      total: 0, 
      attacks: 0, 
      benign: 0, 
      avgScore: 0, 
      avgLatency: 0,
      attackRate: 0 
    };
    const attacks = livePredictions.filter((p) => p.label === 'attack').length;
    const avgScore = livePredictions.reduce((s, p) => s + p.score, 0) / livePredictions.length;
    const avgLatency = livePredictions.reduce((s, p) => s + (p.inference_latency_ms ?? 0), 0) / livePredictions.length;
    const attackRate = (attacks / livePredictions.length) * 100;
    return { 
      total: livePredictions.length, 
      attacks, 
      benign: livePredictions.length - attacks, 
      avgScore, 
      avgLatency,
      attackRate
    };
  }, [livePredictions]);

  // ── Enhanced analysis: Latest prediction + detailed stats ──
  const analysisData = useMemo(() => {
    if (livePredictions.length === 0) return null;
    
    const latest = livePredictions[livePredictions.length - 1];
    const attackCounts = livePredictions.reduce((acc, p) => {
      const type = p.attack_type?.toUpperCase() || 'UNKNOWN';
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    // Probability as percentage
    const probPercent = (latest.confidence ?? 0) * 100;
    
    // Use actual top_anomalies from the latest prediction
    const topAnomalies = latest.top_anomalies || [];
    
    // Adaptive sequence length recommendation
    const seqLengths: Record<string, number> = {
      'DDOS': 5,
      'PORTSCAN': 8, 
      'SLOWLORIS': 15,
    };
    const attackType = latest.attack_type?.toUpperCase() || 'UNKNOWN';
    const recommendedSeqLen = seqLengths[attackType] || 10;
    
    return {
      latest,
      probPercent,
      attackCounts,
      topAnomalies,
      recommendedSeqLen,
      attackType,
    };
  }, [livePredictions]);

  // ── Actions ───────────────────────────────────
  const handleStart = useCallback(async () => {
    setActionLoading(true);
    setError(null);
    try {
      const selectedClientObj = flClients.find(c => c.id === selectedClient);
      const config: SimulationStartConfig = {
        scenario: selectedScenario,
        replay_speed: replaySpeed,
        monitor_interval: monitorInterval,
        replay_loop: replayLoop,
        replay_shuffle: replayShuffle,
        clients: Array.from(selectedClients),
        selected_client_id: selectedClientObj?.client_id,
        selected_device_id: selectedDevice || undefined,
        attack_ratio: attackRatio,
        attack_type: selectedAttackType || undefined,
      };
      const s = await simulationApi.start(config);
      setStatus(s);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setError(e?.response?.data?.detail || e?.message || 'Failed to start simulation');
    } finally {
      setActionLoading(false);
    }
  }, [selectedScenario, replaySpeed, monitorInterval, replayLoop, replayShuffle, selectedClients, selectedClient, selectedDevice, attackRatio, selectedAttackType, flClients]);

  const handleStop = useCallback(async () => {
    setActionLoading(true);
    setError(null);
    try {
      const s = await simulationApi.stop();
      setStatus(s);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setError(e?.response?.data?.detail || e?.message || 'Failed to stop simulation');
    } finally {
      setActionLoading(false);
    }
  }, []);

  const handleRefresh = useCallback(async () => {
    try {
      const [scens, stat] = await Promise.all([
        simulationApi.scenarios().catch(() => scenarios),
        simulationApi.status().catch(() => status),
      ]);
      setScenarios(scens);
      if (stat) setStatus(stat);
    } catch { /* ignore */ }
  }, [scenarios, status]);

  const toggleClient = (id: string) => {
    setSelectedClients((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const isRunning = status?.state === 'running' || status?.state === 'starting';
  const selectedScenarioInfo = scenarios.find((s) => s.name === selectedScenario);

  // ── Loading state ─────────────────────────────
  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', gap: 12 }}>
        <Loader2 style={{ width: 24, height: 24, color: 'var(--accent)' }} className="animate-spin" />
        <span style={{ color: 'var(--text-muted)' }}>Loading simulation controls…</span>
      </div>
    );
  }

  return (
    <motion.div variants={stagger} initial="hidden" animate="show" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

      {/* ── Header ──────────────────────────────── */}
      <motion.div variants={fadeUp} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
            <Radio style={{ width: 22, height: 22, color: 'var(--accent)' }} />
            Traffic Simulation
          </h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '4px 0 0' }}>
            Replay real CIC-IDS2017 network traffic through the trained CNN-LSTM model
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* Status badge */}
          {status && (
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px',
                borderRadius: 20, fontSize: 12, fontWeight: 600,
                background: stateColor(status.state).bg, color: stateColor(status.state).fg,
              }}
            >
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: stateColor(status.state).dot,
                animation: status.state === 'running' ? 'pulse 2s infinite' : undefined }} />
              {stateIcon(status.state)}
              {status.state.toUpperCase()}
              {status.state === 'running' && status.uptime_seconds > 0 && (
                <span style={{ fontWeight: 400, marginLeft: 4 }}>({formatUptime(status.uptime_seconds)})</span>
              )}
            </div>
          )}
          <button
            onClick={handleRefresh}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 34, height: 34, borderRadius: 8, border: '1px solid var(--border)',
              background: 'var(--bg-card)', color: 'var(--text-muted)', cursor: 'pointer',
            }}
            title="Refresh"
          >
            <RefreshCw style={{ width: 14, height: 14 }} />
          </button>
        </div>
      </motion.div>

      {/* ── Error banner ────────────────────────── */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            style={{
              padding: '12px 16px', borderRadius: 10, fontSize: 13,
              background: 'var(--danger-light)', color: 'var(--danger)',
              display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--danger)',
            }}
          >
            <AlertTriangle style={{ width: 16, height: 16, flexShrink: 0 }} />
            {error}
            <button onClick={() => setError(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', fontSize: 16 }}>×</button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Live KPIs (visible when running) ───── */}
      <AnimatePresence>
        {isRunning && (
          <motion.div
            initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
            style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}
          >
            {[
              { label: 'Total Predictions', value: liveStats.total, icon: Activity, color: 'var(--accent)', format: 'number' },
              { label: 'Attacks Detected', value: liveStats.attacks, icon: AlertTriangle, color: 'var(--danger)', format: 'number' },
              { label: 'Attack Rate', value: liveStats.attackRate.toFixed(1), icon: Zap, color: 'var(--warning)', format: 'percent' },
              { label: 'Benign Flows', value: liveStats.benign, icon: CheckCircle2, color: 'var(--success)', format: 'number' },
              { label: 'Avg Score', value: liveStats.total > 0 ? liveStats.avgScore.toFixed(3) : '0.000', icon: Zap, color: 'var(--accent)', format: 'score' },
              { label: 'Avg Latency', value: liveStats.total > 0 ? liveStats.avgLatency.toFixed(1) : '0.0', icon: Clock, color: 'var(--accent)', format: 'latency' },
            ].map((kpi) => (
              <div
                key={kpi.label}
                style={{
                  background: 'var(--bg-card)', border: '1px solid var(--border)',
                  borderRadius: 12, padding: '16px 18px',
                  opacity: liveStats.total > 0 ? 1 : 0.6,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <div style={{ width: 30, height: 30, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', background: `color-mix(in srgb, ${kpi.color} 15%, transparent)` }}>
                    {liveStats.total === 0 ? (
                      <Loader2 style={{ width: 14, height: 14, color: kpi.color, animation: 'spin 1s linear infinite' }} />
                    ) : (
                      <kpi.icon style={{ width: 14, height: 14, color: kpi.color }} />
                    )}
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}>{kpi.label}</span>
                </div>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>
                  {liveStats.total === 0 ? (
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Waiting...</span>
                  ) : (
                    <>{kpi.format === 'latency' ? `${kpi.value}ms` : (kpi.format === 'percent' ? `${kpi.value}%` : kpi.value)}</>
                  )}
                </div>
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Main Grid: Config + Client Status ──── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>

        {/* ── Client & Device Selection ──────────── */}
        <motion.div
          variants={fadeUp}
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 14, padding: 24 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
            <Cpu style={{ width: 16, height: 16, color: 'var(--accent)' }} />
            <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>Device Selection</h2>
          </div>

          {/* Client Selector */}
          <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6, display: 'block' }}>
            Select Client
          </label>
          <div style={{ position: 'relative', marginBottom: 16 }}>
            <select
              value={selectedClient || ''}
              onChange={(e) => setSelectedClient(parseInt(e.target.value) || null)}
              disabled={isRunning}
              style={{
                width: '100%', padding: '10px 14px', borderRadius: 8,
                border: '1px solid var(--border)', background: 'var(--bg-secondary)',
                color: 'var(--text-primary)', fontSize: 13, cursor: isRunning ? 'not-allowed' : 'pointer',
                appearance: 'none', outline: 'none', opacity: isRunning ? 0.6 : 1,
              }}
            >
              <option value="">-- Choose a client --</option>
              {flClients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.client_id} ({c.name})
                </option>
              ))}
            </select>
            <ChevronDown style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', width: 14, height: 14, color: 'var(--text-muted)', pointerEvents: 'none' }} />
          </div>

          {/* Device Selector */}
          {selectedClient && clientDevices.length > 0 && (
            <>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6, display: 'block' }}>
                Select Device
              </label>
              <div style={{ position: 'relative', marginBottom: 16 }}>
                <select
                  value={selectedDevice || ''}
                  onChange={(e) => setSelectedDevice(e.target.value || null)}
                  disabled={isRunning}
                  style={{
                    width: '100%', padding: '10px 14px', borderRadius: 8,
                    border: '1px solid var(--border)', background: 'var(--bg-secondary)',
                    color: 'var(--text-primary)', fontSize: 13, cursor: isRunning ? 'not-allowed' : 'pointer',
                    appearance: 'none', outline: 'none', opacity: isRunning ? 0.6 : 1,
                  }}
                >
                  <option value="">-- All devices --</option>
                  {clientDevices.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name} ({d.device_type})
                    </option>
                  ))}
                </select>
                <ChevronDown style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', width: 14, height: 14, color: 'var(--text-muted)', pointerEvents: 'none' }} />
              </div>
            </>
          )}

          {/* Attack Ratio */}
          <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6, display: 'block' }}>
            <Zap style={{ width: 12, height: 12, display: 'inline', verticalAlign: 'middle', marginRight: 4 }} />
            Attack Ratio: {(attackRatio * 100).toFixed(0)}%
          </label>
          <input
            type="range"
            min={0} max={100} step={5}
            value={attackRatio * 100}
            onChange={(e) => setAttackRatio(parseFloat(e.target.value) / 100)}
            disabled={isRunning}
            style={{ width: '100%', marginBottom: 16, accentColor: 'var(--accent)', opacity: isRunning ? 0.6 : 1 }}
          />

          {/* Attack Type Selector */}
          <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6, display: 'block' }}>
            <Zap style={{ width: 12, height: 12, display: 'inline', verticalAlign: 'middle', marginRight: 6 }} />
            Attack Type
          </label>
          <div style={{ position: 'relative', marginBottom: 12 }}>
            <select
              value={selectedAttackType || ''}
              onChange={(e) => setSelectedAttackType(e.target.value || null)}
              disabled={isRunning}
              style={{
                width: '100%', padding: '10px 14px', borderRadius: 8,
                border: '1px solid var(--border)', background: 'var(--bg-secondary)',
                color: 'var(--text-primary)', fontSize: 13, cursor: isRunning ? 'not-allowed' : 'pointer',
                appearance: 'none', outline: 'none', opacity: isRunning ? 0.6 : 1,
              }}
            >
              <option value="">Auto (mix)</option>
              <option value="ddos">DDoS</option>
              <option value="portscan">Portscan</option>
              <option value="slowloris">Slowloris</option>
              <option value="infiltration">Infiltration</option>
            </select>
            <ChevronDown style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', width: 14, height: 14, color: 'var(--text-muted)', pointerEvents: 'none' }} />
          </div>

          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '8px 0 0', lineHeight: 1.5 }}>
            📊 Configure real-world traffic generation with controllable attack injection ratio
          </p>
        </motion.div>

        {/* ── Scenario Selection ─────────────────── */}
        <motion.div
          variants={fadeUp}
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 14, padding: 24 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
            <Settings2 style={{ width: 16, height: 16, color: 'var(--accent)' }} />
            <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>Scenario Configuration</h2>
          </div>

          {/* Scenario Selector */}
          <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6, display: 'block' }}>
            Traffic Scenario
          </label>
          <div style={{ position: 'relative', marginBottom: 16 }}>
            <select
              value={selectedScenario}
              onChange={(e) => setSelectedScenario(e.target.value)}
              disabled={isRunning}
              style={{
                width: '100%', padding: '10px 14px', borderRadius: 8,
                border: '1px solid var(--border)', background: 'var(--bg-secondary)',
                color: 'var(--text-primary)', fontSize: 13, cursor: isRunning ? 'not-allowed' : 'pointer',
                appearance: 'none', outline: 'none', opacity: isRunning ? 0.6 : 1,
              }}
            >
              {scenarios.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name === 'client_data' ? '📁 Client Data (Default)' : `🎯 ${s.name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}`}
                </option>
              ))}
            </select>
            <ChevronDown style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', width: 14, height: 14, color: 'var(--text-muted)', pointerEvents: 'none' }} />
          </div>

          {/* Scenario info */}
          {selectedScenarioInfo && (
            <div style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--bg-secondary)', marginBottom: 16, fontSize: 12, color: 'var(--text-muted)' }}>
              <p style={{ margin: '0 0 4px', fontWeight: 500, color: 'var(--text-primary)' }}>{selectedScenarioInfo.description}</p>
              {selectedScenarioInfo.total_windows > 0 && (
                <div style={{ display: 'flex', gap: 16, marginTop: 6 }}>
                  <span>Windows: <strong style={{ color: 'var(--text-primary)' }}>{selectedScenarioInfo.total_windows.toLocaleString()}</strong></span>
                  <span>Attack rate: <strong style={{ color: 'var(--danger)' }}>{(selectedScenarioInfo.attack_rate * 100).toFixed(1)}%</strong></span>
                </div>
              )}
            </div>
          )}

          {/* Replay Speed */}
          <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6, display: 'block' }}>
            <Gauge style={{ width: 12, height: 12, display: 'inline', verticalAlign: 'middle', marginRight: 4 }} />
            Replay Speed
          </label>
          <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
            {SPEED_PRESETS.map((preset) => (
              <button
                key={preset.value}
                onClick={() => setReplaySpeed(preset.value)}
                disabled={isRunning}
                style={{
                  flex: 1, padding: '8px 0', borderRadius: 8, fontSize: 12, fontWeight: 600,
                  border: replaySpeed === preset.value ? '2px solid var(--accent)' : '1px solid var(--border)',
                  background: replaySpeed === preset.value ? 'var(--accent-light)' : 'var(--bg-secondary)',
                  color: replaySpeed === preset.value ? 'var(--accent)' : 'var(--text-muted)',
                  cursor: isRunning ? 'not-allowed' : 'pointer',
                  opacity: isRunning ? 0.6 : 1,
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>

          {/* Monitor Interval */}
          <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6, display: 'block' }}>
            <Clock style={{ width: 12, height: 12, display: 'inline', verticalAlign: 'middle', marginRight: 4 }} />
            Prediction Interval: {monitorInterval.toFixed(1)}s
          </label>
          <input
            type="range"
            min={0.5} max={15} step={0.5}
            value={monitorInterval}
            onChange={(e) => setMonitorInterval(parseFloat(e.target.value))}
            disabled={isRunning}
            style={{ width: '100%', marginBottom: 16, accentColor: 'var(--accent)', opacity: isRunning ? 0.6 : 1 }}
          />

          {/* Toggles */}
          <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)', cursor: isRunning ? 'not-allowed' : 'pointer' }}>
              <input type="checkbox" checked={replayLoop} onChange={(e) => setReplayLoop(e.target.checked)} disabled={isRunning} style={{ accentColor: 'var(--accent)' }} />
              <Repeat style={{ width: 12, height: 12 }} /> Loop Replay
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)', cursor: isRunning ? 'not-allowed' : 'pointer' }}>
              <input type="checkbox" checked={replayShuffle} onChange={(e) => setReplayShuffle(e.target.checked)} disabled={isRunning} style={{ accentColor: 'var(--accent)' }} />
              <Shuffle style={{ width: 12, height: 12 }} /> Shuffle Order
            </label>
          </div>

          {/* Start / Stop buttons */}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            {!isRunning ? (
              <button
                onClick={handleStart}
                disabled={actionLoading || selectedClients.size === 0}
                style={{
                  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  padding: '12px 20px', borderRadius: 10, border: 'none', fontSize: 14, fontWeight: 600,
                  background: 'var(--accent)', color: '#fff', cursor: selectedClients.size === 0 ? 'not-allowed' : 'pointer',
                  opacity: actionLoading || selectedClients.size === 0 ? 0.6 : 1,
                  transition: 'opacity .15s, transform .1s',
                }}
              >
                {actionLoading ? <Loader2 style={{ width: 16, height: 16 }} className="animate-spin" /> : <Play style={{ width: 16, height: 16 }} />}
                Start Simulation
              </button>
            ) : (
              <button
                onClick={handleStop}
                disabled={actionLoading}
                style={{
                  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  padding: '12px 20px', borderRadius: 10, border: 'none', fontSize: 14, fontWeight: 600,
                  background: 'var(--danger)', color: '#fff', cursor: 'pointer',
                  opacity: actionLoading ? 0.6 : 1,
                }}
              >
                {actionLoading ? <Loader2 style={{ width: 16, height: 16 }} className="animate-spin" /> : <Square style={{ width: 16, height: 16 }} />}
                Stop Simulation
              </button>
            )}
          </div>
        </motion.div>

        {/* ── Client Selection + Status ──────────── */}
        <motion.div
          variants={fadeUp}
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 14, padding: 24 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
            <Server style={{ width: 16, height: 16, color: 'var(--accent)' }} />
            <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
              FL Clients {isRunning ? '(Live Status)' : '(Select)'}
            </h2>
          </div>

          {/* Client cards */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {ALL_CLIENTS.map((clientId) => {
              const selected = selectedClients.has(clientId);
              const clientStatus = status?.clients?.find((c) => c.client_id === clientId);
              const isClientRunning = clientStatus?.state === 'running';
              const hasError = clientStatus?.state === 'error';

              return (
                <div
                  key={clientId}
                  onClick={() => !isRunning && toggleClient(clientId)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '14px 16px', borderRadius: 10,
                    border: selected ? '2px solid var(--accent)' : '1px solid var(--border)',
                    background: selected ? 'var(--accent-light)' : 'var(--bg-secondary)',
                    cursor: isRunning ? 'default' : 'pointer',
                    transition: 'border-color .15s, background .15s',
                  }}
                >
                  {/* Checkbox (when not running) */}
                  {!isRunning && (
                    <div style={{
                      width: 18, height: 18, borderRadius: 4,
                      border: selected ? '2px solid var(--accent)' : '2px solid var(--border)',
                      background: selected ? 'var(--accent)' : 'transparent',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    }}>
                      {selected && <CheckCircle2 style={{ width: 12, height: 12, color: '#fff' }} />}
                    </div>
                  )}

                  {/* Client info */}
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
                      {clientId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                      {clientId === 'bank_a' && 'Monday + Tuesday traffic'}
                      {clientId === 'bank_b' && 'Wednesday + Thursday traffic'}
                      {clientId === 'bank_c' && 'Friday traffic'}
                    </div>
                  </div>

                  {/* Live status (when running) */}
                  {isRunning && clientStatus && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {isClientRunning && (
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: 4,
                          padding: '4px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600,
                          background: 'var(--success-light)', color: 'var(--success)',
                        }}>
                          <div style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--success)', animation: 'pulse 2s infinite' }} />
                          Running
                        </div>
                      )}
                      {hasError && (
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: 4,
                          padding: '4px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600,
                          background: 'var(--danger-light)', color: 'var(--danger)',
                        }}>
                          <XCircle style={{ width: 10, height: 10 }} />
                          Error
                        </div>
                      )}
                      {!isClientRunning && !hasError && (
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{clientStatus.state}</span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Container details when running */}
          {isRunning && status?.clients && status.clients.length > 0 && (
            <div style={{ marginTop: 16, padding: 14, borderRadius: 10, background: 'var(--bg-secondary)' }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 8 }}>Container Details</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {status.clients.map((c) => (
                  <div key={c.client_id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                    <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{c.container_name || c.client_id}</span>
                    <span style={{ color: c.state === 'running' ? 'var(--success)' : 'var(--text-muted)' }}>
                      {c.container_id ? c.container_id.slice(0, 12) : '—'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Active config summary when running */}
          {isRunning && status?.config && (
            <div style={{ marginTop: 12, padding: 14, borderRadius: 10, background: 'var(--bg-secondary)' }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 8 }}>Active Configuration</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px', fontSize: 12 }}>
                <span style={{ color: 'var(--text-muted)' }}>Scenario:</span>
                <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{status.config.scenario || 'Client Data'}</span>
                <span style={{ color: 'var(--text-muted)' }}>Speed:</span>
                <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{status.config.replay_speed}×</span>
                <span style={{ color: 'var(--text-muted)' }}>Interval:</span>
                <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{status.config.monitor_interval}s</span>
                <span style={{ color: 'var(--text-muted)' }}>Loop:</span>
                <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{status.config.replay_loop ? 'Yes' : 'No'}</span>
              </div>
            </div>
          )}
        </motion.div>
      </div>

      {/* ── Recent Predictions (live feed) ──────── */}
      <motion.div
        variants={fadeUp}
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 14, padding: 24 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <Activity style={{ width: 16, height: 16, color: 'var(--accent)' }} />
          <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>Live Prediction Feed</h2>
          {isRunning && (
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--success)' }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)', animation: 'pulse 2s infinite' }} />
              Live
            </div>
          )}
        </div>

        {livePredictions.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--text-muted)', fontSize: 13 }}>
            {isRunning ? 'Waiting for predictions…' : 'Start a simulation to see live predictions'}
          </div>
        ) : (
          <div style={{ maxHeight: 320, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Time', 'Device', 'Score', 'Prediction', 'Confidence', 'Latency'].map((h) => (
                    <th key={h} style={{ padding: '8px 10px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500, fontSize: 11 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {livePredictions.slice(0, 30).map((p, i) => (
                  <tr key={`${p.timestamp}-${i}`} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 10px', color: 'var(--text-muted)' }}>
                      {new Date(p.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </td>
                    <td style={{ padding: '8px 10px', color: 'var(--text-primary)', fontWeight: 500 }}>
                      {p.device_name || String(p.device_id).slice(0, 8)}
                    </td>
                    <td style={{ padding: '8px 10px', fontFamily: 'monospace', color: p.score >= 0.5 ? 'var(--danger)' : 'var(--success)' }}>
                      {p.score.toFixed(4)}
                    </td>
                    <td style={{ padding: '8px 10px' }}>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        padding: '2px 8px', borderRadius: 8, fontSize: 11, fontWeight: 600,
                        background: p.label === 'attack' ? 'var(--danger-light)' : 'var(--success-light)',
                        color: p.label === 'attack' ? 'var(--danger)' : 'var(--success)',
                      }}>
                        {p.label === 'attack' ? '🚨' : '✓'} {p.label.toUpperCase()}
                      </span>
                    </td>
                    <td style={{ padding: '8px 10px', fontFamily: 'monospace', color: 'var(--text-primary)' }}>
                      {(p.confidence * 100).toFixed(1)}%
                    </td>
                    <td style={{ padding: '8px 10px', fontFamily: 'monospace', color: 'var(--text-muted)' }}>
                      {(p.inference_latency_ms ?? 0).toFixed(1)}ms
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </motion.div>

      {/* ── XAI: Prediction Explanation (Temporal + Anomalies) ── */}
      {isRunning && analysisData?.latest && analysisData.latest.label === 'attack' && (
        <motion.div
          initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
          variants={fadeUp}
          style={{ background: 'var(--bg-card)', border: '1px solid var(--danger-light)', borderRadius: 14, padding: 24 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Zap style={{ width: 16, height: 16, color: 'var(--danger)' }} />
              🔍 Attack Analysis - Why Detected?
            </h2>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {/* Temporal Pattern */}
            <div style={{ padding: 14, borderRadius: 10, background: 'var(--bg-secondary)' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>📊 Temporal Pattern</div>
              <div style={{ fontSize: 13, color: analysisData.latest.temporal_pattern ? 'var(--warning)' : 'var(--text-muted)' }}>
                {analysisData.latest.temporal_pattern || 'Analyzing...'}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
                Pattern observed across the last 3 flows in the sequence
              </div>
            </div>

            {/* Prediction Confidence */}
            <div style={{ padding: 14, borderRadius: 10, background: 'rgba(239,68,68,0.1)' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>🎯 Prediction Stats</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
                <span style={{ color: 'var(--text-muted)' }}>Score:</span>
                <span style={{ fontWeight: 600, color: 'var(--danger)' }}>
                  {analysisData.latest.score.toFixed(4)}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                <span style={{ color: 'var(--text-muted)' }}>Confidence:</span>
                <span style={{ fontWeight: 600, color: 'var(--danger)' }}>
                  {(analysisData.latest.confidence * 100).toFixed(1)}%
                </span>
              </div>
            </div>
          </div>

          {/* Top Anomalies - Feature Importance */}
          {analysisData.latest.top_anomalies && analysisData.latest.top_anomalies.length > 0 && (
            <div style={{ marginTop: 16, padding: 14, borderRadius: 10, background: 'var(--bg-secondary)' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--danger)', marginBottom: 12 }}>🔴 Top Anomalous Features Causing Detection</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
                {analysisData.latest.top_anomalies.slice(0, 3).map((anom, idx) => (
                  <div key={idx} style={{ padding: 12, borderRadius: 8, background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 8 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)' }}>
                        {idx + 1}. {anom.feature}
                      </div>
                      <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--danger)', background: 'rgba(239,68,68,0.3)', padding: '2px 6px', borderRadius: 4 }}>
                        {anom.ratio.toFixed(1)}x
                      </span>
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace', lineHeight: 1.6 }}>
                      <div>Observed: <span style={{ color: 'var(--danger)', fontWeight: 600 }}>{anom.value.toFixed(1)}</span></div>
                      <div>Normal: {anom.baseline.toFixed(1)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </motion.div>
      )}

      {/* ── How it works ────────────────────────── */}
      {!isRunning && (
        <motion.div
          variants={fadeUp}
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 14, padding: 24 }}
        >
          <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Zap style={{ width: 16, height: 16, color: 'var(--warning)' }} />
            How It Works
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
            {[
              { step: '1', title: 'Select Scenario', desc: 'Choose an attack scenario or use default client training data' },
              { step: '2', title: 'Configure Replay', desc: 'Set speed, interval, and loop settings for the simulation' },
              { step: '3', title: 'Start Simulation', desc: 'FL client containers replay real CIC-IDS2017 traffic' },
              { step: '4', title: 'Real Predictions', desc: 'CNN-LSTM model runs inference on real preprocessed data' },
            ].map((item) => (
              <div key={item.step} style={{ padding: '14px 16px', borderRadius: 10, background: 'var(--bg-secondary)' }}>
                <div style={{
                  width: 24, height: 24, borderRadius: '50%', background: 'var(--accent)',
                  color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 12, fontWeight: 700, marginBottom: 8,
                }}>{item.step}</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>{item.title}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4 }}>{item.desc}</div>
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {/* Pulse animation */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </motion.div>
  );
}
