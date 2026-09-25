/**
 * UEMS AP-19 IP-21 (WV1–WV5, E10 = A): die Wiedervorlage des Energiemanagements und das reine Bild des Bausteins
 * „Energiemanagement“ am Unternehmen. Fristen, Lage und Reihenfolge leitet der Server beim Abruf ab
 * (`GET /api/v1/energiemanagement/wiedervorlage`, Operation `wiedervorlage`); hier werden nur Sätze gebildet — Wortlaut
 * aus AP-19 §5.8 über den Zwilling `energiemanagement.ts`. Reines Modul: kein React, kein Netz.
 */
import { satz } from './energiemanagement';

export type WiedervorlageArt =
  | 'dokument_ueberpruefung'
  | 'internes_audit'
  | 'managementbewertung'
  | 'feststellung'
  | 'bewertung_ueberpruefung'
  | 'bezugsbasis_ueberpruefung'
  | 'energieziel_bewertung'
  | 'massnahme_termin'
  | 'abweichung_frist'
  | 'messbedarf_frist'
  | 'bericht_anstoss';

/** Eine Zeile — die Ausgabe der Operation `wiedervorlage`; `id`/`kennzahl_id` tragen den Sprung (WV3). */
export type WiedervorlageZeile = {
  art: WiedervorlageArt;
  kennzeichen: string;
  titel: string;
  faellig_am: string;
  /** Abruf − fällig am: positiv = fällig, 0 = heute, negativ = Vorschau. */
  tage: number;
  satz: string;
  verantwortlich: string | null;
  id: string | null;
  kennzahl_id: string | null;
};

export type Wiedervorlage = {
  stichtag: string;
  vorschau_tage: number;
  faellig: WiedervorlageZeile[];
  vorschau: WiedervorlageZeile[];
  anzahl_faellig: number;
  anzahl_vorschau: number;
  nicht_in_liste: string[];
  verantwortung: string;
};

export const ENERGIEMANAGEMENT_TITEL = 'Energiemanagement';
/** Der Sprung in den Bereich „Energiemanagement“ (IP-9) — der Reiter „Wiedervorlage“ kommt mit IP-24. */
export const ENERGIEMANAGEMENT_OEFFNEN = 'Zum Energiemanagement';
export const KALENDER_ABZUG = 'Kalender-Abzug (.ics)';
/** E10, Folgen von Option A: die Termine veralten im Kalender des Kunden — der Hinweis sagt es, der Abzug trägt den Vermerk. */
export const KALENDER_ABZUG_HINWEIS =
  'Die Termine veralten in Ihrem Kalender, wenn sich eine Frist ändert — maßgeblich ist die Wiedervorlage im Portal. VoltPilot verschickt nichts.';
export const KALENDER_ABZUG_FEHLER = 'Der Kalender-Abzug ließ sich gerade nicht laden. Bitte versuchen Sie es noch einmal.';

export type EnergiemanagementBausteinBild = {
  /** WV5: „8 fällig · 1 in den nächsten 30 Tagen.“ — der §5.8-Satz „Baustein“ ohne den Titel davor. */
  summe: string;
  /** Etwas ist fällig — die Summe trägt den Warnton; nur Vorschau bleibt ruhig. */
  faellig: boolean;
};

const TITEL_PRAEFIX = `${ENERGIEMANAGEMENT_TITEL} — `;

function text(r: { satz?: string; fehler?: string }): string {
  if (r.satz === undefined) throw new Error(`Satz nicht bildbar: ${r.fehler}`);
  return r.satz;
}

/** `2029-02-12T08:00+01:00` → `12.02.2029` — der Tag des Abrufs, wie der Server ihn stellt. */
export function standTag(stichtag: string): string {
  const [j, m, t] = stichtag.slice(0, 10).split('-');
  return `${t}.${m}.${j}`;
}

/** §5.8 „Baustein“: „Energiemanagement — 8 fällig · 1 in den nächsten 30 Tagen.“ */
export function bausteinSatz(w: Pick<Wiedervorlage, 'anzahl_faellig' | 'anzahl_vorschau' | 'vorschau_tage'>): string {
  return text(
    satz('baustein', {
      faellig: String(w.anzahl_faellig),
      vorschau: String(w.anzahl_vorschau),
      tage: String(w.vorschau_tage),
    }),
  );
}

/** §5.8 „Kalender-Abzug“ (WV4): „Stand vom 12.02.2029 aus VoltPilot; maßgeblich ist die Wiedervorlage im Portal.“ */
export function kalenderVermerk(stichtag: string): string {
  return text(satz('kalender_abzug', { am: standTag(stichtag) }));
}

/**
 * WV5 (AP-13 E3): das Bild des Bausteins — `null` ohne fällige und ohne Vorschau-Zeile. Wer kein Energiemanagement
 * führt oder nichts in den nächsten Tagen hat, sieht keine neue Kachel.
 */
export function energiemanagementBaustein(w: Wiedervorlage | null): EnergiemanagementBausteinBild | null {
  if (!w || (w.anzahl_faellig === 0 && w.anzahl_vorschau === 0)) return null;
  const voll = bausteinSatz(w);
  return {
    summe: voll.startsWith(TITEL_PRAEFIX) ? voll.slice(TITEL_PRAEFIX.length) : voll,
    faellig: w.anzahl_faellig > 0,
  };
}
