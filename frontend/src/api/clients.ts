import api from './client';
import type {
  FLClient,
  FLClientDetail,
  FLClientCreate,
  FLClientUpdate,
  ContainerStatus,
  DeviceBrief,
} from '@/types';

export const clientsApi = {
  /** List all FL clients (flat, no nested devices). */
  list: () =>
    api.get<FLClient[]>('/fl/clients').then((r) => r.data),

  /** Get a single client with nested devices. */
  get: (id: number) =>
    api.get<FLClientDetail>(`/fl/clients/${id}`).then((r) => r.data),

  /** Register a new FL client (backend also creates Docker container). */
  create: (data: FLClientCreate) =>
    api.post<FLClient>('/fl/clients', data).then((r) => r.data),

  /** Update an FL client. */
  update: (id: number, data: FLClientUpdate) =>
    api.patch<FLClient>(`/fl/clients/${id}`, data).then((r) => r.data),

  /** Delete an FL client (backend removes Docker container too). */
  delete: (id: number) =>
    api.delete(`/fl/clients/${id}`),

  /** List devices for a client. */
  devices: (id: number) =>
    api.get<DeviceBrief[]>(`/fl/clients/${id}/devices`).then((r) => r.data),

  /** Start monitoring — starts container in MONITOR mode. */
  startMonitoring: (id: number) =>
    api.post<ContainerStatus>(`/fl/clients/${id}/container/start`, null, {
      params: { mode: 'MONITOR' },
    }).then((r) => r.data),

  /** Stop monitoring — stops the client container. */
  stopMonitoring: (id: number) =>
    api.post<ContainerStatus>(`/fl/clients/${id}/container/stop`).then((r) => r.data),

  /** Get container status. */
  containerStatus: (id: number) =>
    api.get<ContainerStatus>(`/fl/clients/${id}/container/status`).then((r) => r.data),
};
