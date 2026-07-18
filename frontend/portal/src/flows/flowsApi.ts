/**
 * Flow-editor API client (platform-admin only, backend AdminFlowController).
 * Like optimizerApi, the page carries its own Mandant→Anlage picker and passes
 * the tenant EXPLICITLY per call via the X-Tenant-Id header (spread last in
 * request(), so it wins over the shell's module-global switcher override).
 */
import { request } from '../api';
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
