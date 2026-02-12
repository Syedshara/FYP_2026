import { useState } from 'react';
import { motion } from 'framer-motion';
import { Loader2 } from 'lucide-react';

const stagger = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { staggerChildren: 0.06 } } };
const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } };

/* ---------- Pipeline steps ---------- */
const pipelineSteps = [
  { id: 1, name: 'Device\nConfigured', color: '#22C55E' },
  { id: 2, name: 'Traffic\nCapture',   color: 'var(--accent)' },
  { id: 3, name: 'Attack\nSimulation', color: '#EF4444' },
  { id: 4, name: 'CNN-LSTM\nDetection', color: 'var(--accent)' },
  { id: 5, name: 'XAI\nAnalysis',       color: '#F59E0B' },
  { id: 6, name: 'Auto\nPrevention',    color: '#22C55E' },
  { id: 7, name: 'Report\nGenerated',   color: 'var(--text-muted)' },
];

/* ---------- Attack sequence (mock) ---------- */
type AttackStatus = 'done' | 'running' | 'pending';
interface AttackItem {
  name: string;
  status: AttackStatus;
  duration: string;
  score: number | null;
}

const mockAttacks: AttackItem[] = [
  { name: 'DDoS Flood',      status: 'done',    duration: '30s', score: 0.94 },
  { name: 'DoS Slowloris',   status: 'done',    duration: '20s', score: 0.87 },
  { name: 'Port Scan',       status: 'done',    duration: '20s', score: 0.81 },
  { name: 'Brute Force SSH', status: 'running', duration: '15s', score: 0.72 },
  { name: 'SQL Injection',   status: 'pending', duration: '—',   score: null },
  { name: 'DNS Amplification', status: 'pending', duration: '—', score: null },
  { name: 'MITM ARP Spoof', status: 'pending', duration: '—',    score: null },
];

/* ---------- Results summary (mock) ---------- */
const resultsSummary = [
  { label: 'Attacks Tested',     value: '3 / 7',  color: 'var(--accent)' },
  { label: 'Detection Rate',     value: '100%',    color: 'var(--success)' },
  { label: 'Avg Score',          value: '0.87',    color: 'var(--warning)' },
  { label: 'Auto-Blocked',       value: '2',       color: 'var(--danger)' },
  { label: 'Alerts Sent',        value: '3',       color: 'var(--accent)' },
  { label: 'Avg Latency',        value: '12ms',    color: 'var(--success)' },
];

const statusStyle: Record<AttackStatus, { bg: string; color: string; label: string }> = {
  done:    { bg: 'var(--success)', color: '#fff', label: 'DONE' },
  running: { bg: 'var(--accent)',  color: '#fff', label: 'RUNNING' },
  pending: { bg: 'var(--bg-secondary)', color: 'var(--text-muted)', label: 'PENDING' },
};

