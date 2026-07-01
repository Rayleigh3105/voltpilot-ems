import { freshToken } from './auth';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8090';

export interface Site {
  id: string;
  name: string;
  biddingZone: string;
}

export interface Device {
  id: string;
  siteId: string;
  externalRef: string;
  kind: string;
  status: string;
}

export interface TelemetryPoint {
  ts: string;
  powerKw: number | null;
  socPct: number | null;
  pvPowerKw: number | null;
  loadKw: number | null;
  gridLimitKw: number | null;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await freshToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new ApiError(res.status, `${res.status} ${res.statusText}`);
  }
  // 201 with body for claim; others JSON. 204 would be empty.
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  listSites: () => request<Site[]>('/api/v1/sites'),
  listDevices: () => request<Device[]>('/api/v1/devices'),
  claimDevice: (siteId: string, externalRef: string) =>
    request<Device>('/api/v1/devices/claim', {
      method: 'POST',
      body: JSON.stringify({ siteId, externalRef }),
    }),
  telemetry: (siteId: string, from?: string, to?: string) => {
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    const qs = q.toString();
    return request<TelemetryPoint[]>(`/api/v1/sites/${siteId}/telemetry${qs ? `?${qs}` : ''}`);
  },
};
