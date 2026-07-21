import { request, type CreateSiteInput, type Site } from '../api';
import type { SimulationRequestInput, SimulationStatus } from '../simulation';

export type { CreateSiteInput, Site } from '../api';

/**
 * Platform-admin API client (tenants + customer users). Every call goes to
 * /api/v1/admin/** which the backend gates with hasRole('platform-admin'), so a
 * customer token gets 403 - the UI only reveals this surface to Portal-Admins,
 * but the backend is the real boundary.
 */

export interface Tenant {
  id: string;
  name: string;
  segment: string;
  plan: string;
  /** U0 shell-frame override; null = automatic (derived from the site count). */
  betriebsart: 'endkunde' | 'betreiber' | null;
  /** The resolved frame the shell keys on: the override, else null = unknown. */
  betriebsartEffective: 'endkunde' | 'betreiber' | null;
  createdAt: string;
}

export interface AdminUser {
  id: string;
  username: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  enabled: boolean;
  tenantId: string | null;
}

export interface CreateTenantInput {
  name: string;
  segment?: string;
}

export interface CreateUserInput {
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  password?: string;
  temporaryPassword?: boolean;
}

export interface ResetPasswordInput {
  password: string;
  temporary?: boolean;
}

export interface ProvisionedDevice {
  externalRef: string;
  kind: string;
  note: string | null;
  provisionedAt: string;
  claimed: boolean;
  claimedByTenant: string | null;
}

export interface ProvisionDeviceInput {
  externalRef: string;
  kind?: string;
  note?: string;
}

export interface UpdateTenantInput {
  name: string;
  segment?: string;
  /**
   * U0 shell-frame override, full representation: 'endkunde'/'betreiber' set
   * it, null/omitted clears it back to the automatic segment-derived default.
   */
  betriebsart?: 'endkunde' | 'betreiber' | null;
}

export interface UpdateUserInput {
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

/** Report of what the tenant offboarding removed (DB transactional, Keycloak best-effort). */
export interface TenantOffboardingReport {
  tenantId: string;
  tenantName: string;
  deletedSites: number;
  deletedDevices: number;
  deletedTelemetryRows: number;
  deletedUsers: string[];
  /** Keycloak logins that could not be deleted - need manual cleanup. */
  failedUsers: string[];
}

export const adminApi = {
  listTenants: () => request<Tenant[]>('/api/v1/admin/tenants'),

  createTenant: (input: CreateTenantInput) =>
    request<Tenant>('/api/v1/admin/tenants', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateTenant: (tenantId: string, input: UpdateTenantInput) =>
    request<Tenant>(`/api/v1/admin/tenants/${tenantId}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  // Type-to-confirm offboarding: confirmName must equal the tenant's exact
  // name or the backend refuses (400) before touching anything.
  deleteTenant: (tenantId: string, confirmName: string) =>
    request<TenantOffboardingReport>(`/api/v1/admin/tenants/${tenantId}/delete`, {
      method: 'POST',
      body: JSON.stringify({ confirmName }),
    }),

  listUsers: (tenantId: string) =>
    request<AdminUser[]>(`/api/v1/admin/tenants/${tenantId}/users`),

  createUser: (tenantId: string, input: CreateUserInput) =>
    request<AdminUser>(`/api/v1/admin/tenants/${tenantId}/users`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateUser: (tenantId: string, userId: string, input: UpdateUserInput) =>
    request<AdminUser>(`/api/v1/admin/tenants/${tenantId}/users/${userId}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  disableUser: (tenantId: string, userId: string) =>
    request<AdminUser>(`/api/v1/admin/tenants/${tenantId}/users/${userId}/disable`, {
      method: 'POST',
    }),

  enableUser: (tenantId: string, userId: string) =>
    request<AdminUser>(`/api/v1/admin/tenants/${tenantId}/users/${userId}/enable`, {
      method: 'POST',
    }),

  deleteUser: (tenantId: string, userId: string) =>
    request<void>(`/api/v1/admin/tenants/${tenantId}/users/${userId}`, {
      method: 'DELETE',
    }),

  // Support lever: no SMTP means no self-service reset, so support sets a new
  // (default temporary) password here; any brute-force lockout is lifted too.
  resetPassword: (tenantId: string, userId: string, input: ResetPasswordInput) =>
    request<AdminUser>(`/api/v1/admin/tenants/${tenantId}/users/${userId}/reset-password`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  listSites: (tenantId: string) =>
    request<Site[]>(`/api/v1/admin/tenants/${tenantId}/sites`),

  createSite: (tenantId: string, input: CreateSiteInput) =>
    request<Site>(`/api/v1/admin/tenants/${tenantId}/sites`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  listProvisionedDevices: () =>
    request<ProvisionedDevice[]>('/api/v1/admin/provisioned-devices'),

  provisionDevice: (input: ProvisionDeviceInput) =>
    request<ProvisionedDevice>('/api/v1/admin/provisioned-devices', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  // 409 while a customer's claim references the ID (unclaim the device first).
  deleteProvisionedDevice: (externalRef: string) =>
    request<void>(`/api/v1/admin/provisioned-devices/${encodeURIComponent(externalRef)}`, {
      method: 'DELETE',
    }),

  // Ersparnis-Rechner (prospect simulation): explicit inputs, no site/tenant,
  // nothing persisted - the async job lives in the simulation service.
  startProspectSimulation: (input: SimulationRequestInput) =>
    request<{ simulationId: string }>('/api/v1/admin/simulation', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  prospectSimulationStatus: (simulationId: string) =>
    request<SimulationStatus>(`/api/v1/admin/simulation/${simulationId}`),
};
