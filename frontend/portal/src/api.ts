import { freshToken } from './auth';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8090';

export interface Site {
  id: string;
  name: string;
  biddingZone: string;
  latitude: number | null;
  longitude: number | null;
}

export interface CreateSiteInput {
  name: string;
  biddingZone?: string;
  latitude?: number | null;
  longitude?: number | null;
}

export interface PricePoint {
  ts: string;
  end: string;
  priceEurMwh: number | null;
}

export interface PriceSeries {
  biddingZone: string;
  resolution: string | null;
  currency: string;
  points: PricePoint[];
}

export interface WeatherPoint {
  ts: string;
  temperatureC: number | null;
  cloudCoverPct: number | null;
  ghiWM2: number | null;
  dniWM2: number | null;
  dhiWM2: number | null;
}

export interface WeatherForecast {
  runAt: string | null;
  points: WeatherPoint[];
}

export interface ScheduleSlot {
  start: string;
  batteryKw: number | null;
  gridKw: number | null;
  socPct: number | null;
  priceEurMwh: number | null;
  costEur: number | null;
  baselineCostEur: number | null;
}

export interface SchedulePlan {
  planId: string | null;
  deviceId: string | null;
  generatedAt: string | null;
  slotMinutes: number;
  savingsEur: number | null;
  slots: ScheduleSlot[];
}

export interface Device {
  id: string;
  siteId: string;
  externalRef: string;
  kind: string;
  status: string;
  /** Newest telemetry timestamp; null until the first data arrives. */
  lastSeenAt: string | null;
}

/** Portal onboarding state derived from telemetry recency. */
export type DeviceLiveStatus = 'online' | 'stale' | 'waiting';

/** A device counts as online when telemetry arrived within this window. */
export const ONLINE_WINDOW_MS = 5 * 60 * 1000;

export function deviceLiveStatus(d: Device, now: Date = new Date()): DeviceLiveStatus {
  if (!d.lastSeenAt) return 'waiting';
  return now.getTime() - new Date(d.lastSeenAt).getTime() <= ONLINE_WINDOW_MS
    ? 'online'
    : 'stale';
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

/**
 * Portal-Admin tenant switcher: when set, every request carries the selected
 * tenant as `X-Tenant-Id`. The backend honors the header ONLY for
 * platform-admin tokens (see TenantFilter), so the customer pages render that
 * tenant's data through the same RLS scoping the customer gets.
 */
let tenantOverride: string | null = null;

export function setTenantOverride(tenantId: string | null): void {
  tenantOverride = tenantId;
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await freshToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(tenantOverride ? { 'X-Tenant-Id': tenantOverride } : {}),
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
  createSite: (input: CreateSiteInput) =>
    request<Site>('/api/v1/sites', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
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
  prices: (siteId: string) => request<PriceSeries>(`/api/v1/sites/${siteId}/prices`),
  weather: (siteId: string) => request<WeatherForecast>(`/api/v1/sites/${siteId}/weather`),
  schedule: (siteId: string) => request<SchedulePlan>(`/api/v1/sites/${siteId}/schedule`),
};
