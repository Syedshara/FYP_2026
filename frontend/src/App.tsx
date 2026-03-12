import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ProtectedRoute from '@/components/ProtectedRoute';
import LoginPage from '@/pages/LoginPage';
import RegisterPage from '@/pages/RegisterPage';
import WorkspacePage from '@/pages/WorkspacePage';
import { WebSocketProvider } from '@/components/WebSocketProvider';
import { useAuthStore } from '@/stores/authStore';

// Legacy pages — kept for reference, no longer routed
// import MainLayout from '@/layouts/MainLayout';
// import DashboardPage from '@/pages/DashboardPage';
// import DevicesPage from '@/pages/DevicesPage';
// import TrafficMonitorPage from '@/pages/TrafficMonitorPage';
// import FLTrainingPage from '@/pages/FLTrainingPage';
// import AttackPipelinePage from '@/pages/AttackPipelinePage';
// import PreventionPage from '@/pages/PreventionPage';
// import ClientsPage from '@/pages/ClientsPage';
// import SettingsPage from '@/pages/SettingsPage';
// import PipelineBuilderPage from '@/pages/PipelineBuilderPage';
// import SecurityMonitorPage from '@/pages/SecurityMonitorPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 60_000,       // data is "fresh" for 60s — no refetch on navigation
      gcTime: 5 * 60_000,      // keep unused cache for 5 min (prevents flash on back-nav)
    },
  },
});

export default function App() {
  const restoreSession = useAuthStore((s) => s.restoreSession);

  // On app boot, restore session from persisted token
  useEffect(() => {
    restoreSession();
  }, [restoreSession]);

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          {/* Public */}
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />

          {/* Workspace — full-screen canvas, the primary app view */}
          <Route
            path="/workspace"
            element={
              <ProtectedRoute>
                <WebSocketProvider>
                  <WorkspacePage />
                </WebSocketProvider>
              </ProtectedRoute>
            }
          />

          {/* Default: authenticated users go to workspace */}
          <Route
            index
            element={
              <ProtectedRoute>
                <Navigate to="/workspace" replace />
              </ProtectedRoute>
            }
          />

          {/* Fallback */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
