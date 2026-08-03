import { request } from './api';

/**
 * Portal-Admin optimizer surface client (backend PR #125): the per-site "why"
 * diagnostics + the per-site/per-asset config panel. Both endpoints are
 * platform-admin-gated and read/write ONE tenant's own site through the
 * RLS-scoped app datasource - the tenant is selected with the `X-Tenant-Id`
 * switcher header, exactly like every other admin-reads-customer-data feature.
 *
 * This page carries its own Mandant->Anlage picker, so it passes the tenant
 * EXPLICITLY per call (the header wins over the shell's module-global override,
 * since request() spreads init.headers last). That keeps the page independent
 * of whatever tenant the top-bar switcher happens to point at.
 *
 * The types mirror the merged DTOs (OptimizerDiagnosticsDto /
 * OptimizerDiagnosticsSlotDto / OptimizerConfigDto / UpdateOptimizerConfigRequest);
 * Jackson serialises the Java `BigDecimal`/`Double` fields to JSON numbers, and
 * a `null` here is the honest "not computable" the backend guarantees - never a
 * fabricated 0.
 */

/** solarladen | netzladen | entladen | ruhe (the schedule.ts chargeKind twin). */
export type DecisionLabel = 'solarladen' | 'netzladen' | 'entladen' | 'ruhe';

/** The battery parameters the €-decomposition priced with (null: no battery). */
export interface OptimizerBatteryContext {
  capacityKwh: number | null;
  roundtripEfficiencyPct: number | null;
  /** Effective per-cycle wear rate (override or platform default). */
  wearCostCtPerKwh: number;
  /** 'asset' (per-asset override) or 'platform-default'. */
  wearCostSource: string;
  socMinPct: number;
  socMaxPct: number;
}

/**
 * One plan slot + its €-decomposition. The persisted schedule columns pass
 * through (null where the optimizer wrote none); the ct/kWh components are
 * `null` when honestly not computable for the slot (no persisted spot, pre-P2
 * wear rows). {@link OptimizerDiagnostics.storedEnergyValueIsApproximation}
 * flags valueOfStoredEnergyCtKwh as a forward heuristic, not a MILP dual.
 */
export interface OptimizerSlot {
  time: string;
  batteryKw: number | null;
  gridKw: number | null;
  socPct: number | null;
  loadKw: number | null;
  pvKw: number | null;
  curtailKw: number | null;
  costEur: number | null;
  baselineCostEur: number | null;
  wearCostEur: number | null;
  solverPriceCtKwh: number | null;
  importPriceCtKwh: number | null;
  exportValueCtKwh: number | null;
  wearCostCtKwh: number | null;
  valueOfStoredEnergyCtKwh: number | null;
  decisionLabel: DecisionLabel | string;
  whyText: string | null;
}

/** The admin "why" view of one persisted optimizer run. */
export interface OptimizerDiagnostics {
  siteId: string;
  planId: string | null;
  generatedAt: string | null;
  slotMinutes: number;
  /** ONE Berlin day's runs (newest first) - the day the `date` param picked, else the shown run's day. */
  availableRuns: string[];
  /** The Berlin day (YYYY-MM-DD) availableRuns covers; null without any plan. */
  availableRunsDate: string | null;
  /** Berlin day of the site's oldest run - lower bound for the date picker (null: no plan). */
  firstRunDate: string | null;
  /** Berlin day of the site's newest run - upper bound for the date picker (null: no plan). */
  lastRunDate: string | null;
  plantKind: string;
  netzladenErlaubt: boolean;
  tarifArt: string;
  tarifParamCtKwh: number | null;
  anzulegenderWertCtKwh: number | null;
  backupReserveSocPct: number | null;
  battery: OptimizerBatteryContext | null;
  activeLoadModel: string;
  activePvModel: string;
  /**
   * Which rule sets the site's grid-import price today (Stufe 2 admin echo):
   * `fest` | `preisblatt` | `sammelaufschlag` | `default-flag` | `spot`. A
   * `spot` value on a household is the dangerous un-maintained default the
   * Nachtbezug report warns about.
   */
  priceSource: string;
  storedEnergyValueIsApproximation: boolean;
  slots: OptimizerSlot[];
}

/** The optimizer's platform-wide tunables (env-level; read-only in the panel). */
export interface OptimizerPlatformDefaults {
  wearCostCtPerKwh: number;
  socMinPct: number;
  socMaxPct: number;
  terminalValueQuantile: number;
  terminalValueCtPerKwh: number | null;
}

