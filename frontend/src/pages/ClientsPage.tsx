import { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Plus, Loader2, Search, X, ChevronDown, ChevronRight,
  Play, Square, Trash2, Pencil,
} from 'lucide-react';
import { clientsApi } from '@/api/clients';
import { useTrustScores } from '@/stores/liveStore';
import { devicesApi } from '@/api/devices';
import type {
  FLClient, FLClientCreate, FLClientUpdate,
  DeviceBrief,
} from '@/types';

/* ── animation variants ─────────────────────────────── */
const stagger = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { staggerChildren: 0.06 } } };
const fadeUp = { hidden: { opacity: 0, y: 14 }, show: { opacity: 1, y: 0 } };

/** Normalise client name to a key for the trust score map. */
function trustKey(name: string): string {
  return name.replace(/\s+/g, '_');
}

/* ── relative-time helper ───────────────────────────── */
function relativeTime(iso: string | null): string {
  if (!iso) return 'Never';
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/* ── status config (kept for modal / legacy usage) ──── */
const clientStatusConfig: Record<string, { color: string; bg: string; label: string }> = {
  active:   { color: 'var(--n8n-success)', bg: 'var(--n8n-success-light)', label: 'Connected' },
  inactive: { color: 'var(--n8n-text-muted)', bg: 'rgba(136,136,136,0.12)', label: 'Offline' },
  training: { color: 'var(--n8n-info)',    bg: 'var(--n8n-info-light)',    label: 'Training' },
  error:    { color: 'var(--n8n-danger)',  bg: 'var(--n8n-danger-light)',  label: 'Error' },
};

const containerStatusConfig: Record<string, { color: string; label: string }> = {
  running:   { color: 'var(--n8n-success)',     label: 'Running' },
  exited:    { color: 'var(--n8n-text-muted)', label: 'Stopped' },
  created:   { color: 'var(--n8n-warning)',    label: 'Created' },
  paused:    { color: 'var(--n8n-warning)',    label: 'Paused' },
  dead:      { color: 'var(--n8n-danger)',     label: 'Dead' },
  not_found: { color: 'var(--n8n-text-muted)', label: 'No Container' },
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
   Node-card sub-components
   ══════════════════════════════════════════════════════ */

/** Trust score progress bar — accent when ≥ 0.5, danger below. */
function TrustBar({ score }: { score: number }) {
  const pct = Math.min(Math.max(score, 0), 1) * 100;
  const barColor = score < 0.5 ? 'var(--n8n-danger)' : 'var(--n8n-accent)';

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--n8n-text-muted)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          Trust Score
        </span>
        <span style={{ fontSize: 13, fontWeight: 700, color: barColor }}>
          {Math.round(pct)}%
        </span>
      </div>
      <div style={{
        height: 6, borderRadius: 999,
        background: 'var(--n8n-card-border)',
        overflow: 'hidden',
      }}>
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.7, ease: 'easeOut' }}
          style={{ height: '100%', borderRadius: 999, background: barColor }}
        />
      </div>
    </div>
  );
}

