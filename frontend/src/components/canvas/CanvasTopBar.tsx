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
      className="flex items-center justify-between px-5 h-[52px] border-b select-none shrink-0"
      style={{
        background: 'var(--n8n-topbar-bg)',
        borderColor: 'var(--n8n-card-border)',
      }}
    >
      {/* Left: Logo + Name + Save indicator */}
      <div className="flex items-center gap-5">
        <div className="flex items-center gap-2">
          <Shield size={20} style={{ color: 'var(--n8n-accent)' }} />
          <span
            className="text-sm font-semibold tracking-tight"
            style={{ color: 'var(--n8n-text-primary)' }}
          >
            {workspaceName}
          </span>
        </div>

        <div className="w-px h-5" style={{ background: 'var(--n8n-card-border)' }} />

        {/* Save button / indicator */}
        <button
          type="button"
          onClick={() => saveWorkspace()}
          disabled={isSaving || !isDirty}
          title={isSaving ? 'Saving...' : isDirty ? 'Save (Ctrl+S)' : 'All changes saved'}
          className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors"
          style={{
            background: isDirty && !isSaving ? 'var(--n8n-accent-light)' : 'transparent',
            color: isDirty && !isSaving
              ? 'var(--n8n-accent)'
              : isSaving
                ? 'var(--n8n-text-muted)'
                : 'var(--n8n-success)',
            cursor: isDirty && !isSaving ? 'pointer' : 'default',
            opacity: !isDirty && !isSaving ? 0.7 : 1,
          }}
        >
          {isSaving ? (
            <Loader2 size={14} className="animate-spin" />
          ) : isDirty ? (
            <Save size={14} />
          ) : (
            <Check size={14} />
          )}
          <span>{isSaving ? 'Saving' : isDirty ? 'Save' : 'Saved'}</span>
        </button>
      </div>

      {/* Center: Zoom Controls */}
      <div className="flex items-center gap-1">
        <ToolbarButton icon={ZoomOut} tooltip="Zoom out" onClick={() => zoomOut()} />
        <ToolbarButton icon={ZoomIn} tooltip="Zoom in" onClick={() => zoomIn()} />
        <div className="w-px h-5 mx-1" style={{ background: 'var(--n8n-card-border)' }} />
        <ToolbarButton icon={Maximize2} tooltip="Fit view" onClick={handleFitView} />
        <ToolbarButton
          icon={Map}
          tooltip="Toggle minimap"
          active={minimapVisible}
          onClick={() => setMinimapVisible(!minimapVisible)}
        />
      </div>

      {/* Right: Theme toggle + User Menu */}
      <div className="flex items-center gap-5">
        <ToolbarButton
          icon={theme === 'dark' ? Sun : Moon}
          tooltip={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          onClick={toggleTheme}
        />

        <div className="w-px h-5" style={{ background: 'var(--n8n-card-border)' }} />

        <div className="flex items-center gap-2">
          <User size={16} style={{ color: 'var(--n8n-text-muted)' }} />
          <span className="text-xs" style={{ color: 'var(--n8n-text-muted)' }}>
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
