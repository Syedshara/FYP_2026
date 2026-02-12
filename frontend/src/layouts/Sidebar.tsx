import { NavLink, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Menu, X } from 'lucide-react';

const navItems = [
  // { to: '/', label: 'Dashboard' },
  { to: '/devices', label: 'Devices' },
  { to: '/clients', label: 'Clients' },
  { to: '/traffic', label: 'Traffic Monitor' },
  // { to: '/attack-pipeline', label: 'Attack Pipeline' },
  { to: '/fl-training', label: 'FL Training' },
  { to: '/simulation', label: 'Simulation' },
  // { to: '/prevention', label: 'Prevention' },
];

const bottomItems: { to: string; label: string }[] = [
  // { to: '/settings', label: 'Settings' },
];

interface Props {
  collapsed: boolean;
  onToggle: () => void;
}

export default function Sidebar({ collapsed, onToggle }: Props) {
  const location = useLocation();

  const isActive = (to: string) =>
    to === '/' ? location.pathname === '/' : location.pathname.startsWith(to);

  const renderLink = (item: (typeof navItems)[0]) => {
    const active = isActive(item.to);
    return (
      <NavLink
        key={item.to}
        to={item.to}
        className="group relative flex items-center gap-3 no-underline"
        style={{
          padding: collapsed ? '8px 0' : '8px 14px',
          justifyContent: collapsed ? 'center' : 'flex-start',
          background: active ? 'var(--accent-light)' : 'transparent',
          color: active ? 'var(--text-primary)' : 'var(--text-muted)',
          fontWeight: active ? 600 : 400,
          fontSize: 13,
          borderRadius: 2,
          transition: 'background 0.1s',
        }}
        onMouseEnter={(e) => {
          if (!active) e.currentTarget.style.background = 'var(--accent-light)';
        }}
        onMouseLeave={(e) => {
          if (!active) e.currentTarget.style.background = 'transparent';
        }}
      >
        {/* Active indicator bar */}
        {active && (
          <motion.div
            layoutId="nav-indicator"
            className="absolute left-0 top-1/2 -translate-y-1/2"
            style={{ width: 2, height: 20, background: 'var(--accent)' }}
            transition={{ type: 'spring', stiffness: 500, damping: 35 }}
          />
        )}

        {/* Terminal-style prefix */}
        <span style={{ color: active ? 'var(--text-primary)' : 'var(--text-muted)', fontSize: 12 }}>
          {collapsed ? '>' : active ? '>' : ' '}
        </span>

        <AnimatePresence>
          {!collapsed && (
            <motion.span
              initial={{ opacity: 0, width: 0 }}
              animate={{ opacity: 1, width: 'auto' }}
              exit={{ opacity: 0, width: 0 }}
              style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden' }}
            >
              {item.label}
            </motion.span>
          )}
        </AnimatePresence>

        {/* Tooltip for collapsed */}
        {collapsed && (
          <div
            className="pointer-events-none absolute left-full ml-3 px-3 py-1.5 text-xs
                        whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-50"
            style={{
              background: 'var(--bg-card)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border)',
              borderRadius: 2,
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
      }}
    >
      {/* Logo + Hamburger */}
      <div
        className="flex items-center shrink-0"
        style={{
          height: 48, borderBottom: '1px solid var(--border)',
          padding: collapsed ? '0 16px' : '0 20px',
          justifyContent: collapsed ? 'center' : 'space-between',
          gap: 12,
        }}
      >
        <div className="flex items-center gap-2 overflow-hidden" style={{ minWidth: 0 }}>
          <AnimatePresence>
            {!collapsed && (
              <motion.div
                initial={{ opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: 'auto' }}
                exit={{ opacity: 0, width: 0 }}
                style={{ overflow: 'hidden', whiteSpace: 'nowrap' }}
              >
                <p style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)', lineHeight: 1.2 }}>IoT IDS</p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Hamburger toggle */}
        <button
          onClick={onToggle}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, borderRadius: 2, border: 'none', cursor: 'pointer',
            background: 'transparent', color: 'var(--text-muted)', flexShrink: 0,
            transition: 'background .15s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent-light)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <Menu style={{ width: 16, height: 16 }} /> : <X style={{ width: 16, height: 16 }} />}
        </button>
      </div>

      {/* Main Nav */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden" style={{ padding: '12px 8px', display: 'flex', flexDirection: 'column', gap: 1 }}>
        {navItems.map(renderLink)}

        {/* Divider */}
        <div style={{ height: 1, background: 'var(--border)', margin: '8px 0' }} />

        {bottomItems.map(renderLink)}
      </nav>
    </motion.aside>
  );
}
