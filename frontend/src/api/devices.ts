import api from './client';
import type { Device, DeviceCreate, DeviceUpdate, Prediction } from '@/types';

export const devicesApi = {
  list: (clientId?: number) =>
    api.get<Device[]>('/devices/', { params: clientId != null ? { client_id: clientId } : undefined }).then((r) => r.data),

  get: (id: string) =>
    api.get<Device>(`/devices/${id}`).then((r) => r.data),

  create: (data: DeviceCreate) =>
    api.post<Device>('/devices/', data).then((r) => r.data),

  update: (id: string, data: DeviceUpdate) =>
    api.patch<Device>(`/devices/${id}`, data).then((r) => r.data),

  delete: (id: string) =>
    api.delete(`/devices/${id}`),

  /** Prediction history for a specific device. */
  predictions: (deviceId: string, limit = 50) =>
    api.get<Prediction[]>(`/predictions/device/${deviceId}?limit=${limit}`).then((r) => r.data),
};
