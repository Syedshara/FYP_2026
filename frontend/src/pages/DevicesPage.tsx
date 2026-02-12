import { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Plus, Loader2, Search, X,
  Trash2, Pencil,
} from 'lucide-react';
import { devicesApi } from '@/api/devices';
import { clientsApi } from '@/api/clients';
import type { Device, DeviceCreate, DeviceUpdate, FLClient, Prediction } from '@/types';
import { formatDate } from '@/lib/utils';

/* ── animation variants ─────────────────────────────── */
const stagger = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { staggerChildren: 0.04 } } };
const fadeUp = { hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } };

/* ── status styling ─────────────────────────────────── */
const statusConfig: Record<string, { color: string; bg: string; label: string; dot: string }> = {
  online:       { color: 'var(--success)', bg: 'var(--success-light)', label: 'Online',      dot: 'status-dot status-online' },
  offline:      { color: 'var(--text-muted)', bg: 'var(--bg-secondary)', label: 'Offline',    dot: 'status-dot status-offline' },
  under_attack: { color: 'var(--danger)',  bg: 'var(--danger-light)',  label: 'Under Attack', dot: 'status-dot status-attack' },
  quarantined:  { color: 'var(--warning)', bg: 'var(--warning-light)', label: 'Quarantined',  dot: 'status-dot status-quarantined' },
};

/* ══════════════════════════════════════════════════════
   Add / Edit Device Modal
   ══════════════════════════════════════════════════════ */
