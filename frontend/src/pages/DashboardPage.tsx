import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, AreaChart, Area, Line,
} from 'recharts';
import { Loader2 } from 'lucide-react';
import { predictionsApi } from '@/api/predictions';
import { devicesApi } from '@/api/devices';
import { clientsApi } from '@/api/clients';
import type { PredictionSummary, Device, FLClient } from '@/types';
import { useLiveStore } from '@/stores/liveStore';
import { getStatusDotClass, formatRelativeTime } from '@/lib/utils';

const PIE_COLORS = ['#ef4444', '#22c55e'];
const stagger = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { staggerChildren: 0.05 } } };
const fadeUp = { hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } };

const RANGE_OPTIONS = ['1H', '6H', '24H', '7D'] as const;
function dashRangeToMs(r: string): number {
  switch (r) {
    case '1H':  return 1 * 60 * 60 * 1000;
    case '6H':  return 6 * 60 * 60 * 1000;
    case '24H': return 24 * 60 * 60 * 1000;
    case '7D':  return 7 * 24 * 60 * 60 * 1000;
    default:    return 1 * 60 * 60 * 1000;
  }
}

const chartTooltipStyle: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border)',
  borderRadius: 8, color: 'var(--text-primary)', boxShadow: 'var(--shadow-lg)', fontSize: 12,
};

