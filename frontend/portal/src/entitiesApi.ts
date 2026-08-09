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

  /**
   * Edit an entity's CONFIG (guards, rated power, capabilities) - the
   * installer/admin editor. Renaming has its own customer route, see
   * {@link entitiesApi.rename}.
   */
  update: (siteId: string, pointId: string, body: SaveEntityInput) =>
    request<SiteEntity>(`/api/v1/admin/sites/${siteId}/v2-entities/${pointId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  /**
   * Rename a component - the customer's own name (concept vp-entity-alias-k1).
   * CUSTOMER route (RLS-fenced, own site only, admins via the X-Tenant-Id
   * switcher), and deliberately its OWN route rather than a label-only `update`:
   * that one is admin-gated and also carries guard/capability fields, so a
   * customer could never have reached it and a rename would have travelled next
   * to config it must never touch (R1).
   *
   * `null` clears the name - back to the derived one, never an empty label (R5).
   * Every component may be renamed, including the platform-composed
   * battery/grid/house rows: a name changes neither what a component IS nor
   * whether it exists.
   */
  rename: (siteId: string, entityId: string, label: string | null) =>
    request<AdminEntity>(`/api/v1/sites/${siteId}/v2-entities/${entityId}/label`, {
      method: 'PUT',
      body: JSON.stringify({ label: label ?? '' }),
    }),

  /**
   * Remove an entity (v1-backed rows only lose their entity config).
   * `purgePoint` additionally deletes the measurement point outright - kWp
   * released from the aggregate, source pin freed - the duplicate-cleanup
   * lever (vp-vier-erzeuger-p9): without it a wrongly adopted duplicate
   * reappears as "Neues Gerät gefunden" forever.
   */
  remove: (siteId: string, pointId: string, opts?: { purgePoint?: boolean }) =>
    request<void>(
      `/api/v1/admin/sites/${siteId}/v2-entities/${pointId}`
        + (opts?.purgePoint ? '?purgePoint=true' : ''),
      { method: 'DELETE' },
    ),

  /**
   * Re-pin an entity to a currently reported edge source ("Wieder verbinden",
   * vp-vier-erzeuger-p9). CUSTOMER route (RLS-fenced, own site only) - the
   * repair for identity churn/crossed pins: reconnects the existing component
   * instead of adopting a duplicate. 409 = source already pinned elsewhere,
   * 422 = not reported / role mismatch.
   */
  repin: (siteId: string, entityId: string, sourceId: string, opts?: { swap?: boolean }) =>
    request<AdminEntity>(`/api/v1/sites/${siteId}/v2-entities/${entityId}/edge-source`, {
      method: 'POST',
      body: JSON.stringify(opts?.swap ? { sourceId, swap: true } : { sourceId }),
    }),

  /**
   * Delete an adopted component - the CUSTOMER cleanup lever
   * (vp-bereinigung-ui-k3). Removes the measurement point outright: its kWp is
   * released from the plant total and its device becomes free, so it reappears
   * as "Neues Gerät gefunden" and can be assigned to the right component.
   * RLS-fenced to the caller's own site; the platform-composed base components
   * (battery-hybrid / house-load) and unpinned rows are refused with 422.
   */
  removeComponent: (siteId: string, entityId: string) =>
    request<void>(`/api/v1/sites/${siteId}/v2-entities/${entityId}`, { method: 'DELETE' }),

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
