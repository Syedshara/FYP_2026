import { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Plus, Loader2, Search, X,
  Trash2, Pencil,
} from 'lucide-react';
import { devicesApi } from '@/api/devices';
import { clientsApi } from '@/api/clients';
import type { Device, DeviceCreate, DeviceUpdate, FLClient, Prediction } from '@/types';
import { formatDate, formatRelativeTime } from '@/lib/utils';

/* ── animation variants ─────────────────────────────── */
const stagger = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { staggerChildren: 0.05 } } };
const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0, transition: { duration: 0.2 } } };

/* ── status config ───────────────────────────────────── */
type StatusKey = 'online' | 'offline' | 'under_attack' | 'quarantined';

const statusConfig: Record<StatusKey, { dotColor: string; label: string; dotClass: string }> = {
  online:       { dotColor: 'var(--n8n-success)',  label: 'Online',       dotClass: 'status-dot status-online' },
  offline:      { dotColor: 'var(--n8n-text-muted)', label: 'Offline',    dotClass: 'status-dot status-offline' },
  under_attack: { dotColor: 'var(--n8n-danger)',   label: 'Under Attack', dotClass: 'status-dot status-attack' },
  quarantined:  { dotColor: 'var(--n8n-warning)',  label: 'Quarantined',  dotClass: 'status-dot status-quarantined' },
};

function getStatusCfg(status: string) {
  return statusConfig[status as StatusKey] ?? statusConfig.offline;
}

/* ══════════════════════════════════════════════════════
   Add / Edit Device Modal  (unchanged logic, updated style)
   ══════════════════════════════════════════════════════ */
