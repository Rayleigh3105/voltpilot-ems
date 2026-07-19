/**
 * Platform-admin API for v2 entity management ("Geräte & Entitäten", E1b).
 * The customer READ surface is `api.siteEntities` / `api.entityHistory`; WRITES
 * (create/edit/delete + the type catalog) are admin-only under
 * /api/v1/admin/sites/{siteId}/v2-entities, reached from inside a customer
 * page through the shell's `X-Tenant-Id` switcher (like optimizerApi). Callers
 * must fail soft - a customer token or missing tenant selection gets 403/404.
 */
import { request, type SiteEntity } from './api';

/** One entity type as the data-driven catalog declares it. */
export interface EntityTypeDef {
  type: string;
  label: string;
  category: 'storage' | 'producer' | 'meter' | 'consumer';
  controllable: boolean;
  composed: boolean;
  default_failsafe: string;
}

export interface EntityTypeCatalog {
  catalog_version: string;
  types: EntityTypeDef[];
}

/** Create/edit body. capabilities/guards are optional JSON overrides. */
export interface SaveEntityInput {
  entityType?: string;
  label?: string | null;
  maxPowerKw?: number | null;
  capabilities?: SiteEntity['capabilities'];
  guards?: SiteEntity['guards'];
}

export const entitiesApi = {
  /** The data-driven entity-type catalog (admin editor palette). */
  typeCatalog: () => request<EntityTypeCatalog>('/api/v1/admin/entity-type-catalog'),

  /** Create a v2-native entity of an open catalog type. */
  create: (siteId: string, body: SaveEntityInput) =>
    request<SiteEntity>(`/api/v1/admin/sites/${siteId}/v2-entities`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** Edit an entity (label; config only for non-composed types). */
  update: (siteId: string, pointId: string, body: SaveEntityInput) =>
    request<SiteEntity>(`/api/v1/admin/sites/${siteId}/v2-entities/${pointId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  /** Remove an entity (v1-backed rows only lose their entity config). */
  remove: (siteId: string, pointId: string) =>
    request<void>(`/api/v1/admin/sites/${siteId}/v2-entities/${pointId}`, {
      method: 'DELETE',
    }),
};
