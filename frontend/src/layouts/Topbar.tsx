import { LogOut } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useLocation, useNavigate } from 'react-router-dom';

const pageTitles: Record<string, [string, string]> = {
  '/':                ['Dashboard',       '~/dashboard'],
  '/devices':         ['Device Management','~/devices'],
  '/traffic':         ['Traffic Monitor',  '~/traffic'],
  '/attack-pipeline': ['Attack Pipeline',  '~/attack-pipeline'],
  '/fl-training':     ['FL Training',      '~/fl-training'],
  '/prevention':      ['Prevention',       '~/prevention'],
  '/settings':        ['Settings',         '~/settings'],
};

export default function Topbar() {
  const { user, logout } = useAuthStore();
  const location = useLocation();
  const navigate = useNavigate();

  const [title, breadcrumb] = pageTitles[location.pathname] ?? ['Dashboard', '~/'];

  const handleLogout = () => { logout(); navigate('/login'); };

  return (
    <header
      className="flex items-center justify-between sticky top-0 z-30"
      style={{
        height: 'var(--topbar-height)',
        padding: '0 24px',
        background: 'var(--bg-card)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      {/* Left: Title + Breadcrumb */}
      <div>
        <h1 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.3 }}>
          {title}
        </h1>
        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>{breadcrumb}</p>
      </div>

      {/* Right: User + Logout */}
      <div className="flex items-center gap-1">
        {/* User — clickable, navigates to settings/profile */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/settings')}
            className="flex items-center gap-2"
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px 8px', borderRadius: 2, transition: 'background .15s' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-secondary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            title="Open profile settings"
          >
            <div className="hidden sm:block" style={{ textAlign: 'left' }}>
              <p style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)', lineHeight: 1.3 }}>
                {user?.username ?? 'admin'}
              </p>
              <p style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'capitalize' }}>
                {user?.role ?? 'admin'}
              </p>
            </div>
          </button>

          <div style={{ width: 1, height: 24, background: 'var(--border)' }} />

          <button onClick={handleLogout} className="btn-ghost" title="Logout"
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--danger)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-secondary)'; }}
          >
            <LogOut style={{ width: 14, height: 14 }} />
          </button>
        </div>
      </div>
    </header>
  );
}