export default function AttackPipelinePage() {
  const [currentStep] = useState(4);
  const progress = ((currentStep - 1) / (pipelineSteps.length - 1)) * 100;

  return (
    <motion.div variants={stagger} initial="hidden" animate="show" className="page-stack">
      {/* Header */}
      <motion.div variants={fadeUp} className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>Automated Attack Pipeline</h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>Pipeline runs automatically when a device is configured</p>
        </div>
        <span className="badge" style={{ background: 'var(--success)', color: '#fff', fontSize: 11 }}>AUTO-RUN ENABLED</span>
      </motion.div>

      {/* Pipeline Flow */}
      <motion.div variants={fadeUp} className="card" style={{ padding: 24 }}>
        <h2 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 20 }}>Pipeline Flow: Device Added / Configured</h2>

        <div className="flex items-center gap-2 overflow-x-auto pb-2" style={{ minHeight: 70 }}>
          {pipelineSteps.map((step, i) => {
            const isActive = i + 1 === currentStep;
            const isDone = i + 1 < currentStep;
            const opacity = isDone ? 1 : isActive ? 1 : 0.4;

            return (
              <div key={step.id} className="flex items-center" style={{ flexShrink: 0 }}>
                <motion.div
                  whileHover={{ scale: 1.04 }}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    width: 110, height: 56, borderRadius: 3, opacity,
                    background: step.color, color: step.color === '#F59E0B' ? '#0F172A' : '#fff',
                    fontSize: 11, fontWeight: 600, textAlign: 'center', lineHeight: 1.3,
                    border: isActive ? '2px solid #1a1a1a' : 'none',
                    fontFamily: 'inherit',
                  }}
                >
                  {step.name.split('\n').map((l, li) => <span key={li}>{l}</span>)}
                </motion.div>
                {i < pipelineSteps.length - 1 && (
                  <div style={{ width: 32, height: 2, background: isDone ? 'var(--accent)' : 'var(--border)', margin: '0 2px', flexShrink: 0 }} />
                )}
              </div>
            );
          })}
        </div>
      </motion.div>

      {/* Current Device Status */}
      <motion.div variants={fadeUp} className="card" style={{ padding: 20, borderLeft: '3px solid var(--success)' }}>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <p style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>Camera_01</p>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, fontFamily: 'monospace' }}>
              IP: 192.168.1.101 | Protocol: TCP | Port: 8080 | Status: Online
            </p>
          </div>
          <div style={{ textAlign: 'right' }}>
            <span className="badge" style={{ background: 'var(--accent)', color: '#fff', fontSize: 11 }}>PIPELINE RUNNING</span>
            <div style={{ marginTop: 8 }}>
              <span style={{ fontSize: 11, fontFamily: 'inherit', color: 'var(--text-primary)' }}>
                {(() => { const total = 20; const filled = Math.round((progress / 100) * total); return `[${'█'.repeat(filled)}${'░'.repeat(total - filled)}] ${Math.round(progress)}%`; })()}
              </span>
            </div>
            <p style={{ fontSize: 10, color: 'var(--accent)', marginTop: 4 }}>Step {currentStep} of {pipelineSteps.length} — {pipelineSteps[currentStep - 1].name.replace('\n', ' ')}</p>
          </div>
        </div>
      </motion.div>

      {/* Main content: Attack Sequence + Results */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Attack Sequence */}
        <motion.div variants={fadeUp} className="card lg:col-span-3" style={{ padding: 24 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>Auto-Run Attack Sequence</h2>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, marginBottom: 16 }}>Executed automatically for every new device</p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {mockAttacks.map((atk) => {
              const s = statusStyle[atk.status];
              return (
                <motion.div
                  key={atk.name}
                  whileHover={{ x: 2 }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
                    borderRadius: 8,
                    background: atk.status === 'done' ? 'rgba(34,197,94,0.06)' :
                                atk.status === 'running' ? 'rgba(99,102,241,0.08)' : 'var(--bg-primary)',
                    border: atk.status === 'running' ? '1px solid var(--accent)' : '1px solid var(--border)',
                  }}
                >
                  {/* Status badge */}
                  <span style={{
                    padding: '3px 10px', borderRadius: 4, fontSize: 9, fontWeight: 700,
                    background: s.bg, color: s.color, minWidth: 56, textAlign: 'center',
                  }}>
                    {s.label}
                  </span>

                  {/* Name */}
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', flex: 1 }}>{atk.name}</span>

                  {/* Duration */}
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{atk.duration}</span>

                  {/* Score */}
                  {atk.score !== null && (
                    <span style={{
                      fontSize: 12, fontWeight: 600,
                      color: atk.score >= 0.7 ? 'var(--danger)' : atk.score >= 0.5 ? 'var(--warning)' : 'var(--success)',
                    }}>
                      Score: {atk.score.toFixed(2)}
                    </span>
                  )}

                  {/* Running progress */}
                  {atk.status === 'running' && (
                    <span style={{ fontSize: 11, fontFamily: 'inherit', color: 'var(--accent)' }}>[████░░░░░░]</span>
                  )}
                </motion.div>
              );
            })}
          </div>
        </motion.div>

        {/* Results Summary */}
        <motion.div variants={fadeUp} className="card lg:col-span-2" style={{ padding: 24 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 16 }}>Pipeline Results</h2>

          <div className="grid grid-cols-2 gap-3">
            {resultsSummary.map((r) => (
              <div key={r.label} className="card" style={{ padding: 16, textAlign: 'center' }}>
                <p style={{ fontSize: 22, fontWeight: 700, color: r.color }}>{r.value}</p>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{r.label}</p>
              </div>
            ))}
          </div>

          {/* Detection timeline mini */}
          <div style={{ marginTop: 20 }}>
            <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 10 }}>Detection Timeline</p>
            <div className="space-y-2">
              {mockAttacks.filter(a => a.status === 'done').map((a) => (
                <div key={a.name} className="flex items-center gap-3">
                  <span style={{ fontSize: 12, color: 'var(--success)', flexShrink: 0, fontFamily: 'inherit' }}>✓</span>
                  <span style={{ fontSize: 12, color: 'var(--text-primary)', flex: 1 }}>{a.name}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{a.duration}</span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--danger)' }}>{a.score?.toFixed(2)}</span>
                </div>
              ))}
              {mockAttacks.filter(a => a.status === 'running').map((a) => (
                <div key={a.name} className="flex items-center gap-3">
                  <Loader2 style={{ width: 14, height: 14, color: 'var(--accent)', flexShrink: 0 }} className="animate-spin" />
                  <span style={{ fontSize: 12, color: 'var(--text-primary)', flex: 1 }}>{a.name}</span>
                  <span style={{ fontSize: 11, color: 'var(--accent)' }}>In Progress</span>
                </div>
              ))}
              {mockAttacks.filter(a => a.status === 'pending').map((a) => (
                <div key={a.name} className="flex items-center gap-3">
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 0, fontFamily: 'inherit' }}>○</span>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', flex: 1 }}>{a.name}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Pending</span>
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
}
