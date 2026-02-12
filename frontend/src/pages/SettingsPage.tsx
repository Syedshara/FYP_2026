import { useState } from 'react';
import { motion } from 'framer-motion';
import { useAuthStore } from '@/stores/authStore';

const stagger = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { staggerChildren: 0.06 } } };
const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } };

const tabs = [
  { id: 'profile',       label: 'Profile' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'security',      label: 'Security' },
  { id: 'model',         label: 'Model Config' },
  { id: 'system',        label: 'System' },
];

function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      style={{
        width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer',
        background: checked ? 'var(--accent)' : 'var(--bg-secondary)',
        position: 'relative', transition: 'background .2s',
      }}
    >
      <span style={{
        width: 18, height: 18, borderRadius: '50%', background: '#fff',
        position: 'absolute', top: 3, left: checked ? 23 : 3,
        transition: 'left .2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
      }} />
    </button>
  );
}

function FieldRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-3" style={{ borderBottom: '1px solid var(--border)' }}>
      <div>
        <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{label}</p>
        {description && <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{description}</p>}
      </div>
      {children}
    </div>
  );
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState('profile');
  const { user } = useAuthStore();

  // Notification settings
  const [emailAlerts, setEmailAlerts] = useState(true);
  const [pushAlerts, setPushAlerts] = useState(true);
  const [attackAlerts, setAttackAlerts] = useState(true);
  const [weeklyReport, setWeeklyReport] = useState(false);

  // Security settings
  const [twoFactor, setTwoFactor] = useState(false);
  const [sessionTimeout, setSessionTimeout] = useState('30');

  // Model config
  const [threshold, setThreshold] = useState('0.5');
  const [batchSize, setBatchSize] = useState('10');
  const [autoRetrain, setAutoRetrain] = useState(false);

  return (
    <motion.div variants={stagger} initial="hidden" animate="show" className="page-stack">
      <motion.div variants={fadeUp}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>Settings</h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>Manage your account and system preferences</p>
      </motion.div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Sidebar Tabs */}
        <motion.div variants={fadeUp} className="card lg:col-span-1" style={{ padding: 8 }}>
          <nav style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {tabs.map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                    padding: '10px 14px', borderRadius: 3, border: 'none', cursor: 'pointer',
                    fontSize: 13, fontWeight: isActive ? 600 : 400, textAlign: 'left',
                    background: isActive ? 'var(--accent-light)' : 'transparent',
                    color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                    transition: 'all .15s',
                    fontFamily: 'inherit',
                  }}
                >
                  <span style={{ color: isActive ? 'var(--accent)' : 'var(--text-muted)' }}>&gt;</span>
                  {tab.label}
                </button>
              );
            })}
          </nav>
        </motion.div>

        {/* Content */}
        <motion.div variants={fadeUp} className="card lg:col-span-3" style={{ padding: 28 }}>
          {/* Profile */}
          {activeTab === 'profile' && (
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 20 }}>Profile Settings</h2>

              <div className="flex items-center gap-4 mb-6" style={{ padding: 16, borderRadius: 10, background: 'var(--bg-primary)' }}>
                <div style={{
                  width: 56, height: 56, borderRadius: '50%', background: 'var(--accent)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 20, fontWeight: 700, color: '#fff',
                }}>
                  {user?.username?.charAt(0).toUpperCase() ?? 'A'}
                </div>
                <div>
                  <p style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>{user?.username ?? 'admin'}</p>
                  <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>{user?.email ?? 'admin@iotids.local'}</p>
                  <p style={{ fontSize: 11, color: 'var(--accent)', marginTop: 2 }}>{user?.role ?? 'administrator'}</p>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Username</label>
                  <input className="input" defaultValue={user?.username ?? 'admin'} style={{ maxWidth: 360 }} />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Email</label>
                  <input className="input" defaultValue={user?.email ?? 'admin@iotids.local'} style={{ maxWidth: 360 }} />
                </div>
                <button className="btn btn-primary" style={{ marginTop: 8 }}>Save Changes</button>
              </div>
            </div>
          )}

          {/* Notifications */}
          {activeTab === 'notifications' && (
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 20 }}>Notification Preferences</h2>
              <FieldRow label="Email Alerts" description="Receive threat alerts via email">
                <Toggle checked={emailAlerts} onChange={() => setEmailAlerts(!emailAlerts)} />
              </FieldRow>
              <FieldRow label="Push Notifications" description="Browser push notifications for real-time alerts">
                <Toggle checked={pushAlerts} onChange={() => setPushAlerts(!pushAlerts)} />
              </FieldRow>
              <FieldRow label="Attack Detection Alerts" description="Immediate notification when attacks are detected">
                <Toggle checked={attackAlerts} onChange={() => setAttackAlerts(!attackAlerts)} />
              </FieldRow>
              <FieldRow label="Weekly Security Report" description="Automated weekly summary of security events">
                <Toggle checked={weeklyReport} onChange={() => setWeeklyReport(!weeklyReport)} />
              </FieldRow>
            </div>
          )}

          {/* Security */}
          {activeTab === 'security' && (
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 20 }}>Security Settings</h2>
              <FieldRow label="Two-Factor Authentication" description="Add extra security to your account">
                <Toggle checked={twoFactor} onChange={() => setTwoFactor(!twoFactor)} />
              </FieldRow>
              <FieldRow label="Session Timeout" description="Auto-logout after inactivity (minutes)">
                <select value={sessionTimeout} onChange={(e) => setSessionTimeout(e.target.value)} style={{ width: 120, height: 36, fontSize: 13, padding: '6px 12px', borderRadius: 6, border: '1.5px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', outline: 'none', cursor: 'pointer' }}>
                  <option value="15">15 min</option>
                  <option value="30">30 min</option>
                  <option value="60">1 hour</option>
                  <option value="120">2 hours</option>
                </select>
              </FieldRow>
              <div style={{ marginTop: 20 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Change Password</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 360 }}>
                  <input className="input" type="password" placeholder="Current password" />
                  <input className="input" type="password" placeholder="New password" />
                  <input className="input" type="password" placeholder="Confirm new password" />
                  <button className="btn btn-primary">Update Password</button>
                </div>
              </div>
            </div>
          )}

          {/* Model Config */}
          {activeTab === 'model' && (
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 20 }}>Model Configuration</h2>
              <FieldRow label="Detection Threshold" description="Anomaly score threshold for attack classification">
                <div className="flex items-center gap-3">
                  <input
                    type="range" min="0.1" max="0.9" step="0.05" value={threshold}
                    onChange={(e) => setThreshold(e.target.value)}
                    style={{ width: 120, accentColor: 'var(--accent)' }}
                  />
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--warning)', minWidth: 36 }}>{threshold}</span>
                </div>
              </FieldRow>
              <FieldRow label="Sequence Window" description="Number of packets per prediction window">
                <select value={batchSize} onChange={(e) => setBatchSize(e.target.value)} style={{ width: 100, height: 36, fontSize: 13, padding: '6px 12px', borderRadius: 6, border: '1.5px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', outline: 'none', cursor: 'pointer' }}>
                  <option value="5">5</option>
                  <option value="10">10</option>
                  <option value="15">15</option>
                  <option value="20">20</option>
                </select>
              </FieldRow>
              <FieldRow label="Auto-Retrain" description="Automatically trigger FL retraining when accuracy drops">
                <Toggle checked={autoRetrain} onChange={() => setAutoRetrain(!autoRetrain)} />
              </FieldRow>
              <div style={{ marginTop: 20, padding: 16, borderRadius: 8, background: 'var(--bg-primary)', border: '1px solid var(--border)' }}>
                <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>Current Model</p>
                <div className="space-y-1" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  <p>Architecture: <span style={{ color: 'var(--text-primary)' }}>CNN-LSTM (Conv1d + LSTM + Linear)</span></p>
                  <p>File: <span style={{ color: 'var(--accent)', fontFamily: 'monospace' }}>cnn_lstm_global_with_HE_25rounds_16k.pt</span></p>
                  <p>Input Shape: <span style={{ color: 'var(--text-primary)' }}>(batch, 10, 78)</span></p>
                  <p>Training: <span style={{ color: 'var(--text-primary)' }}>25 rounds FL + CKKS HE</span></p>
                </div>
              </div>
            </div>
          )}

          {/* System */}
          {activeTab === 'system' && (
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 20 }}>System Information</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[
                  { label: 'Backend API', value: 'FastAPI v0.115+', status: 'running' },
                  { label: 'Database', value: 'PostgreSQL 15', status: 'running' },
                  { label: 'Cache', value: 'Redis 7', status: 'running' },
                  { label: 'FL Server', value: 'Flower gRPC :8080', status: 'running' },
                  { label: 'Frontend', value: 'React + Vite', status: 'running' },
                  { label: 'ML Runtime', value: 'PyTorch + TenSEAL', status: 'loaded' },
                ].map((s) => (
                  <div key={s.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderRadius: 8, background: 'var(--bg-primary)', border: '1px solid var(--border)' }}>
                    <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{s.label}</span>
                    <div className="flex items-center gap-3">
                      <span style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{s.value}</span>
                      <span className="status-dot status-online" />
                      <span style={{ fontSize: 11, color: 'var(--success)' }}>{s.status}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 20, display: 'flex', gap: 10 }}>
                <button className="btn btn-secondary">Export Logs</button>
                <button className="btn btn-ghost" style={{ color: 'var(--danger)' }}>Clear Cache</button>
              </div>
            </div>
          )}


        </motion.div>
      </div>
    </motion.div>
  );
}
