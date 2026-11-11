import { request } from './api';

/**
 * Der Zugang zum Meldungs-Center (Alerting Scheibe 1) - bewusst sein EIGENES, winziges Modul.
 *
 * Die Glocke im Kopf (`shell/GlockeButton.tsx`) und die Zustands-Anzeige (`shell/AppShell.tsx`)
 * liegen im EINSTIEGS-Bündel (sie sind auf jeder Ebene sichtbar, nicht hinter einem Klick); alles
 * Weitere des Meldungs-Centers (Sätze, Sortierung, Wörter, die Seite selbst) gehört dagegen in das
 * Lazy-Stück `pages/MeldungenPage.tsx` (`meldungen.ts`) - zwei Module, damit der Einstieg nicht
 * das ganze Center mitträgt (`test/bundle-smoke.sh`, Grenze 256 kB gz).
 *
 * Die Aufrufe zum Anlegen einer Überwachung (`werte`, `anlegen`, `probelauf`, …) stehen bewusst
 * NICHT hier, sondern in `ueberwachungApi.ts`: dieses Modul hier ist entry-gebündelt
 * (`AnlagenPage.tsx`, `GlockeButton.tsx`), jedes neue Byte hier kostet also jeden Besuch mit.
 * `ueberwachungApi.ts` brauchen nur die Lazy-Stücke Meldungs-Center (`+ Überwachung`) und
 * Steuerung (Umwandeln einer Regel) - der Bündel-Wächter (`test/bundle-smoke.sh`) hält das fest.
 */
export type Schwere = 'hinweis' | 'warnung' | 'dringend';
export type MeldungZustand = 'aktiv' | 'gesehen' | 'erledigt';

export interface Meldung {
  id: string;
  kennzeichen: string;
  wertart: string;
  schwere: Schwere;
  anlageId: string | null;
  anlageName: string | null;
  standortId: string | null;
  ausgeloestAm: string;
  zustand: MeldungZustand;
  wiederNormalAm: string | null;
  gesehenVon: string | null;
  gesehenAm: string | null;
  erledigtAm: string | null;
  /** Derselbe rohe Bezug wie am Alarm (Alerting Scheibe 5, §6.4 Nr. 7), z. B. `"kennzahl:<uuid>"`. */
  bezugKennung: string | null;
}

/**
 * Eine Regel im Reiter "Überwachungen" (§6.8) - auch die Antwort von `ueberwachungAnlegen` und
 * `scharfSchalten` (§6.8 Scheibe 2, Nachbesserung 3/3).
 *
 * `probelaufBis` ist `null`, sobald die Regel scharf ist (eine ab-Werk-Regel kennt nie einen
 * Probelauf, eine eigene endet damit nach 30 Tagen oder per Tipper auf "jetzt scharf schalten").
 * `bezugJson` ist derselbe rohe Bezug wie im Anfragekörper (§6.3) - eine Fläche braucht ihn, um
 * "schon überwacht" an einem KONKRETEN Wertverweis zu erkennen: bei der Familie `geraet.messwert`
 * identifiziert die Wertart allein keinen Wert, erst Wertart+Bezug (Komponente+Kanal).
 */
export interface UeberwachungsRegel {
  id: string;
  name: string | null;
  wertart: string;
  schwere: Schwere;
  herkunft: string;
  aktiv: boolean;
  probelaufBis: string | null;
  bezugJson: string | null;
}

/**
 * `regeln()` bleibt bewusst hier (Scheibe 1, entry-gebündelt): die Glocke prüft nichts darüber,
 * aber die Liste braucht derselbe `request`-Zugang. "Jetzt scharf schalten" ist dagegen NEU
 * (Scheibe 2, Nachbesserung 3/3) und steht deshalb bewusst NICHT hier, sondern in
 * `ueberwachungApi.ts` (dieselbe Begründung wie `werte`/`anlegen`/`probelauf` dort: jedes neue
 * Byte hier kostet jeden Besuch mit, auch ohne "Überwachungen" je zu öffnen).
 */
export const meldungenApi = {
  jetzt: () => request<{ meldungen: Meldung[] }>('/api/v1/meldungen?status=jetzt').then((r) => r.meldungen),
  verlauf: () => request<{ meldungen: Meldung[] }>('/api/v1/meldungen?status=verlauf').then((r) => r.meldungen),
  zahl: () => request<{ ungesehen: number; dringend: boolean }>('/api/v1/meldungen/zahl'),
  gesehen: (id: string) => request<Meldung>(`/api/v1/meldungen/${encodeURIComponent(id)}/gesehen`, { method: 'POST' }),
  regeln: () =>
    request<{ ueberwachungen: UeberwachungsRegel[] }>('/api/v1/meldungen/regeln').then((r) => r.ueberwachungen),
};
