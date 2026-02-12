import { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Plus, Loader2, Search, X, ChevronDown, ChevronRight,
  Play, Square, Trash2, Pencil,
} from 'lucide-react';
import { clientsApi } from '@/api/clients';
import { devicesApi } from '@/api/devices';
import type {
  FLClient, FLClientCreate, FLClientUpdate,
  DeviceBrief,
} from '@/types';

/* ── animation variants ─────────────────────────────── */
const stagger = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { staggerChildren: 0.05 } } };
const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } };

/* ── status config ──────────────────────────────────── */
const clientStatusConfig: Record<string, { color: string; bg: string; label: string }> = {
  active:   { color: 'var(--success)', bg: 'var(--success-light)', label: 'Active' },
  inactive: { color: 'var(--text-muted)', bg: 'var(--bg-secondary)', label: 'Inactive' },
  training: { color: 'var(--info)',    bg: 'var(--info-light)',    label: 'Training' },
  error:    { color: 'var(--danger)',  bg: 'var(--danger-light)',  label: 'Error' },
};

const containerStatusConfig: Record<string, { color: string; label: string }> = {
  running:   { color: 'var(--success)', label: 'Running' },
  exited:    { color: 'var(--text-muted)', label: 'Stopped' },
  created:   { color: 'var(--warning)', label: 'Created' },
  paused:    { color: 'var(--warning)', label: 'Paused' },
  dead:      { color: 'var(--danger)',  label: 'Dead' },
  not_found: { color: 'var(--text-muted)', label: 'No Container' },
};

const deviceTypeIcons: Record<string, string> = {
  camera: '📷', sensor: '🌡️', router: '📡', gateway: '🔌',
  switch: '🔀', controller: '🎛️', actuator: '⚙️',
};

/* ── types ──────────────────────────────────────────── */
interface ClientWithMeta extends FLClient {
  devices: DeviceBrief[];
  containerStatus: string;
}

/* ══════════════════════════════════════════════════════
   Create Client Modal
   ══════════════════════════════════════════════════════ */
function CreateClientModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (c: FLClient) => void;
}) {
  const [form, setForm] = useState<FLClientCreate>({
    client_id: '',
    name: '',
    description: '',
    ip_address: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!form.client_id.trim() || !form.name.trim()) {
      setError('Client ID and Name are required.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const created = await clientsApi.create({
        ...form,
        description: form.description || undefined,
        ip_address: form.ip_address || undefined,
      });
      onCreated(created);
      onClose();
      setForm({ client_id: '', name: '', description: '', ip_address: '' });
    } catch (err: unknown) {
      const msg = (err as Record<string, Record<string, Record<string, string>>>)?.response?.data?.detail;
      setError(msg || 'Failed to create client');
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
        <div className="flex items-center justify-between" style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>Create Client</h2>
          <button className="btn-ghost btn" onClick={onClose}><X style={{ width: 18, height: 18 }} /></button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Client ID *</label>
            <input className="input" placeholder="e.g. bank_a" value={form.client_id}
              onChange={(e) => setForm({ ...form, client_id: e.target.value })} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Name *</label>
            <input className="input" placeholder="e.g. Bank A" value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Description</label>
            <input className="input" placeholder="Optional description" value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>IP Address</label>
            <input className="input" placeholder="e.g. 192.168.1.100" value={form.ip_address}
              onChange={(e) => setForm({ ...form, ip_address: e.target.value })} />
          </div>
        </div>

        {error && (
          <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 12 }}>{error}</p>
        )}

        <div className="flex justify-end gap-3" style={{ marginTop: 20 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus style={{ width: 16, height: 16 }} />}
            {saving ? 'Creating…' : 'Create Client'}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   Edit Client Modal
   ══════════════════════════════════════════════════════ */
function EditClientModal({
  client,
  onClose,
  onUpdated,
}: {
  client: FLClient | null;
  onClose: () => void;
  onUpdated: (c: FLClient) => void;
}) {
  const [form, setForm] = useState<FLClientUpdate>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (client) {
      setForm({
        name: client.name,
        description: client.description || '',
        ip_address: client.ip_address || '',
      });
    }
  }, [client]);

  const handleSubmit = async () => {
    if (!client) return;
    setSaving(true);
    setError('');
    try {
      const updated = await clientsApi.update(client.id, form);
      onUpdated(updated);
      onClose();
    } catch (err: unknown) {
      const msg = (err as Record<string, Record<string, Record<string, string>>>)?.response?.data?.detail;
      setError(msg || 'Failed to update client');
    } finally {
      setSaving(false);
    }
  };

  if (!client) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="card"
        style={{ width: 460, padding: 28 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between" style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>Edit Client</h2>
          <button className="btn-ghost btn" onClick={onClose}><X style={{ width: 18, height: 18 }} /></button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Name</label>
            <input className="input" value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Description</label>
            <input className="input" value={form.description || ''} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>IP Address</label>
            <input className="input" value={form.ip_address || ''} onChange={(e) => setForm({ ...form, ip_address: e.target.value })} />
          </div>
        </div>

        {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 12 }}>{error}</p>}

        <div className="flex justify-end gap-3" style={{ marginTop: 20 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Pencil style={{ width: 16, height: 16 }} />}
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   Add Device to Client Modal
   ══════════════════════════════════════════════════════ */
function AddDeviceModal({
  clientId,
  clientPk,
  onClose,
  onAdded,
}: {
  clientId: string;
  clientPk: number;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [form, setForm] = useState({
    name: '',
    device_type: 'sensor',
    ip_address: '',
    protocol: 'tcp',
    port: '',
    description: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!form.name.trim()) {
      setError('Device name is required.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await devicesApi.create({
        name: form.name,
        device_type: form.device_type,
        ip_address: form.ip_address || undefined,
        protocol: form.protocol,
        port: form.port ? parseInt(form.port) : undefined,
        description: form.description || undefined,
        client_id: clientPk,
      });
      onAdded();
      onClose();
    } catch (err: unknown) {
      const msg = (err as Record<string, Record<string, Record<string, string>>>)?.response?.data?.detail;
      setError(msg || 'Failed to add device');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="card"
        style={{ width: 460, padding: 28 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between" style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>
            Add Device to <span style={{ color: 'var(--accent)' }}>{clientId}</span>
          </h2>
          <button className="btn-ghost btn" onClick={onClose}><X style={{ width: 18, height: 18 }} /></button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Device Name *</label>
            <input className="input" placeholder="e.g. IoT Camera 01" value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="flex gap-3">
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Type</label>
              <select className="input" value={form.device_type} onChange={(e) => setForm({ ...form, device_type: e.target.value })}>
                <option value="sensor">Sensor</option>
                <option value="camera">Camera</option>
                <option value="router">Router</option>
                <option value="gateway">Gateway</option>
                <option value="switch">Switch</option>
                <option value="controller">Controller</option>
                <option value="actuator">Actuator</option>
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Protocol</label>
              <select className="input" value={form.protocol} onChange={(e) => setForm({ ...form, protocol: e.target.value })}>
                <option value="tcp">TCP</option>
                <option value="udp">UDP</option>
                <option value="mqtt">MQTT</option>
                <option value="coap">CoAP</option>
                <option value="http">HTTP</option>
              </select>
            </div>
          </div>
          <div className="flex gap-3">
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>IP Address</label>
              <input className="input" placeholder="192.168.1.50" value={form.ip_address}
                onChange={(e) => setForm({ ...form, ip_address: e.target.value })} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Port</label>
              <input className="input" type="number" placeholder="8080" value={form.port}
                onChange={(e) => setForm({ ...form, port: e.target.value })} />
            </div>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Description</label>
            <input className="input" placeholder="Optional" value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
        </div>

        {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 12 }}>{error}</p>}

        <div className="flex justify-end gap-3" style={{ marginTop: 20 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : '+'}
            {saving ? 'Adding…' : 'Add Device'}
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
  client,
  onClose,
  onConfirm,
}: {
  client: FLClient;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await clientsApi.delete(client.id);
      onConfirm();
    } catch {
      /* swallow */
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="card"
        style={{ width: 400, padding: 28, textAlign: 'center' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ width: 48, height: 48, borderRadius: 12, background: 'var(--danger-light)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
          <Trash2 style={{ width: 22, height: 22, color: 'var(--danger)' }} />
        </div>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>Delete Client</h3>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20 }}>
          Are you sure you want to delete <strong>{client.name}</strong> ({client.client_id})?
          This will also remove its Docker container and all associated devices.
        </p>
        <div className="flex justify-center gap-3">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn"
            style={{ background: 'var(--danger)', color: '#fff' }}
            onClick={handleDelete}
            disabled={deleting}
          >
            {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 style={{ width: 16, height: 16 }} />}
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════
   Client Card — Expandable
   ══════════════════════════════════════════════════════ */
function ClientCard({
  client,
  devices,
  containerStatus,
  onEdit,
  onDelete,
  onAddDevice,
  onToggleMonitoring,
}: {
  client: FLClient;
  devices: DeviceBrief[];
  containerStatus: string;
  onEdit: () => void;
  onDelete: () => void;
  onAddDevice: () => void;
  onToggleMonitoring: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [toggling, setToggling] = useState(false);
  const sc = clientStatusConfig[client.status] ?? clientStatusConfig.inactive;
  const cc = containerStatusConfig[containerStatus] ?? containerStatusConfig.not_found;
  const isMonitoring = containerStatus === 'running' && client.status === 'active';

  const handleToggle = async () => {
    setToggling(true);
    try {
      await onToggleMonitoring();
    } finally {
      setToggling(false);
    }
  };

  return (
    <motion.div variants={fadeUp} className="card" style={{ overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '20px 20px 0 20px' }}>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div style={{
              width: 44, height: 44, borderRadius: 3,
              background: sc.bg, display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 14, fontWeight: 700, color: sc.color, fontFamily: 'inherit',
            }}>
              {'>'}
            </div>
            <div>
              <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{client.name}</p>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{client.client_id}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button className="btn btn-ghost" onClick={onEdit} title="Edit">
              <Pencil style={{ width: 14, height: 14 }} />
            </button>
            <button className="btn btn-ghost" onClick={onDelete} title="Delete" style={{ color: 'var(--danger)' }}>
              <Trash2 style={{ width: 14, height: 14 }} />
            </button>
          </div>
        </div>

        {/* Meta info */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Status: <span className="badge" style={{ background: sc.bg, color: sc.color, marginLeft: 4 }}>{sc.label}</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Container: <span style={{ color: cc.color, fontWeight: 600, marginLeft: 4 }}>{cc.label}</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Devices: <span style={{ color: 'var(--text-primary)', fontWeight: 600, marginLeft: 4 }}>{devices.length}</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Samples: <span style={{ color: 'var(--text-primary)', fontWeight: 600, marginLeft: 4 }}>{client.total_samples.toLocaleString()}</span>
          </div>
        </div>

        {client.ip_address && (
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
            IP: <span style={{ fontFamily: 'monospace', color: 'var(--text-secondary)' }}>{client.ip_address}</span>
          </p>
        )}
        {client.description && (
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{client.description}</p>
        )}
      </div>

      {/* Action bar */}
      <div
        className="flex items-center justify-between"
        style={{ padding: '12px 20px', marginTop: 16, borderTop: '1px solid var(--border)' }}
      >
        <div className="flex items-center gap-2">
          {/* Monitor toggle */}
          <button
            className="btn"
            style={{
              padding: '6px 14px',
              fontSize: 12,
              background: isMonitoring ? 'var(--danger-light)' : 'var(--success-light)',
              color: isMonitoring ? 'var(--danger)' : 'var(--success)',
            }}
            onClick={handleToggle}
            disabled={toggling}
          >
            {toggling ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : isMonitoring ? (
              <Square style={{ width: 14, height: 14 }} />
            ) : (
              <Play style={{ width: 14, height: 14 }} />
            )}
            {isMonitoring ? 'Stop Monitoring' : 'Start Monitoring'}
          </button>

          {/* Add device */}
          <button
            className="btn"
            style={{ padding: '6px 14px', fontSize: 12, background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
            onClick={onAddDevice}
          >
            <Plus style={{ width: 14, height: 14 }} />
            Add Device
          </button>
        </div>

        {/* Expand toggle */}
        <button
          className="btn btn-ghost"
          onClick={() => setExpanded(!expanded)}
          style={{ fontSize: 12, gap: 4, color: 'var(--text-muted)' }}
        >
          {expanded ? <ChevronDown style={{ width: 14, height: 14 }} /> : <ChevronRight style={{ width: 14, height: 14 }} />}
          {devices.length} device{devices.length !== 1 ? 's' : ''}
        </button>
      </div>

      {/* Expandable device list */}
      <AnimatePresence>
        {expanded && devices.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            style={{ overflow: 'hidden', borderTop: '1px solid var(--border)' }}
          >
            <div style={{ padding: '12px 20px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {devices.map((dev) => (
                <div
                  key={dev.id}
                  className="flex items-center justify-between"
                  style={{
                    padding: '10px 14px', borderRadius: 8,
                    background: 'var(--bg-secondary)', fontSize: 13,
                  }}
                >
                  <div className="flex items-center gap-3">
                    <span style={{ fontSize: 16 }}>{deviceTypeIcons[dev.device_type] || '📟'}</span>
                    <div>
                      <p style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 13 }}>{dev.name}</p>
                      <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {dev.device_type}{dev.ip_address ? ` • ${dev.ip_address}` : ''}
                      </p>
                    </div>
                  </div>
                  <span
                    className="badge"
                    style={{
                      background: dev.status === 'online' ? 'var(--success-light)' : 'var(--bg-primary)',
                      color: dev.status === 'online' ? 'var(--success)' : 'var(--text-muted)',
                    }}
                  >
                    {dev.status}
                  </span>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/* ══════════════════════════════════════════════════════
   Main Page
   ══════════════════════════════════════════════════════ */
export default function ClientsPage() {
  const [clients, setClients] = useState<ClientWithMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  // Modals
  const [createOpen, setCreateOpen] = useState(false);
  const [editClient, setEditClient] = useState<FLClient | null>(null);
  const [deleteClient, setDeleteClient] = useState<FLClient | null>(null);
  const [addDeviceTarget, setAddDeviceTarget] = useState<{ id: string; pk: number } | null>(null);

  const fetchClients = useCallback(async () => {
    try {
      const rawClients = await clientsApi.list();
      // Fetch devices and container status for each client
      const enriched: ClientWithMeta[] = await Promise.all(
        rawClients.map(async (c) => {
          let devices: DeviceBrief[] = [];
          let containerStatus = 'not_found';
          try {
            const detail = await clientsApi.get(c.id);
            devices = detail.devices;
          } catch { /* skip */ }
          try {
            const cs = await clientsApi.containerStatus(c.id);
            containerStatus = cs.status;
          } catch { /* skip */ }
          return { ...c, devices, containerStatus };
        })
      );
      setClients(enriched);
    } catch (err) {
      console.error('Failed to fetch clients:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchClients(); }, [fetchClients]);

  const handleToggleMonitoring = async (client: ClientWithMeta) => {
    const isMonitoring = client.containerStatus === 'running' && client.status === 'active';
    try {
      if (isMonitoring) {
        await clientsApi.stopMonitoring(client.id);
      } else {
        await clientsApi.startMonitoring(client.id);
      }
    } finally {
      await fetchClients();
    }
  };

  const filtered = clients
    .filter((c) => statusFilter === 'all' || c.status === statusFilter)
    .filter((c) => {
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return (
        c.name.toLowerCase().includes(q) ||
        c.client_id.toLowerCase().includes(q) ||
        (c.ip_address ?? '').toLowerCase().includes(q)
      );
    });

  const counts = {
    all: clients.length,
    active: clients.filter((c) => c.status === 'active').length,
    inactive: clients.filter((c) => c.status === 'inactive').length,
    training: clients.filter((c) => c.status === 'training').length,
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
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>Client Management</h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>
            {clients.length} registered FL client{clients.length !== 1 ? 's' : ''}
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>
          <Plus style={{ width: 16, height: 16 }} /> Create Client
        </button>
      </motion.div>

      {/* ── KPI Strip ── */}
      <motion.div variants={fadeUp} className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'Total Clients', value: counts.all, color: 'var(--accent)' },
          { label: 'Active', value: counts.active, color: 'var(--success)' },
          { label: 'Training', value: counts.training, color: 'var(--info)' },
          { label: 'Inactive', value: counts.inactive, color: 'var(--text-muted)' },
        ].map((kpi) => (
          <div key={kpi.label} className="card" style={{ padding: '16px 20px' }}>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{kpi.label}</p>
            <p style={{ fontSize: 24, fontWeight: 700, color: kpi.color }}>{kpi.value}</p>
          </div>
        ))}
      </motion.div>

      {/* ── Filters + Search ── */}
      <motion.div variants={fadeUp} className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-1.5">
          {(['all', 'active', 'inactive', 'training'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              style={{
                padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
                fontSize: 12, fontWeight: 500,
                background: statusFilter === s ? 'var(--accent)' : 'var(--bg-secondary)',
                color: statusFilter === s ? '#fff' : 'var(--text-secondary)',
                transition: 'all .15s',
              }}
            >
              {s.charAt(0).toUpperCase() + s.slice(1)}
              <span style={{ marginLeft: 6, opacity: 0.7 }}>({counts[s as keyof typeof counts] ?? 0})</span>
            </button>
          ))}
        </div>

        <div className="relative flex-1" style={{ maxWidth: 280 }}>
          <Search className="absolute left-3 top-1/2 -translate-y-1/2" style={{ width: 14, height: 14, color: 'var(--text-muted)' }} />
          <input
            type="text"
            placeholder="Search by name or ID…"
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

      {/* ── Client Grid ── */}
      {filtered.length > 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-5">
          {filtered.map((client) => (
            <ClientCard
              key={client.id}
              client={client}
              devices={client.devices}
              containerStatus={client.containerStatus}
              onEdit={() => setEditClient(client)}
              onDelete={() => setDeleteClient(client)}
              onAddDevice={() => setAddDeviceTarget({ id: client.client_id, pk: client.id })}
              onToggleMonitoring={() => handleToggleMonitoring(client)}
            />
          ))}
        </div>
      ) : (
        <div className="card flex flex-col items-center justify-center" style={{ padding: 64 }}>
          <span style={{ fontSize: 24, color: 'var(--text-muted)', marginBottom: 16 }}>[ ]</span>
          <p style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
            {clients.length === 0 ? 'No clients yet' : 'No clients match your filter'}
          </p>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
            {clients.length === 0 ? 'Create your first FL client to get started.' : 'Try adjusting your search or filter.'}
          </p>
          {clients.length === 0 && (
            <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>
              <Plus style={{ width: 16, height: 16 }} /> Create Client
            </button>
          )}
        </div>
      )}

      {/* ── Modals ── */}
      <AnimatePresence>
        {createOpen && (
          <CreateClientModal
            open={createOpen}
            onClose={() => setCreateOpen(false)}
            onCreated={() => fetchClients()}
          />
        )}
      </AnimatePresence>

      <EditClientModal
        client={editClient}
        onClose={() => setEditClient(null)}
        onUpdated={() => fetchClients()}
      />

      {deleteClient && (
        <ConfirmDeleteDialog
          client={deleteClient}
          onClose={() => setDeleteClient(null)}
          onConfirm={() => { setDeleteClient(null); fetchClients(); }}
        />
      )}

      {addDeviceTarget && (
        <AddDeviceModal
          clientId={addDeviceTarget.id}
          clientPk={addDeviceTarget.pk}
          onClose={() => setAddDeviceTarget(null)}
          onAdded={() => fetchClients()}
        />
      )}
    </motion.div>
  );
}
