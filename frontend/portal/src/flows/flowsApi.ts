/**
 * Flow-editor API client (platform-admin only, backend AdminFlowController).
 * Like optimizerApi, the page carries its own Mandant→Anlage picker and passes
 * the tenant EXPLICITLY per call via the X-Tenant-Id header (spread last in
 * request(), so it wins over the shell's module-global switcher override).
 */
import { api, request } from '../api';
import { optimizerApi } from '../optimizerApi';
import type { SimulationStatus } from '../simulation';
import type { EditorEntity, FlowDocument } from './model';
import type { FlowFinding } from './validate';

export interface FlowVersion {
  flowId: string;
  flowVersion: number;
  siteId: string;
  name: string;
  runtime: string;
  lifecycle: string;
  document: FlowDocument;
  simulation: FlowSimulationSummary | null;
  createdAt: string;
  updatedAt: string;
  simulatedAt: string | null;
  activatedAt: string | null;
}

export interface FlowSummary {
  flowId: string;
  name: string;
  runtime: string;
  latestVersion: number;
  latestLifecycle: string;
  activeVersion: number | null;
  updatedAt: string;
  simulation: FlowSimulationSummary | null;
  latestDocument: FlowDocument;
  versions: number[];
}

export interface FlowSimulationSummary {
  simulationId: string;
  scenario: 'voltpilot' | 'standardSpeicher';
  finishedAt: string;
  headline?: { gesamtVorteilNettoEur?: number; voltpilotVorteilNettoEur?: number };
  preisjahr?: string;
}

export interface FlowValidationResult {
  valid: boolean;
  findings: FlowFinding[];
}

export interface FlowActivationResult {
  activated: boolean;
  reason?: string;
  message: string;
  published: boolean;
  deviceId?: string;
  lifecycle: string;
}

/** The poll document: the Ersparnis-Simulation status + which scenario is the flow. */
export interface FlowSimulationStatus extends SimulationStatus {
  flowScenario: 'voltpilot' | 'standardSpeicher';
}

/** Raw v2 entity row of the admin registry endpoint. */
interface EntityAdminDto {
  id: string;
  entityType: string | null;
  role: string;
  label: string | null;
  capabilities: {
    measure?: Array<{ channel: string }>;
    actuate?: Array<{ command: string }>;
  } | null;
}

function tenantHeaders(tenantId: string): RequestInit {
  return { headers: { 'X-Tenant-Id': tenantId } };
}