export default function DashboardPage() {
  const navigate = useNavigate();
  const [summary, setSummary] = useState<PredictionSummary | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [clients, setClients] = useState<FLClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [dashRange, setDashRange] = useState<string>('1H');

  // Live store data
  const wsConnected = useLiveStore((s) => s.wsConnected);
  const livePredictions = useLiveStore((s) => s.latestPredictions);
  const liveDeviceStatuses = useLiveStore((s) => s.deviceStatuses);
  const liveClientStatuses = useLiveStore((s) => s.clientStatuses);

  useEffect(() => {
    const load = async () => {
      try {
        const [s, d, c] = await Promise.all([
          predictionsApi.summary(),
          devicesApi.list(),
          clientsApi.list(),
        ]);
        setSummary(s); setDevices(d); setClients(c);
      } catch (e) { console.error(e); }
      finally { setLoading(false); }
    };
    load();
    const iv = setInterval(load, 30_000);
    return () => clearInterval(iv);
  }, []);

  // Build a device map for name lookups (must be before early return)
  const deviceMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of devices) m.set(d.id, d.name);
    return m;
  }, [devices]);

  // Filter live predictions by selected time range (must be before early return)
  const rangeFilteredPreds = useMemo(() => {
    const now = Date.now();
    const windowMs = dashRangeToMs(dashRange);
    return livePredictions.filter((p) => now - new Date(p.timestamp).getTime() <= windowMs);
  }, [livePredictions, dashRange]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin" style={{ color: 'var(--accent)' }} />
      </div>
    );
  }

  // Merge live device statuses with API data
  const mergedDevices = devices.map((d) => {
    const live = liveDeviceStatuses[d.id];
    return live ? { ...d, status: live.status } : d;
  });

  // Merge live predictions into summary
  const liveAttackCount = livePredictions.filter((p) => p.label === 'attack').length;
  const liveBenignCount = livePredictions.filter((p) => p.label === 'benign').length;
  const effectiveSummary: PredictionSummary | null = summary ? {
    ...summary,
    total_predictions: summary.total_predictions + livePredictions.length,
    attack_count: summary.attack_count + liveAttackCount,
    benign_count: summary.benign_count + liveBenignCount,
    attack_rate: (summary.attack_count + liveAttackCount) / Math.max(summary.total_predictions + livePredictions.length, 1),
  } : summary;

  const onlineCount = mergedDevices.filter((d) => d.status === 'online').length;
  const attackDeviceCount = mergedDevices.filter((d) => d.status === 'under_attack').length;
  const offlineCount = mergedDevices.filter((d) => d.status === 'offline').length;

  const attackRate = effectiveSummary?.attack_rate ?? 0;
  const threatLevel = attackRate > 0.5 ? 'CRITICAL' : attackRate > 0.2 ? 'HIGH' : attackRate > 0.05 ? 'MEDIUM' : 'LOW';

  const threatColors: Record<string, { color: string; bg: string }> = {
    CRITICAL: { color: 'var(--danger)', bg: 'var(--danger-light)' },
    HIGH:     { color: 'var(--danger)', bg: 'var(--danger-light)' },
    MEDIUM:   { color: 'var(--warning)', bg: 'var(--warning-light)' },
    LOW:      { color: 'var(--success)', bg: 'var(--success-light)' },
  };
  const tc = threatColors[threatLevel];

  const pieData = effectiveSummary
    ? [{ name: 'Attacks', value: effectiveSummary.attack_count }, { name: 'Benign', value: effectiveSummary.benign_count }]
    : [];

  // Build timeline from range-filtered predictions
  const timelineData = rangeFilteredPreds.length > 0
    ? [...rangeFilteredPreds].reverse().map((p) => ({
        time: new Date(p.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        score: p.score,
      }))
    : Array.from({ length: 24 }, (_, i) => ({
        time: `${String(i).padStart(2, '0')}:00`,
        score: +(Math.random() * attackRate + Math.random() * 0.2).toFixed(3),
      }));

  // Live alerts (attacks from range-filtered predictions)
  const liveAlerts = rangeFilteredPreds
    .filter((p) => p.label === 'attack')
    .slice(0, 10);

  // Client health section
  const clientHealth = clients.map((c) => {
    const live = liveClientStatuses[c.id];
    return {
      id: c.id,
      name: c.name,
      client_id: c.client_id,
      status: live?.status ?? c.status,
      containerStatus: live?.container_status ?? 'unknown',
    };
  });

  const kpis = [
    {
      label: 'THREAT LEVEL', value: threatLevel,
      sub: `Score: ${(attackRate).toFixed(2)} / 1.0`, color: tc.color, bg: tc.bg,
      bar: attackRate,
    },
    {
      label: 'ACTIVE DEVICES', value: `${mergedDevices.length}`,
      sub: `${onlineCount} online  ·  ${offlineCount} offline`, color: 'var(--info)', bg: 'var(--info-light)',
      extra: attackDeviceCount > 0 ? `${attackDeviceCount} under attack` : undefined,
      extraColor: 'var(--danger)',
    },
    {
      label: 'ATTACKS DETECTED', value: `${effectiveSummary?.attack_count ?? 0}`,
      sub: `of ${effectiveSummary?.total_predictions ?? 0} predictions`, color: 'var(--danger)', bg: 'var(--danger-light)',
    },
    {
      label: 'BENIGN RATE', value: `${((1 - attackRate) * 100).toFixed(1)}%`,
      sub: `Avg confidence: ${((effectiveSummary?.avg_confidence ?? 0) * 100).toFixed(1)}%`, color: 'var(--success)', bg: 'var(--success-light)',
    },
  ];

  return (
    <motion.div variants={stagger} initial="hidden" animate="show" className="page-stack">
      {/* Header */}
      <motion.div variants={fadeUp} className="flex items-center justify-between">
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>Security Overview</h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>Real-time threat monitoring & analytics</p>
        </div>
        <div className="flex items-center gap-2">
          <span style={{
            fontSize: 11, fontWeight: 500,
            padding: '4px 10px', borderRadius: 2,
            background: wsConnected ? 'var(--success-light)' : 'var(--bg-secondary)',
            color: wsConnected ? 'var(--success)' : 'var(--text-muted)',
            border: '1px solid var(--border)',
          }}>
            {wsConnected ? '[LIVE]' : '[OFFLINE]'}
          </span>
        </div>
      </motion.div>

      {/* KPI Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {kpis.map((kpi) => {
          const termBar = kpi.bar !== undefined ? (() => {
            const filled = Math.round(Math.min(kpi.bar, 1) * 20);
            return '[' + '█'.repeat(filled) + '░'.repeat(20 - filled) + '] ' + (kpi.bar * 100).toFixed(0) + '%';
          })() : null;
          return (
            <motion.div key={kpi.label} variants={fadeUp} className="card" style={{ padding: 16 }}>
              <p style={{ fontSize: 10, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text-muted)' }}>
                {kpi.label}
              </p>
              <p style={{ fontSize: 24, fontWeight: 700, color: kpi.color, marginTop: 6, lineHeight: 1 }}>
                {kpi.value}
              </p>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{kpi.sub}</p>
              {kpi.extra && (
                <p style={{ fontSize: 11, color: kpi.extraColor, marginTop: 2 }}>{kpi.extra}</p>
              )}
              {termBar && (
                <p style={{ marginTop: 10, fontSize: 11, color: kpi.color, letterSpacing: 1 }}>
                  {termBar}
                </p>
              )}
            </motion.div>
          );
        })}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Threat Timeline */}
        <motion.div variants={fadeUp} className="card lg:col-span-2" style={{ padding: 20 }}>
          <div className="flex items-center justify-between" style={{ marginBottom: 20 }}>
            <div>
              <h3 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
                Live Threat Timeline
                {wsConnected && livePredictions.length > 0 && (
                  <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: 'var(--success)', verticalAlign: 'middle' }}>● STREAMING</span>
                )}
              </h3>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                Anomaly score over time{wsConnected ? ' (real-time)' : ' (polling)'}
              </p>
            </div>
            <div className="flex gap-1">
              {RANGE_OPTIONS.map((label) => (
                <button key={label} onClick={() => setDashRange(label)} style={{
                  padding: '4px 12px', borderRadius: 6, border: 'none', cursor: 'pointer',
                  fontSize: 11, fontWeight: 600,
                  background: dashRange === label ? 'var(--accent)' : 'var(--bg-secondary)',
                  color: dashRange === label ? '#fff' : 'var(--text-muted)',
                  transition: 'all 0.15s ease',
                }}>{label}</button>
              ))}
            </div>
          </div>
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={timelineData}>
              <defs>
                <linearGradient id="scoreG" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#6366f1" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="time" stroke="var(--text-muted)" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
              <YAxis domain={[0, 1]} stroke="var(--text-muted)" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={30} />
              <Tooltip contentStyle={chartTooltipStyle} />
              <Line type="monotone" dataKey={() => 0.5} stroke="var(--danger)" strokeDasharray="6 3" dot={false} strokeWidth={1} name="Threshold" />
              <Area type="monotone" dataKey="score" stroke="#6366f1" strokeWidth={2} fill="url(#scoreG)" dot={false} activeDot={{ r: 4, fill: '#6366f1', stroke: '#fff', strokeWidth: 2 }} name="Score" />
            </AreaChart>
          </ResponsiveContainer>
        </motion.div>

        {/* Pie */}
        <motion.div variants={fadeUp} className="card" style={{ padding: 20 }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>Attack Distribution</h3>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Distribution of detected attacks</p>
          {effectiveSummary && effectiveSummary.total_predictions > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={pieData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={3} dataKey="value" animationBegin={200}>
                    {pieData.map((_, idx) => <Cell key={idx} fill={PIE_COLORS[idx]} />)}
                  </Pie>
                  <Tooltip contentStyle={chartTooltipStyle} />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex justify-center gap-6" style={{ marginTop: 4 }}>
                {pieData.map((d, i) => (
                  <span key={d.name} className="flex items-center gap-2" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: PIE_COLORS[i], display: 'inline-block' }} />
                    {d.name} ({d.value})
                  </span>
                ))}
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center" style={{ height: 200, color: 'var(--text-muted)', fontSize: 13 }}>No predictions yet</div>
          )}
        </motion.div>
      </div>

      {/* Recent Alerts Table */}
      <motion.div variants={fadeUp} className="card" style={{ padding: 20 }}>
        <div className="flex items-center justify-between" style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
            Recent Alerts
            {wsConnected && liveAlerts.length > 0 && (
              <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: 'var(--danger)', verticalAlign: 'middle' }}>● LIVE</span>
            )}
          </h3>
          <span style={{ fontSize: 12, color: 'var(--accent)', cursor: 'pointer' }}>View All &rarr;</span>
        </div>
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Timestamp</th>
                <th>Device</th>
                <th>Score</th>
                <th>Label</th>
              </tr>
            </thead>
            <tbody>
              {liveAlerts.length > 0 ? (
                liveAlerts.map((alert, idx) => (
                  <tr
                    key={`${alert.device_id}-${alert.timestamp}-${idx}`}
                    className="cursor-pointer transition-all"
                    style={{ cursor: 'pointer' }}
                    onClick={() => navigate(`/traffic?device_id=${alert.device_id}`)}
                    title="Click to view device traffic"
                  >
                    <td style={{ color: 'var(--text-muted)' }}>{idx + 1}</td>
                    <td>{new Date(alert.timestamp).toLocaleTimeString()}</td>
                    <td style={{ fontWeight: 500, fontSize: 12 }}>
                      {alert.device_name ?? deviceMap.get(String(alert.device_id)) ?? (
                        <span title={`Device ID: ${alert.device_id}`} style={{ fontFamily: 'monospace', color: 'var(--text-muted)' }}>
                          ⚠ {String(alert.device_id).slice(0, 8)}…
                        </span>
                      )}
                    </td>
                    <td>
                      <div className="flex items-center gap-2">
                        <span style={{ fontSize: 11, fontFamily: 'inherit', color: 'var(--danger)' }}>
                          {'[' + '█'.repeat(Math.round(alert.score * 10)) + '░'.repeat(10 - Math.round(alert.score * 10)) + ']'}
                        </span>
                        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--danger)' }}>{alert.score.toFixed(3)}</span>
                      </div>
                    </td>
                    <td>
                      <span className="badge" style={{ background: 'var(--danger-light)', color: 'var(--danger)' }}>
                        ● Attack
                      </span>
                    </td>
                  </tr>
                ))
              ) : (
                <tr><td colSpan={5} style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>
                  {wsConnected ? 'No attacks detected — monitoring live' : 'No recent alerts'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </motion.div>

      {/* FL Client Health */}
      {clientHealth.length > 0 && (
        <motion.div variants={fadeUp} className="card" style={{ padding: 20 }}>
          <div className="flex items-center justify-between" style={{ marginBottom: 16 }}>
            <div>
              <h3 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>FL Client Health</h3>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Federated Learning client status</p>
            </div>
            {wsConnected && (
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--success)' }}>● LIVE</span>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {clientHealth.map((c) => {
              const statusColor = c.status === 'training' ? 'var(--accent)' : c.status === 'active' ? 'var(--success)' : c.status === 'error' ? 'var(--danger)' : 'var(--text-muted)';
              return (
                <div key={c.id} className="card" style={{ padding: 14, textAlign: 'center', borderColor: statusColor, borderWidth: 1.5 }}>
                  <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {c.name}
                  </p>
                  <p style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2, fontFamily: 'monospace' }}>
                    {c.client_id}
                  </p>
                  <p style={{ fontSize: 11, color: statusColor, marginTop: 4, fontWeight: 600, textTransform: 'capitalize' }}>
                    {c.status}
                  </p>
                  <p style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                    {c.containerStatus}
                  </p>
                </div>
              );
            })}
          </div>
        </motion.div>
      )}

      {/* Device Health Map */}
      <motion.div variants={fadeUp} className="card" style={{ padding: 20 }}>
        <div className="flex items-center justify-between" style={{ marginBottom: 16 }}>
          <div>
            <h3 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>Device Health Map</h3>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Click a device to open Traffic Monitor</p>
          </div>
          <div className="flex gap-4" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            <span className="flex items-center gap-1.5"><span className="status-dot status-online" /> Online</span>
            <span className="flex items-center gap-1.5"><span className="status-dot status-attack" /> Under Attack</span>
            <span className="flex items-center gap-1.5"><span className="status-dot status-quarantined" /> Quarantined</span>
            <span className="flex items-center gap-1.5"><span className="status-dot status-offline" /> Offline</span>
          </div>
        </div>

        {mergedDevices.length > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {mergedDevices.map((device) => {
              const borderColor = device.status === 'under_attack' ? 'var(--danger)' : device.status === 'quarantined' ? 'var(--warning)' : device.status === 'offline' ? 'var(--text-muted)' : 'var(--success)';
              return (
                <div
                  key={device.id}
                  className="card cursor-pointer transition-all"
                  style={{
                    padding: 14, textAlign: 'center',
                    borderColor, borderWidth: 1.5,
                    opacity: device.status === 'offline' ? 0.5 : 1,
                  }}
                  onClick={() => navigate(`/traffic?device_id=${device.id}`)}
                  title="Click to view device traffic"
                >
                  <div className="flex justify-center" style={{ marginBottom: 8 }}>
                    <span className={getStatusDotClass(device.status)} />
                  </div>
                  <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {device.name}
                  </p>
                  <p style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2, fontFamily: 'monospace' }}>
                    {device.ip_address}
                  </p>
                  <p style={{ fontSize: 11, color: borderColor, marginTop: 4, fontWeight: 500 }}>
                    {device.status.replace('_', ' ')}
                  </p>
                  {device.last_seen_at && (
                    <p style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                      {formatRelativeTime(device.last_seen_at)}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 13 }}>No devices registered</p>
        )}
      </motion.div>
    </motion.div>
  );
}