/** Billing period of a Lastspitzenkappung Leistungspreis contract. */
export type LeistungspreisAbrechnung = 'jahr' | 'monat';

/**
 * Peak-shaving (Lastspitzenkappung) contract fields - DEFENSIVELY OPTIONAL:
 * the sibling backend task (vp-peakshave-core-p1) is adding them to the
 * optimizer-config DTOs. Until it ships the GET response omits them; the
 * portal probes presence (`supportsLastspitzenConfig` in moduleSurface.ts)
 * and hides the admin editing block when absent - never PUTs guessed fields.
 */
export interface LastspitzenConfigFields {
  leistungspreisEurKw?: number | null;
  leistungspreisAbrechnung?: LeistungspreisAbrechnung | null;
  lastspitzenReserveKw?: number | null;
}

/** The nullable per-site/per-asset override columns (null = default applies). */
export interface OptimizerOverrides extends LastspitzenConfigFields {
  wearCostCtPerKwh: number | null;
  socMinPct: number | null;
  socMaxPct: number | null;
  backupReserveSocPct: number | null;
}

/** What the optimizer resolves: override ?? platform default. */
export interface OptimizerEffective {
  wearCostCtPerKwh: number | null;
  socMinPct: number | null;
  socMaxPct: number | null;
  backupReserveSocPct: number | null;
}

/** Read-only echo of the site levers editable via PUT /api/v1/sites/{id}. */
export interface OptimizerSiteLevers {
  netzladenErlaubt: boolean;
  plantKind: string;
  tarifArt: string;
  tarifParamCtKwh: number | null;
  anzulegenderWertCtKwh: number | null;
}

export interface OptimizerConfig {
  siteId: string;
  hasBattery: boolean;
  defaults: OptimizerPlatformDefaults;
  overrides: OptimizerOverrides;
  effective: OptimizerEffective;
  site: OptimizerSiteLevers;
}

/**
 * Write the per-site/per-asset overrides (full-representation: a null field
 * CLEARS that override back to the platform default). Battery fields (wear +
 * SoC band) need a battery asset -> 409; an effective SoC band with min >= max
 * -> 400.
 */
export interface UpdateOptimizerConfig extends LastspitzenConfigFields {
  wearCostCtPerKwh: number | null;
  socMinPct: number | null;
  socMaxPct: number | null;
  backupReserveSocPct: number | null;
}

// ---- what-if re-optimize (design §4.3) --------------------------------------

/**
 * The knobs a what-if may move. EVERY field is optional and an ABSENT field
 * means "leave it as the site has it" - never zero. That is what makes an
 * empty body meaningful: it re-solves the site exactly as configured, which
 * is the baseline the variant is measured against.
 *
 * `backupReserveSocPct: 0` IS "no reserve" (a 0 % floor and no floor are the
 * same constraint), so there is no separate clear flag.
 */
export interface WhatIfOverrides {
  wearCostCtPerKwh?: number;
  backupReserveSocPct?: number;
  socMinPct?: number;
  socMaxPct?: number;
  netzladenErlaubt?: boolean;
  horizonSlots?: number;
}

/** One slot of a freshly solved (never persisted) plan. */
export interface WhatIfSlot {
  time: string;
  batteryKw: number | null;
  gridKw: number | null;
  socPct: number | null;
  pvKw: number | null;
  loadKw: number | null;
  curtailKw: number | null;
  priceEurMwh: number | null;
  costEur: number | null;
  baselineCostEur: number | null;
  wearCostEur: number | null;
  slotRole: string | null;
}

/** The knob values one solve actually used (so the panel never has to guess). */
export interface WhatIfKnobs {
  wearCostCtPerKwh: number;
  backupReserveSocPct: number | null;
  socMinPct: number;
  socMaxPct: number;
  netzladenErlaubt: boolean;
}

/**
 * One ephemeral solve. Money keeps the persisted schedule's discipline:
 * `savingsEur` is GROSS of wear, `wearCostEur` is separate, `netSavingsEur`
 * is the honest difference, and `bankedValueEur` prices what the plan carries
 * into the next day at its own terminal value.
 */
