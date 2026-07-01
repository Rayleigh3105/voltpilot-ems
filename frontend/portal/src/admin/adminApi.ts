import { request } from '../api';

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

export const adminApi = {
  listTenants: () => request<Tenant[]>('/api/v1/admin/tenants'),

  createTenant: (input: CreateTenantInput) =>
    request<Tenant>('/api/v1/admin/tenants', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  listUsers: (tenantId: string) =>
    request<AdminUser[]>(`/api/v1/admin/tenants/${tenantId}/users`),

  createUser: (tenantId: string, input: CreateUserInput) =>
    request<AdminUser>(`/api/v1/admin/tenants/${tenantId}/users`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  disableUser: (tenantId: string, userId: string) =>
    request<AdminUser>(`/api/v1/admin/tenants/${tenantId}/users/${userId}/disable`, {
      method: 'POST',
    }),
};
