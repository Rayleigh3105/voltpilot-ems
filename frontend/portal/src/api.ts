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

export type HistoryRange = 'day' | 'week' | 'month' | 'year';

export interface HistoryBucket {
  start: string;
  pvKwh: number | null;
  loadKwh: number | null;
  gridImportKwh: number | null;
  gridExportKwh: number | null;
  batteryChargeKwh: number | null;
  batteryDischargeKwh: number | null;
  socMinPct: number | null;
  socMaxPct: number | null;
  socLastPct: number | null;
  priceEurMwh: number | null;
  costEur: number | null;
}

export interface HistoryTotals {
  consumptionKwh: number;
  pvGenerationKwh: number;
  gridImportKwh: number;
  gridExportKwh: number;
  /** Null when no price data overlaps the period. */
  gridCostEur: number | null;
  /** Null when no optimizer plan covers the period. */
  batterySavingsEur: number | null;
  autarkiePct: number | null;
  eigenverbrauchPct: number | null;
}

export type ProtocolEventType =
  | 'batterie-laden'
  | 'batterie-entladen'
  | 'pv-spitze'
  | 'preis-tief'
  | 'preis-hoch';

export interface ProtocolEvent {
  type: ProtocolEventType;
  start: string;
  end: string;
  /** Plain-German event description, server-formatted. */
  text: string;
  energyKwh: number | null;
  avgPriceEurMwh: number | null;
  avoidedCostEur: number | null;
  peakKw: number | null;
}

export interface HistoryPlanPoint {
  time: string;
  batteryKw: number | null;
  socPct: number | null;
}

export interface History {
  range: HistoryRange;
  from: string;
  to: string;
  bucketMinutes: number;
  buckets: HistoryBucket[];
  totals: HistoryTotals;
  /** Tagesprotokoll - day range only, else empty. */
  protocol: ProtocolEvent[];
  /** Plan-vs-actual overlay - day range only, else empty. */
  plan: HistoryPlanPoint[];
}

/**
 * Prognosequalität (shadow-mode forecasting): which model is live per kind,
 * every model's lifecycle, and the daily error/skill series from the
 * evaluation job. Model ids: load-persistence / pv-physical (Vergleichsmodelle),
 * load-xgb / pv-residual-xgb (lernende Kandidaten, shadow-only until promoted).
 */
export type ForecastModelId =
  | 'load-persistence'
  | 'pv-physical'
  | 'load-xgb'
  | 'pv-residual-xgb';

export interface FeatureImportance {
  feature: string;
  /** Plain-German label, server-provided. */
  label: string;
  weight: number;
}

export interface ForecastModelState {
  model: ForecastModelId;
  kind: 'load' | 'pv';
  /** 'collecting' = challenger still gathering training days (no predictions). */
  status: 'collecting' | 'ready';
  /** Whether the optimizer consumes THIS model's forecasts. */
  active: boolean;
  daysCollected: number | null;
  daysRequired: number | null;
  trainedAt: string | null;
  trainRows: number | null;
  featureImportance: FeatureImportance[];
  updatedAt: string | null;
}

export interface ForecastAccuracyPoint {
  day: string;
  model: ForecastModelId;
  kind: 'load' | 'pv';
  maeKw: number;
  nmaePct: number | null;
  biasKw: number | null;
  /** 1 - mae/mae_baseline; positive = better than the baseline; null for the baseline. */
  skillVsBaseline: number | null;
  nSlots: number;
}

export interface PlanAccuracyPoint {
  day: string;
  plannedCostEur: number | null;
  baselineCostEur: number | null;
  realizedCostEur: number | null;
  nSlots: number;
}

