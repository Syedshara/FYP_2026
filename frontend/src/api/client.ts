import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { useAuthStore } from '@/stores/authStore';

// In dev, Vite proxy forwards /api → http://localhost:8000 (no CORS needed).
// In production, set VITE_API_URL to the backend origin.
const API_BASE_URL = import.meta.env.VITE_API_URL || '';

const api = axios.create({
  baseURL: `${API_BASE_URL}/api/v1`,
  headers: { 'Content-Type': 'application/json' },
});

// ── Request interceptor: attach Bearer token ──────────
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ── Response interceptor: auto-refresh on 401 ────────
let isRefreshing = false;
let failedQueue: Array<{
  resolve: (token: string) => void;
  reject: (err: unknown) => void;
}> = [];

function processQueue(error: unknown, token: string | null) {
  failedQueue.forEach((prom) => {
    if (token) prom.resolve(token);
    else prom.reject(error);
  });
  failedQueue = [];
}

api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };

    // Only handle 401 (unauthorized)
    if (error.response?.status !== 401 || !originalRequest) {
      return Promise.reject(error);
    }

    // Don't retry auth endpoints themselves (prevents infinite loops)
    const url = originalRequest.url || '';
    if (url.includes('/auth/login') || url.includes('/auth/refresh')) {
      useAuthStore.getState().logout();
      return Promise.reject(error);
    }

    // Already retried this request — give up
    if (originalRequest._retry) {
      useAuthStore.getState().logout();
      return Promise.reject(error);
    }

    originalRequest._retry = true;

    // If another request is already refreshing, queue this one
    if (isRefreshing) {
      return new Promise<string>((resolve, reject) => {
        failedQueue.push({ resolve, reject });
      }).then((newToken) => {
        originalRequest.headers.Authorization = `Bearer ${newToken}`;
        return api(originalRequest);
      });
    }

    isRefreshing = true;

    try {
      const newToken = await useAuthStore.getState().refreshAccessToken();
      if (!newToken) {
        processQueue(error, null);
        return Promise.reject(error);
      }
      processQueue(null, newToken);
      originalRequest.headers.Authorization = `Bearer ${newToken}`;
      return api(originalRequest);
    } catch (refreshError) {
      processQueue(refreshError, null);
      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  },
);

export default api;