function DeviceModal({
  open,
  onClose,
  onSaved,
  clients,
  editing,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  clients: FLClient[];
  editing?: Device;
}) {
  const [form, setForm] = useState<DeviceCreate>({
    name: '',
    device_type: 'sensor',
    ip_address: '',
    protocol: 'tcp',
    port: 0,
    description: '',
    client_id: undefined,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (editing) {
      setForm({
        name: editing.name,
        device_type: editing.device_type,
        ip_address: editing.ip_address || '',
        protocol: editing.protocol,
        port: editing.port,
        description: editing.description || '',
        client_id: editing.client_id ?? undefined,
      });
    } else {
      setForm({ name: '', device_type: 'sensor', ip_address: '', protocol: 'tcp', port: 0, description: '', client_id: undefined });
    }
    setError('');
  }, [editing, open]);

  const handleSubmit = async () => {
    if (!form.name.trim()) { setError('Name is required.'); return; }
    if (!form.client_id) { setError('Please select a client.'); return; }
    setSaving(true);
    setError('');
    try {
      if (editing) {
        const update: DeviceUpdate = {};
        if (form.name !== editing.name) update.name = form.name;
        if (form.device_type !== editing.device_type) update.device_type = form.device_type;
        if (form.ip_address !== (editing.ip_address || '')) update.ip_address = form.ip_address || undefined;
        if (form.protocol !== editing.protocol) update.protocol = form.protocol;
        if (form.port !== editing.port) update.port = form.port;
        if (form.description !== (editing.description || '')) update.description = form.description || undefined;
        if (form.client_id !== (editing.client_id ?? undefined)) update.client_id = form.client_id;
        await devicesApi.update(editing.id, update);
      } else {
        await devicesApi.create({
          ...form,
          ip_address: form.ip_address || undefined,
          description: form.description || undefined,
        });
      }
      onSaved();
      onClose();
    } catch (err: unknown) {
      const msg = (err as Record<string, Record<string, Record<string, string>>>)?.response?.data?.detail;
      setError(msg || `Failed to ${editing ? 'update' : 'create'} device`);
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="card"
        style={{ width: 460, padding: 28 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 20 }}>
          {editing ? 'Edit Device' : 'Add Device'}
        </h2>

        <div className="page-stack" style={{ gap: 14 }}>
          {/* Client selector */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>
              Client <span style={{ color: 'var(--danger)' }}>*</span>
            </label>
            <select
              value={form.client_id ?? ''}
              onChange={(e) => setForm({ ...form, client_id: e.target.value ? Number(e.target.value) : undefined })}
              className="input"
              style={{ height: 38, fontSize: 13 }}
            >
              <option value="">Select a client…</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>{c.name} ({c.client_id})</option>
              ))}
            </select>
          </div>

          {/* Name */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>
              Device Name <span style={{ color: 'var(--danger)' }}>*</span>
            </label>
            <input
              className="input"
              style={{ height: 38, fontSize: 13 }}
              placeholder="e.g. Front Door Camera"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>

          {/* Type + Protocol */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Type</label>
              <select
                value={form.device_type}
                onChange={(e) => setForm({ ...form, device_type: e.target.value })}
                className="input"
                style={{ height: 38, fontSize: 13 }}
              >
                {['camera', 'sensor', 'router', 'gateway', 'switch', 'controller', 'actuator'].map((t) => (
                  <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Protocol</label>
              <select
                value={form.protocol}
                onChange={(e) => setForm({ ...form, protocol: e.target.value })}
                className="input"
                style={{ height: 38, fontSize: 13 }}
              >
                {['tcp', 'udp', 'mqtt', 'coap', 'http', 'https'].map((p) => (
                  <option key={p} value={p}>{p.toUpperCase()}</option>
                ))}
              </select>
            </div>
          </div>

          {/* IP + Port */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>IP Address</label>
              <input
                className="input"
                style={{ height: 38, fontSize: 13 }}
                placeholder="192.168.1.100"
                value={form.ip_address || ''}
                onChange={(e) => setForm({ ...form, ip_address: e.target.value })}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Port</label>
              <input
                className="input"
                type="number"
                style={{ height: 38, fontSize: 13 }}
                placeholder="8080"
                value={form.port || ''}
                onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
              />
            </div>
          </div>

          {/* Description */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Description</label>
            <textarea
              className="input"
              rows={2}
              style={{ fontSize: 13, resize: 'none' }}
              placeholder="Optional description…"
              value={form.description || ''}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>

          {error && <p style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</p>}
        </div>

        <div className="flex justify-end gap-2" style={{ marginTop: 20 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {editing ? 'Save Changes' : 'Add Device'}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   Confirm Delete Dialog
   ══════════════════════════════════════════════════════ */
function ConfirmDeleteDialog({
  open,
  deviceName,
  onClose,
  onConfirm,
}: {
  open: boolean;
  deviceName: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [deleting, setDeleting] = useState(false);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="card"
        style={{ width: 400, padding: 28 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3" style={{ marginBottom: 16 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--danger-light)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Trash2 style={{ width: 18, height: 18, color: 'var(--danger)' }} />
          </div>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>Delete Device</h2>
        </div>

        <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          Are you sure you want to delete <strong>{deviceName}</strong>? This action cannot be undone. All associated predictions will remain in the database.
        </p>

        <div className="flex justify-end gap-2" style={{ marginTop: 20 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn"
            style={{ background: 'var(--danger)', color: '#fff' }}
            disabled={deleting}
            onClick={async () => {
              setDeleting(true);
              await onConfirm();
              setDeleting(false);
            }}
          >
            {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            Delete
          </button>
        </div>
      </motion.div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   Prediction History Panel (slide-out detail)
   ══════════════════════════════════════════════════════ */
function PredictionPanel({
  device,
  clientName,
  onClose,
}: {
  device: Device;
  clientName: string;
  onClose: () => void;
}) {
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    devicesApi.predictions(device.id, 50).then(setPredictions).catch(() => {}).finally(() => setLoading(false));
  }, [device.id]);

  const sc = statusConfig[device.status] ?? statusConfig.offline;
  const attackCount = predictions.filter((p) => p.label === 'attack').length;
  const benignCount = predictions.filter((p) => p.label === 'benign').length;

  return (
    <motion.div
      initial={{ opacity: 0, x: 40 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 40 }}
      className="card"
      style={{ padding: 0, overflow: 'hidden' }}
    >
      {/* Header */}
      <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div>
              <h3 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{device.name}</h3>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{device.ip_address || 'No IP'}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="flex items-center justify-center"
            style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--bg-card)', border: '1px solid var(--border)', cursor: 'pointer', color: 'var(--text-muted)' }}
          >
            <X style={{ width: 16, height: 16 }} />
          </button>
        </div>
      </div>

      {/* Device Info */}
      <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border)' }}>
        <div className="grid grid-cols-2 gap-y-3 gap-x-6" style={{ fontSize: 12 }}>
          <div>
            <span style={{ color: 'var(--text-muted)' }}>Status</span>
            <p style={{ color: sc.color, fontWeight: 600 }}>{sc.label}</p>
          </div>
          <div>
            <span style={{ color: 'var(--text-muted)' }}>Type</span>
            <p style={{ color: 'var(--text-primary)' }}>{device.device_type}</p>
          </div>
          <div>
            <span style={{ color: 'var(--text-muted)' }}>Client</span>
            <p style={{ color: 'var(--accent)', fontWeight: 500 }}>{clientName}</p>
          </div>
          <div>
            <span style={{ color: 'var(--text-muted)' }}>Protocol / Port</span>
            <p style={{ color: 'var(--text-primary)' }}>{device.protocol.toUpperCase()} : {device.port}</p>
          </div>
          <div>
            <span style={{ color: 'var(--text-muted)' }}>Threats Today</span>
            <p style={{ color: device.threat_count_today > 0 ? 'var(--danger)' : 'var(--text-primary)', fontWeight: device.threat_count_today > 0 ? 600 : 400 }}>
              {device.threat_count_today}
            </p>
          </div>
        </div>
      </div>

      {/* Prediction Stats */}
      <div style={{ padding: '12px 24px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 16 }}>
        <div className="flex items-center gap-2" style={{ fontSize: 12 }}>
          <span style={{ color: 'var(--text-muted)' }}>Total: <strong style={{ color: 'var(--text-primary)' }}>{predictions.length}</strong></span>
        </div>
        <div className="flex items-center gap-2" style={{ fontSize: 12 }}>
          <span style={{ color: 'var(--text-muted)' }}>Attacks: <strong style={{ color: 'var(--danger)' }}>{attackCount}</strong></span>
        </div>
        <div className="flex items-center gap-2" style={{ fontSize: 12 }}>
          <span style={{ color: 'var(--text-muted)' }}>Benign: <strong style={{ color: 'var(--success)' }}>{benignCount}</strong></span>
        </div>
      </div>

      {/* Prediction History */}
      <div style={{ padding: '16px 24px', maxHeight: 400, overflowY: 'auto' }}>
        <h4 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 12 }}>
          Recent Predictions
        </h4>

        {loading ? (
          <div className="flex justify-center" style={{ padding: 24 }}>
            <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--accent)' }} />
          </div>
        ) : predictions.length === 0 ? (
          <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: 24 }}>
            No predictions recorded yet.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {predictions.map((p) => {
              const isAttack = p.label === 'attack';
              return (
                <div
                  key={p.id}
                  style={{
                    padding: '10px 14px',
                    borderRadius: 8,
                    background: isAttack ? 'var(--danger-light)' : 'var(--bg-secondary)',
                    borderLeft: `3px solid ${isAttack ? 'var(--danger)' : 'var(--success)'}`,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: 12,
                  }}
                >
                  <div className="flex items-center gap-3">
                    <span
                      className="badge"
                      style={{
                        background: isAttack ? 'var(--danger)' : 'var(--success)',
                        color: '#fff',
                        fontSize: 10,
                        padding: '2px 8px',
                      }}
                    >
                      {isAttack ? 'ATTACK' : 'BENIGN'}
                    </span>
                    <span style={{ color: 'var(--text-secondary)' }}>
                      Score: {p.score.toFixed(4)} &middot; Conf: {(p.confidence * 100).toFixed(1)}%
                    </span>
                  </div>
                  <span style={{ color: 'var(--text-muted)', fontSize: 10, whiteSpace: 'nowrap' }}>
                    {formatDate(p.timestamp)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </motion.div>
  );
}

/* ══════════════════════════════════════════════════════
   Main Device Card
   ══════════════════════════════════════════════════════ */
function DeviceCard({
  device,
  clientName,
  onEdit,
  onDelete,
  onSelect,
}: {
  device: Device;
  clientName: string;
  onEdit: () => void;
  onDelete: () => void;
  onSelect: () => void;
}) {
  const sc = statusConfig[device.status] ?? statusConfig.offline;

  return (
    <motion.div
      variants={fadeUp}
      className="card card-interactive cursor-pointer"
      style={{ padding: 20, borderLeft: `3px solid ${sc.color}` }}
      onClick={onSelect}
    >
      {/* Top row: name + status dot */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div>
            <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{device.name}</p>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{device.ip_address || 'No IP'}</p>
          </div>
        </div>
        <span className={sc.dot} />
      </div>

      {/* Client badge */}
      <div className="flex items-center gap-2" style={{ marginTop: 12 }}>
        <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 500 }}>&gt; {clientName}</span>
      </div>

      {/* Status */}
      <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="badge" style={{ background: sc.bg, color: sc.color }}>{sc.label}</span>
      </div>

      {/* Meta info */}
      <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: 'var(--text-muted)' }}>
        <span>{device.device_type}</span>
        {device.threat_count_today > 0 && (
          <span style={{ color: 'var(--danger)', fontWeight: 600 }}>
            ! {device.threat_count_today} threats
          </span>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex justify-end gap-2" style={{ marginTop: 14 }}>
        <button
          className="btn btn-ghost"
          style={{ padding: '4px 10px', fontSize: 11 }}
          onClick={(e) => { e.stopPropagation(); onEdit(); }}
        >
          <Pencil style={{ width: 12, height: 12 }} /> Edit
        </button>
        <button
          className="btn btn-ghost"
          style={{ padding: '4px 10px', fontSize: 11, color: 'var(--danger)' }}
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
        >
          <Trash2 style={{ width: 12, height: 12 }} /> Delete
        </button>
      </div>
    </motion.div>
  );
}

/* ══════════════════════════════════════════════════════
   Page Component
   ══════════════════════════════════════════════════════ */
export default function DevicesPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [clients, setClients] = useState<FLClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [clientFilter, setClientFilter] = useState<number | 'all'>('all');
  const [search, setSearch] = useState('');

  // Modal / panel state
  const [modalOpen, setModalOpen] = useState(false);
  const [editingDevice, setEditingDevice] = useState<Device | undefined>(undefined);
  const [deleteTarget, setDeleteTarget] = useState<Device | null>(null);
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);

  const clientMap = new Map(clients.map((c) => [c.id, c]));

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [devs, cls] = await Promise.all([
        devicesApi.list(clientFilter === 'all' ? undefined : clientFilter),
        clientsApi.list(),
      ]);
      setDevices(devs);
      setClients(cls);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [clientFilter]);

  useEffect(() => { fetchData(); }, [fetchData]);

  /* ── derived ── */
  const filtered = devices
    .filter((d) => filter === 'all' || d.status === filter)
    .filter((d) => {
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      const cName = clientMap.get(d.client_id ?? -1)?.name ?? '';
      return (
        d.name.toLowerCase().includes(q) ||
        (d.ip_address ?? '').toLowerCase().includes(q) ||
        cName.toLowerCase().includes(q)
      );
    });

  const counts = {
    all: devices.length,
    online: devices.filter((d) => d.status === 'online').length,
    offline: devices.filter((d) => d.status === 'offline').length,
    under_attack: devices.filter((d) => d.status === 'under_attack').length,
    quarantined: devices.filter((d) => d.status === 'quarantined').length,
  };

  /* ── handlers ── */
  const handleDelete = async (device: Device) => {
    try {
      await devicesApi.delete(device.id);
      setDeleteTarget(null);
      if (selectedDevice?.id === device.id) setSelectedDevice(null);
      fetchData();
    } catch {
      // silent
    }
  };

  const getClientName = (clientId: number | null) => {
    if (clientId == null) return 'Unassigned';
    return clientMap.get(clientId)?.name ?? `Client #${clientId}`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin" style={{ color: 'var(--accent)' }} />
      </div>
    );
  }

  return (
    <motion.div variants={stagger} initial="hidden" animate="show" className="page-stack">
      {/* ── Header ── */}
      <motion.div variants={fadeUp} className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>Device Management</h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>
            {devices.length} registered device{devices.length !== 1 ? 's' : ''}
            {clientFilter !== 'all' && ` · Filtered by ${getClientName(clientFilter)}`}
          </p>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => { setEditingDevice(undefined); setModalOpen(true); }}
        >
          <Plus style={{ width: 16, height: 16 }} /> Add Device
        </button>
      </motion.div>

      {/* ── KPI Strip ── */}
      <motion.div variants={fadeUp} className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'Total Devices', value: counts.all, color: 'var(--accent)' },
          { label: 'Online', value: counts.online, color: 'var(--success)' },
          { label: 'Under Attack', value: counts.under_attack, color: 'var(--danger)' },
          { label: 'Offline', value: counts.offline, color: 'var(--text-muted)' },
        ].map((kpi) => (
          <div key={kpi.label} className="card" style={{ padding: '16px 20px' }}>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{kpi.label}</p>
            <p style={{ fontSize: 24, fontWeight: 700, color: kpi.color }}>{kpi.value}</p>
          </div>
        ))}
      </motion.div>

      {/* ── Filters + Client Dropdown + Search ── */}
      <motion.div variants={fadeUp} className="flex items-center gap-3 flex-wrap">
        {/* Status tabs */}
        <div className="flex gap-1.5">
          {(['all', 'online', 'offline', 'under_attack', 'quarantined'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              style={{
                padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
                fontSize: 12, fontWeight: 500,
                background: filter === s ? 'var(--accent)' : 'var(--bg-secondary)',
                color: filter === s ? '#fff' : 'var(--text-secondary)',
                transition: 'all .15s',
              }}
            >
              {s === 'all' ? 'All' : s === 'under_attack' ? 'Attack' : s.charAt(0).toUpperCase() + s.slice(1)}
              <span style={{ marginLeft: 6, opacity: 0.7 }}>({counts[s]})</span>
            </button>
          ))}
        </div>

        {/* Client filter dropdown */}
        <div className="relative">
          <select
            value={clientFilter === 'all' ? '' : String(clientFilter)}
            onChange={(e) => setClientFilter(e.target.value ? Number(e.target.value) : 'all')}
            className="input"
            style={{ height: 36, fontSize: 12, paddingLeft: 10, paddingRight: 28, minWidth: 160 }}
          >
            <option value="">All Clients</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>

        {/* Search */}
        <div className="relative flex-1" style={{ maxWidth: 280 }}>
          <Search className="absolute left-3 top-1/2 -translate-y-1/2" style={{ width: 14, height: 14, color: 'var(--text-muted)' }} />
          <input
            type="text"
            placeholder="Search by name, IP, or client…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input"
            style={{ paddingLeft: 34, paddingRight: search ? 34 : 14, height: 36, fontSize: 13 }}
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center justify-center"
              style={{ width: 20, height: 20, borderRadius: 4, background: 'var(--bg-secondary)', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
            >
              <X style={{ width: 12, height: 12 }} />
            </button>
          )}
        </div>
      </motion.div>

      {/* ── Main Content: Grid + Detail Panel ── */}
      <div className="flex gap-6" style={{ minHeight: 400 }}>
        {/* Device Grid */}
        <div className="flex-1">
          {filtered.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {filtered.map((device) => (
                <DeviceCard
                  key={device.id}
                  device={device}
                  clientName={getClientName(device.client_id)}
                  onEdit={() => { setEditingDevice(device); setModalOpen(true); }}
                  onDelete={() => setDeleteTarget(device)}
                  onSelect={() => setSelectedDevice(device)}
                />
              ))}
            </div>
          ) : (
            <div className="card flex flex-col items-center justify-center" style={{ padding: 48 }}>
              <span style={{ fontSize: 24, color: 'var(--text-muted)', marginBottom: 12 }}>[ ]</span>
              <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>No devices found</p>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                {search ? 'Try adjusting your search or filters.' : 'Create a device to get started.'}
              </p>
            </div>
          )}
        </div>

        {/* Prediction Detail Panel */}
        <AnimatePresence>
          {selectedDevice && (
            <div style={{ width: 420, flexShrink: 0 }}>
              <PredictionPanel
                key={selectedDevice.id}
                device={selectedDevice}
                clientName={getClientName(selectedDevice.client_id)}
                onClose={() => setSelectedDevice(null)}
              />
            </div>
          )}
        </AnimatePresence>
      </div>

      {/* ── Modals ── */}
      <AnimatePresence>
        {modalOpen && (
          <DeviceModal
            open={modalOpen}
            onClose={() => { setModalOpen(false); setEditingDevice(undefined); }}
            onSaved={fetchData}
            clients={clients}
            editing={editingDevice}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {deleteTarget && (
          <ConfirmDeleteDialog
            open={!!deleteTarget}
            deviceName={deleteTarget.name}
            onClose={() => setDeleteTarget(null)}
            onConfirm={() => handleDelete(deleteTarget)}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}