/** Security feature check row (Gradient Signed / mTLS). */
function SecurityRow({ gradientSigned, mtls }: { gradientSigned: boolean; mtls: boolean }) {
  const check = (ok: boolean) => (
    <span style={{ color: ok ? 'var(--n8n-success)' : 'var(--n8n-danger)', fontWeight: 700 }}>
      {ok ? '✓' : '✗'}
    </span>
  );

  return (
    <div style={{ display: 'flex', gap: 20, fontSize: 12, color: 'var(--n8n-text-muted)' }}>
      <span>Gradient Signed: {check(gradientSigned)}</span>
      <span>mTLS: {check(mtls)}</span>
    </div>
  );
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
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
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
          <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--n8n-text-primary)' }}>Create Client</h2>
          <button className="btn-ghost btn" onClick={onClose}><X style={{ width: 18, height: 18 }} /></button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--n8n-text-muted)', marginBottom: 4, display: 'block' }}>Client ID *</label>
            <input className="input" placeholder="e.g. bank_a" value={form.client_id}
              onChange={(e) => setForm({ ...form, client_id: e.target.value })} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--n8n-text-muted)', marginBottom: 4, display: 'block' }}>Name *</label>
            <input className="input" placeholder="e.g. Bank A" value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--n8n-text-muted)', marginBottom: 4, display: 'block' }}>Description</label>
            <input className="input" placeholder="Optional description" value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--n8n-text-muted)', marginBottom: 4, display: 'block' }}>IP Address</label>
            <input className="input" placeholder="e.g. 192.168.1.100" value={form.ip_address}
              onChange={(e) => setForm({ ...form, ip_address: e.target.value })} />
          </div>
        </div>

        {error && (
          <p style={{ color: 'var(--n8n-danger)', fontSize: 13, marginTop: 12 }}>{error}</p>
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
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
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
          <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--n8n-text-primary)' }}>Edit Client</h2>
          <button className="btn-ghost btn" onClick={onClose}><X style={{ width: 18, height: 18 }} /></button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--n8n-text-muted)', marginBottom: 4, display: 'block' }}>Name</label>
            <input className="input" value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--n8n-text-muted)', marginBottom: 4, display: 'block' }}>Description</label>
            <input className="input" value={form.description || ''} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--n8n-text-muted)', marginBottom: 4, display: 'block' }}>IP Address</label>
            <input className="input" value={form.ip_address || ''} onChange={(e) => setForm({ ...form, ip_address: e.target.value })} />
          </div>
        </div>

        {error && <p style={{ color: 'var(--n8n-danger)', fontSize: 13, marginTop: 12 }}>{error}</p>}

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
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
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
          <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--n8n-text-primary)' }}>
            Add Device to <span style={{ color: 'var(--n8n-accent)' }}>{clientId}</span>
          </h2>
          <button className="btn-ghost btn" onClick={onClose}><X style={{ width: 18, height: 18 }} /></button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--n8n-text-muted)', marginBottom: 4, display: 'block' }}>Device Name *</label>
            <input className="input" placeholder="e.g. IoT Camera 01" value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="flex gap-3">
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--n8n-text-muted)', marginBottom: 4, display: 'block' }}>Type</label>
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
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--n8n-text-muted)', marginBottom: 4, display: 'block' }}>Protocol</label>
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
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--n8n-text-muted)', marginBottom: 4, display: 'block' }}>IP Address</label>
              <input className="input" placeholder="192.168.1.50" value={form.ip_address}
                onChange={(e) => setForm({ ...form, ip_address: e.target.value })} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--n8n-text-muted)', marginBottom: 4, display: 'block' }}>Port</label>
              <input className="input" type="number" placeholder="8080" value={form.port}
                onChange={(e) => setForm({ ...form, port: e.target.value })} />
            </div>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--n8n-text-muted)', marginBottom: 4, display: 'block' }}>Description</label>
            <input className="input" placeholder="Optional" value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
        </div>

        {error && <p style={{ color: 'var(--n8n-danger)', fontSize: 13, marginTop: 12 }}>{error}</p>}

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
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="card"
        style={{ width: 400, padding: 28, textAlign: 'center' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{
          width: 48, height: 48, borderRadius: 12,
          background: 'var(--n8n-danger-light)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          margin: '0 auto 16px',
        }}>
          <Trash2 style={{ width: 22, height: 22, color: 'var(--n8n-danger)' }} />
        </div>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: 'var(--n8n-text-primary)', marginBottom: 8 }}>Delete Client</h3>
        <p style={{ fontSize: 13, color: 'var(--n8n-text-muted)', marginBottom: 20 }}>
          Are you sure you want to delete <strong>{client.name}</strong> ({client.client_id})?
          This will also remove its Docker container and all associated devices.
        </p>
        <div className="flex justify-center gap-3">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn"
            style={{ background: 'var(--n8n-danger)', color: '#fff' }}
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
   n8n Node Card — FL Client
   ══════════════════════════════════════════════════════ */