export interface ForecastQuality {
  activeLoadModel: ForecastModelId;
  activePvModel: ForecastModelId;
  models: ForecastModelState[];
  accuracy: ForecastAccuracyPoint[];
  planAccuracy: PlanAccuracyPoint[];
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

/** One asset row of a site: optimizer battery params, forecast PV params, registry provenance. */
export interface SiteAsset {
  id: string;
  type: string;
  capacityKwh: number | null;
  maxChargeKw: number | null;
  maxDischargeKw: number | null;
  pvCapacityKwp: number | null;
  moduleCount: number | null;
  azimuthDeg: number | null;
  tiltDeg: number | null;
  commissionedOn: string | null;
  registry: string | null;
  registryUnitId: string | null;
  registryFetchedAt: string | null;
}

/**
 * Mapped MaStR record for confirmation ("Anlage verknüpfen" step 2). Nothing
 * is persisted until mastrApply; null fields mean "nicht im Register
 * hinterlegt" (e.g. Balkonkraftwerke carry no orientation).
 */
export interface MastrPreview {
  mastrNummer: string;
  kind: 'pv' | 'storage';
  name: string | null;
  status: string | null;
  plantType: string | null;
  powerKw: number | null;
  inverterPowerKw: number | null;
  moduleCount: number | null;
  azimuthLabel: string | null;
  azimuthDeg: number | null;
  tiltLabel: string | null;
  tiltDeg: number | null;
  commissionedOn: string | null;
  storageCapacityKwh: number | null;
  chargePowerKw: number | null;
  batteryTechnology: string | null;
  plz: string | null;
  ort: string | null;
  linkedUnitNumber: string | null;
  warnings: string[];
}

export interface MastrApplyInput {
  pv?: {
    mastrNummer: string;
    capacityKwp: number | null;
    moduleCount: number | null;
    azimuthDeg: number | null;
    tiltDeg: number | null;
    commissionedOn: string | null;
  };
  storage?: {
    mastrNummer: string;
    capacityKwh: number | null;
    maxChargeKw: number | null;
    maxDischargeKw: number | null;
    commissionedOn: string | null;
  };
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
    // Some endpoints (MaStR lookup) return a customer-facing German message.
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body && typeof body.message === 'string' && body.message) message = body.message;
    } catch {
      // non-JSON error body: keep the status text
    }
    throw new ApiError(res.status, message);
  }
  // 201 with body for claim; others JSON. 204 would be empty.
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export interface RegisterInput {
  name: string;
  email: string;
  password: string;
}

export interface RegistrationResult {
  tenantId: string;
  tenantName: string;
  username: string;
}

/**
 * Self-service registration. Deliberately NOT via request(): it runs before any
 * login exists, and request()'s token refresh would bounce the visitor to the
 * Keycloak login page instead.
 */
export async function register(input: RegisterInput): Promise<RegistrationResult> {
  const res = await fetch(`${API_BASE}/api/v1/registration`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new ApiError(res.status, `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as RegistrationResult;
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
  siteAssets: (siteId: string) => request<SiteAsset[]>(`/api/v1/sites/${siteId}/assets`),
  mastrLookup: (siteId: string, einheitNummer: string) =>
    request<MastrPreview>(`/api/v1/sites/${siteId}/mastr-lookup`, {
      method: 'POST',
      body: JSON.stringify({ einheitNummer }),
    }),
  mastrApply: (siteId: string, input: MastrApplyInput) =>
    request<SiteAsset[]>(`/api/v1/sites/${siteId}/mastr-apply`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  prices: (siteId: string) => request<PriceSeries>(`/api/v1/sites/${siteId}/prices`),
  weather: (siteId: string) => request<WeatherForecast>(`/api/v1/sites/${siteId}/weather`),
  schedule: (siteId: string) => request<SchedulePlan>(`/api/v1/sites/${siteId}/schedule`),
  forecastQuality: (siteId: string, days = 30) =>
    request<ForecastQuality>(`/api/v1/sites/${siteId}/forecast-quality?days=${days}`),
  /** at = any ISO date (YYYY-MM-DD) inside the wanted period, Europe/Berlin. */
  history: (siteId: string, range: HistoryRange, at: string) =>
    request<History>(`/api/v1/sites/${siteId}/history?range=${range}&at=${at}`),
};
