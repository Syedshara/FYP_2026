import { NavLink, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LayoutDashboard, Monitor, Activity, Brain, Shield, Settings,
  Workflow, Wifi, Menu, X, Server,
} from 'lucide-react';
import { useThemeStore } from '@/stores/themeStore';

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/devices', icon: Monitor, label: 'Devices' },
  { to: '/clients', icon: Server, label: 'Clients' },
  { to: '/traffic', icon: Activity, label: 'Traffic Monitor' },
  { to: '/attack-pipeline', icon: Workflow, label: 'Attack Pipeline' },
  { to: '/fl-training', icon: Brain, label: 'FL Training' },
  { to: '/prevention', icon: Shield, label: 'Prevention' },
];

const bottomItems = [
  { to: '/settings', icon: Settings, label: 'Settings' },
];

interface Props {
  collapsed: boolean;
  onToggle: () => void;
}

export default function Sidebar({ collapsed, onToggle }: Props) {
  const location = useLocation();
  const { theme } = useThemeStore();
  const isDark = theme === 'dark';

  const isActive = (to: string) =>
    to === '/' ? location.pathname === '/' : location.pathname.startsWith(to);

  const renderLink = (item: (typeof navItems)[0]) => {
    const active = isActive(item.to);
    return (
      <NavLink
        key={item.to}
        to={item.to}
        className="group relative flex items-center gap-3 rounded-lg transition-all duration-150 no-underline"
        style={{
          padding: collapsed ? '10px 0' : '10px 14px',
          justifyContent: collapsed ? 'center' : 'flex-start',
          background: active ? 'var(--accent-light)' : 'transparent',
          color: active ? 'var(--accent)' : 'var(--text-muted)',
        }}
        onMouseEnter={(e) => {
          if (!active) e.currentTarget.style.background = 'var(--accent-light)';
        }}
        onMouseLeave={(e) => {
          if (!active) e.currentTarget.style.background = active ? 'var(--accent-light)' : 'transparent';
        }}
      >
        {/* Active indicator bar */}
        {active && (
          <motion.div
            layoutId="nav-indicator"
            className="absolute left-0 top-1/2 -translate-y-1/2 rounded-r-full"
            style={{ width: 3, height: 24, background: 'var(--accent)' }}
            transition={{ type: 'spring', stiffness: 500, damping: 35 }}
          />
        )}

        <item.icon style={{ width: 18, height: 18, flexShrink: 0 }} />

        <AnimatePresence>
          {!collapsed && (
            <motion.span
              initial={{ opacity: 0, width: 0 }}
              animate={{ opacity: 1, width: 'auto' }}
              exit={{ opacity: 0, width: 0 }}
              style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden' }}
            >
              {item.label}
            </motion.span>
          )}
        </AnimatePresence>

        {/* Tooltip for collapsed */}
        {collapsed && (
          <div
            className="pointer-events-none absolute left-full ml-3 px-3 py-1.5 rounded-md text-xs font-medium
                        whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-50"
            style={{
              background: 'var(--bg-card)',
              color: 'var(--text-primary)',
              boxShadow: 'var(--shadow-lg)',
              border: '1px solid var(--border)',
            }}
          >
            {item.label}
          </div>
        )}
      </NavLink>
    );
  };

  return (
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? 72 : 256 }}
      transition={{ duration: 0.2, ease: 'easeInOut' }}
      className="fixed left-0 top-0 h-screen z-40 flex flex-col"
      style={{
        background: 'var(--bg-sidebar)',
        borderRight: '1px solid var(--border)',
        boxShadow: isDark ? 'none' : '2px 0 8px rgba(0,0,0,0.04)',
      }}
    >
      {/* Logo + Hamburger */}
      <div
        className="flex items-center shrink-0"
        style={{
          height: 60, borderBottom: '1px solid var(--border)',
          padding: collapsed ? '0 16px' : '0 20px',
          justifyContent: collapsed ? 'center' : 'space-between',
          gap: 12,
        }}
      >
        <div className="flex items-center gap-3 overflow-hidden" style={{ minWidth: 0 }}>
          <div
            className="flex items-center justify-center shrink-0"
            style={{ width: 34, height: 34, borderRadius: 10, background: 'var(--accent)' }}
          >
            <Shield style={{ width: 17, height: 17, color: '#fff' }} />
          </div>
          <AnimatePresence>
            {!collapsed && (
              <motion.div
                initial={{ opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: 'auto' }}
                exit={{ opacity: 0, width: 0 }}
                style={{ overflow: 'hidden', whiteSpace: 'nowrap' }}
              >
                <p style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)', lineHeight: 1.2 }}>IoT IDS</p>
                <p style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.2 }}>Intrusion Detection</p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Hamburger toggle */}
        <button
          onClick={onToggle}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 30, height: 30, borderRadius: 6, border: 'none', cursor: 'pointer',
            background: 'transparent', color: 'var(--text-muted)', flexShrink: 0,
            transition: 'background .15s, color .15s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent-light)'; e.currentTarget.style.color = 'var(--accent)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <Menu style={{ width: 18, height: 18 }} /> : <X style={{ width: 18, height: 18 }} />}
        </button>
      </div>

      {/* Main Nav */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden" style={{ padding: '16px 12px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {!collapsed && (
          <p style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', padding: '0 14px', marginBottom: 8 }}>
            Menu
          </p>
        )}
        {navItems.map(renderLink)}

        {/* Divider */}
        <div style={{ height: 1, background: 'var(--border)', margin: '12px 0' }} />

        {bottomItems.map(renderLink)}
      </nav>

      {/* Connection Status */}
      <div
        className="flex items-center justify-center shrink-0"
        style={{ padding: collapsed ? '12px 0' : '12px 20px', borderTop: '1px solid var(--border)' }}
      >
        <div className="flex items-center gap-2" style={{ fontSize: 11, color: 'var(--success)' }}>
          <Wifi style={{ width: 12, height: 12 }} />
          <AnimatePresence>
            {!collapsed && (
              <motion.span
                initial={{ opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: 'auto' }}
                exit={{ opacity: 0, width: 0 }}
                style={{ whiteSpace: 'nowrap', overflow: 'hidden' }}
              >
                Connected
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.aside>
  );
}
