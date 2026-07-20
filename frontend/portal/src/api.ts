import { AuthRedirectError, freshToken } from './auth';
import type { SimulationRequestInput, SimulationStatus } from './simulation';
import type { Topology } from './topology';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8090';

/**
 * Anlagentyp of a site: steers the money wording ("mehr verdient" for
 * Direktvermarktung - spot revenue is literal income - vs. "gespart" for
 * Eigenverbrauch - avoided cost).
 */
export type PlantKind = 'direktvermarktung' | 'eigenverbrauch';

/**
 * Electricity tariff art of a site (REPLACES the old fixed strompreis). Steers
 * how self-consumed energy is valued in euros: 'dynamisch' = each self-consumed
 * kWh at its 15-min Börsenpreis + an optional Aufschlag; 'fest' = a single fixed
 * retail price; 'ohne' = no euro value (kWh only, never fabricated).
 */
export type TarifArt = 'dynamisch' | 'fest' | 'ohne';

/**
 * The U0 Kontotyp/Betriebsart shell frame (design vp-ems-ui-overhaul §2):
 * 'endkunde' = single-object cockpit shell (never fleet chrome), 'betreiber' =
 * fleet/portfolio shell. The value is resolved SERVER-side (explicit tenant
 * override wins, else derived from the segment: B2C -> endkunde, CI ->
 * betreiber) - the portal consumes it as-is and never re-derives.
 */
export type Betriebsart = 'endkunde' | 'betreiber';

/**
 * The caller's tenant context, read once at login (the U0 bootstrap).
 * `betriebsart` is the EFFECTIVE frame the navigation shell keys on.
 */
export interface TenantContext {
  tenantId: string;
  name: string;
  segment: string;
  betriebsart: Betriebsart;
}

export interface Site {
  id: string;
  name: string;
  biddingZone: string;
  latitude: number | null;
  longitude: number | null;
  plantKind: PlantKind;
  /**
   * Anzulegender Wert (ct/kWh) - the plant's fixed EEG reference rate from
   * the EEG award / Direktvermarktungsvertrag; null = not configured. Only
   * relevant for plantKind 'direktvermarktung' - when set, the earnings
   * include the dynamic monthly premium max(0, anzulegender Wert -
   * Monatsmarktwert Solar), suspended in negative-price slots.
   */
  anzulegenderWertCtKwh: number | null;
  /**
   * Electricity tariff art (REPLACES the fixed strompreisCtKwh). 'dynamisch'
   * values self-consumption per 15-min slot at spot + Aufschlag, 'fest' at the
   * fixed price, 'ohne' in kWh only. Defaults to 'ohne'.
   */
  tarifArt: TarifArt;
  /**
   * The tariff parameter (ct/kWh); null = none. The fixed retail price for
   * 'fest', the optional spot-price Aufschlag (grid fees, levies, margin) for
   * 'dynamisch', unused for 'ohne'.
   */
  tarifParamCtKwh: number | null;
  /**
   * Per-site grid-charging switch: false (default) = "Nur Solarladen (EEG)"
   * (the optimizer charges the battery only from PV surplus), true =
   * "Netzladen aktiv" (grid arbitrage). Editable by the site owner and by
   * Portal-Admins (captain revision 2026-07-07); the form carries the
   * Ausschließlichkeitsprinzip warning.
   */
  netzladenErlaubt: boolean;
  /**
   * Static feed-in cap at the grid connection point (Einspeisegrenze am
   * Netzanschlusspunkt, kW > 0); null = no connection-point limit. The
   * optimizer enforces it export-only (FK1).
   */
  maxFeedInKw: number | null;
  /**
   * Leistungspreis (EUR/kW) of a Lastspitzenkappung setup, configured by
   * VoltPilot (admin optimizer-config, Tier 2) - never customer-editable.
   * DEFENSIVELY OPTIONAL: a sibling backend task adds the field; until that
   * ships the API omits it (undefined) and absent/null both read as
   * "not active" (see moduleSurface.ts).
   */
  leistungspreisEurKw?: number | null;
}

