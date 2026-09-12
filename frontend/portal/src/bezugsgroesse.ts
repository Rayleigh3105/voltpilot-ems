import { EINHEIT_UNBEKANNT, SAETZE as EINHEIT_SAETZE } from './bezugsEinheit';

/**
 * Das VERWALTEN einer Bezugsgröße im Portal (UEMS AP-09 IP-5): der GESCHLOSSENE
 * Satz der Ablehnungen der Schnittstelle `/api/v1/bezugsgroessen` mit Status
 * und Kundensatz, und die Lesarten des Lesemodells.
 *
 * Die Wahrheit steht in `docs/contracts/v2/bezugsdaten-vectors.json` (Block
 * `verwalten`); `bezugsdaten.test.ts` hält diese Datei Zeile für Zeile daran,
 * der Java-Zwilling `uems/BezugsgroesseRegeln` ebenso. Die Regeln M1–M6 rechnet
 * der Server — das Portal zeigt die Ablehnung mit ihrem Satz und erfindet keinen
 * zweiten. `einheit_unbekannt` spricht denselben Satz wie der Befund.
 */
export const ABLEHNUNGEN = {
  anfrage_ungueltig: {
    status: 400,
    satz: 'Die Anfrage ist unvollständig oder nennt ein Feld, das es hier nicht gibt.',
  },
  wort_unbekannt: {
    status: 400,
    satz: 'Dieses Wort ist hier nicht vorgesehen — erlaubt sind die Wörter der Liste.',
  },
  [EINHEIT_UNBEKANNT]: { status: 400, satz: EINHEIT_SAETZE[EINHEIT_UNBEKANNT] },
  kennzeichen_format: {
    status: 400,
    satz: 'Ein Kennzeichen hat 2 bis 16 Zeichen: Großbuchstaben, Ziffern, Punkt, Bindestrich oder Schrägstrich.',
  },
  zeitraum_ungueltig: { status: 400, satz: 'Der Zeitraum endet vor seinem Beginn.' },
  periode_passt_nicht_zur_wertart: {
    status: 422,
    satz: 'Nur ein Periodenwert hat eine Periode (Tag, Woche, Monat oder Jahr); ein Stand und ein Stammdatum haben keine.',
  },
  flaeche_aus_struktur: { status: 422, satz: 'Flächen pflegen Sie am Gebäude.' },
  geltung_nicht_waehlbar: {
    status: 422,
    satz: 'Prozesse und Kostenstellen sind als Geltungsbereich noch nicht wählbar.',
  },
  geltung_unbekannt: { status: 422, satz: 'Den gewählten Geltungsbereich gibt es nicht.' },
  bedeutung_fest: {
    status: 422,
    satz: 'Nach dem ersten Wert bleiben Wertart, Einheit, Periode und Geltungsbereich fest. Legen Sie dafür eine neue Bezugsgröße an.',
  },
  kennzeichen_belegt: {
    status: 409,
    satz: 'Dieses Kennzeichen trägt oder trug schon eine andere Bezugsgröße.',
  },
  archiviert: { status: 409, satz: 'Diese Bezugsgröße ist archiviert und wird nicht mehr geändert.' },
  hat_werte: {
    status: 409,
    satz: 'Eine Bezugsgröße mit Werten wird nicht gelöscht. Archivieren Sie sie stattdessen.',
  },
  nicht_gefunden: { status: 404, satz: 'Diese Bezugsgröße gibt es nicht.' },
} as const;

/** Ein Code aus dem geschlossenen Satz der Ablehnungen. */
export type BezugsgroesseAblehnungCode = keyof typeof ABLEHNUNGEN;

/** `GET …/{id}/werte?fassungen=` — `wirksam` (Vorgabe) oder `alle`. */
export const LESARTEN = ['wirksam', 'alle'] as const;

export type BezugsgroesseLesart = (typeof LESARTEN)[number];

/** Der Kundensatz einer Ablehnung — die Fläche schreibt keinen zweiten. */
export const ablehnungSatz = (code: BezugsgroesseAblehnungCode): string => ABLEHNUNGEN[code].satz;
