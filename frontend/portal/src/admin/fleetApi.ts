import {
  request,
  type ControlStatus,
  type CurtailmentStatus,
  type EdgeVersion,
  type Overview,
  type Site,
  type SiteSource,
} from '../api';

/**
 * Die Datenquelle der Plattform-Übersicht: dieselben KUNDEN-Endpunkte, die auch
 * eine Kundenseite liest, nur je Aufruf auf EINEN Mandanten gestellt.
 *
 * **Stufe 1 aggregiert bewusst client-seitig** (Captain-Entscheid Q3): der
 * per-Call-`X-Tenant-Id`-Mechanismus ist erprobt (`api.ts request()` spreadet
 * `init.headers` ZULETZT, `optimizerApi.ts` nutzt genau das), und bei der
 * heutigen Flottengröße ist eine Schleife über die Mandanten unkritisch. Der
 * EINE Fleet-Endpunkt (`GET /api/v1/admin/fleet`, BYPASSRLS) ist Stufe 2 -
 * dann wechselt hier die Datenquelle und die Oberfläche bleibt, wie sie ist.
 *
 * Es geht bewusst NICHT über `setTenantOverride`: der Umschalter der Schale ist
 * ein globaler Zustand, den diese Seite nicht umschreiben darf (der Admin steht
 * beim Verlassen sonst in einem fremden Mandanten). Jeder Aufruf trägt seinen
 * Mandanten selbst - der RLS-Pfad bleibt der Zaun, BYPASSRLS bleibt hinter
 * `/api/v1/admin/**`.
 *
 * Jeder Aufruf ist EINZELN, damit ein Fehlschlag genau eine Zelle leer lässt
 * und nie eine ganze Zeile (oder gar die Seite) verschluckt.
 */
function forTenant(tenantId: string): RequestInit {
  return { headers: { 'X-Tenant-Id': tenantId } };
}

export const fleetApi = {
  overview: (tenantId: string) => request<Overview>('/api/v1/overview', forTenant(tenantId)),

  /** Die Anlagen-Stammdaten - der Pflege-Check liest daraus die Tarifart. */
  sites: (tenantId: string) =>
    request<Site[]>(`/api/v1/admin/tenants/${tenantId}/sites`),

  edgeVersions: (tenantId: string) =>
    request<EdgeVersion[]>('/api/v1/edge-versions', forTenant(tenantId)),

  sources: (tenantId: string, siteId: string) =>
    request<SiteSource[]>(`/api/v1/sites/${siteId}/sources`, forTenant(tenantId)),

  /** 204 -> null (kein Rücklese-Beleg), wie auf der Kundenfläche. */
  controlStatus: (tenantId: string, siteId: string) =>
    request<ControlStatus | undefined>(
      `/api/v1/sites/${siteId}/control-status`,
      forTenant(tenantId),
    ).then((v) => v ?? null),

  curtailmentStatus: (tenantId: string, siteId: string) =>
    request<CurtailmentStatus | undefined>(
      `/api/v1/sites/${siteId}/curtailment-status`,
      forTenant(tenantId),
    ).then((v) => v ?? null),
};
