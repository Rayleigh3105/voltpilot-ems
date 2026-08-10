/**
 * API client for the steuerbare-Verbraucher surface (Increment 1). Reuses the
 * shared `request` (so the shell's X-Tenant-Id switcher applies for an admin
 * acting in a customer page, like entitiesApi/optimizerApi). Every route is
 * tenant-scoped by RLS - a foreign site is 404.
 */
import { request } from '../api';
import type {
  Consumer,
  ConsumerOptions,
  ConsumerPolicyDocument,
  ConsumerPolicyVersion,
} from './types';

export interface CreateConsumerBody {
  type: string;
  name?: string;
  ratedPowerKw: number;
  controlKind?: string;
  levelsKw?: number[];
  minPowerKw?: number;
  resolutionKw?: number;
  powerRangesKw?: number[][];
  storageRelation?: string;
  defaultGridEnergyPolicy?: string;
  allowStorageDischarge?: boolean;
  failsafe?: string;
  edgeSourceId?: string;
}

export interface PatchConsumerBody {
  name?: string;
  ratedPowerKw?: number;
  controlKind?: string;
  levelsKw?: number[];
  minPowerKw?: number;
  resolutionKw?: number;
  powerRangesKw?: number[][];
  storageRelation?: string;
  defaultGridEnergyPolicy?: string;
  allowStorageDischarge?: boolean;
  failsafe?: string;
  enabled?: boolean;
  expectedVersion?: number;
}

const base = (siteId: string) => `/api/v1/sites/${siteId}/consumers`;

/**
 * The activate/resume outcome envelope (the flows-activation pattern):
 * `activated:false` + `reason`/`message` is an HONEST refusal, not a transport
 * error - the German `message` is customer copy.
 */
export interface PolicyActivationOutcome {
  activated: boolean;
  reason: string | null;
  message: string;
  published: boolean;
  policyVersion: number | null;
}

/** The stop half (deactivate/pause): flag-independent, always available. */
export interface PolicyStopOutcome {
  published: boolean;
  message: string;
}

export const consumersApi = {
  options: (siteId: string) =>
    request<ConsumerOptions>(`/api/v1/sites/${siteId}/consumer-options`),
  list: (siteId: string) => request<Consumer[]>(base(siteId)),
  /**
   * Edge-reported live states (Inkrement 3, D9). An empty list is the honest
   * no-evidence state - the surface then renders exactly like before.
   */
  status: (siteId: string) =>
    request<import('./status').ConsumerRuntimeStatus[]>(
      `/api/v1/sites/${siteId}/consumer-status`),
  get: (siteId: string, id: string) => request<Consumer>(`${base(siteId)}/${id}`),
  create: (siteId: string, body: CreateConsumerBody) =>
    request<Consumer>(base(siteId), { method: 'POST', body: JSON.stringify(body) }),
  patch: (siteId: string, id: string, body: PatchConsumerBody) =>
    request<Consumer>(`${base(siteId)}/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  remove: (siteId: string, id: string) =>
    request<void>(`${base(siteId)}/${id}`, { method: 'DELETE' }),
  /** The latest policy, or null when none authored yet (endpoint answers 204). */
  getPolicy: async (siteId: string, id: string): Promise<ConsumerPolicyVersion | null> =>
    (await request<ConsumerPolicyVersion | undefined>(`${base(siteId)}/${id}/policy`)) ?? null,
  savePolicy: (siteId: string, id: string, document: ConsumerPolicyDocument) =>
    request<ConsumerPolicyVersion>(`${base(siteId)}/${id}/policy`, {
      method: 'PUT',
      body: JSON.stringify({ document }),
    }),
  /** Activate the latest saved draft (§11 atomic: validate → compile → rollout). */
  activatePolicy: (siteId: string, id: string) =>
    request<PolicyActivationOutcome>(`${base(siteId)}/${id}/policy/activate`, { method: 'POST' }),
  /** Retire the active rule + retract the generated automation (flag-independent). */
  deactivatePolicy: (siteId: string, id: string) =>
    request<PolicyStopOutcome>(`${base(siteId)}/${id}/policy/deactivate`, { method: 'POST' }),
  /** Pause: the device failsafe takes over; the rule stays stored (flag-independent). */
  pause: (siteId: string, id: string) =>
    request<PolicyStopOutcome>(`${base(siteId)}/${id}/pause`, { method: 'POST' }),
  /** Resume after a pause: re-enable + re-deploy the stored artifact. */
  resume: (siteId: string, id: string) =>
    request<PolicyActivationOutcome>(`${base(siteId)}/${id}/resume`, { method: 'POST' }),

  // -- fulfilment ledger + manual override (Inkrement 5) -------------------

  /** The fulfilment ledger of one consumer (§9.4): Ist derived from telemetry. */
  fulfillment: (siteId: string, id: string) =>
    request<import('./fulfillment').ConsumerFulfilment>(`${base(siteId)}/${id}/fulfillment`),
  /** Every ACTIVE (unexpired) manual override of the site's consumers. */
  overrides: (siteId: string) =>
    request<import('./fulfillment').ManualOverride[]>(
      `/api/v1/sites/${siteId}/consumer-overrides`),
  /** "Jetzt starten"/"Jetzt stoppen" (§14.13): a TTL-bound intervention. */
  startOverride: (
    siteId: string,
    id: string,
    body: { action: 'start' | 'stop'; durationMinutes?: number; setpointKw?: number },
  ) =>
    request<ConsumerOverrideOutcome>(`${base(siteId)}/${id}/override`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** "Automatik fortsetzen": end the manual intervention now. */
  clearOverride: (siteId: string, id: string) =>
    request<ConsumerOverrideOutcome>(`${base(siteId)}/${id}/override`, { method: 'DELETE' }),
};

/** The override start/stop/resume outcome (honest `pushed` while the flag is off). */
export interface ConsumerOverrideOutcome {
  applied: boolean;
  pushed: boolean;
  kind: string;
  endsAt: string | null;
  effectivePowerKw: number | null;
  gridImportPossible: boolean;
  ttlCapped: boolean;
  message: string;
}