function DeviceModal({
  open, onClose, onSaved, clients, editing,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  clients: FLClient[];
  editing?: Device;
}) {
  const [form, setForm] = useState<DeviceCreate>({
    name: '', device_type: 'sensor', ip_address: '', protocol: 'tcp',
    port: 0, description: '', client_id: undefined,
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

  const labelStyle: React.CSSProperties = {
    fontSize: 11, fontWeight: 600, color: 'var(--n8n-text-muted)',
    textTransform: 'uppercase', letterSpacing: '0.05em',
    marginBottom: 6, display: 'block',
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.94 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.94 }}
        style={{
          width: 480,
          background: 'var(--n8n-card-bg)',
          border: '1px solid var(--n8n-card-border)',
          borderRadius: 'var(--n8n-radius)',
          padding: 28,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 22 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, color: 'var(--n8n-text-primary)' }}>
            {editing ? 'Edit Device' : 'Add Device'}
          </h2>
          <button
            onClick={onClose}
            style={{
              width: 28, height: 28, borderRadius: 6, border: '1px solid var(--n8n-card-border)',
              background: 'transparent', cursor: 'pointer', color: 'var(--n8n-text-muted)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <X style={{ width: 14, height: 14 }} />
          </button>
        </div>

        <div className="page-stack" style={{ gap: 14 }}>
          {/* Client selector */}
          <div>
            <label style={labelStyle}>
              Client <span style={{ color: 'var(--n8n-danger)' }}>*</span>
            </label>
            <select
              value={form.client_id ?? ''}
              onChange={(e) => setForm({ ...form, client_id: e.target.value ? Number(e.target.value) : undefined })}
              className="input"
              style={{ height: 38, fontSize: 12 }}
            >
              <option value="">Select a client…</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>{c.name} ({c.client_id})</option>
              ))}
            </select>
          </div>

          {/* Name */}
          <div>
            <label style={labelStyle}>
              Device Name <span style={{ color: 'var(--n8n-danger)' }}>*</span>
            </label>
            <input
              className="input"
              style={{ height: 38, fontSize: 12 }}
              placeholder="e.g. Front Door Camera"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>

          {/* Type + Protocol */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label style={labelStyle}>Type</label>
              <select
                value={form.device_type}
                onChange={(e) => setForm({ ...form, device_type: e.target.value })}
                className="input"
                style={{ height: 38, fontSize: 12 }}
              >
                {['camera', 'sensor', 'router', 'gateway', 'switch', 'controller', 'actuator'].map((t) => (
                  <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Protocol</label>
              <select
                value={form.protocol}
                onChange={(e) => setForm({ ...form, protocol: e.target.value })}
                className="input"
                style={{ height: 38, fontSize: 12 }}
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
              <label style={labelStyle}>IP Address</label>
              <input
                className="input"
                style={{ height: 38, fontSize: 12 }}
                placeholder="192.168.1.100"
                value={form.ip_address || ''}
                onChange={(e) => setForm({ ...form, ip_address: e.target.value })}
              />
            </div>
            <div>
              <label style={labelStyle}>Port</label>
              <input
                className="input"
                type="number"
                style={{ height: 38, fontSize: 12 }}
                placeholder="8080"
                value={form.port || ''}
                onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
              />
            </div>
          </div>

          {/* Description */}
          <div>
            <label style={labelStyle}>Description</label>
            <textarea
              className="input"
              rows={2}
              style={{ fontSize: 12, resize: 'none' }}
              placeholder="Optional description…"
              value={form.description || ''}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>

          {error && (
            <p style={{
              fontSize: 12, color: 'var(--n8n-danger)',
              background: 'var(--n8n-danger-light)',
              border: '1px solid var(--n8n-danger)',
              borderRadius: 6, padding: '8px 12px',
            }}>{error}</p>
          )}
        </div>

        <div className="flex justify-end gap-2" style={{ marginTop: 22 }}>
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
  open, deviceName, onClose, onConfirm,
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
      style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        style={{
          width: 400,
          background: 'var(--n8n-card-bg)',
          border: '1px solid var(--n8n-danger)',
          borderRadius: 'var(--n8n-radius)',
          padding: 28,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 8,
            background: 'var(--n8n-danger-light)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Trash2 style={{ width: 16, height: 16, color: 'var(--n8n-danger)' }} />
          </div>
          <h2 style={{ fontSize: 15, fontWeight: 700, color: 'var(--n8n-text-primary)' }}>Delete Device</h2>
        </div>

        <p style={{ fontSize: 13, color: 'var(--n8n-text-muted)', lineHeight: 1.6 }}>
          Are you sure you want to delete <strong style={{ color: 'var(--n8n-text-primary)' }}>{deviceName}</strong>?
          This action cannot be undone.
        </p>

        <div className="flex justify-end gap-2" style={{ marginTop: 22 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn"
            style={{ background: 'var(--n8n-danger)', color: '#fff', borderColor: 'var(--n8n-danger)' }}
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
  device, clientName, onClose,
}: {
  device: Device;
  clientName: string;
  onClose: () => void;
}) {
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    devicesApi.predictions(device.id, 50)
      .then(setPredictions)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [device.id]);

  const sc = getStatusCfg(device.status);
  const attackCount = predictions.filter((p) => p.label === 'attack').length;
  const benignCount = predictions.filter((p) => p.label === 'benign').length;

  return (
    <motion.div
      initial={{ opacity: 0, x: 32 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 32 }}
      style={{
        background: 'var(--n8n-card-bg)',
        border: '1px solid var(--n8n-card-border)',
        borderRadius: 'var(--n8n-radius)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <div style={{
        padding: '16px 20px',
        borderBottom: '1px solid var(--n8n-card-border)',
        background: 'rgba(255,255,255,0.03)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--n8n-text-primary)' }}>{device.name}</p>
            <p style={{ fontSize: 11, color: 'var(--n8n-text-muted)', fontFamily: 'monospace', marginTop: 2 }}>
              {device.ip_address || 'No IP'} · {clientName}
            </p>
          </div>
          <button
            onClick={onClose}
            style={{
              width: 30, height: 30, borderRadius: 6,
              background: 'transparent',
              border: '1px solid var(--n8n-card-border)',
              cursor: 'pointer', color: 'var(--n8n-text-muted)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <X style={{ width: 14, height: 14 }} />
          </button>
        </div>
      </div>

      {/* Device meta */}
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--n8n-card-border)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 24px', fontSize: 12 }}>
          {[
            { label: 'Status', value: sc.label, color: sc.dotColor },
            { label: 'Type', value: device.device_type, color: 'var(--n8n-text-primary)' },
            { label: 'Protocol', value: `${device.protocol.toUpperCase()} : ${device.port}`, color: 'var(--n8n-text-primary)' },
            {
              label: 'Threats Today',
              value: String(device.threat_count_today),
              color: device.threat_count_today > 0 ? 'var(--n8n-danger)' : 'var(--n8n-text-primary)',
            },
          ].map((row) => (
            <div key={row.label}>
              <span style={{ color: 'var(--n8n-text-muted)', display: 'block', marginBottom: 2 }}>{row.label}</span>
              <span style={{ color: row.color, fontWeight: 600 }}>{row.value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Prediction summary bar */}
      <div style={{
        padding: '10px 20px',
        borderBottom: '1px solid var(--n8n-card-border)',
        display: 'flex', gap: 20, fontSize: 12,
      }}>
        <span style={{ color: 'var(--n8n-text-muted)' }}>
          Total: <strong style={{ color: 'var(--n8n-text-primary)' }}>{predictions.length}</strong>
        </span>
        <span style={{ color: 'var(--n8n-text-muted)' }}>
          Attacks: <strong style={{ color: 'var(--n8n-danger)' }}>{attackCount}</strong>
        </span>
        <span style={{ color: 'var(--n8n-text-muted)' }}>
          Benign: <strong style={{ color: 'var(--n8n-success)' }}>{benignCount}</strong>
        </span>
      </div>

      {/* Prediction history */}
      <div style={{ padding: '14px 20px', maxHeight: 380, overflowY: 'auto', flex: 1 }}>
        <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--n8n-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
          Recent Predictions
        </p>

        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
            <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--n8n-accent)' }} />
          </div>
        ) : predictions.length === 0 ? (
          <p style={{ fontSize: 12, color: 'var(--n8n-text-muted)', textAlign: 'center', padding: '20px 0' }}>
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
                    padding: '8px 12px',
                    borderRadius: 8,
                    background: isAttack ? 'var(--n8n-danger-light)' : 'rgba(255,255,255,0.03)',
                    borderLeft: `3px solid ${isAttack ? 'var(--n8n-danger)' : 'var(--n8n-success)'}`,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: 12,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{
                      padding: '2px 7px', borderRadius: 4, fontSize: 10, fontWeight: 700,
                      background: isAttack ? 'var(--n8n-danger)' : 'var(--n8n-success)',
                      color: '#fff',
                    }}>
                      {isAttack ? 'ATTACK' : 'BENIGN'}
                    </span>
                    <span style={{ color: 'var(--n8n-text-muted)' }}>
                      Score: {p.score.toFixed(4)} · Conf: {(p.confidence * 100).toFixed(1)}%
                    </span>
                  </div>
                  <span style={{ color: 'var(--n8n-text-muted)', fontSize: 10, whiteSpace: 'nowrap' }}>
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
   n8n Node Card  (D-0.2 redesign)
   ══════════════════════════════════════════════════════ */
function DeviceNodeCard({
  device, clientName, onEdit, onDelete, onSelect,
}: {
  device: Device;
  clientName: string;
  onEdit: () => void;
  onDelete: () => void;
  onSelect: () => void;
}) {
  const sc = getStatusCfg(device.status);
  const [hovered, setHovered] = useState(false);

  return (
    <motion.div
      variants={fadeUp}
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: 'var(--n8n-card-bg)',
        border: `1px solid ${hovered ? 'var(--n8n-accent)' : 'var(--n8n-card-border)'}`,
        boxShadow: hovered ? '0 0 0 1px var(--n8n-accent)' : 'none',
        borderRadius: 12,
        padding: 16,
        cursor: 'pointer',
        transition: 'border-color 0.15s, box-shadow 0.15s',
      }}
    >
      {/* Row 1: status dot + label  |  IP right-aligned */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span className={sc.dotClass} />
          <span style={{ fontSize: 11, fontWeight: 600, color: sc.dotColor }}>
            {sc.label}
          </span>
        </div>
        <span style={{
          fontSize: 10, fontFamily: 'monospace',
          color: 'var(--n8n-text-muted)',
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid var(--n8n-card-border)',
          borderRadius: 4, padding: '2px 6px',
        }}>
          {device.ip_address || '—'}
        </span>
      </div>

      {/* Row 2: device name */}
      <p style={{
        fontSize: 14, fontWeight: 700, color: 'var(--n8n-text-primary)',
        fontFamily: 'monospace', marginBottom: 4,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {device.name}
      </p>

      {/* Row 3: type / protocol (muted) */}
      <p style={{ fontSize: 11, color: 'var(--n8n-text-muted)', marginBottom: 12 }}>
        {device.device_type.charAt(0).toUpperCase() + device.device_type.slice(1)}
        {' / '}
        {device.protocol.toUpperCase()}
        {' · '}
        <span style={{ color: 'var(--n8n-accent)', fontWeight: 500 }}>{clientName}</span>
      </p>

      {/* Divider */}
      <div style={{ height: 1, background: 'var(--n8n-card-border)', marginBottom: 12 }} />

      {/* Row 4: stats */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, marginBottom: 8 }}>
        <span style={{ color: 'var(--n8n-text-muted)' }}>
          Port:{' '}
          <strong style={{ color: 'var(--n8n-text-primary)' }}>{device.port}</strong>
        </span>
        <span style={{ color: device.threat_count_today > 0 ? 'var(--n8n-danger)' : 'var(--n8n-text-muted)' }}>
          Alerts:{' '}
          <strong style={{ color: device.threat_count_today > 0 ? 'var(--n8n-danger)' : 'var(--n8n-text-primary)' }}>
            {device.threat_count_today}
          </strong>
        </span>
      </div>

      {/* Row 5: last seen + action buttons */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 10, color: 'var(--n8n-text-muted)' }}>
          {device.last_seen_at
            ? `Last seen: ${formatRelativeTime(device.last_seen_at)}`
            : 'Never seen'}
        </span>

        <div style={{ display: 'flex', gap: 6 }}>
          <button
            title="Edit"
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            style={{
              width: 26, height: 26, borderRadius: 6,
              border: '1px solid var(--n8n-card-border)',
              background: 'transparent', cursor: 'pointer',
              color: 'var(--n8n-text-muted)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'border-color 0.12s, color 0.12s',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--n8n-accent)';
              (e.currentTarget as HTMLButtonElement).style.color = 'var(--n8n-accent)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--n8n-card-border)';
              (e.currentTarget as HTMLButtonElement).style.color = 'var(--n8n-text-muted)';
            }}
          >
            <Pencil style={{ width: 11, height: 11 }} />
          </button>
          <button
            title="Delete"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            style={{
              width: 26, height: 26, borderRadius: 6,
              border: '1px solid var(--n8n-card-border)',
              background: 'transparent', cursor: 'pointer',
              color: 'var(--n8n-text-muted)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'border-color 0.12s, color 0.12s',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--n8n-danger)';
              (e.currentTarget as HTMLButtonElement).style.color = 'var(--n8n-danger)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--n8n-card-border)';
              (e.currentTarget as HTMLButtonElement).style.color = 'var(--n8n-text-muted)';
            }}
          >
            <Trash2 style={{ width: 11, height: 11 }} />
          </button>
        </div>
      </div>
    </motion.div>
  );
}

/* ══════════════════════════════════════════════════════
   Filter chip type
   ══════════════════════════════════════════════════════ */
type FilterKey = 'all' | 'online' | 'offline' | 'under_attack' | 'quarantined';

const filterChips: { key: FilterKey; label: string }[] = [
  { key: 'all',          label: 'All' },
  { key: 'online',       label: 'Online' },
  { key: 'offline',      label: 'Offline' },
  { key: 'under_attack', label: 'Alert' },
  { key: 'quarantined',  label: 'Quarantined' },
];

/* ══════════════════════════════════════════════════════
   Page Component
   ══════════════════════════════════════════════════════ */
export default function DevicesPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [clients, setClients] = useState<FLClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [clientFilter, setClientFilter] = useState<number | 'all'>('all');
  const [search, setSearch] = useState('');

  /* modal / panel state */
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

  /* derived */
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

  const counts: Record<FilterKey, number> = {
    all:          devices.length,
    online:       devices.filter((d) => d.status === 'online').length,
    offline:      devices.filter((d) => d.status === 'offline').length,
    under_attack: devices.filter((d) => d.status === 'under_attack').length,
    quarantined:  devices.filter((d) => d.status === 'quarantined').length,
  };

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

  /* ── Loading ── */
  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 240 }}>
        <Loader2 className="w-8 h-8 animate-spin" style={{ color: 'var(--n8n-accent)' }} />
      </div>
    );
  }

  return (
    <motion.div variants={stagger} initial="hidden" animate="show" className="page-stack">

      {/* ── Header ── */}
      <motion.div variants={fadeUp} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--n8n-text-primary)' }}>Devices</h1>
          <span style={{
            fontSize: 11, fontWeight: 600,
            color: 'var(--n8n-accent)',
            background: 'var(--n8n-accent-light)',
            border: '1px solid var(--n8n-accent)',
            borderRadius: 20, padding: '3px 10px',
          }}>
            {devices.length} {devices.length === 1 ? 'device' : 'devices'}
          </span>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => { setEditingDevice(undefined); setModalOpen(true); }}
        >
          <Plus style={{ width: 15, height: 15 }} />
          Add Device
        </button>
      </motion.div>

      {/* ── KPI strip ── */}
      <motion.div variants={fadeUp} style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        {([
          { label: 'Total',        value: counts.all,          color: 'var(--n8n-accent)' },
          { label: 'Online',       value: counts.online,       color: 'var(--n8n-success)' },
          { label: 'Under Attack', value: counts.under_attack, color: 'var(--n8n-danger)' },
          { label: 'Offline',      value: counts.offline,      color: 'var(--n8n-text-muted)' },
        ] as const).map((kpi) => (
          <div key={kpi.label} style={{
            background: 'var(--n8n-card-bg)',
            border: '1px solid var(--n8n-card-border)',
            borderRadius: 'var(--n8n-radius)',
            padding: '14px 18px',
          }}>
            <p style={{ fontSize: 10, fontWeight: 600, color: 'var(--n8n-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
              {kpi.label}
            </p>
            <p style={{ fontSize: 26, fontWeight: 700, color: kpi.color, lineHeight: 1 }}>{kpi.value}</p>
          </div>
        ))}
      </motion.div>

      {/* ── Filter bar ── */}
      <motion.div variants={fadeUp} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {/* Status toggle chips */}
        <div style={{ display: 'flex', gap: 6 }}>
          {filterChips.map(({ key, label }) => {
            const active = filter === key;
            return (
              <button
                key={key}
                onClick={() => setFilter(key)}
                style={{
                  padding: '5px 14px',
                  borderRadius: 20,
                  border: `1px solid ${active ? 'var(--n8n-accent)' : 'var(--n8n-card-border)'}`,
                  background: active ? 'var(--n8n-accent-light)' : 'transparent',
                  color: active ? 'var(--n8n-accent)' : 'var(--n8n-text-muted)',
                  fontSize: 12, fontWeight: active ? 600 : 400,
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                  fontFamily: 'inherit',
                }}
              >
                {label}
                <span style={{ marginLeft: 5, opacity: 0.75 }}>({counts[key]})</span>
              </button>
            );
          })}
        </div>

        {/* Client dropdown */}
        <select
          value={clientFilter === 'all' ? '' : String(clientFilter)}
          onChange={(e) => setClientFilter(e.target.value ? Number(e.target.value) : 'all')}
          className="input"
          style={{ height: 34, fontSize: 12, minWidth: 155, width: 'auto' }}
        >
          <option value="">All Clients</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>

        {/* Search */}
        <div style={{ position: 'relative', flex: 1, maxWidth: 280 }}>
          <Search style={{
            position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
            width: 13, height: 13, color: 'var(--n8n-text-muted)',
          }} />
          <input
            type="text"
            placeholder="Search by name, IP, or client…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input"
            style={{ paddingLeft: 30, paddingRight: search ? 30 : 12, height: 34, fontSize: 12 }}
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              style={{
                position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                width: 18, height: 18, borderRadius: 4,
                background: 'var(--n8n-card-border)', border: 'none',
                cursor: 'pointer', color: 'var(--n8n-text-muted)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <X style={{ width: 10, height: 10 }} />
            </button>
          )}
        </div>
      </motion.div>

      {/* ── Main: grid + detail panel ── */}
      <div style={{ display: 'flex', gap: 20, minHeight: 400 }}>

        {/* Node card grid */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {filtered.length > 0 ? (
            <motion.div
              variants={stagger}
              initial="hidden"
              animate="show"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                gap: 16,
              }}
            >
              {filtered.map((device) => (
                <DeviceNodeCard
                  key={device.id}
                  device={device}
                  clientName={getClientName(device.client_id)}
                  onEdit={() => { setEditingDevice(device); setModalOpen(true); }}
                  onDelete={() => setDeleteTarget(device)}
                  onSelect={() => setSelectedDevice(prev => prev?.id === device.id ? null : device)}
                />
              ))}
            </motion.div>
          ) : (
            /* Empty state */
            <div style={{
              background: 'var(--n8n-card-bg)',
              border: '1px dashed var(--n8n-card-border)',
              borderRadius: 'var(--n8n-radius)',
              padding: 48,
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              gap: 8,
            }}>
              <span style={{ fontSize: 28, color: 'var(--n8n-card-border)' }}>[ ]</span>
              <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--n8n-text-muted)' }}>No devices found</p>
              <p style={{ fontSize: 12, color: 'var(--n8n-text-muted)' }}>
                {search ? 'Try adjusting your search or filters.' : 'Add a device to get started.'}
              </p>
            </div>
          )}
        </div>

        {/* Prediction panel */}
        <AnimatePresence>
          {selectedDevice && (
            <div style={{ width: 400, flexShrink: 0 }}>
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
