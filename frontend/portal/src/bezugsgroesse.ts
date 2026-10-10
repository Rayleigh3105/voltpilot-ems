import { EINHEIT_UNBEKANNT, SAETZE as EINHEIT_SAETZE } from './bezugsEinheit';

/**
 * Das VERWALTEN einer Bezugsgröße im Portal (UEMS AP-09 IP-5): der GESCHLOSSENE
 * Satz der Ablehnungen der Schnittstelle `/api/v1/bezugsgroessen` mit Status
 * und Kundensatz (seit AP-09 IP-6 auch der Stammdatum-Route und von
 * `/api/v1/bezugsflaechen`), und die Lesarten des Lesemodells.
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
  wert_ungueltig: {
    status: 400,
    satz: 'Bitte geben Sie den Wert als Zahl größer als 0 an, mit Punkt und höchstens sechs Nachkommastellen, z. B. 180.',
  },
  periode_passt_nicht_zur_wertart: {
    status: 422,
    satz: 'Nur ein Periodenwert hat eine Periode (Tag, Woche, Monat oder Jahr); ein Stand und ein Stammdatum haben keine.',
  },
  flaeche_aus_struktur: { status: 422, satz: 'Flächen pflegen Sie am Gebäude. Als Nenner einer Kennzahl nehmen Sie die Bezugsfläche des Standorts, Gebäudes oder Bereichs.' },
  kein_stammdatum: {
    status: 422,
    satz: 'Eine Gültigkeit ab einem Tag hat nur ein Stammdatum. Periodenwerte und Stände werden als Werte eingetragen.',
  },
  kein_periodenwert: { status: 422, satz: 'Werte je Periode gibt es nur für eine Bezugsgröße mit Periodenwerten.' },
  periode_passt_nicht: { status: 422, satz: 'Der gelieferte Zeitraum ist keine Periode dieser Bezugsgröße.' },
  periode_nicht_zu_ende: { status: 422, satz: 'Diese Periode ist noch nicht zu Ende.' },
  zahl_unlesbar: { status: 422, satz: 'Diese Zahl ist nicht lesbar.' },
  wert_negativ: { status: 422, satz: 'Ein Wert unter null wird nicht übernommen.' },
  begruendung_zu_kurz: { status: 422, satz: 'Bitte begründen Sie die Berichtigung (mindestens 10 Zeichen).' },
  begruendung_zu_lang: { status: 422, satz: 'Eine Begründung hat höchstens 500 Zeichen.' },
  geltung_nicht_waehlbar: {
    status: 422,
    satz: 'Prozesse und Kostenstellen sind als Geltungsbereich noch nicht wählbar.',
  },
  geltung_unbekannt: { status: 422, satz: 'Den gewählten Geltungsbereich gibt es nicht.' },
  bedeutung_fest: {
    status: 422,
    satz: 'Nach dem ersten Wert bleiben Art, Wertart, Einheit, Periode und Geltungsbereich fest. Legen Sie dafür eine neue Bezugsgröße an.',
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
  konflikt_anderer_wert: { status: 409, satz: 'Für diesen Zeitraum gibt es schon einen anderen Wert.' },
  kein_wert: { status: 409, satz: 'Für diese Periode gibt es noch keinen Wert — geben Sie ihn zuerst ein.' },
  vorschlag_offen: { status: 409, satz: 'Für diesen Wert liegt schon ein Vorschlag vor. Bis zur Entscheidung ist keine zweite Berichtigung möglich.' },
  nicht_gefunden: { status: 404, satz: 'Diese Bezugsgröße gibt es nicht.' },
} as const;

/** AP-09 IP-7: was die Schnittstelle nach einem Wert sagt — Zeile für Zeile `verwalten.eingabe.urteile`. */
export const EINGABE_SAETZE = {
  neu: 'Der Wert ist gespeichert.',
  wiederholung: 'Bereits gespeichert, keine Änderung.',
  berichtigung: 'Berichtigt — die bisherige Fassung bleibt lesbar.',
  vorschlag: 'Vorschlag gesendet — bis zur Freigabe gilt der bisherige Wert.',
} as const;

/** U5: der Zusatz zu `zahl_unlesbar` bei Stück, Personen und Schichten (`{einheit}`). */
export const GANZE_ZAHLEN = '{einheit} sind ganze Zahlen.';

/** Ein Code aus dem geschlossenen Satz der Ablehnungen. */
export type BezugsgroesseAblehnungCode = keyof typeof ABLEHNUNGEN;

/** `GET …/{id}/werte?fassungen=` — `wirksam` (Vorgabe) oder `alle`. */
export const LESARTEN = ['wirksam', 'alle'] as const;

export type BezugsgroesseLesart = (typeof LESARTEN)[number];

/** Der Kundensatz einer Ablehnung — die Fläche schreibt keinen zweiten. */
export const ablehnungSatz = (code: BezugsgroesseAblehnungCode): string => ABLEHNUNGEN[code].satz;
