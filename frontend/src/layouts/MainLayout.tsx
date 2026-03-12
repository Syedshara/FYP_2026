import { useState, useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Topbar from './Topbar';
import { useLiveStore } from '@/stores/liveStore';

export default function MainLayout() {
  const wsConnected = useLiveStore((s) => s.wsConnected);
  const [bannerReady, setBannerReady] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setBannerReady(true), 3000);
    return () => clearTimeout(t);
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        minHeight: '100vh',
        background: 'var(--n8n-canvas-bg)',
      }}
    >
      {/* Sidebar: fixed, CSS hover-expand — no JS width tracking needed */}
      <Sidebar />

      {/* Main area: offset by the collapsed sidebar width */}
      <div
        style={{
          flex: 1,
          marginLeft: 'var(--n8n-sidebar-collapsed)',
          display: 'flex',
          flexDirection: 'column',
          minHeight: '100vh',
          minWidth: 0,
        }}
      >
        <Topbar />

        {/* WS reconnect banner */}
        {!wsConnected && bannerReady && (
          <div
            style={{
              background: 'rgba(240,160,32,0.10)',
              borderBottom: '1px solid rgba(240,160,32,0.30)',
              padding: '6px 24px',
              fontSize: 12,
              color: 'var(--n8n-warning)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span>&#9888;</span>
            <span>Live updates unavailable — reconnecting&hellip; polling every 3s</span>
          </div>
        )}

        <main
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '24px',
          }}
        >
          <div
            className="animate-fade-in"
            style={{ maxWidth: 1600, margin: '0 auto' }}
          >
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
