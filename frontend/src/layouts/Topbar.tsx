import { useAuthStore } from '@/stores/authStore';
import { useLocation, useNavigate } from 'react-router-dom';

const pageTitles: Record<string, [string, string]> = {
  '/':                ['Dashboard',        'iot-ids / dashboard'],
  '/devices':         ['Device Management', 'iot-ids / devices'],
  '/clients':         ['Clients',           'iot-ids / clients'],
  '/traffic':         ['Traffic Monitor',   'iot-ids / traffic'],
  '/attack-pipeline': ['Attack Pipeline',   'iot-ids / attack-pipeline'],
  '/fl-training':     ['FL Training',       'iot-ids / fl-training'],
  '/simulation':      ['Simulation',        'iot-ids / simulation'],
  '/security':        ['Security Monitor',  'iot-ids / security'],
  '/prevention':      ['Prevention',        'iot-ids / prevention'],
  '/settings':        ['Settings',          'iot-ids / settings'],
};

/* Inline SVG icons — no lucide dependency */
const IconUser = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="8" r="4" />
    <path d="M4 20v-1a8 8 0 0 1 16 0v1" />
  </svg>
);

const IconLogout = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <polyline points="16 17 21 12 16 7" />
    <line x1="21" y1="12" x2="9" y2="12" />
  </svg>
);

const IconWsOk = () => (
  <svg width="8" height="8" viewBox="0 0 8 8">
    <circle cx="4" cy="4" r="4" fill="var(--n8n-success)" />
  </svg>
);

export default function Topbar() {
  const { user, logout } = useAuthStore();
  const location = useLocation();
  const navigate = useNavigate();

  const [title, breadcrumb] = pageTitles[location.pathname] ?? ['Dashboard', 'iot-ids /'];

  const handleLogout = () => { logout(); navigate('/login'); };

  return (
    <header
      style={{
        height: 'var(--n8n-topbar-height)',
        background: 'var(--n8n-topbar-bg)',
        borderBottom: '1px solid var(--n8n-card-border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 24px',
        position: 'sticky',
        top: 0,
        zIndex: 30,
        flexShrink: 0,
      }}
    >
      {/* Left: breadcrumb */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: 'var(--n8n-text-primary)',
            lineHeight: 1.2,
          }}
        >
          {title}
        </span>
        <span
          style={{
            fontSize: 11,
            color: 'var(--n8n-text-muted)',
            fontFamily: 'inherit',
          }}
        >
          {breadcrumb}
        </span>
      </div>

      {/* Right: status + user + logout */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        {/* System status pill */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 10px',
            borderRadius: 6,
            background: 'rgba(24,160,88,0.10)',
            border: '1px solid rgba(24,160,88,0.25)',
          }}
        >
          <IconWsOk />
          <span style={{ fontSize: 11, color: 'var(--n8n-success)', fontWeight: 500 }}>
            system online
          </span>
        </div>

        {/* Separator */}
        <div style={{ width: 1, height: 24, background: 'var(--n8n-card-border)' }} />

        {/* User info */}
        <button
          onClick={() => navigate('/settings')}
          title="Profile settings"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '4px 8px',
            borderRadius: 6,
            color: 'var(--n8n-text-muted)',
            transition: 'background 0.12s, color 0.12s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
            e.currentTarget.style.color = 'var(--n8n-text-primary)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'none';
            e.currentTarget.style.color = 'var(--n8n-text-muted)';
          }}
        >
          <IconUser />
          <span style={{ fontSize: 12, fontWeight: 500 }}>
            {user?.username ?? 'admin'}
          </span>
          <span
            style={{
              fontSize: 10,
              color: 'var(--n8n-text-muted)',
              textTransform: 'capitalize',
            }}
          >
            {user?.role ?? 'admin'}
          </span>
        </button>

        {/* Logout */}
        <button
          onClick={handleLogout}
          title="Logout"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 30,
            height: 30,
            borderRadius: 6,
            border: 'none',
            background: 'none',
            cursor: 'pointer',
            color: 'var(--n8n-text-muted)',
            transition: 'background 0.12s, color 0.12s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--n8n-danger-light)';
            e.currentTarget.style.color = 'var(--n8n-danger)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'none';
            e.currentTarget.style.color = 'var(--n8n-text-muted)';
          }}
        >
          <IconLogout />
        </button>
      </div>
    </header>
  );
}
