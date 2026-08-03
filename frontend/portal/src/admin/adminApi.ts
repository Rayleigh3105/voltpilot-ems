import { request, type CreateSiteInput, type Site } from '../api';
import type { EdgeUpdates } from '../adminEdgeUpdates';

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

/**
 * Ein Gerät, das sich gemeldet hat (CSR hochgeladen) und auf keinen Claim
 * trifft — die andere Hälfte des Tippfehler-Fensters: das Gerät „hat seinen
 * Teil getan", der Kunde hat eine andere Referenz getippt, und bis hierher war
 * dieser Zustand auf BEIDEN Seiten unsichtbar.
 *
 * `everIssued` unterscheidet „nie beansprucht" von „war beansprucht und wurde
 * getrennt" (ein Zertifikat wurde schon einmal ausgestellt).
 *
 * Mandantenlos per Konstruktion — ein Enrollment kennt keinen Mandanten.
 */
export interface PendingEnrollment {
  externalRef: string;
  deviceInfo: string | null;
  csrUpdatedAt: string;
  everIssued: boolean;
  issuedAt: string | null;
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

  /**
   * Geräte, die sich gemeldet haben, aber auf keinen Claim treffen. Cross-tenant
   * per Konstruktion (ein Enrollment kennt keinen Mandanten), deshalb ohne
   * Mandanten-Argument.
   */
  listPendingEnrollments: () =>
    request<PendingEnrollment[]>('/api/v1/admin/enrollments/pending'),

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

  // ── OTA Stufe 2 „Verteilen" ─────────────────────────────────────────────
  //
  // Alle Schreibwege sind platform-admin-gefenced; die Ehrlichkeits- und
  // Freigabe-REGELN stehen server-seitig (RolloutStates/BakeGate) - das Portal
  // rendert sie, es entscheidet nichts nach.

  /** Alles, was die Seite „Edge-Updates" zeigt, in EINEM Aufruf. */
  edgeUpdates: () => request<EdgeUpdates>('/api/v1/admin/edge-updates'),

  /** Rollout aus einem SIGNIERTEN Register-Eintrag starten (409 sonst). */
  createRollout: (input: {
    releaseSeq: number;
    channel?: string;
    waves: { name: string; devices: string[] }[];
  }) =>
    request<{ rolloutId: string }>('/api/v1/admin/rollouts', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /** Nächste Welle - der Server verweigert sie (409), solange das Bake offen ist. */
  promoteRollout: (rolloutId: string) =>
    request<void>(`/api/v1/admin/rollouts/${rolloutId}/promote`, { method: 'POST' }),

  pauseRollout: (rolloutId: string) =>
    request<void>(`/api/v1/admin/rollouts/${rolloutId}/pause`, { method: 'POST' }),

  resumeRollout: (rolloutId: string) =>
    request<void>(`/api/v1/admin/rollouts/${rolloutId}/resume`, { method: 'POST' }),

  /** Not-Aus. Endgültig: „weitermachen" ist ein neuer, bewusster Rollout. */
  haltRollout: (rolloutId: string, reason?: string) =>
    request<void>(`/api/v1/admin/rollouts/${rolloutId}/halt`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason ?? 'Von Hand eingefroren.' }),
    }),

  /** Einzelgerät: Release + Kanal + Pin setzen. */
  setUpdateTarget: (deviceId: string, input: {
    releaseSeq: number;
    channel?: string;
    pinned?: boolean;
  }) =>
    request<void>(`/api/v1/admin/devices/${deviceId}/update-target`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /** Zuweisung zurücknehmen (Zeile UND retained Nachricht). */
  revertUpdateTarget: (deviceId: string) =>
    request<void>(`/api/v1/admin/devices/${deviceId}/update-target/revert`, {
      method: 'POST',
    }),
};