function ClientNodeCard({
  client,
  devices,
  containerStatus,
  liveTrustScores,
  onEdit,
  onDelete,
  onAddDevice,
  onToggleMonitoring,
}: {
  client: FLClient;
  devices: DeviceBrief[];
  containerStatus: string;
  liveTrustScores: Record<string, number>;
  onEdit: () => void;
  onDelete: () => void;
  onAddDevice: () => void;
  onToggleMonitoring: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [toggling, setToggling] = useState(false);

  const sc = clientStatusConfig[client.status] ?? clientStatusConfig.inactive;
  const cc = containerStatusConfig[containerStatus] ?? containerStatusConfig.not_found;
  const isConnected = client.status === 'active';
  const isMonitoring = containerStatus === 'running' && isConnected;
  const trustScore = liveTrustScores[trustKey(client.name)] ?? 1.0;

  /* Derive "rounds participated" from total_samples as proxy until Wave 4 */
  const roundsParticipated = client.total_samples > 0 ? Math.floor(client.total_samples / 100) : 0;

  /* Derive security feature flags from container status (placeholder until Wave 4) */
  const gradientSigned = isConnected;
  const mtlsEnabled = isConnected;

  const handleToggle = async () => {
    setToggling(true);
    try {
      await onToggleMonitoring();
    } finally {
      setToggling(false);
    }
  };

  return (
    <motion.div
      variants={fadeUp}
      style={{
        background: 'var(--n8n-card-bg)',
        border: `1.5px solid ${isConnected ? 'var(--n8n-accent)' : 'var(--n8n-card-border)'}`,
        borderRadius: 'var(--n8n-radius)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        transition: 'border-color 0.2s, box-shadow 0.2s',
        boxShadow: isConnected
          ? '0 0 0 1px rgba(255,109,90,0.15), 0 4px 24px rgba(0,0,0,0.35)'
          : '0 4px 24px rgba(0,0,0,0.3)',
      }}
    >
      {/* ── Card Header ── */}
      <div style={{ padding: '18px 20px 14px 20px', borderBottom: '1px solid var(--n8n-card-border)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 0 }}>
          {/* Client name + ID */}
          <div>
            <p style={{
              fontSize: 16, fontWeight: 800, color: 'var(--n8n-text-primary)',
              letterSpacing: '0.01em', textTransform: 'uppercase',
            }}>
              {client.name}
            </p>
            <p style={{ fontSize: 11, color: 'var(--n8n-text-muted)', fontFamily: 'monospace', marginTop: 2 }}>
              {client.client_id}
            </p>
          </div>

          {/* Status badge + action buttons */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 999,
              background: sc.bg, color: sc.color,
              letterSpacing: '0.04em',
            }}>
              {sc.label}
            </span>
            <button
              className="btn btn-ghost"
              onClick={onEdit}
              title="Edit"
              style={{ padding: '4px 6px' }}
            >
              <Pencil style={{ width: 13, height: 13 }} />
            </button>
            <button
              className="btn btn-ghost"
              onClick={onDelete}
              title="Delete"
              style={{ padding: '4px 6px', color: 'var(--n8n-danger)' }}
            >
              <Trash2 style={{ width: 13, height: 13 }} />
            </button>
          </div>
        </div>
      </div>

      {/* ── Card Body ── */}
      <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14, flex: 1 }}>
        {/* Trust Score bar */}
        <TrustBar score={trustScore} />

        {/* Divider */}
        <div style={{ height: 1, background: 'var(--n8n-card-border)' }} />

        {/* Key metrics row */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
            <span style={{ color: 'var(--n8n-text-muted)' }}>Rounds Participated</span>
            <span style={{ color: 'var(--n8n-text-primary)', fontWeight: 600, fontFamily: 'monospace' }}>
              {roundsParticipated}
            </span>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
            <span style={{ color: 'var(--n8n-text-muted)' }}>Last Seen</span>
            <span style={{ color: 'var(--n8n-text-muted)', fontFamily: 'monospace' }}>
              {relativeTime(client.last_seen_at)}
            </span>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
            <span style={{ color: 'var(--n8n-text-muted)' }}>Container</span>
            <span style={{ color: cc.color, fontWeight: 600 }}>{cc.label}</span>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
            <span style={{ color: 'var(--n8n-text-muted)' }}>Samples</span>
            <span style={{ color: 'var(--n8n-text-primary)', fontWeight: 600, fontFamily: 'monospace' }}>
              {client.total_samples.toLocaleString()}
            </span>
          </div>

          {client.ip_address && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
              <span style={{ color: 'var(--n8n-text-muted)' }}>IP Address</span>
              <span style={{ color: 'var(--n8n-text-muted)', fontFamily: 'monospace' }}>{client.ip_address}</span>
            </div>
          )}
        </div>

        {/* Security feature row */}
        <SecurityRow gradientSigned={gradientSigned} mtls={mtlsEnabled} />
      </div>

      {/* ── Card Footer: action bar ── */}
      <div style={{
        padding: '12px 20px',
        borderTop: '1px solid var(--n8n-card-border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 8,
      }}>
        {/* Left: monitoring toggle + add device */}
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn"
            style={{
              padding: '5px 12px', fontSize: 12,
              background: isMonitoring ? 'var(--n8n-danger-light)' : 'var(--n8n-success-light)',
              color: isMonitoring ? 'var(--n8n-danger)' : 'var(--n8n-success)',
              border: `1px solid ${isMonitoring ? 'var(--n8n-danger)' : 'var(--n8n-success)'}`,
              borderRadius: 'var(--n8n-radius-sm)',
            }}
            onClick={handleToggle}
            disabled={toggling}
          >
            {toggling ? (
              <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" />
            ) : isMonitoring ? (
              <Square style={{ width: 13, height: 13 }} />
            ) : (
              <Play style={{ width: 13, height: 13 }} />
            )}
            {isMonitoring ? 'Stop' : 'Monitor'}
          </button>

          <button
            className="btn"
            style={{
              padding: '5px 12px', fontSize: 12,
              background: 'rgba(255,109,90,0.08)',
              color: 'var(--n8n-accent)',
              border: '1px solid var(--n8n-accent)',
              borderRadius: 'var(--n8n-radius-sm)',
            }}
            onClick={onAddDevice}
          >
            <Plus style={{ width: 13, height: 13 }} />
            Device
          </button>
        </div>

        {/* Right: expand device list */}
        <button
          className="btn btn-ghost"
          onClick={() => setExpanded(!expanded)}
          style={{ fontSize: 12, gap: 4, color: 'var(--n8n-text-muted)', padding: '5px 8px' }}
        >
          {expanded
            ? <ChevronDown style={{ width: 13, height: 13 }} />
            : <ChevronRight style={{ width: 13, height: 13 }} />}
          {devices.length} device{devices.length !== 1 ? 's' : ''}
        </button>
      </div>

      {/* ── Expandable device list ── */}
      <AnimatePresence>
        {expanded && devices.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            style={{ overflow: 'hidden', borderTop: '1px solid var(--n8n-card-border)' }}
          >
            <div style={{ padding: '12px 20px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {devices.map((dev) => (
                <div
                  key={dev.id}
                  style={{
                    padding: '9px 12px', borderRadius: 'var(--n8n-radius-sm)',
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid var(--n8n-card-border)',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    fontSize: 12,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 15 }}>{deviceTypeIcons[dev.device_type] || '📟'}</span>
                    <div>
                      <p style={{ fontWeight: 600, color: 'var(--n8n-text-primary)', fontSize: 12 }}>{dev.name}</p>
                      <p style={{ fontSize: 10, color: 'var(--n8n-text-muted)' }}>
                        {dev.device_type}{dev.ip_address ? ` • ${dev.ip_address}` : ''}
                      </p>
                    </div>
                  </div>
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                    background: dev.status === 'online' ? 'var(--n8n-success-light)' : 'rgba(136,136,136,0.12)',
                    color: dev.status === 'online' ? 'var(--n8n-success)' : 'var(--n8n-text-muted)',
                  }}>
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
  const liveTrustScores = useTrustScores();
  const [clients, setClients] = useState<ClientWithMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  /* Modals */
  const [createOpen, setCreateOpen] = useState(false);
  const [editClient, setEditClient] = useState<FLClient | null>(null);
  const [deleteClient, setDeleteClient] = useState<FLClient | null>(null);
  const [addDeviceTarget, setAddDeviceTarget] = useState<{ id: string; pk: number } | null>(null);

  const fetchClients = useCallback(async () => {
    try {
      const rawClients = await clientsApi.list();
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
        <Loader2 className="w-8 h-8 animate-spin" style={{ color: 'var(--n8n-accent)' }} />
      </div>
    );
  }

  return (
    <motion.div variants={stagger} initial="hidden" animate="show" className="page-stack">
      {/* ── Header ── */}
      <motion.div variants={fadeUp} className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--n8n-text-primary)' }}>
            FL Clients
          </h1>
          <p style={{ fontSize: 13, color: 'var(--n8n-text-muted)', marginTop: 2 }}>
            {clients.length} registered federation node{clients.length !== 1 ? 's' : ''}
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>
          <Plus style={{ width: 16, height: 16 }} /> Create Client
        </button>
      </motion.div>

      {/* ── KPI Strip ── */}
      <motion.div variants={fadeUp} className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'Total Clients', value: counts.all,      color: 'var(--n8n-accent)' },
          { label: 'Connected',     value: counts.active,   color: 'var(--n8n-success)' },
          { label: 'Training',      value: counts.training, color: 'var(--n8n-info)' },
          { label: 'Offline',       value: counts.inactive, color: 'var(--n8n-text-muted)' },
        ].map((kpi) => (
          <div
            key={kpi.label}
            style={{
              background: 'var(--n8n-card-bg)',
              border: '1px solid var(--n8n-card-border)',
              borderRadius: 'var(--n8n-radius)',
              padding: '16px 20px',
            }}
          >
            <p style={{ fontSize: 11, color: 'var(--n8n-text-muted)', marginBottom: 4 }}>{kpi.label}</p>
            <p style={{ fontSize: 26, fontWeight: 800, color: kpi.color }}>{kpi.value}</p>
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
                padding: '6px 14px', borderRadius: 'var(--n8n-radius-sm)',
                border: statusFilter === s ? '1px solid var(--n8n-accent)' : '1px solid var(--n8n-card-border)',
                cursor: 'pointer', fontSize: 12, fontWeight: 500,
                background: statusFilter === s ? 'var(--n8n-accent-light)' : 'var(--n8n-card-bg)',
                color: statusFilter === s ? 'var(--n8n-accent)' : 'var(--n8n-text-muted)',
                transition: 'all .15s',
              }}
            >
              {s === 'active' ? 'Connected' : s.charAt(0).toUpperCase() + s.slice(1)}
              <span style={{ marginLeft: 6, opacity: 0.7 }}>({counts[s as keyof typeof counts] ?? 0})</span>
            </button>
          ))}
        </div>

        <div className="relative flex-1" style={{ maxWidth: 280 }}>
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2"
            style={{ width: 14, height: 14, color: 'var(--n8n-text-muted)' }}
          />
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
              style={{
                width: 20, height: 20, borderRadius: 4,
                background: 'var(--n8n-card-bg)', border: 'none',
                cursor: 'pointer', color: 'var(--n8n-text-muted)',
              }}
            >
              <X style={{ width: 12, height: 12 }} />
            </button>
          )}
        </div>
      </motion.div>

      {/* ── Node Card Grid — 3 columns ── */}
      {filtered.length > 0 ? (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 20,
        }}>
          {filtered.map((client) => (
            <ClientNodeCard
              key={client.id}
              client={client}
              devices={client.devices}
              containerStatus={client.containerStatus}
              liveTrustScores={liveTrustScores}
              onEdit={() => setEditClient(client)}
              onDelete={() => setDeleteClient(client)}
              onAddDevice={() => setAddDeviceTarget({ id: client.client_id, pk: client.id })}
              onToggleMonitoring={() => handleToggleMonitoring(client)}
            />
          ))}
        </div>
      ) : (
        <div
          style={{
            background: 'var(--n8n-card-bg)',
            border: '1px solid var(--n8n-card-border)',
            borderRadius: 'var(--n8n-radius)',
            padding: 64,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <span style={{ fontSize: 28, color: 'var(--n8n-text-muted)', marginBottom: 14, fontFamily: 'monospace' }}>[ ]</span>
          <p style={{ fontSize: 16, fontWeight: 600, color: 'var(--n8n-text-primary)', marginBottom: 4 }}>
            {clients.length === 0 ? 'No clients yet' : 'No clients match your filter'}
          </p>
          <p style={{ fontSize: 13, color: 'var(--n8n-text-muted)', marginBottom: 16 }}>
            {clients.length === 0
              ? 'Create your first FL client to get started.'
              : 'Try adjusting your search or filter.'}
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
            onCreated={(newClient: FLClient) => {
              setClients(prev => [{ ...newClient, devices: [], containerStatus: 'not_found' }, ...prev]);
              fetchClients();
            }}
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
