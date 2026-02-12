import { useState } from 'react';
import { motion } from 'framer-motion';
import { Plus, Search } from 'lucide-react';

const stagger = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { staggerChildren: 0.06 } } };
const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } };

interface PreventionRule {
  id: number;
  name: string;
  description: string;
  type: 'block' | 'alert' | 'quarantine' | 'rate_limit';
  enabled: boolean;
  trigger: string;
  actions: string;
  hits: number;
}

const mockRules: PreventionRule[] = [
  { id: 1, name: 'DDoS Auto-Block', description: 'Blocks source IP when DDoS attack detected with score > 0.8', type: 'block', enabled: true, trigger: 'score > 0.8 AND label = DDoS', actions: 'Block IP for 30 min', hits: 47 },
  { id: 2, name: 'Port Scan Alert', description: 'Send notification when port scanning activity is detected', type: 'alert', enabled: true, trigger: 'score > 0.6 AND label = Port Scan', actions: 'Email + Slack alert', hits: 23 },
  { id: 3, name: 'Brute Force Quarantine', description: 'Quarantine device after 3+ brute force attempts', type: 'quarantine', enabled: true, trigger: 'brute_force_count >= 3', actions: 'Quarantine device', hits: 8 },
  { id: 4, name: 'High Traffic Rate Limit', description: 'Rate limit devices exceeding normal traffic threshold', type: 'rate_limit', enabled: false, trigger: 'pps > 10000', actions: 'Limit to 1000 pps', hits: 0 },
  { id: 5, name: 'SQL Injection Block', description: 'Block traffic patterns matching SQL injection signatures', type: 'block', enabled: true, trigger: 'score > 0.7 AND label = SQLi', actions: 'Block + log payload', hits: 12 },
  { id: 6, name: 'DNS Amplification Prevention', description: 'Auto-block DNS amplification attack sources', type: 'block', enabled: true, trigger: 'score > 0.75 AND label = DNS_Amp', actions: 'Block IP + notify', hits: 5 },
];

interface QuarantinedDevice {
  id: string;
  name: string;
  ip: string;
  reason: string;
  since: string;
}

const mockQuarantined: QuarantinedDevice[] = [
  { id: '1', name: 'Sensor_04', ip: '192.168.1.104', reason: 'Brute Force SSH (Score: 0.91)', since: '2h ago' },
  { id: '2', name: 'Gateway_02', ip: '192.168.1.201', reason: 'DDoS Attack (Score: 0.88)', since: '5h ago' },
];

const typeConfig: Record<string, { symbol: string; color: string; bg: string; label: string }> = {
  block:      { symbol: '✕', color: 'var(--danger)',  bg: 'var(--danger-light)',  label: 'Block' },
  alert:      { symbol: '!', color: 'var(--warning)', bg: 'var(--warning-light)', label: 'Alert' },
  quarantine: { symbol: '◉', color: '#A855F7',        bg: 'rgba(168,85,247,0.1)', label: 'Quarantine' },
  rate_limit: { symbol: '~', color: 'var(--accent)',  bg: 'var(--accent-light)',  label: 'Rate Limit' },
};

