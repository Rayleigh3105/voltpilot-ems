/**
 * Die zwei Abrufe des Anlagen-Checks (Bedienkonzept vp-privatkunde-bedienkonzept, BK-4/BK-5/BK-7 = A) - ein eigenes
 * Modul, damit sie NICHT im Einstiegs-Bündel liegen (`test/bundle-smoke.sh`): das Cockpit lädt es per `import()`,
 * Verlauf und Geräteseite sind ohnehin nachgeladen. Mandantenbezogen wie jede `/sites/**`-Route - fremde Anlage 404.
 * Bühnen patchen dieses Objekt (`e2e/anlagen-check-fixtures.ts`).
 */
import { request, type AnlagenCheck, type SpeicherBilanz } from './api';

export const anlagenCheckApi = {
  /** Kachel (immer die letzten 7 bzw. 14 Tage) und mit `z` die Karte des Zeitraums. */
  anlagenCheck: (siteId: string, z?: 'tag' | 'woche' | 'monat' | 'jahr', at?: string) => {
    const q = new URLSearchParams();
    if (z) q.set('z', z);
    if (at) q.set('at', at);
    const qs = q.toString();
    return request<AnlagenCheck>(`/api/v1/sites/${siteId}/anlagen-check${qs ? `?${qs}` : ''}`);
  },

  /** Die Speicher-Bilanz der letzten 30 Tage (ohne Kapazität 90) und die 12 Monate davor. */
  speicherBilanz: (siteId: string) => request<SpeicherBilanz>(`/api/v1/sites/${siteId}/speicher-bilanz`),
};
