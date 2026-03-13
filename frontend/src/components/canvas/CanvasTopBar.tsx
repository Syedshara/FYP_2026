/**
 * CanvasTopBar — Top toolbar for the workspace canvas.
 *
 * Logo, workspace name, zoom controls, fit view, minimap toggle,
 * theme toggle, user menu.
 *
 * All hover states are CSS-only via .toolbar-btn class (index.css).
 */

import { useCallback } from 'react';
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  Map,
  LogOut,
  User,
  Shield,
  Save,
  Loader2,
  Check,
  Sun,
  Moon,
} from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useThemeStore } from '@/stores/themeStore';

export default function CanvasTopBar() {
  const zoomIn = useWorkspaceStore((s) => s.zoomIn);
  const zoomOut = useWorkspaceStore((s) => s.zoomOut);
  const fitView = useWorkspaceStore((s) => s.fitView);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const minimapVisible = useWorkspaceStore((s) => s.minimapVisible);
  const setMinimapVisible = useWorkspaceStore((s) => s.setMinimapVisible);
  const workspaceName = useWorkspaceStore((s) => s.workspaceName);
  const isDirty = useWorkspaceStore((s) => s.isDirty);
  const isSaving = useWorkspaceStore((s) => s.isSaving);
  const saveWorkspace = useWorkspaceStore((s) => s.saveWorkspace);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggle);

  const handleFitView = useCallback(() => {
    fitView();
  }, [fitView]);

  return (
    <header
      className="flex items-center justify-between px-4 h-[52px] shrink-0 select-none"
      style={{
        background: 'var(--n8n-topbar-bg)',
        borderBottom: '1px solid var(--n8n-card-border)',
        boxShadow: '0 1px 8px rgba(0,0,0,0.25)',
      }}
    >
      {/* Left: Logo + Workspace Name + Save indicator */}
      <div className="flex items-center gap-3 min-w-0">
        {/* Brand mark */}
        <div
          className="flex items-center justify-center w-7 h-7 rounded-lg flex-shrink-0"
          style={{ background: 'var(--n8n-accent-light)', border: '1px solid rgba(255,109,90,0.25)' }}
        >
          <Shield size={14} style={{ color: 'var(--n8n-accent)' }} />
        </div>

        {/* Workspace name */}
        <span
          className="text-sm font-semibold tracking-tight truncate max-w-[180px]"
          style={{ color: 'var(--n8n-text-primary)' }}
        >
          {workspaceName}
        </span>

        {/* Vertical divider */}
        <div className="w-px h-4 flex-shrink-0" style={{ background: 'var(--n8n-card-border)' }} />

        {/* Save button / indicator */}
        <button
          type="button"
          onClick={() => saveWorkspace()}
          disabled={isSaving || !isDirty}
          title={isSaving ? 'Saving...' : isDirty ? 'Save (Ctrl+S)' : 'All changes saved'}
          className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium transition-colors flex-shrink-0"
          style={{
            background: isDirty && !isSaving ? 'var(--n8n-accent-light)' : 'transparent',
            color: isDirty && !isSaving
              ? 'var(--n8n-accent)'
              : isSaving
                ? 'var(--n8n-text-muted)'
                : 'var(--n8n-success)',
            cursor: isDirty && !isSaving ? 'pointer' : 'default',
            opacity: !isDirty && !isSaving ? 0.65 : 1,
          }}
        >
          {isSaving ? (
            <Loader2 size={13} className="animate-spin" />
          ) : isDirty ? (
            <Save size={13} />
          ) : (
            <Check size={13} />
          )}
          <span>{isSaving ? 'Saving…' : isDirty ? 'Save' : 'Saved'}</span>
        </button>
      </div>

      {/* Center: Zoom Controls */}
      <div className="flex items-center gap-0.5">
        <ToolbarButton icon={ZoomOut} tooltip="Zoom out" onClick={() => zoomOut()} />
        <ToolbarButton icon={ZoomIn} tooltip="Zoom in" onClick={() => zoomIn()} />
        <div className="w-px h-4 mx-1.5 flex-shrink-0" style={{ background: 'var(--n8n-card-border)' }} />
        <ToolbarButton icon={Maximize2} tooltip="Fit view" onClick={handleFitView} />
        <ToolbarButton
          icon={Map}
          tooltip="Toggle minimap"
          active={minimapVisible}
          onClick={() => setMinimapVisible(!minimapVisible)}
        />
      </div>

      {/* Right: Theme toggle + User + Logout */}
      <div className="flex items-center gap-1.5">
        <ToolbarButton
          icon={theme === 'dark' ? Sun : Moon}
          tooltip={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          onClick={toggleTheme}
        />

        <div className="w-px h-4 mx-1.5 flex-shrink-0" style={{ background: 'var(--n8n-card-border)' }} />

        {/* User pill badge */}
        <div
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg flex-shrink-0"
          style={{
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid var(--n8n-card-border)',
          }}
        >
          <User size={13} style={{ color: 'var(--n8n-text-muted)' }} />
          <span className="text-[12px] font-medium" style={{ color: 'var(--n8n-text-primary)' }}>
            {user?.username ?? 'Unknown'}
          </span>
        </div>

        <ToolbarButton icon={LogOut} tooltip="Logout" onClick={logout} />
      </div>
    </header>
  );
}

// ── Toolbar Button (CSS-only hover via .toolbar-btn class) ──

function ToolbarButton({
  icon: Icon,
  tooltip,
  onClick,
  active,
}: {
  icon: React.ComponentType<{ size?: number }>;
  tooltip: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={tooltip}
      className="toolbar-btn"
      data-active={active ? 'true' : undefined}
    >
      <Icon size={16} />
    </button>
  );
}