export default function PreventionPage() {
  const [rules, setRules] = useState(mockRules);
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState('all');

  const toggleRule = (id: number) => {
    setRules(rules.map((r) => r.id === id ? { ...r, enabled: !r.enabled } : r));
  };

  const filtered = rules
    .filter((r) => filterType === 'all' || r.type === filterType)
    .filter((r) => r.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <motion.div variants={stagger} initial="hidden" animate="show" className="page-stack">
      {/* Header */}
      <motion.div variants={fadeUp} className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>Prevention Rules</h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>Automated response actions for detected threats</p>
        </div>
        <button className="btn btn-primary">
          <Plus style={{ width: 16, height: 16 }} /> Add Rule
        </button>
      </motion.div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-5">
        {[
          { label: 'Active Rules', value: rules.filter(r => r.enabled).length, total: rules.length, color: 'var(--success)' },
          { label: 'Total Blocked', value: rules.reduce((a, r) => a + (r.type === 'block' ? r.hits : 0), 0), color: 'var(--danger)' },
          { label: 'Quarantined Devices', value: mockQuarantined.length, color: '#A855F7' },
          { label: 'Alerts Today', value: rules.reduce((a, r) => a + (r.type === 'alert' ? r.hits : 0), 0), color: 'var(--warning)' },
        ].map((kpi) => (
          <motion.div key={kpi.label} variants={fadeUp} className="kpi-card" style={{ '--accent-color': kpi.color } as React.CSSProperties}>
            <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>{kpi.label}</p>
            <p style={{ fontSize: 24, fontWeight: 700, color: kpi.color, marginTop: 4 }}>
              {kpi.value}
              {kpi.total !== undefined && <span style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 400 }}> / {kpi.total}</span>}
            </p>
          </motion.div>
        ))}
      </div>

      {/* Toolbar */}
      <motion.div variants={fadeUp} className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-1.5">
          {['all', 'block', 'alert', 'quarantine', 'rate_limit'].map((t) => (
            <button
              key={t}
              onClick={() => setFilterType(t)}
              style={{
                padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
                fontSize: 12, fontWeight: 500,
                background: filterType === t ? 'var(--accent)' : 'var(--bg-secondary)',
                color: filterType === t ? '#fff' : 'var(--text-secondary)',
                transition: 'all .15s',
              }}
            >
              {t === 'all' ? 'All' : t === 'rate_limit' ? 'Rate Limit' : t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <div className="relative flex-1" style={{ maxWidth: 260 }}>
          <Search className="absolute left-3 top-1/2 -translate-y-1/2" style={{ width: 14, height: 14, color: 'var(--text-muted)' }} />
          <input
            type="text"
            placeholder="Search rules..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input"
            style={{ paddingLeft: 34, height: 36, fontSize: 13 }}
          />
        </div>
      </motion.div>

      {/* Rules List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {filtered.map((rule) => {
          const tc = typeConfig[rule.type];
          return (
            <motion.div
              key={rule.id}
              variants={fadeUp}
              className="card"
              style={{
                padding: '16px 20px',
                opacity: rule.enabled ? 1 : 0.5,
                borderLeft: `3px solid ${tc.color}`,
              }}
            >
              <div className="flex items-center gap-4">
                {/* Symbol */}
                <div style={{ width: 40, height: 40, borderRadius: 3, background: tc.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 16, fontWeight: 700, color: tc.color, fontFamily: 'inherit' }}>
                  {tc.symbol}
                </div>

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="flex items-center gap-2">
                    <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{rule.name}</p>
                    <span className="badge" style={{ background: tc.bg, color: tc.color, fontSize: 10 }}>{tc.label}</span>
                  </div>
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{rule.description}</p>
                  <div className="flex items-center gap-4 mt-2" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    <span>Trigger: <span style={{ color: 'var(--text-secondary)', fontFamily: 'monospace' }}>{rule.trigger}</span></span>
                    <span>Actions: <span style={{ color: 'var(--text-secondary)' }}>{rule.actions}</span></span>
                  </div>
                </div>

                {/* Hits */}
                <div style={{ textAlign: 'center', minWidth: 60, flexShrink: 0 }}>
                  <p style={{ fontSize: 18, fontWeight: 700, color: rule.hits > 0 ? tc.color : 'var(--text-muted)' }}>{rule.hits}</p>
                  <p style={{ fontSize: 10, color: 'var(--text-muted)' }}>hits</p>
                </div>

                {/* Toggle */}
                <button
                  onClick={() => toggleRule(rule.id)}
                  style={{
                    width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer',
                    background: rule.enabled ? 'var(--success)' : 'var(--bg-secondary)',
                    position: 'relative', transition: 'background .2s', flexShrink: 0,
                  }}
                >
                  <span style={{
                    width: 18, height: 18, borderRadius: '50%', background: '#fff',
                    position: 'absolute', top: 3, left: rule.enabled ? 23 : 3,
                    transition: 'left .2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                  }} />
                </button>
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* Quarantined Devices */}
      <motion.div variants={fadeUp} className="card" style={{ padding: 24 }}>
        <div className="flex items-center gap-3 mb-4">
          <span style={{ fontSize: 14, fontWeight: 700, color: '#A855F7', fontFamily: 'inherit' }}>◉</span>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>Quarantined Devices</h2>
          <span className="badge" style={{ background: 'rgba(168,85,247,0.1)', color: '#A855F7' }}>{mockQuarantined.length}</span>
        </div>

        {mockQuarantined.length > 0 ? (
          <div className="space-y-2">
            {mockQuarantined.map((d) => (
              <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderRadius: 8, background: 'var(--bg-primary)', border: '1px solid var(--border)' }}>
                <span className="status-dot status-quarantined" />
                <div style={{ flex: 1 }}>
                  <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{d.name}</p>
                  <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>{d.ip} — {d.reason}</p>
                </div>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{d.since}</span>
                <button className="btn btn-ghost" style={{ fontSize: 11, height: 28, padding: '0 12px' }}>Release</button>
              </div>
            ))}
          </div>
        ) : (
          <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, padding: 20 }}>No quarantined devices</p>
        )}
      </motion.div>
    </motion.div>
  );
}
