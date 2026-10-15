import { request } from './api';

/**
 * Der Zugang zum Meldungs-Center (Alerting Scheibe 1) - bewusst sein EIGENES, winziges Modul.
 *
 * Die Glocke im Kopf (`shell/GlockeButton.tsx`) und die Zustands-Anzeige (`shell/AppShell.tsx`)
 * liegen im EINSTIEGS-Bündel (sie sind auf jeder Ebene sichtbar, nicht hinter einem Klick); alles
 * Weitere des Meldungs-Centers (Sätze, Sortierung, Wörter, die Seite selbst) gehört dagegen in das
 * Lazy-Stück `pages/MeldungenPage.tsx` (`meldungen.ts`) - zwei Module, damit der Einstieg nicht
 * das ganze Center mitträgt (`test/bundle-smoke.sh`, Grenze 256 kB gz).
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
}

/** Eine Regel im Reiter "Überwachungen" (§6.8) - nur lesend in dieser Scheibe. */
export interface UeberwachungsRegel {
  id: string;
  name: string | null;
  wertart: string;
  schwere: Schwere;
  herkunft: string;
  aktiv: boolean;
}

export const meldungenApi = {
  jetzt: () => request<{ meldungen: Meldung[] }>('/api/v1/meldungen?status=jetzt').then((r) => r.meldungen),
  verlauf: () => request<{ meldungen: Meldung[] }>('/api/v1/meldungen?status=verlauf').then((r) => r.meldungen),
  zahl: () => request<{ ungesehen: number; dringend: boolean }>('/api/v1/meldungen/zahl'),
  gesehen: (id: string) => request<Meldung>(`/api/v1/meldungen/${encodeURIComponent(id)}/gesehen`, { method: 'POST' }),
  regeln: () =>
    request<{ ueberwachungen: UeberwachungsRegel[] }>('/api/v1/meldungen/regeln').then((r) => r.ueberwachungen),
};
