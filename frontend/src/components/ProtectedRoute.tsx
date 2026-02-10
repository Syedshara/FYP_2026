import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { Loader2 } from 'lucide-react';

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const token = useAuthStore((s) => s.token);
  const isHydrating = useAuthStore((s) => s.isHydrating);
  const location = useLocation();

  // While restoring session from localStorage, show spinner
  if (isHydrating) {
    return (
      <div className="flex items-center justify-center h-screen" style={{ background: 'var(--bg-main)' }}>
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin" style={{ color: 'var(--accent)' }} />
          <span style={{ color: 'var(--text-secondary)' }}>Restoring session…</span>
        </div>
      </div>
    );
  }

  if (!isAuthenticated || !token) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}