export const flowsApi = {
  list: (tenantId: string, siteId: string) =>
    request<FlowSummary[]>(`/api/v1/admin/sites/${siteId}/flows`, tenantHeaders(tenantId)),

  create: (tenantId: string, siteId: string, name: string, document?: FlowDocument) =>
    request<FlowVersion>(`/api/v1/admin/sites/${siteId}/flows`, {
      method: 'POST',
      body: JSON.stringify({ name, document }),
      ...tenantHeaders(tenantId),
    }),

  get: (tenantId: string, siteId: string, flowId: string, version: number) =>
    request<FlowVersion>(
      `/api/v1/admin/sites/${siteId}/flows/${flowId}/versions/${version}`,
      tenantHeaders(tenantId),
    ),

  /** Save. The response may carry a NEW version (editing simulated/active). */
  save: (
    tenantId: string,
    siteId: string,
    flowId: string,
    version: number,
    name: string,
    document: FlowDocument,
  ) =>
    request<FlowVersion>(
      `/api/v1/admin/sites/${siteId}/flows/${flowId}/versions/${version}`,
      {
        method: 'PUT',
        body: JSON.stringify({ name, document }),
        ...tenantHeaders(tenantId),
      },
    ),

  remove: (tenantId: string, siteId: string, flowId: string) =>
    request<void>(`/api/v1/admin/sites/${siteId}/flows/${flowId}`, {
      method: 'DELETE',
      ...tenantHeaders(tenantId),
    }),

  validate: (tenantId: string, siteId: string, flowId: string, version: number) =>
    request<FlowValidationResult>(
      `/api/v1/admin/sites/${siteId}/flows/${flowId}/versions/${version}/validate`,
      { method: 'POST', ...tenantHeaders(tenantId) },
    ),

  simulate: (tenantId: string, siteId: string, flowId: string, version: number) =>
    request<{ simulationId: string; flowScenario: string }>(
      `/api/v1/admin/sites/${siteId}/flows/${flowId}/versions/${version}/simulate`,
      { method: 'POST', ...tenantHeaders(tenantId) },
    ),

  simulationStatus: (
    tenantId: string,
    siteId: string,
    flowId: string,
    version: number,
    simulationId: string,
  ) =>
    request<FlowSimulationStatus>(
      `/api/v1/admin/sites/${siteId}/flows/${flowId}/versions/${version}`
      + `/simulation/${simulationId}`,
      tenantHeaders(tenantId),
    ),

  activate: (tenantId: string, siteId: string, flowId: string, version: number) =>
    request<FlowActivationResult>(
      `/api/v1/admin/sites/${siteId}/flows/${flowId}/versions/${version}/activate`,
      { method: 'POST', ...tenantHeaders(tenantId) },
    ),

  /** The site's v2 entities mapped to the editor's capability view. */
  entities: async (tenantId: string, siteId: string): Promise<EditorEntity[]> => {
    const rows = await request<EntityAdminDto[]>(
      `/api/v1/admin/sites/${siteId}/v2-entities`,
      tenantHeaders(tenantId),
    );
    return rows
      .filter((row) => row.entityType != null)
      .map((row) => ({
        id: row.id,
        entityType: row.entityType ?? '',
        label: row.label && row.label.trim() ? row.label : row.id,
        measure: row.capabilities?.measure?.map((m) => m.channel) ?? [],
        actuate: row.capabilities?.actuate?.map((a) => a.command) ?? [],
      }));
  },
};

// --- E3b: the site-bound editor API (one editor, two surfaces) --------------

/** Gated strategy node types + their per-site enablement (AE7 governance). */
export interface FlowNodeGovernance {
  gatedNodes: Array<{ type: string; label: string; gated: boolean; enabled: boolean }>;
}

export interface FlowDeactivationResult {
  deactivated: boolean;
  published: boolean;
  message: string;
  lifecycle: string;
}

/** The SoC band the guard bar shows (null = not readable on this surface). */
export interface FlowSocBands {
  socMinPct: number | null;
  socMaxPct: number | null;
  backupReserveSocPct: number | null;
}

/**
 * The editor's API surface, PRE-BOUND to a site - so ONE {@link FlowEditorPage}
 * (palette/canvas/inspector) drives both the platform-admin flow console and the
 * customer "Steuerung" section without a forked editor. The two factories below
 * differ only in the routes + tenant handling; every response shape is identical.
 */
export interface BoundFlowApi {
  list(): Promise<FlowSummary[]>;
  create(name: string, document?: FlowDocument): Promise<FlowVersion>;
  get(flowId: string, version: number): Promise<FlowVersion>;
  save(flowId: string, version: number, name: string, document: FlowDocument): Promise<FlowVersion>;
  remove(flowId: string): Promise<void>;
  validate(flowId: string, version: number): Promise<FlowValidationResult>;
  simulate(flowId: string, version: number): Promise<{ simulationId: string; flowScenario: string }>;
  simulationStatus(
    flowId: string, version: number, simulationId: string,
  ): Promise<FlowSimulationStatus>;
  activate(flowId: string, version: number): Promise<FlowActivationResult>;
  deactivate(flowId: string): Promise<FlowDeactivationResult>;
  entities(): Promise<EditorEntity[]>;
  governance(): Promise<FlowNodeGovernance>;
  /** The SoC band for the guard bar, or null when this surface cannot read it. */
  socBands(): Promise<FlowSocBands | null>;
}

