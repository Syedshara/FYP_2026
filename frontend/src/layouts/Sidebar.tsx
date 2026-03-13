import { useLocation, NavLink } from 'react-router-dom';

/* ---- SVG icons (inline, no external dependency) ---- */
const IconDevices = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </svg>
);

const IconClients = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="9" cy="7" r="4" />
    <path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    <path d="M21 21v-2a4 4 0 0 0-3-3.87" />
  </svg>
);

const IconFL = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="5" r="2" />
    <circle cx="5" cy="19" r="2" />
    <circle cx="19" cy="19" r="2" />
    <path d="M12 7v4M8.5 16.5 12 11M15.5 16.5 12 11" />
  </svg>
);

const IconTraffic = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
  </svg>
);

const IconSecurity = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
);

const IconPipeline = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="4" cy="12" r="2" />
    <circle cx="12" cy="5" r="2" />
    <circle cx="12" cy="19" r="2" />
    <line x1="6" y1="11" x2="10" y2="6" />
    <line x1="6" y1="13" x2="10" y2="18" />
  </svg>
);

/* ---- Nav item config (keep routes identical to original) ---- */
interface NavItem {
  to: string;
  label: string;
  Icon: React.FC;
}

const navItems: NavItem[] = [
  { to: '/devices',     label: 'Devices',         Icon: IconDevices },
  { to: '/clients',     label: 'Clients',          Icon: IconClients },
  { to: '/traffic',     label: 'Traffic Monitor',  Icon: IconTraffic },
  { to: '/fl-training', label: 'FL Training',      Icon: IconFL },
  { to: '/pipeline',    label: 'Pipeline Builder',  Icon: IconPipeline },
  { to: '/security',    label: 'Security',          Icon: IconSecurity },
];

/* ---- Logo mark ---- */
const LogoMark = () => (
  <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
    <rect width="32" height="32" rx="8" fill="var(--n8n-accent)" />
    <path d="M8 24 L16 8 L24 24" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    <circle cx="16" cy="8" r="2.5" fill="#fff" />
  </svg>
);

export default function Sidebar() {
  const location = useLocation();

  const isActive = (to: string) =>
    to === '/' ? location.pathname === '/' : location.pathname.startsWith(to);

  return (
    <aside
      style={{
        position: 'fixed',
        left: 0,
        top: 0,
        height: '100vh',
        width: 'var(--n8n-sidebar-collapsed)',
        background: 'var(--n8n-sidebar-bg)',
        borderRight: '1px solid var(--n8n-card-border)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 40,
        overflow: 'hidden',
        transition: 'width 0.2s ease',
        flexShrink: 0,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.width = 'var(--n8n-sidebar-expanded)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.width = 'var(--n8n-sidebar-collapsed)';
      }}
    >
      {/* Logo header */}
      <div
        style={{
          height: 'var(--n8n-topbar-height)',
          display: 'flex',
          alignItems: 'center',
          padding: '0 18px',
          borderBottom: '1px solid var(--n8n-card-border)',
          gap: 12,
          flexShrink: 0,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
        }}
      >
        <div style={{ flexShrink: 0 }}>
          <LogoMark />
        </div>
        <span
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: 'var(--n8n-text-primary)',
            letterSpacing: '0.03em',
            opacity: 0,
            transition: 'opacity 0.15s ease 0.05s',
          }}
          className="sidebar-label"
        >
          IoT IDS
        </span>
      </div>

      {/* Navigation */}
      <nav
        style={{
          flex: 1,
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: '12px 8px',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        {navItems.map(({ to, label, Icon }) => {
          const active = isActive(to);
          return (
            <NavLink
              key={to}
              to={to}
              title={label}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '9px 10px',
                borderRadius: 8,
                textDecoration: 'none',
                color: active ? 'var(--n8n-text-primary)' : 'var(--n8n-text-muted)',
                background: active ? 'var(--n8n-accent-light)' : 'transparent',
                borderLeft: active ? '2px solid var(--n8n-accent)' : '2px solid transparent',
                fontWeight: active ? 600 : 400,
                fontSize: 13,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                transition: 'background 0.12s, color 0.12s',
                flexShrink: 0,
              }}
              onMouseEnter={(e) => {
                if (!active) {
                  e.currentTarget.style.background = 'rgba(255,109,90,0.06)';
                  e.currentTarget.style.color = 'var(--n8n-text-primary)';
                }
              }}
              onMouseLeave={(e) => {
                if (!active) {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.color = 'var(--n8n-text-muted)';
                }
              }}
            >
              <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
                <Icon />
              </span>
              <span
                className="sidebar-label"
                style={{
                  opacity: 0,
                  transition: 'opacity 0.15s ease 0.05s',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {label}
              </span>
            </NavLink>
          );
        })}
      </nav>

      {/* Bottom separator line */}
      <div
        style={{
          height: 1,
          background: 'var(--n8n-card-border)',
          margin: '0 8px 12px',
          flexShrink: 0,
        }}
      />

      {/* Inline styles for hover label reveal */}
      <style>{`
        aside:hover .sidebar-label {
          opacity: 1 !important;
        }
      `}</style>
    </aside>
  );
}
