import { freshToken } from './auth';
import {
  API_BASE,
  ApiError,
  bereichKopf,
  request,
  type ErzeugerVorgabeDetail,
  type ErzeugerVorgabenHeute,
} from './api';

/**
 * **Die Vorgaben-Routen einer Erzeugeranlage** (UEMS EZ-7) für Cockpit und Verlauf (EZ-9) — ein eigenes Stück wie
 * `consumers/consumersApi.ts`: das Einstiegs-Bündel trägt nur das erste Bild (`test/bundle-smoke.sh`), und jede
 * Anlage ohne Anlagensteuerung lädt diese Zeilen nie. Die Formen stehen in `api.ts` (Snake-Case wie die Route).
 */
export const erzeugerVorgabenApi = {
  /** „Wer hat heute geregelt?“: der heutige Tag (Europe/Berlin) je Urheber. 404 = keine Anlage/älteres Backend. */
  heute: (siteId: string) => request<ErzeugerVorgabenHeute>(`/api/v1/sites/${siteId}/erzeuger/vorgaben/heute`),
  /** Eine Vorgabe mit Rohsignalen am Beginn und Ende und den Zählerständen — das Detail der Chronik-Zeile. */
  detail: (siteId: string, vorgabeId: string) =>
    request<ErzeugerVorgabeDetail>(`/api/v1/sites/${siteId}/erzeuger/vorgaben/${vorgabeId}`),
};

/**
 * Holt „heute“ sofort und dann im Takt (der Vorgaben-Läufer rechnet minütlich); ein Fehler behält den letzten Stand.
 * Zurück kommt das Abmelden.
 */
export function heuteAbonnieren(
  siteId: string,
  setze: (heute: ErzeugerVorgabenHeute) => void,
  taktMs: number,
): () => void {
  let aktiv = true;
  const holen = () =>
    erzeugerVorgabenApi.heute(siteId).then(
      (h) => {
        if (aktiv) setze(h);
      },
      () => {},
    );
  holen();
  const timer = setInterval(holen, taktMs);
  return () => {
    aktiv = false;
    clearInterval(timer);
  };
}

/**
 * „Vorgaben als CSV“ (EW-12 A): die Vorgaben und Datenlücken in `[von, bis)` aus der CSV-Route von EZ-7 (Spalten
 * deutsch, de-DE-Zahlen, Semikolon, UTF-8 mit BOM) — derselbe Download-Weg wie `ladeMeldungenVerlaufCsv`; den
 * Dateinamen gibt der Aufrufer, wie beim Energie-CSV daneben.
 */
export async function ladeVorgabenCsv(siteId: string, von: string, bis: string, datei: string): Promise<void> {
  const token = await freshToken();
  const path = `/api/v1/sites/${siteId}/erzeuger/vorgaben.csv?von=${encodeURIComponent(von)}&bis=${encodeURIComponent(bis)}`;
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...bereichKopf(path),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => undefined);
    throw new ApiError(
      res.status,
      (body as { message?: string } | undefined)?.message ?? 'Die Vorgaben konnten nicht geladen werden.',
      body,
    );
  }
  const href = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = href;
  link.download = datei;
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 0);
}
