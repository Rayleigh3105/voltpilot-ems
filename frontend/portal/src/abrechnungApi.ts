/**
 * Die Abrufe von „Abrechnung prüfen“ (R1–R3). ⚠ EIGENES MODUL wie `erzeugerVorgabenApi.ts`: `api.ts` liegt als Ganzes
 * im Einstiegs-Bündel (Wächter `test/bundle-smoke.sh`); diese Abrufe braucht nur Verlauf › Energie, ein Lazy-Stück.
 */
import { request, type Abrechnung, type AbrechnungPruefung, type History } from './api';

export const abrechnungApi = {
  /** Freier Zeitraum in ganzen Tagen, beide eingeschlossen (`GET …/history?from=&to=`, R1). */
  historyZeitraum: (siteId: string, von: string, bis: string) =>
    request<History>(`/api/v1/sites/${siteId}/history?from=${von}&to=${bis}`),
  /** Netzbezug und Einspeisung eines Zeitraums mit Zählerständen und Herkunft (R2). */
  abrechnung: (siteId: string, von: string, bis: string) =>
    request<Abrechnung>(`/api/v1/sites/${siteId}/abrechnung?von=${von}&bis=${bis}`),
  /** „Frühere Prüfungen“: alle gespeicherten Zeiträume, der jüngste zuerst (R3). */
  pruefungen: (siteId: string) => request<AbrechnungPruefung[]>(`/api/v1/sites/${siteId}/abrechnung/pruefungen`),
  /**
   * Die Zahlen von der Rechnung speichern (R3). `null` je Feld löscht nur diese Zahl; beide `null` löschen die
   * Prüfung (204 → `undefined`).
   */
  pruefungSpeichern: (
    siteId: string,
    von: string,
    bis: string,
    werte: { bezugKwh: number | null; einspeisungKwh: number | null },
  ) =>
    request<AbrechnungPruefung | undefined>(`/api/v1/sites/${siteId}/abrechnung/pruefung?von=${von}&bis=${bis}`, {
      method: 'PUT',
      body: JSON.stringify(werte),
    }),
};
