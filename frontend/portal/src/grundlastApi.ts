import { request, type Grundlast, type GrundlastZeitraum } from './api';

/**
 * Der Abruf der Grundlast (`GET /api/v1/sites/{id}/grundlast`, Vertrag `docs/contracts/openapi.yaml` → `Grundlast`).
 *
 * ⚠ EIGENES OBJEKT statt eines Eintrags in `api` (wie `entitiesApi`, `consumersApi`): `api.ts` liegt im
 * Einstiegs-Bündel, gebraucht wird der Abruf nur von der Karte im Verlauf und der Kachel im Cockpit, beide
 * nachgeladen (`test/bundle-smoke.sh`). Die Bühnen ersetzen ihn mit `Object.assign(grundlastApi, …)`.
 */
export const grundlastApi = {
  /** Grundlast des Zeitraums (`aktuell` = die letzten 14 Nächte, `at` zählt dort nicht). */
  grundlast: (siteId: string, z: GrundlastZeitraum, at?: string) =>
    request<Grundlast>(`/api/v1/sites/${siteId}/grundlast?z=${z}${at ? `&at=${at}` : ''}`),
};
