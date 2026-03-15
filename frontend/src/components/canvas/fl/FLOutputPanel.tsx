/**
 * FLOutputPanel — mTLS certificate viewer for the FL right sidebar.
 *
 * Displays parsed X.509 certificate metadata for all active FL participants
 * (clients, server, root CA). Data fetched once on mount from the REST API.
 *
 * Data flows: REST /security/certificates → local state.
 */

import { useState, useEffect } from 'react';
import {
  Activity,
  XCircle,
  FileKey2,
  Shield,
  Server,
} from 'lucide-react';
import { flApi } from '@/api/fl';
import type { CertificateMetadata } from '@/api/fl';

// ── Component ──────────────────────────────────────────

export default function FLOutputPanel() {
  return (
    <div className="flex flex-col gap-0 h-full">
      {/* Header bar — mirrors fl-output-tab-bar style, non-interactive */}
      <div className="fl-output-tab-bar">
        <span className="fl-output-tab fl-output-tab--active" style={{ cursor: 'default' }}>
          Certificates
        </span>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <CertificatesTab />
      </div>
    </div>
  );
}

// ── Certificates Tab ───────────────────────────────────

function CertificatesTab() {
  const [certs, setCerts] = useState<CertificateMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    flApi
      .certificates()
      .then(setCerts)
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : 'Failed to load certificates';
        setError(msg);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="fl-empty-state" style={{ padding: '40px 16px' }}>
        <Activity size={20} className="fl-empty-state-icon animate-spin" />
        <p className="fl-empty-state-text">Loading certificates...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="fl-empty-state" style={{ padding: '40px 16px' }}>
        <XCircle size={20} style={{ color: 'var(--n8n-danger)', opacity: 0.5 }} />
        <p className="fl-empty-state-text">{error}</p>
      </div>
    );
  }

  if (certs.length === 0) {
    return (
      <div className="fl-empty-state" style={{ padding: '40px 16px' }}>
        <FileKey2 size={24} className="fl-empty-state-icon" />
        <p className="fl-empty-state-text">
          No certificates found.<br />
          Certificates will be available when mTLS is configured.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" style={{ padding: '10px 10px' }}>
      {certs.map((cert) => (
        <CertificateCard key={cert.clientId} cert={cert} />
      ))}
    </div>
  );
}

// ── Certificate Card ───────────────────────────────────

/** Role badge colors and icons */
const ROLE_META: Record<string, { color: string; bg: string; Icon: typeof FileKey2 }> = {
  'FL Client': { color: 'var(--n8n-accent)',  bg: 'rgba(255,109,90,0.12)',  Icon: FileKey2 },
  'FL Server': { color: '#38bdf8',            bg: 'rgba(56,189,248,0.12)', Icon: Server   },
  'Root CA':   { color: '#f59e0b',            bg: 'rgba(245,158,11,0.12)', Icon: Shield   },
};

function CertificateCard({ cert }: { cert: CertificateMetadata }) {
  const isExpired = new Date(cert.notAfter) < new Date();
  const roleMeta = ROLE_META[cert.role] ?? ROLE_META['FL Client'];
  const RoleIcon = roleMeta.Icon;

  return (
    <div className="fl-cert-card">
      {/* Card header: icon + display name + role badge + valid/expired */}
      <div className="flex items-center gap-2 mb-2">
        <RoleIcon size={14} style={{ color: roleMeta.color, flexShrink: 0 }} />
        <span className="text-xs font-semibold" style={{ color: 'var(--n8n-text-primary)' }}>
          {cert.displayName}
        </span>
        <span
          className="text-[9px] font-semibold px-1.5 py-0.5 rounded"
          style={{ color: roleMeta.color, background: roleMeta.bg, flexShrink: 0 }}
        >
          {cert.role}
        </span>
        <span
          className={`fl-status-badge ${isExpired ? 'fl-status-badge--error' : 'fl-status-badge--on'}`}
          style={{ marginLeft: 'auto' }}
        >
          {isExpired ? 'Expired' : 'Valid'}
        </span>
      </div>

      <div className="fl-cert-grid">
        <CertField
          label="Signed by"
          value={cert.issuer}
          tooltip="The Certificate Authority that verified and issued this identity"
        />
        <CertField label="Valid From"  value={new Date(cert.notBefore).toLocaleDateString()} />
        <CertField
          label="Valid Until"
          value={new Date(cert.notAfter).toLocaleDateString()}
          valueColor={isExpired ? 'var(--n8n-danger)' : undefined}
        />
        <CertField label="Fingerprint" value={cert.fingerprint.substring(0, 24) + '...'} mono />
      </div>

      {/* Technical cert filename — subtle reference line */}
      <div className="mt-2 pt-1.5" style={{ borderTop: '1px solid var(--n8n-card-border)' }}>
        <span className="text-[9px] font-mono" style={{ color: 'var(--n8n-text-muted)', opacity: 0.6 }}>
          {cert.clientId}.crt
        </span>
      </div>
    </div>
  );
}

function CertField({
  label,
  value,
  mono,
  tooltip,
  valueColor,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tooltip?: string;
  valueColor?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span
        className="text-[9px] font-semibold uppercase tracking-wider flex items-center gap-1"
        style={{ color: 'var(--n8n-text-muted)' }}
        title={tooltip}
      >
        {label}
        {tooltip && (
          <span
            className="inline-flex items-center justify-center w-3 h-3 rounded-full text-[8px] font-bold cursor-help"
            style={{ background: 'var(--n8n-card-border)', color: 'var(--n8n-text-muted)' }}
          >
            ?
          </span>
        )}
      </span>
      <span
        className={`text-[11px] ${mono ? 'font-mono' : ''}`}
        style={{ color: valueColor ?? 'var(--n8n-text-primary)', wordBreak: 'break-all' }}
      >
        {value}
      </span>
    </div>
  );
}
