import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MainLayout from '@/layouts/MainLayout';
import ProtectedRoute from '@/components/ProtectedRoute';
import LoginPage from '@/pages/LoginPage';
// import DashboardPage from '@/pages/DashboardPage';
import DevicesPage from '@/pages/DevicesPage';
import TrafficMonitorPage from '@/pages/TrafficMonitorPage';
import FLTrainingPage from '@/pages/FLTrainingPage';
// import AttackPipelinePage from '@/pages/AttackPipelinePage';
// import PreventionPage from '@/pages/PreventionPage';
import ClientsPage from '@/pages/ClientsPage';
// import SettingsPage from '@/pages/SettingsPage';
import RegisterPage from '@/pages/RegisterPage';
import SimulationControlPage from '@/pages/SimulationControlPage';
import { WebSocketProvider } from '@/components/WebSocketProvider';
import { useAuthStore } from '@/stores/authStore';

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

          {/* Protected */}
          <Route
            element={
              <ProtectedRoute>
                <WebSocketProvider>
                  <MainLayout />
                </WebSocketProvider>
              </ProtectedRoute>
            }
          >
            {/* <Route index element={<DashboardPage />} /> */}
            <Route index element={<Navigate to="/fl-training" replace />} />
            <Route path="devices" element={<DevicesPage />} />
            <Route path="traffic" element={<TrafficMonitorPage />} />
            {/* <Route path="attack-pipeline" element={<AttackPipelinePage />} /> */}
            <Route path="clients" element={<ClientsPage />} />
            <Route path="fl-training" element={<FLTrainingPage />} />
            <Route path="simulation" element={<SimulationControlPage />} />
            {/* <Route path="prevention" element={<PreventionPage />} /> */}
            {/* <Route path="settings" element={<SettingsPage />} /> */}
          </Route>

          {/* Fallback */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
