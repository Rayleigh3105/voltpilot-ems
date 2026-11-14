import { DEFAULT_EARNINGS_RANGE } from './anlage';
import { api, vorabAbrufen } from './api';
import { consumersApi } from './consumers/consumersApi';
import { customerFlowApi } from './flows/flowsApi';
import { parseRoute } from './nav';

/**
 * SEITENDATEN NACH ROUTE VORAB (Performance-Runde vp-perf2-portal, Idee 2).
 *
 * Beim Start einer Anlagen-Adresse (`#/anlage/{id}…`, Neuladen oder Direktlink) steht die Anlagen-ID schon in der
 * Adresse. Die Seite fragt ihre Daten aber erst, wenn `/me` und `/sites` geantwortet haben und sie gerendert ist -
 * eine ganze Runde nach dem Start. Hier gehen dieselben Abrufe gleichzeitig mit `/me` hinaus; die Seite findet
 * sie im Startfenster des Bündels (`vorabAbrufen` in `api.ts`) und stellt keine zweite Anfrage.
 *
 * ⚠ Nur, was die Seite beim Öffnen IMMER selbst fragt, mit GENAU denselben Argumenten - ein Vorab-Abruf, den sie
 * nicht stellt, wäre eine vergeudete Serveranfrage. Bedingte Abrufe (Tagesverlauf hinter der Stapel-Entscheidung,
 * Ausfall des Standorts, Bilanz einer Anlage auf einer Ebene, Anlagensteuerung) bleiben bei der Seite. Der
 * Wächter `seitenVorab.test.tsx` hält beide Listen an den tatsächlichen Aufrufern fest.
 *
 * Der Server schneidet jede Antwort selbst auf die Rechte zu: eine fremde oder gelöschte Anlagen-ID in der Adresse
 * bekommt dieselbe Ablehnung wie ohne Vorab-Abruf, und die wird nie geteilt.
 */

/** Was JEDE Anlagen-Route liest: die Schale und die Seite (`useAnlageSurface`), dazu die Funktionen. */
export function anlageGrundAbrufe(siteId: string): Array<() => Promise<unknown>> {
  return [
    () => api.funktionen(),
    () => api.usageProfile(siteId),
    () => api.siteEntities(siteId),
    () => customerFlowApi(siteId).list(),
    () => api.siteProfiles(siteId),
    () => api.siteInterventions(siteId),
    () => api.entityStrategies(siteId),
  ];
}

/** Was das Cockpit (`AnlageSeite`, `useAdaptiveLive`) beim Öffnen liest, ohne die bedingten Abrufe. */
export function cockpitAbrufe(siteId: string): Array<() => Promise<unknown>> {
  return [
    () => api.topology(siteId),
    () => api.overview(),
    () => api.siteEarnings(siteId, DEFAULT_EARNINGS_RANGE, null),
    () => api.controlStatus(siteId),
    () => api.curtailmentStatus(siteId),
    () => api.erzeugerJetzt(siteId),
    () => api.siteChargers(siteId),
    () => api.siteSources(siteId),
    () => consumersApi.status(siteId),
    () => api.weather(siteId),
    () => api.forecast(siteId),
    () => api.schedule(siteId),
    () => api.cockpitLayout(siteId),
    ...['pv', 'consumer', 'grid'].map((rolle) => () => api.rollenWert(siteId, rolle)),
  ];
}

/** Stellt die Abrufe der Seite hinter `hash` vorab - nur für Anlagen-Routen mit ID, sonst nichts. */
export function seitendatenVorab(hash: string): void {
  const route = parseRoute(hash);
  if (route.page !== 'anlagen' || !route.siteId) return;
  vorabAbrufen([...anlageGrundAbrufe(route.siteId), ...(route.sub == null ? cockpitAbrufe(route.siteId) : [])]);
}