export interface CreateSiteInput {
  name: string;
  biddingZone?: string;
  latitude?: number | null;
  longitude?: number | null;
  /** Defaults to 'eigenverbrauch' server-side. */
  plantKind?: PlantKind;
  /** Anzulegender Wert in ct/kWh (>= 0); omit/null = not configured. */
  anzulegenderWertCtKwh?: number | null;
  /** Electricity tariff art; omitted = 'ohne'. */
  tarifArt?: TarifArt;
  /** Tariff parameter in ct/kWh (>= 0): fixed price for fest, Aufschlag for dynamisch. */
  tarifParamCtKwh?: number | null;
  /**
   * Grid-charging switch, settable by the site owner and by Portal-Admins.
   * Omitted = the safe default false on create / keep the stored value on
   * update.
   */
  netzladenErlaubt?: boolean;
  /**
   * Static feed-in cap at the grid connection point (kW, strictly positive).
   * Omitted/null = no limit on create / keep the stored value on update
   * (the netzladenErlaubt pattern).
   */
  maxFeedInKw?: number | null;
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

export interface PriceBucket {
  ts: string;
  avgEurMwh: number | null;
  minEurMwh: number | null;
  maxEurMwh: number | null;
}

export interface PriceRangeSummary {
  avgEurMwh: number | null;
  minEurMwh: number | null;
  maxEurMwh: number | null;
  cheapestTs: string | null;
  mostExpensiveTs: string | null;
  count: number;
  coverageStart: string | null;
  coverageEnd: string | null;
}

export interface PriceHistory {
  biddingZone: string;
  currency: string;
  /** ISO-8601 duration: PT15M (day), PT1H (week), P1D (month/year). */
  bucket: string;
  from: string;
  to: string;
  buckets: PriceBucket[];
  summary: PriceRangeSummary;
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
  /**
   * Planned PV curtailment for the slot (kW held back, always >= 0). At
   * negative prices the optimizer curtails feed-in so the plant does not pay
   * to export; the Anlage page surfaces "heute X kWh abgeregelt, Y € Verlust
   * vermieden". Null on runs that predate the curtailment column.
   */
  curtailKw: number | null;
  /**
   * PV forecast the slot planned with (kW, `schedule.pv_kw`). Feeds the
   * pv-aware "Laden aus dem Netz" derivation (schedule.ts chargeKind): since
   * FK3 an EEG site may charge solar while the house imports, so cyan needs
   * charge > available PV, not merely charge-while-importing. Null on rows
   * without a persisted PV input (chargeKind then falls back to the old
   * import-based rule).
   */
  pvKw: number | null;
}

export interface SchedulePlan {
  planId: string | null;
  deviceId: string | null;
  generatedAt: string | null;
  slotMinutes: number;
  savingsEur: number | null;
  /**
   * Value of the energy the plan banks into (positive) or draws out of
   * (negative) the horizon - the run's terminal value per stored kWh times the
   * SoC swing. Makes savingsEur honest on bank days (storing into tomorrow
   * otherwise reads as negative savings). Null when not computable (runs
   * predating the terminal-value column, no battery asset) - the banked line
   * then stays hidden, never a fabricated 0.
   */
  bankedValueEur: number | null;
  /** Battery SoC at the plan start (what the banked value is measured from). */
  socStartPct: number | null;
  /** Planned SoC at the horizon end. */
  socEndPct: number | null;
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
  /** Optional customer-facing label (Bezeichnung); externalRef stays the identity. */
  name: string | null;
  status: string;
  /** Newest telemetry timestamp; null until the first data arrives. */
  lastSeenAt: string | null;
  /** When the device was claimed; drives the waiting-too-long escalation. */
  createdAt: string | null;
}

/** Only type + label are editable; the externalRef is the device's identity. */
export interface UpdateDeviceInput {
  kind?: string;
  name?: string | null;
}

/** Outcome of a device data purge ("Datenaufzeichnungen löschen"). */
export interface DevicePurgeResult {
  deviceId: string;
  /** Raw datapoints removed (derived aggregates are rebuilt, not counted). */
  purgedRows: number;
  /** The purge watermark; older replayed samples are refused from now on. */
  purgedBefore: string;
  /**
   * Whether the purge command reached the device's message channel. False on
   * a broker outage: the cloud data is still gone, the device's local buffer
   * is cleaned up once the command can be delivered.
   */
  deviceNotified: boolean;
}

/** What deleting a site would remove - drives the confirm dialog. */
export interface SiteDeletionPreview {
  deviceCount: number;
  telemetryCount: number;
  telemetryFrom: string | null;
  telemetryTo: string | null;
  forecastCount: number;
  scheduleCount: number;
  weatherCount: number;
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

/**
 * A device claimed longer ago than this without ever sending data is treated
 * as abnormal (likely a mistyped ID or an offline device) - the portal then
 * escalates the "wartet auf erste Daten" copy to troubleshooting guidance.
 */
export const WAITING_ESCALATION_MS = 15 * 60 * 1000;

/** True when a still-waiting device has waited past {@link WAITING_ESCALATION_MS} since claiming. */
export function deviceWaitedTooLong(d: Device, now: Date = new Date()): boolean {
  if (deviceLiveStatus(d, now) !== 'waiting' || !d.createdAt) return false;
  return now.getTime() - new Date(d.createdAt).getTime() > WAITING_ESCALATION_MS;
}

/** One asset row of a site: optimizer battery params, forecast PV params, registry provenance. */
export interface SiteAsset {
  id: string;
  type: string;
  /**
   * The device that controls this asset. A battery with a null deviceId has no
   * control path - the optimizer plans it but can never publish the plan to the
   * edge, so the portal warns and offers the link editor.
   */
  deviceId: string | null;
  capacityKwh: number | null;
  maxChargeKw: number | null;
  maxDischargeKw: number | null;
  roundtripEfficiencyPct: number | null;
  /**
   * Battery only: the EFFECTIVE "Umgang mit dem Speicher" preset, derived
   * server-side from the stored wear cost - 'aggressiv' | 'ausgewogen' (also
   * for the platform default) | 'schonend', or 'individuell' when an admin
   * configured a custom value. Null for non-battery assets.
   */
  speicherschonung: string | null;
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
 * An additional read-only measurement point of a site (multi-source Anlage). A
 * site with a battery-hybrid inverter PLUS a separate AC-coupled PV records the
 * second PV here as an Erzeuger source; its kWp sums into the aggregate site PV.
 * Read-only by construction (control is always false).
 */
export interface MeasurementPoint {
  id: string;
  role: string;
  label: string | null;
  brand: string | null;
  model: string | null;
  capacityKwp: number | null;
  registryUnitId: string | null;
  control: boolean;
  createdAt: string | null;
  /** v2 entity registry: pilot domain type when this row is a v2 entity (admin-managed). */
  entityType?: string | null;
}

/** Record a new additional Erzeuger source (master data; no second device claim). */
export interface CreateMeasurementPointInput {
  role?: string;
  label?: string;
  brand?: string;
  model?: string;
  capacityKwp?: number;
  registryUnitId?: string;
}

// ---- v2 entities ("Geräte & Entitäten") ----------------------------------

/** Per-entity Soll/Ist verdict (edge-reported Ist vs. cloud registry Soll). */
export type EntitySyncStatus =
  | 'in_sync'
  | 'pending'
  | 'missing_on_device'
  | 'unreported'
  | 'never_pushed';

/** The edge-reported observed Ist of one entity (null = nothing reported). */
export interface EntityObserved {
  health: 'ok' | 'stale' | 'never';
  lastTelemetryAt: string | null;
  channels: string[] | null;
  appliedType: string | null;
  reportedAt: string;
}

/** One v2 entity with its capabilities, guard config and drift verdict. */
export interface SiteEntity {
  id: string;
  entityType: string;
  typeLabel: string;
  role: string;
  label: string | null;
  control: boolean;
  deviceId: string | null;
  capabilities: {
    measure?: { channel: string; unit?: string }[];
    actuate?: { command: string; min?: number; max?: number; modes?: string[] }[];
  } | null;
  guards: {
    limits?: Record<string, number | boolean>;
    failsafe?: { behavior: string };
  } | null;
  syncStatus: EntitySyncStatus;
  observed: EntityObserved | null;
}

/** The composed registry Soll + the edge's echoed revision. */
export interface EntityRegistryState {
  revision: string;
  composedAt: string;
  deviceId: string | null;
  reportedRevision: string | null;
  reportedAt: string | null;
}

/** One edge-local commissioning item (inverter/source; never auto-imported). */
export interface EntityLocalSetup {
  id: string;
  kind: string;
  label: string | null;
  reportedAt: string;
}

/** The whole "Geräte & Entitäten" surface for a site. */
export interface SiteEntities {
  registry: EntityRegistryState | null;
  entities: SiteEntity[];
  localSetup: EntityLocalSetup[];
  staleOnDevice: string[];
}

// --- AE1 topology read-model (adaptive energy flow + tiles) -------------------

/** One capability of a topology entity: its resolved role + latest live value. */
export interface TopologyCapability {
  channel: string;
  unit: string | null;
  /** Resolved role (pv | storage | consumer | grid); null = unassigned. */
  role: string | null;
  /** The maßgebliche (primary) capability of its role. */
  primary: boolean;
  /** Latest live value; null = unknown (never a fabricated 0). */
  value: number | null;
}

/** One entity as the topology read-model exposes it (camelCase). */
export interface TopologyEntity {
  id: string;
  entityType: string;
  typeLabel: string;
  label: string | null;
  /** storage | producer | meter | consumer (steers the tile/flow semantics). */
  category: string;
  /** ok | stale | never (5-min liveness window). */
  health: string;
  capabilities: TopologyCapability[];
}

/**
 * The Anlagen-Topologie-Read-Model (AE1, GET /sites/{id}/topology): the entity
 * graph + the server-derived role-grouped hub topology the adaptive energy-flow
 * diagram (AE2) renders. A fresh / un-migrated site returns empty entities +
 * empty topology nodes (the caller then falls back to the v1 telemetry view).
 */
export interface SiteTopology {
  schemaVersion: string;
  entities: TopologyEntity[];
  topology: Topology;
}

// --- AE7 usage profile (adaptation axis 2: emphasis) -------------------------

/** Which surfaces a profile makes prominent | secondary | minimal | hidden. */
export interface UsageEmphasis {
  money: string;
  peak: string;
  flow: string;
  devices: string;
}

/** The signals the profile was derived from (transparency). */
export interface UsageProfileSignals {
  hasStorage: boolean;
  hasPv: boolean;
  hasControllableConsumer: boolean;
  activeStrategyNodeTypes: string[];
  plantKind: string | null;
  hasLeistungspreis: boolean;
}

/**
 * The AE7 Nutzungsprofil read-model (GET /sites/{id}/profile): the EFFECTIVE
 * profile (arbitrage | peak | private), the derived default, the raw override,
 * the emphasis map (which surfaces AE2/AE3 make prominent) and the signals.
 */
export interface SiteUsageProfile {
  usageProfile: string;
  derivedProfile: string;
  override: string | null;
  emphasis: UsageEmphasis;
  signals: UsageProfileSignals;
}

/** One aggregated bucket of one entity channel. */
export interface EntityHistoryBucket {
  start: string;
  avg: number | null;
  min: number | null;
  max: number | null;
  last: number | null;
  n: number;
}

/** Per-entity channel history (channel name -> bucket series). */
export interface EntityHistory {
  range: HistoryRange;
  from: string;
  to: string;
  bucketMinutes: number;
  channels: Record<string, EntityHistoryBucket[]>;
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

/** Manual battery master data + optional controlling-device link. */
export interface SaveBatteryInput {
  capacityKwh: number;
  maxChargeKw: number;
  maxDischargeKw: number;
  roundtripEfficiencyPct?: number | null;
  /** The controlling device; omit to auto-link the site's single device. */
  deviceId?: string | null;
  /**
   * "Umgang mit dem Speicher" preset (FK4), mapped server-side onto the
   * battery's wear cost. Omit to keep the stored value.
   */
  speicherschonung?: 'aggressiv' | 'ausgewogen' | 'schonend';
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

// ---- Fleet overview (GET /api/v1/overview) ---------------------------------

/** Newest telemetry observation of a site (the fleet card's live snapshot). */
export interface OverviewLive {
  ts: string;
  pvKw: number | null;
  loadKw: number | null;
  /** + = Bezug (import), - = Einspeisung (export). */
  gridKw: number | null;
  socPct: number | null;
}

/**
 * One site of the fleet overview. Liveness counts derive from each device's
 * newest telemetry ARRIVAL server-side (the store-and-forward rule) with the
 * same 5-minute window as {@link deviceLiveStatus}.
 */
export interface OverviewSite {
  id: string;
  name: string;
  plantKind: PlantKind;
  /** Per-site grid-charging switch (the mode badge on the site card). */
  netzladenErlaubt: boolean;
  /**
   * The site has a battery asset with no controlling device: the optimizer
   * plans it but cannot publish the plan to the edge. The portal warns.
   */
  batteryWithoutDevice: boolean;
  deviceCount: number;
  onlineCount: number;
  /** Devices that never sent data ("wartet auf erste Daten"). */
  waitingCount: number;
  /** Worst device status (stale beats waiting beats online); null = no devices. */
  worstStatus: DeviceLiveStatus | null;
  lastSeenAt: string | null;
  live: OverviewLive | null;
  /** Ex-ante optimizer savings for today (Berlin day); null = no plan today. */
  plannedSavingsTodayEur: number | null;
}

export interface OverviewTotals {
  sites: number;
  devices: number;
  online: number;
  /** Null when NO site has a plan today (never a misleading zero). */
  plannedSavingsTodayEur: number | null;
  /** Sites whose live snapshot is inside the 5-min freshness window. */
  liveSitesCovered: number;
}

/** One Europe/Berlin day of fleet-wide ex-ante savings (hero mini chart). */
export interface OverviewDailySavings {
  day: string;
  savingsEur: number;
}

export interface Overview {
  sites: OverviewSite[];
  totals: OverviewTotals;
  dailySavings: OverviewDailySavings[];
}

// ---- Inverter control confirmation (GET /api/v1/sites/{id}/control-status) --

/**
 * The latest inverter-control confirmation for a site: what the schedule
 * commanded ({@code commandedKw}) vs. what the inverter read back
 * ({@code confirmedKw}), a healthy/mismatch verdict, and the freshness anchor
 * the "Steuerung" strip turns into "geprüft vor X". `controlEnabled` /
 * `certified` distinguish "confirmed", "control off" and "not yet released".
 */
export interface ControlStatus {
  deviceId: string;
  commandedKw: number | null;
  confirmedKw: number | null;
  allMatch: boolean;
  controlEnabled: boolean;
  certified: boolean;
  mismatchRoles: string | null;
  slotStart: string | null;
  checkedAt: string;
}

// ---- Realized earnings (GET /api/v1/earnings) -------------------------------

export type EarningsRange = 'day' | 'month' | 'year' | 'all';

/**
 * Why a site has nothing computable: no_data = no measurements in the window;
 * missing_channels = the device does not report the load/PV/grid channels the
 * math needs (generation-only inverters); no_prices = no day-ahead price
 * covers the measured slots yet.
 */
export type EarningsReason = 'no_data' | 'missing_channels' | 'no_prices';

/** One Europe/Berlin day of realized savings. */
export interface EarningsDaily {
  day: string;
  savedEur: number;
}

/** One Ertrag-chart bucket: its Berlin start (ISO) + the Gesamtertrag. */
export interface EarningsSeriesPoint {
  start: string;
  gesamtertragEur: number;
}

/** One month of the 12-month strip: first day of the Berlin month + Gesamtertrag. */
export interface EarningsMonth {
  month: string;
  gesamtertragEur: number;
}

/**
 * One site's MEASURED earnings over the window: baseline = the unregulated
 * plant (same sun, same consumption, battery idle), actual = what really
 * happened at the meter, saved = baseline - actual. All are signed COSTS
 * (negative = revenue); null when nothing is computable ({@link EarningsReason}).
 * `dailySaved` is the last 14 Berlin days regardless of range (spark bars +
 * "Heute" teaser).
 */
export interface EarningsSite {
  id: string;
  name: string;
  plantKind: PlantKind;
  /**
   * The site's configured anzulegender Wert (ct/kWh), echoed so the fine
   * print can say the numbers INCLUDE the dynamic monthly premium; null =
   * none (pure spot numbers).
   */
  anzulegenderWertCtKwh: number | null;
  /**
   * Benchmark KPI: the export-weighted spot price (ct/kWh) the site's feed-in
   * actually fetched over the window vs the Monatsmarktwert Solar weighted
   * with the same exports; `marketValueProvisional` is true while any
   * contributing month's value is still the provisional (not yet published)
   * one. Null without exported energy or market-value coverage.
   */
  realizedExportCtKwh: number | null;
  marketValueSolarCtKwh: number | null;
  marketValueProvisional: boolean | null;
  baselineEur: number | null;
  actualEur: number | null;
  savedEur: number | null;
  /**
   * The "davon Arbitrage-Gewinn" split for grid-charging sites
   * (netzladen_erlaubt): arbitrage = what the permission concretely earned
   * (grid-charged energy's discharge revenue minus its purchase cost,
   * storage-mix attribution), pvShift = the remainder, so
   * arbitrageEur + pvShiftEur === savedEur exactly. Both null when the site
   * may not grid-charge or the window has no grid-charged energy.
   */
  arbitrageEur: number | null;
  pvShiftEur: number | null;
  coveredSlots: number;
  firstCoveredDate: string | null;
  reason: EarningsReason | null;
  dailySaved: EarningsDaily[];
  /**
   * Money-centric "Meine Anlage" view (v2). Gesamtertrag =
   * einspeiseErloesEur (metered feed-in valued at spot + Marktprämie) +
   * eigenverbrauchsWertEur (self-consumed energy valued per the site's tariff).
   * `tarifArt`/`tarifParamCtKwh` echo the configured tariff so the provenance
   * sentence can name it. eigenverbrauchsWertEur is computed slot-by-slot
   * (dynamisch: each kWh at its 15-min spot price + Aufschlag; fest: the fixed
   * price) and is null for an 'ohne' tariff (self-consumption then shown as
   * selbstverbrauchKwh only, never a fabricated euro), so gesamtertragEur equals
   * einspeiseErloesEur alone. All money fields are null when nothing is
   * computable (same `reason`). `series` is the Ertrag chart for the selected
   * range (per Berlin hour for day, day for month, month for year/all);
   * `monthlyStrip` is the last 12 months (independent of range) - the tappable
   * strip. Both list only computable buckets.
   */
  tarifArt: TarifArt;
  tarifParamCtKwh: number | null;
  einspeiseErloesEur: number | null;
  eigenverbrauchsWertEur: number | null;
  gesamtertragEur: number | null;
  selbstverbrauchKwh: number | null;
  eingespeistKwh: number | null;
  batterieBewegtKwh: number | null;
  /**
   * Forward-looking expected Marktwert Solar (ct/kWh): the day-ahead price
   * weighted with THIS site's own PV forecast over the coming horizon
   * (Σ(price × pv) / Σ(pv)) - the forward companion to the realized
   * `marketValueSolarCtKwh`. Range-independent (always the future).
   * `expectedMarketValueFrom`/`...To` bound the covered forward slots and
   * `expectedMarketValueSlots` counts them, so the portal can say "nächste
   * N h". All four are null when there is no forward PV forecast or no
   * forward price coverage - the figure is then hidden (never a fake 0).
   */
  expectedMarketValueSolarCtKwh: number | null;
  expectedMarketValueFrom: string | null;
  expectedMarketValueTo: string | null;
  expectedMarketValueSlots: number | null;
  series: EarningsSeriesPoint[];
  monthlyStrip: EarningsMonth[];
  /**
   * The Lastspitzenkappung proof (PS-4): present exactly when the site's
   * peak-shaving module is active (a Leistungspreis is configured); null
   * otherwise. Range-independent - always the RUNNING billing period.
   * Optional so the portal ships against an older backend (absent reads the
   * same as null - no proof shown).
   */
  peakShaving?: PeakShaving | null;
}

/**
 * Peak-shaving proof of a module-active site: the running Europe/Berlin
 * billing period's measured grid-import peak vs. the counterfactual
 * no-battery peak (max 15-min mean import; the counterfactual is the same
 * plant with the battery idle). `avoidedKw = max(0, baseline - measured)`;
 * `avoidedEur = avoidedKw × leistungspreisEurKw` - NOT pro-rated, mid-period
 * it is the current standing. The peak fields are null while the running
 * period has no measured import bucket yet - never fabricated.
 */
export interface PeakShaving {
  /** EUR per kW per billing period (the module flag - always present here). */
  leistungspreisEurKw: number;
  /** Billing period kind: Europe/Berlin calendar year or month. */
  abrechnung: 'jahr' | 'monat';
  /** First Berlin day of the running billing period (ISO date). */
  periodStart: string;
  peakKw: number | null;
  baselinePeakKw: number | null;
  avoidedKw: number | null;
  avoidedEur: number | null;
  /** Last 12 billing periods with measured data, ascending (incl. running). */
  history: PeakShavingPeriod[];
}

/** One billing period of the peak-shaving history. */
export interface PeakShavingPeriod {
  periodStart: string;
  peakKw: number;
  baselinePeakKw: number;
  avoidedKw: number;
  avoidedEur: number;
}

export interface EarningsTotals {
  baselineEur: number | null;
  actualEur: number | null;
  savedEur: number | null;
  /**
   * Fleet-level arbitrage split: arbitrage sums the grid-charging sites'
   * attributions, pvShift is the whole fleet's remainder (sites without a
   * split cannot grid-charge, so their entire saved is PV-shift) - null when
   * no site grid-charged in the window.
   */
  arbitrageEur: number | null;
  pvShiftEur: number | null;
  coveredSlots: number;
  /** Earliest covered Berlin day - the honest start of a "Gesamt" range. */
  firstCoveredDate: string | null;
}

export interface Earnings {
  range: EarningsRange;
  from: string;
  to: string;
  sites: EarningsSite[];
  totals: EarningsTotals;
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
  let token: string | undefined;
  try {
    token = await freshToken();
  } catch (e) {
    // freshToken() already triggered a full-page login redirect. Abort this
    // request by never resolving - the browser navigates away, so no error
    // banner (and no raw "401") flashes before the redirect (m4).
    if (e instanceof AuthRedirectError) return new Promise<never>(() => {});
    throw e;
  }
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
    // Never leak a raw HTTP status/statusText into customer-facing copy (m4):
    // default to a plain-German message and let a server-provided German
    // `message` (e.g. MaStR lookup) override it. The numeric status stays on
    // ApiError.status for callers that branch on it (409/422/…).
    let message = 'Der Server ist zurzeit nicht erreichbar. Bitte versuchen Sie es erneut.';
    try {
      const body = await res.json();
      if (body && typeof body.message === 'string' && body.message) message = body.message;
    } catch {
      // non-JSON error body: keep the generic message
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
    // Carry the server's message (don't discard it) but keep it off the raw
    // status text; App maps the status to German copy, incl. the 502/503
    // outage branch (m7).
    let message = 'Die Registrierung ist zurzeit nicht möglich.';
    try {
      const body = await res.json();
      if (body && typeof body.message === 'string' && body.message) message = body.message;
    } catch {
      // non-JSON error body: keep the generic message
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as RegistrationResult;
}

export const api = {
  /** Tenant-wide fleet overview (the adaptive Übersicht's fleet mode). */
  overview: () => request<Overview>('/api/v1/overview'),
  /**
   * Realized earnings (measured, per site + totals) for a Berlin period. `at`
   * (ISO day) picks the period instance - e.g. a past month tapped in the
   * 12-month strip; omitted = the current period.
   */
  earnings: (range: EarningsRange = 'month', at?: string | null) =>
    request<Earnings>(
      `/api/v1/earnings?range=${range}${at ? `&at=${at}` : ''}`,
    ),
  /**
   * The site's latest inverter-control confirmation (the calm "Steuerung"
   * strip). Resolves to null when no device has reported a readback yet
   * (endpoint answers 204).
   */
  controlStatus: (siteId: string) =>
    request<ControlStatus | undefined>(
      `/api/v1/sites/${siteId}/control-status`,
    ).then((v) => v ?? null),
  /**
   * The caller's tenant context (U0 login bootstrap): tenant name/segment +
   * the EFFECTIVE Betriebsart that picks the navigation shell. 404 for an
   * admin without a selected tenant (RLS default-deny).
   */
  tenantContext: () => request<TenantContext>('/api/v1/tenant-context'),
  listSites: () => request<Site[]>('/api/v1/sites'),
  createSite: (input: CreateSiteInput) =>
    request<Site>('/api/v1/sites', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateSite: (siteId: string, input: CreateSiteInput) =>
    request<Site>(`/api/v1/sites/${siteId}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  /** 409 while the site still has devices (remove them first). */
  deleteSite: (siteId: string) =>
    request<void>(`/api/v1/sites/${siteId}`, { method: 'DELETE' }),
  siteDeletionPreview: (siteId: string) =>
    request<SiteDeletionPreview>(`/api/v1/sites/${siteId}/deletion-preview`),
  listDevices: () => request<Device[]>('/api/v1/devices'),
  claimDevice: (siteId: string, externalRef: string) =>
    request<Device>('/api/v1/devices/claim', {
      method: 'POST',
      body: JSON.stringify({ siteId, externalRef }),
    }),
  updateDevice: (deviceId: string, input: UpdateDeviceInput) =>
    request<Device>(`/api/v1/devices/${deviceId}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  /** Unclaim: deletes the device and its telemetry; the ref becomes claimable again. */
  deleteDevice: (deviceId: string) =>
    request<void>(`/api/v1/devices/${deviceId}`, { method: 'DELETE' }),
  /**
   * Purge all recorded data of a device WITHOUT unclaiming it: telemetry and
   * derived aggregates are gone, the device stays connected, new data flows
   * normally. Irreversible.
   */
  purgeDeviceData: (deviceId: string) =>
    request<DevicePurgeResult>(`/api/v1/devices/${deviceId}/purge-data`, { method: 'POST' }),
  telemetry: (siteId: string, from?: string, to?: string) => {
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    const qs = q.toString();
    return request<TelemetryPoint[]>(`/api/v1/sites/${siteId}/telemetry${qs ? `?${qs}` : ''}`);
  },
  siteAssets: (siteId: string) => request<SiteAsset[]>(`/api/v1/sites/${siteId}/assets`),
  /** A site's additional read-only Erzeuger measurement points (multi-source). */
  measurementPoints: (siteId: string) =>
    request<MeasurementPoint[]>(`/api/v1/sites/${siteId}/measurement-points`),
  /** Record an additional Erzeuger source; returns the site's points afterwards. */
  addMeasurementPoint: (siteId: string, input: CreateMeasurementPointInput) =>
    request<MeasurementPoint[]>(`/api/v1/sites/${siteId}/measurement-points`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /** Remove an additional source; returns the site's remaining points. */
  deleteMeasurementPoint: (siteId: string, pointId: string) =>
    request<MeasurementPoint[]>(`/api/v1/sites/${siteId}/measurement-points/${pointId}`, {
      method: 'DELETE',
    }),
  /** The site's v2 "Geräte & Entitäten" surface (Soll/Ist reconciliation). */
  siteEntities: (siteId: string) =>
    request<SiteEntities>(`/api/v1/sites/${siteId}/entities`),
  /** AE1 topology read-model (adaptive energy flow + tiles). Empty for un-migrated sites. */
  topology: (siteId: string) => request<SiteTopology>(`/api/v1/sites/${siteId}/topology`),
  /** AE7 usage profile + emphasis map (the adaptive view's second axis). */
  usageProfile: (siteId: string) =>
    request<SiteUsageProfile>(`/api/v1/sites/${siteId}/profile`),
  /**
   * Set (or clear with null) the site's usage-profile override (AE7, spec §2:
   * "Kunde/Admin kann explizit überschreiben"). Customer- or admin-scoped like
   * the GET; returns the recomputed read-model. Null re-enables auto-derivation.
   */
  setUsageProfileOverride: (siteId: string, override: string | null) =>
    request<SiteUsageProfile>(`/api/v1/sites/${siteId}/profile`, {
      method: 'PUT',
      body: JSON.stringify({ override }),
    }),
  /** Per-entity channel history over the v2 telemetry rollups. */
  entityHistory: (siteId: string, entityId: string, range: HistoryRange, at?: string) =>
    request<EntityHistory>(
      `/api/v1/sites/${siteId}/entities/${entityId}/history?range=${range}${
        at ? `&at=${at}` : ''
      }`,
    ),
  /**
   * Save the site's battery master data by hand and maintain its controlling
   * device link ("Ihr Wechselrichter steuert diesen Speicher"). Omit deviceId
   * to auto-link the site's single device; pass it to pick on a multi-device
   * site. Returns the site's assets after the save.
   */
  saveBattery: (siteId: string, input: SaveBatteryInput) =>
    request<SiteAsset[]>(`/api/v1/sites/${siteId}/battery`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
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
  /** at = any ISO date (YYYY-MM-DD) inside the wanted period, Europe/Berlin. */
  priceHistory: (siteId: string, range: HistoryRange, at: string) =>
    request<PriceHistory>(`/api/v1/sites/${siteId}/price-history?range=${range}&at=${at}`),
  weather: (siteId: string) => request<WeatherForecast>(`/api/v1/sites/${siteId}/weather`),
  schedule: (siteId: string) => request<SchedulePlan>(`/api/v1/sites/${siteId}/schedule`),
  forecastQuality: (siteId: string, days = 30) =>
    request<ForecastQuality>(`/api/v1/sites/${siteId}/forecast-quality?days=${days}`),
  /** at = any ISO date (YYYY-MM-DD) inside the wanted period, Europe/Berlin. */
  history: (siteId: string, range: HistoryRange, at: string) =>
    request<History>(`/api/v1/sites/${siteId}/history?range=${range}&at=${at}`),
  /** Ersparnis-Simulation: async job - POST starts (defaults from the site's
   * master data, body fields override), GET polls every ~2 s. */
  startSimulation: (siteId: string, input: SimulationRequestInput) =>
    request<{ simulationId: string }>(`/api/v1/sites/${siteId}/simulation`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  simulationStatus: (siteId: string, simulationId: string) =>
    request<SimulationStatus>(`/api/v1/sites/${siteId}/simulation/${simulationId}`),
};
