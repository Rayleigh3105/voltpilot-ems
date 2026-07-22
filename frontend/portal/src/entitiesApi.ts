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

/** Adopt an edge-reported source into a v2 entity (U2). */
export interface AdoptInput {
  sourceId: string;
  entityType: string;
  label?: string;
  /** Consumer rated power (bounds commands). */
  maxPowerKw?: number;
  /** Producer nameplate (kWp) - sums into the aggregate site PV. */
  capacityKwp?: number;
  /** MaStR SEE number of the source. */
  registryUnitId?: string;
}

/** One entity as the admin registry surface returns it (bootstrap/create/list). */
export interface AdminEntity {
  id: string;
  entityType: string;
  role: string;
  label: string | null;
  deviceId: string | null;
}

/** The v2 pilot-entity bootstrap response (compose from v1 master data + push). */
export interface EntityBootstrapResult {
  entities: AdminEntity[];
  skipped: string[];
  push: { published: boolean; reason: string | null } | null;
}

/** The AE7 auto-start-flow seeding outcome (created, or skipped with a reason). */
export interface AutoStartOutcome {
  created: boolean;
  reason: string | null;
  profile: string | null;
  flowId: string | null;
  version: number | null;
  name: string | null;
  message: string | null;
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

  /**
   * Adopt an edge-reported source into a v2 entity (Portal v3 M6 "Neues Gerät
   * gefunden", the one-move Zuordnen). Idempotent per {@code sourceId}: a
   * re-adopt returns the existing entity. A consumer type becomes a v2-native
   * entity; a composed producer/grid-meter is recorded as a read-only source
   * (its kWp / MaStR SEE # captured here).
   *
   * Points at the CUSTOMER twin `POST /api/v1/sites/{id}/v2-entities/adopt`
   * (RLS-fenced, catalog-guarded to the guided types — the SiteFlowController
   * pattern; O3 built in M6). Admins reach it through the X-Tenant-Id switcher.
   * If the twin is absent (older backend) the call is 401/403/404 and the
   * caller falls back to the honest "VoltPilot richtet das ein" hint.
   */
  adopt: (siteId: string, body: AdoptInput) =>
    request<AdminEntity>(`/api/v1/sites/${siteId}/v2-entities/adopt`, {
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

  /**
   * AE5 onboarding: compose the site's pilot entities (battery-hybrid / producer
   * / grid-meter) from its v1 master data and best-effort push the registry to
   * the gateway device. Idempotent - re-running refreshes. Admin-only.
   */
  bootstrap: (siteId: string) =>
    request<EntityBootstrapResult>(`/api/v1/admin/sites/${siteId}/v2-entities/bootstrap`, {
      method: 'POST',
    }),

  /**
   * AE7 auto-start (spec §3): seed the site's derived-profile starter flow DRAFT
   * if it has none, so onboarding never dead-ends on an empty editor. Idempotent
   * (an existing flow / no battery is skipped, never an error). Admin-only.
   */
  autoStart: (siteId: string) =>
    request<AutoStartOutcome>(`/api/v1/admin/sites/${siteId}/flows/auto-start`, {
      method: 'POST',
    }),
};
