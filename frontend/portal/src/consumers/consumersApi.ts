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
};