/** The platform-admin bound API (explicit X-Tenant-Id, admin routes). */
export function adminFlowApi(tenantId: string, siteId: string): BoundFlowApi {
  return {
    list: () => flowsApi.list(tenantId, siteId),
    create: (name, document) => flowsApi.create(tenantId, siteId, name, document),
    get: (flowId, version) => flowsApi.get(tenantId, siteId, flowId, version),
    save: (flowId, version, name, document) =>
      flowsApi.save(tenantId, siteId, flowId, version, name, document),
    remove: (flowId) => flowsApi.remove(tenantId, siteId, flowId),
    validate: (flowId, version) => flowsApi.validate(tenantId, siteId, flowId, version),
    simulate: (flowId, version) => flowsApi.simulate(tenantId, siteId, flowId, version),
    simulationStatus: (flowId, version, simulationId) =>
      flowsApi.simulationStatus(tenantId, siteId, flowId, version, simulationId),
    activate: (flowId, version) => flowsApi.activate(tenantId, siteId, flowId, version),
    deactivate: (flowId) =>
      request<FlowDeactivationResult>(
        `/api/v1/admin/sites/${siteId}/flows/${flowId}/deactivate`,
        { method: 'POST', ...tenantHeaders(tenantId) },
      ),
    entities: () => flowsApi.entities(tenantId, siteId),
    governance: () =>
      request<FlowNodeGovernance>(
        `/api/v1/admin/sites/${siteId}/flow-node-governance`,
        tenantHeaders(tenantId),
      ),
    socBands: () =>
      optimizerApi.config(tenantId, siteId)
        .then((config) => ({
          socMinPct: config.effective.socMinPct,
          socMaxPct: config.effective.socMaxPct,
          backupReserveSocPct: config.effective.backupReserveSocPct,
        }))
        .catch(() => null),
  };
}

/**
 * The CUSTOMER bound API (tenant from the JWT, no X-Tenant-Id header): the
 * /api/v1/sites/** flow routes (E3b). Governance is READ-ONLY here (the customer
 * cannot enable a gated node); the guard bar's SoC band is not readable on the
 * customer surface, so guardChips renders those chips honestly absent.
 */
export function customerFlowApi(siteId: string): BoundFlowApi {
  const base = `/api/v1/sites/${siteId}/flows`;
  return {
    list: () => request<FlowSummary[]>(base),
    create: (name, document) =>
      request<FlowVersion>(base, { method: 'POST', body: JSON.stringify({ name, document }) }),
    get: (flowId, version) => request<FlowVersion>(`${base}/${flowId}/versions/${version}`),
    save: (flowId, version, name, document) =>
      request<FlowVersion>(`${base}/${flowId}/versions/${version}`, {
        method: 'PUT',
        body: JSON.stringify({ name, document }),
      }),
    remove: (flowId) => request<void>(`${base}/${flowId}`, { method: 'DELETE' }),
    validate: (flowId, version) =>
      request<FlowValidationResult>(`${base}/${flowId}/versions/${version}/validate`,
        { method: 'POST' }),
    simulate: (flowId, version) =>
      request<{ simulationId: string; flowScenario: string }>(
        `${base}/${flowId}/versions/${version}/simulate`, { method: 'POST' }),
    simulationStatus: (flowId, version, simulationId) =>
      request<FlowSimulationStatus>(
        `${base}/${flowId}/versions/${version}/simulation/${simulationId}`),
    activate: (flowId, version) =>
      request<FlowActivationResult>(`${base}/${flowId}/versions/${version}/activate`,
        { method: 'POST' }),
    deactivate: (flowId) =>
      request<FlowDeactivationResult>(`${base}/${flowId}/deactivate`, { method: 'POST' }),
    entities: async () => {
      const surface = await api.siteEntities(siteId);
      return surface.entities.map((row) => ({
        id: row.id,
        entityType: row.entityType,
        label: row.label && row.label.trim() ? row.label : row.id,
        measure: row.capabilities?.measure?.map((m) => m.channel) ?? [],
        actuate: row.capabilities?.actuate?.map((a) => a.command) ?? [],
      }));
    },
    governance: () =>
      request<FlowNodeGovernance>(`/api/v1/sites/${siteId}/flow-node-governance`),
    // The customer surface has no optimizer-config read; the guard bar renders
    // the site-derived chips (netzladen/max-feed-in/Leistungspreis) and omits the
    // SoC band honestly (guardbar handles null).
    socBands: () => Promise.resolve(null),
  };
}
