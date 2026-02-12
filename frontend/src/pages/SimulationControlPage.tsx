import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Loader2, Play, Square,
  AlertTriangle,
  ChevronDown,
} from 'lucide-react';
import { simulationApi } from '@/api/simulation';
import { useLiveStore } from '@/stores/liveStore';
import type { Scenario, SimulationStatus, SimClient } from '@/api/simulation';

/* ── Animations ───────────────────────────────── */
const stagger = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { staggerChildren: 0.06 } } };
const fadeUp  = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } };

/* ── Helpers ────────────────────────────────── */

function stateColor(state: string) {
  switch (state) {
    case 'running':  return { bg: 'var(--success-light)', fg: 'var(--success)', dot: 'var(--success)' };
    case 'starting': return { bg: 'var(--warning-light)', fg: 'var(--warning)', dot: 'var(--warning)' };
    case 'stopping': return { bg: 'var(--warning-light)', fg: 'var(--warning)', dot: 'var(--warning)' };
    case 'error':    return { bg: 'var(--danger-light)',  fg: 'var(--danger)',  dot: 'var(--danger)'  };
    default:         return { bg: 'var(--bg-secondary)',  fg: 'var(--text-muted)', dot: 'var(--text-muted)' };
  }
}

function formatUptime(sec: number): string {
  if (sec < 60) return `${Math.floor(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.floor(sec % 60)}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

function friendlyScenario(name: string): string {
  if (name === 'client_data') return 'Client Data';
  return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function attackIcon(rate: number): string {
  if (rate === 0) return '🟢';
  if (rate < 0.3) return '🟡';
  if (rate < 0.6) return '🟠';
  return '🔴';
}

/* ══════════════════════════════════════════════════
   SimulationControlPage
   ══════════════════════════════════════════════════ */
export default function SimulationControlPage() {
  /* ── State ─────────────────────────────────── */
  const [scenarios, setScenarios]       = useState<Scenario[]>([]);
  const [simClients, setSimClients]     = useState<SimClient[]>([]);
  const [status, setStatus]             = useState<SimulationStatus | null>(null);
  const [loading, setLoading]           = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError]               = useState<string | null>(null);

  // User picks
  const [selectedScenario, setSelectedScenario] = useState('');
  const selectedDuration = 'continuous';
  const [selectedClients, setSelectedClients]   = useState<Set<string>>(new Set());

  // Live predictions from WS (last 50)
  const livePredictions = useLiveStore(s => s.latestPredictions);
  const clearPredictions = useLiveStore(s => s.clearPredictions);

  // Polling
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /* ── Initial load ──────────────────────────── */
  useEffect(() => {
    Promise.all([
      simulationApi.scenarios().catch(() => []),
      simulationApi.status().catch(() => null),
      simulationApi.clients().catch(() => []),
    ]).then(([scens, stat, cls]) => {
      setScenarios(scens);
      if (stat) setStatus(stat);
      setSimClients(cls);

      // Default selection: first non-default scenario or client_data
      if (scens.length > 0) {
        const first = scens.find(s => !s.is_default);
        setSelectedScenario(first ? first.name : 'client_data');
      }
      // Select only clients that have devices
      const withDevices = cls.filter(c => c.device_count > 0);
      if (withDevices.length > 0) {
        setSelectedClients(new Set(withDevices.map(c => c.client_id)));
      }
    }).finally(() => setLoading(false));
  }, []);

  /* ── Status polling while running ──────────── */
  useEffect(() => {
    if (status?.state === 'running' || status?.state === 'starting') {
      pollRef.current = setInterval(async () => {
        try { setStatus(await simulationApi.status()); } catch { /* ignore */ }
      }, 3000);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [status?.state]);

  /* ── Derived ───────────────────────────────── */
  const isRunning     = status?.state === 'running' || status?.state === 'starting';

  // Only show clients that have at least one device
  const eligibleClients = useMemo(
    () => simClients.filter(c => c.device_count > 0),
    [simClients],
  );

  const liveStats = useMemo(() => {
    if (livePredictions.length === 0)
      return { total: 0, attacks: 0, benign: 0, rate: 0 };
    const attacks = livePredictions.filter(p => p.label === 'attack').length;
    return {
      total:   livePredictions.length,
      attacks,
      benign:  livePredictions.length - attacks,
      rate:    attacks / livePredictions.length,
    };
  }, [livePredictions]);

  /* ── Actions ───────────────────────────────── */
  const handleStart = useCallback(async () => {
    setActionLoading(true);
    setError(null);
    clearPredictions();
    try {
      const s = await simulationApi.start({
        scenario: selectedScenario,
        duration: selectedDuration,
        clients: Array.from(selectedClients),
      });
      setStatus(s);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setError(e?.response?.data?.detail || e?.message || 'Failed to start simulation');
    } finally {
      setActionLoading(false);
    }
  }, [selectedScenario, selectedDuration, selectedClients, clearPredictions]);

  const handleStop = useCallback(async () => {
    setActionLoading(true);
    setError(null);
    try {
      setStatus(await simulationApi.stop());
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setError(e?.response?.data?.detail || e?.message || 'Failed to stop simulation');
    } finally {
      setActionLoading(false);
    }
  }, []);

  const toggleClient = (id: string) => {
    setSelectedClients(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  /* ── Loading spinner ───────────────────────── */
  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', gap: 12 }}>
        <Loader2 style={{ width: 24, height: 24, color: 'var(--accent)' }} className="animate-spin" />
        <span style={{ color: 'var(--text-muted)' }}>Loading simulation…</span>
      </div>
    );
  }

  /* ══════════════════════════════════════════════
     RENDER
     ══════════════════════════════════════════════ */
  return (
    <motion.div variants={stagger} initial="hidden" animate="show"
      style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

      {/* ── Header ──────────────────────────────── */}
      <motion.div variants={fadeUp}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', margin: 0,
                       display: 'flex', alignItems: 'center', gap: 10 }}>
            Traffic Simulation
          </h1>
        </div>

        {/* Status badge */}
        {status && status.state !== 'idle' && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px',
            borderRadius: 20, fontSize: 12, fontWeight: 600,
            background: stateColor(status.state).bg,
            color: stateColor(status.state).fg,
          }}>
            <div style={{
              width: 6, height: 6, borderRadius: '50%',
              background: stateColor(status.state).dot,
              animation: status.state === 'running' ? 'pulse 2s infinite' : undefined,
            }} />
            {status.state === 'running' ? null
              : status.state === 'starting' || status.state === 'stopping'
              ? <Loader2 style={{ width: 14, height: 14 }} className="animate-spin" />
              : null}
            {status.state.toUpperCase()}
            {status.state === 'running' && status.uptime_seconds > 0 && (
              <span style={{ fontWeight: 400, marginLeft: 4 }}>
                ({formatUptime(status.uptime_seconds)})
              </span>
            )}
          </div>
        )}
      </motion.div>

      {/* ── Error banner ────────────────────────── */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            style={{
              padding: '12px 16px', borderRadius: 10, fontSize: 13,
              background: 'var(--danger-light)', color: 'var(--danger)',
              display: 'flex', alignItems: 'center', gap: 8,
              border: '1px solid var(--danger)',
            }}>
            <AlertTriangle style={{ width: 16, height: 16, flexShrink: 0 }} />
            {error}
            <button onClick={() => setError(null)}
              style={{ marginLeft: 'auto', background: 'none', border: 'none',
                       color: 'var(--danger)', cursor: 'pointer', fontSize: 16 }}>×</button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Live KPIs (when running) ─────────────── */}
      <AnimatePresence>
        {isRunning && (
          <motion.div
            initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            style={{
              background: 'var(--bg-card)', border: '1px solid var(--border)',
              borderRadius: 14, padding: 20,
            }}>

            {/* Active info row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '5px 12px', borderRadius: 3, fontSize: 12, fontWeight: 600,
                background: 'var(--accent-light)', color: 'var(--accent)',
              }}>
                {friendlyScenario(status?.config?.scenario || 'client_data')}
              </div>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {status?.scenario_description}
              </span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 'auto' }}>
                {status?.config?.flow_rate ?? 0} flows/sec
                {' · '}
                {status?.config?.duration === 'continuous' ? 'Continuous' : status?.config?.duration}
              </span>
            </div>

            {/* KPI cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
              {[
                { label: 'Recent (50)',      value: liveStats.total,   color: 'var(--accent)' },
                { label: 'Attacks Detected', value: liveStats.attacks, color: 'var(--danger)' },
                { label: 'Benign Flows',     value: liveStats.benign,  color: 'var(--success)' },
                { label: 'Attack Rate',
                  value: liveStats.total > 0 ? `${(liveStats.rate * 100).toFixed(1)}%` : '—',
                  color: liveStats.rate > 0.5 ? 'var(--danger)' : 'var(--success)' },
              ].map(kpi => (
                <div key={kpi.label} style={{
                  background: 'var(--bg-secondary)', borderRadius: 3, padding: '14px 16px',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}>{kpi.label}</span>
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>{kpi.value}</div>
                </div>
              ))}
            </div>

            {/* Per-client status chips */}
            {status?.clients && status.clients.length > 0 && (
              <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
                {status.clients.map(c => (
                  <div key={c.client_id} style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '5px 12px', borderRadius: 20, fontSize: 11, fontWeight: 500,
                    background: c.state === 'running' ? 'var(--success-light)' : c.state === 'error' ? 'var(--danger-light)' : 'var(--bg-secondary)',
                    color: c.state === 'running' ? 'var(--success)' : c.state === 'error' ? 'var(--danger)' : 'var(--text-muted)',
                  }}>
                    <div style={{
                      width: 5, height: 5, borderRadius: '50%',
                      background: c.state === 'running' ? 'var(--success)' : c.state === 'error' ? 'var(--danger)' : 'var(--text-muted)',
                      animation: c.state === 'running' ? 'pulse 2s infinite' : undefined,
                    }} />
                    {c.client_id.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase())}
                    {c.state === 'error' && c.error && (
                      <span style={{ fontWeight: 400 }}> — {c.error.slice(0, 40)}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Main Grid: Config + Clients ──────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>

        {/* ── Scenario Selection Card ────────────── */}
        <motion.div variants={fadeUp}
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 14, padding: 24 }}>

          <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 18px',
                       display: 'flex', alignItems: 'center', gap: 8 }}>
            {isRunning ? 'Active Scenario' : 'Choose Scenario'}
          </h2>

          {/* Scenario selector */}
          <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6, display: 'block' }}>
            Attack Scenario
          </label>
          <div style={{ position: 'relative', marginBottom: 16 }}>
            <select
              value={selectedScenario}
              onChange={e => setSelectedScenario(e.target.value)}
              disabled={isRunning}
              style={{
                width: '100%', padding: '10px 14px', borderRadius: 8,
                border: '1px solid var(--border)', background: 'var(--bg-secondary)',
                color: 'var(--text-primary)', fontSize: 13,
                cursor: isRunning ? 'not-allowed' : 'pointer',
                appearance: 'none', outline: 'none', opacity: isRunning ? 0.6 : 1,
              }}>
              {scenarios.map(s => (
                <option key={s.name} value={s.name}>
                  {s.is_default
                    ? '📁 Client Data (Default)'
                    : `${attackIcon(s.attack_rate)} ${friendlyScenario(s.name)}`}
                </option>
              ))}
            </select>
            <ChevronDown style={{
              position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
              width: 14, height: 14, color: 'var(--text-muted)', pointerEvents: 'none',
            }} />
          </div>

          {/* Start / Stop */}
          <div style={{ display: 'flex', gap: 8 }}>
            {!isRunning ? (
              <button
                onClick={handleStart}
                disabled={actionLoading || selectedClients.size === 0}
                style={{
                  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  padding: '13px 20px', borderRadius: 10, border: 'none', fontSize: 14, fontWeight: 600,
                  background: 'var(--accent)', color: '#fff',
                  cursor: selectedClients.size === 0 ? 'not-allowed' : 'pointer',
                  opacity: actionLoading || selectedClients.size === 0 ? 0.6 : 1,
                }}>
                {actionLoading
                  ? <Loader2 style={{ width: 16, height: 16 }} className="animate-spin" />
                  : <Play style={{ width: 16, height: 16 }} />}
                Start Simulation
              </button>
            ) : (
              <button
                onClick={handleStop}
                disabled={actionLoading}
                style={{
                  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  padding: '13px 20px', borderRadius: 10, border: 'none', fontSize: 14, fontWeight: 600,
                  background: 'var(--danger)', color: '#fff', cursor: 'pointer',
                  opacity: actionLoading ? 0.6 : 1,
                }}>
                {actionLoading
                  ? <Loader2 style={{ width: 16, height: 16 }} className="animate-spin" />
                  : <Square style={{ width: 16, height: 16 }} />}
                Stop Simulation
              </button>
            )}
          </div>
        </motion.div>

        {/* ── Client Selection Card ──────────────── */}
        <motion.div variants={fadeUp}
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 14, padding: 24 }}>

          <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 18px',
                       display: 'flex', alignItems: 'center', gap: 8 }}>
            {isRunning ? 'Active Clients' : 'Select Clients'}
            <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 'auto' }}>
              {selectedClients.size} of {eligibleClients.length} selected
            </span>
          </h2>

          {eligibleClients.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--text-muted)', fontSize: 13 }}>
              <span style={{ display: 'block', margin: '0 auto 8px', fontSize: 16, color: 'var(--warning)' }}>!</span>
              <strong style={{ color: 'var(--text-primary)' }}>No clients with devices available.</strong>
              <br />Please register devices in the <strong>Device Management</strong> page first.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {eligibleClients.map(client => {
                const selected = selectedClients.has(client.client_id);
                const clientState = status?.clients?.find(c => c.client_id === client.client_id);

                return (
                  <div
                    key={client.client_id}
                    onClick={() => !isRunning && toggleClient(client.client_id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 12,
                      padding: '12px 14px', borderRadius: 10,
                      border: selected ? '2px solid var(--accent)' : '1px solid var(--border)',
                      background: selected ? 'var(--accent-light)' : 'var(--bg-secondary)',
                      cursor: isRunning ? 'default' : 'pointer',
                      transition: 'border-color .15s, background .15s',
                    }}>

                    {/* Checkbox (when idle) */}
                    {!isRunning && (
                      <div style={{
                        width: 18, height: 18, borderRadius: 4,
                        border: selected ? '2px solid var(--accent)' : '2px solid var(--border)',
                        background: selected ? 'var(--accent)' : 'transparent',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0,
                      }}>
                        {selected && <span style={{ fontSize: 10, color: '#fff', fontWeight: 700 }}>✓</span>}
                      </div>
                    )}

                    {/* Client info */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
                        {client.name || friendlyScenario(client.client_id)}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                        {`${client.device_count} device${client.device_count > 1 ? 's' : ''}`}
                        {client.total_samples > 0 && ` · ${client.total_samples.toLocaleString()} samples`}
                      </div>
                    </div>

                    {/* Live state badge */}
                    {isRunning && clientState && (
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 4,
                        padding: '4px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600,
                        background: clientState.state === 'running' ? 'var(--success-light)'
                                  : clientState.state === 'error' ? 'var(--danger-light)'
                                  : 'var(--bg-secondary)',
                        color: clientState.state === 'running' ? 'var(--success)'
                             : clientState.state === 'error' ? 'var(--danger)'
                             : 'var(--text-muted)',
                      }}>
                        <div style={{
                          width: 5, height: 5, borderRadius: '50%',
                          background: clientState.state === 'running' ? 'var(--success)' : clientState.state === 'error' ? 'var(--danger)' : 'var(--text-muted)',
                          animation: clientState.state === 'running' ? 'pulse 2s infinite' : undefined,
                        }} />
                        {clientState.state === 'running' ? 'Predicting'
                          : clientState.state === 'error' ? 'Error' : clientState.state}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </motion.div>
      </div>

      {/* ── Live Prediction Feed ─────────────────── */}
      <motion.div variants={fadeUp}
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 14, padding: 24 }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
            Live Prediction Feed
          </h2>
          {isRunning && (
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--success)' }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)', animation: 'pulse 2s infinite' }} />
              Live — Model is predicting
            </div>
          )}
        </div>

        {livePredictions.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: 13 }}>
            {isRunning
              ? 'Waiting for the first predictions to arrive…'
              : 'Start a simulation to see real‑time predictions from the CNN‑LSTM model'}
          </div>
        ) : (
          <div style={{ maxHeight: 360, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Time', 'Device', 'Prediction', 'Confidence', 'Attack Type', 'Latency'].map(h => (
                    <th key={h} style={{ padding: '8px 10px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 500, fontSize: 11 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {livePredictions.slice(0, 40).map((p, i) => (
                  <tr key={`${p.timestamp}-${i}`}
                    style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 10px', color: 'var(--text-muted)' }}>
                      {new Date(p.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </td>
                    <td style={{ padding: '8px 10px', color: 'var(--text-primary)', fontWeight: 500 }}>
                      {p.device_name || String(p.device_id).slice(0, 8)}
                    </td>
                    <td style={{ padding: '8px 10px' }}>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        padding: '2px 8px', borderRadius: 8, fontSize: 11, fontWeight: 600,
                        background: p.label === 'attack' ? 'var(--danger-light)' : 'var(--success-light)',
                        color: p.label === 'attack' ? 'var(--danger)' : 'var(--success)',
                      }}>
                        {p.label === 'attack' ? '🚨' : '✓'} {p.label === 'attack' ? 'ATTACK' : 'BENIGN'}
                      </span>
                    </td>
                    <td style={{ padding: '8px 10px', fontFamily: 'monospace', color: 'var(--text-primary)' }}>
                      {(p.confidence * 100).toFixed(1)}%
                    </td>
                    <td style={{ padding: '8px 10px', color: 'var(--text-muted)' }}>
                      {p.attack_type ? friendlyScenario(p.attack_type) : '—'}
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