export interface WhatIfPlan {
  slotMinutes: number;
  costEur: number | null;
  baselineCostEur: number | null;
  savingsEur: number | null;
  wearCostEur: number | null;
  netSavingsEur: number | null;
  terminalValueEurPerKwh: number | null;
  bankedValueEur: number | null;
  chargedKwh: number | null;
  dischargedKwh: number | null;
  gridImportKwh: number | null;
  gridExportKwh: number | null;
  curtailedKwh: number | null;
  cycles: number | null;
  socStartPct: number | null;
  socEndPct: number | null;
  peakTargetKw: number | null;
  fallback14a: boolean;
  knobs: WhatIfKnobs;
  slots: WhatIfSlot[];
}

/** Variant minus baseline; a figure null on either side stays null. */
export type WhatIfDelta = Partial<
  Record<
    | 'costEur'
    | 'savingsEur'
    | 'wearCostEur'
    | 'netSavingsEur'
    | 'bankedValueEur'
    | 'chargedKwh'
    | 'dischargedKwh'
    | 'gridImportKwh'
    | 'gridExportKwh'
    | 'curtailedKwh'
    | 'cycles'
    | 'socEndPct'
    | 'peakTargetKw',
    number | null
  >
>;

/**
 * Two plans solved over ONE freshly gathered set of inputs, plus their delta.
 * NOTHING here was committed: no plan was persisted, no MQTT schedule was
 * published, and the site's stored settings and in-force run are untouched.
 */
export interface WhatIfResult {
  siteId: string;
  computedAt: string;
  horizonSlots: number;
  slotMinutes: number;
  /** Echo of the knobs that actually differed (untouched ones are absent). */
  appliedOverrides: Record<string, number | boolean>;
  baseline: WhatIfPlan;
  variant: WhatIfPlan;
  delta: WhatIfDelta;
}

function tenantHeaders(tenantId: string): RequestInit {
  return { headers: { 'X-Tenant-Id': tenantId } };
}

export const optimizerApi = {
  /**
   * One persisted run's "why" view. Omit generatedAt for the latest run;
   * `date` (YYYY-MM-DD, Europe/Berlin) scopes `availableRuns` to that day and
   * - without generatedAt - shows the day's newest run.
   */
  diagnostics: (
    tenantId: string,
    siteId: string,
    generatedAt?: string | null,
    date?: string | null,
  ) => {
    const params = new URLSearchParams();
    if (generatedAt) params.set('generatedAt', generatedAt);
    if (date) params.set('date', date);
    const query = params.toString();
    return request<OptimizerDiagnostics>(
      `/api/v1/admin/sites/${siteId}/optimizer-diagnostics${query ? `?${query}` : ''}`,
      tenantHeaders(tenantId),
    );
  },

  config: (tenantId: string, siteId: string) =>
    request<OptimizerConfig>(
      `/api/v1/admin/sites/${siteId}/optimizer-config`,
      tenantHeaders(tenantId),
    ),

  updateConfig: (tenantId: string, siteId: string, body: UpdateOptimizerConfig) =>
    request<OptimizerConfig>(`/api/v1/admin/sites/${siteId}/optimizer-config`, {
      method: 'PUT',
      body: JSON.stringify(body),
      ...tenantHeaders(tenantId),
    }),

  /**
   * Preview a knob change: solve this site twice on ONE fresh set of inputs
   * (as configured + with the overrides) and get both plans plus the delta.
   * Persists nothing, publishes nothing - the run in force stays in force.
   */
  whatIf: (tenantId: string, siteId: string, body: WhatIfOverrides) =>
    request<WhatIfResult>(`/api/v1/admin/sites/${siteId}/optimizer-what-if`, {
      method: 'POST',
      body: JSON.stringify(body),
      ...tenantHeaders(tenantId),
    }),

  /**
   * Switcher-context variants (no explicit tenant): the shell's module-global
   * X-Tenant-Id override applies, exactly like every other admin-reads-
   * customer-data surface. Used where a platform-admin acts INSIDE a customer
   * page (the Optimierung subpage, the Anlage-anlegen wizard). Callers must
   * fail soft - a customer token or a missing tenant selection gets 403/404.
   */
  configViaSwitcher: (siteId: string) =>
    request<OptimizerConfig>(`/api/v1/admin/sites/${siteId}/optimizer-config`),

  updateConfigViaSwitcher: (siteId: string, body: UpdateOptimizerConfig) =>
    request<OptimizerConfig>(`/api/v1/admin/sites/${siteId}/optimizer-config`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
};
