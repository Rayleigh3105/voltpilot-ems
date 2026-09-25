/**
 * UEMS AP-19 IP-24: die Routen der Managementbewertung (Berichte der Vorlage `managementbewertung`, AP-12/IP-22) und der
 * Wiedervorlage (IP-21) im Browser gespielt — für die Bühne `e2e/energiemanagement.tsx` (`&mb=…`) und die Vitest-Fälle.
 * Referenz: Kunststoffwerk Ahrenberg, AP-19 R12 (Wiedervorlage am 12.02.2029, `energiemanagement-vectors.json`, mit den
 * Kennzeichen des Codes BR-… statt VB-/BW-…, W11) und R13 (BR-2029-0001, die Eingaben wie `ManagementbewertungVorlageApiTest`
 * sie prüft). Die Prüfsumme bildet die Bühne wie der Dienst über die kanonische Kopie.
 *
 * Lagen: `leer` — keine Managementbewertung (der Weg Anlegen → Sitzung → Beschluss → Freigabe → Folge); `r13` —
 * BR-2029-0001 für 2028 im Entwurf, ohne Sitzung; `r13f` — mit Sitzung und den sechs Beschlüssen der Referenz, Stand Nr. 1
 * vom 12.02.2029, 14:10. Sitzung, Beschlüsse und Folgen (IP-23) prüft die Bühne wie die Route: Leitung am Tag (über die
 * Aufgaben-Route der Bühne), Sitzung vor dem Beschluss, Freigabe nur mit Sitzung, Leitung und Beschluss, Folgen erst danach
 * und nur auf Objekte, die die Listen-Routen der Bühne kennen. Jeder Schreib-Körper landet in `gesendet`.
 */
import {
  ApiError,
  type api,
  type Bericht,
  type BerichtDetail,
  type BerichtEntwurf,
  type BerichtStand,
  type BerichtStandKurz,
  type Managementbewertung,
  type ManagementbewertungBeschluss,
  type ManagementbewertungBeschlussFesthalten,
  type ManagementbewertungFolge,
  type ManagementbewertungFolgeVerknuepfen,
  type ManagementbewertungSitzungFesthalten,
} from '../api';
import { SAETZE } from '../energiemanagement';
import { UEMS_NORMGRENZE, UEMS_VERANTWORTUNG } from '../glossar';
import { kanonisch, PRUEFSUMME_PRAEFIX } from '../uemsBericht';
import type { Wiedervorlage, WiedervorlageZeile } from '../wiedervorlage';
import { EM_IDS } from './energiemanagementFixtures';

export type MbLage = 'leer' | 'r13' | 'r13f';
export const MB_KENNUNG = 'BR-2029-0001';
export const UNTERNEHMEN_ID = 'u0190000-0000-4000-8000-000000000001';
const ZONE = 'Europe/Berlin';
const IK = { name: 'Ines Kaltenbach', rolle: 'energiemanager' };

async function sha256Hex(text: string): Promise<string> {
  const summe = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(summe)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const fehler = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  new ApiError(status, message, { code, message, ...extra });

// ------------------------------------------------------------------ R12: die Wiedervorlage am 12.02.2029

const zeile = (
  art: WiedervorlageZeile['art'], kennzeichen: string, titel: string, faellig_am: string, tage: number,
  verantwortlich: string | null = null, id: string | null = null,
): WiedervorlageZeile => ({
  art, kennzeichen, titel, faellig_am, tage, satz: tage > 0 ? `seit ${tage} Tagen fällig` : tage === 0 ? 'heute fällig' : `fällig in ${-tage} Tagen`,
  verantwortlich, id, kennzahl_id: art === 'bezugsbasis_ueberpruefung' ? 'k0170000-0000-4000-8000-000000000001' : null,
});

export function r12Wiedervorlage(): Wiedervorlage {
  return {
    stichtag: '2029-02-12T08:00:00+01:00',
    vorschau_tage: 30,
    faellig: [
      zeile('bezugsbasis_ueberpruefung', 'BB-0002', 'Bezugsbasis BB-0002, Fassung 2 — Überprüfung (Freigabe 13.11.2026 + 12 Monate)', '2027-11-13', 457),
      zeile('bezugsbasis_ueberpruefung', 'BB-0005', 'Bezugsbasis BB-0005, Fassung 1 — Überprüfung (Freigabe 20.11.2026 + 12 Monate)', '2027-11-20', 450),
      zeile('bezugsbasis_ueberpruefung', 'BB-0003', 'Bezugsbasis BB-0003, Fassung 2 — Überprüfung (Freigabe 05.03.2027 + 12 Monate)', '2028-03-05', 344),
      zeile('bericht_anstoss', 'BR-2028-0001', 'Kunststoffwerk Ahrenberg GmbH · leistungsvergleich — Revision angestoßen (K-2028-0001)', '2028-04-03', 315),
      zeile('bezugsbasis_ueberpruefung', 'BB-0004', 'Bezugsbasis BB-0004, Fassung 1 — Überprüfung (Freigabe 24.11.2027 + 12 Monate)', '2028-11-24', 80),
      zeile('bewertung_ueberpruefung', 'BR-2027-0001', 'Energetische Bewertung — Überprüfung', '2028-11-24', 80),
      zeile('dokument_ueberpruefung', 'D-0001', 'Energiepolitik — Überprüfung', '2028-12-10', 64, null, EM_IDS.d1),
      zeile('dokument_ueberpruefung', 'D-0002', 'Anwendungsbereich — Überprüfung', '2028-12-10', 64, null, EM_IDS.d2),
    ],
    vorschau: [
      zeile('massnahme_termin', 'M-2029-0001', 'Aufgabe „Bezugsbasen pflegen und freigeben“ festlegen und über die zweite Prüfung entscheiden', '2029-02-28', -16, 'Jonas Wendlinger'),
    ],
    anzahl_faellig: 8,
    anzahl_vorschau: 1,
    nicht_in_liste: ['AU-2029-0001', 'BB-0001', 'D-0003', 'D-0004', 'F-2029-0001', 'M-2029-0002'],
    verantwortung: UEMS_VERANTWORTUNG,
  };
}

// ------------------------------------------------------------------ R13: die Eingaben der Managementbewertung 2028

const frist = (faellig_am: string, tage: number) => ({ faellig_am, satz: `seit ${tage} Tagen fällig` });
const SUMME = (n: number) => `sha256:${n.toString(16).padStart(4, '0').repeat(16)}`;

type AbzugSitzung = { tag: string; leitung: string | null; teilnehmende: string[]; ort: string | null; eingetragen_von: string; eingetragen_am: string };
type AbzugBeschluss = {
  nr: number; kennung: string; art: string; wortlaut: string; entschieden_von: string; eingetragen_von: string; eingetragen_am: string;
  zustaendig: string | null; termin: string | null;
};

/** Der Abzug von BR-2029-0001 am Datenstand `datenstand` — die Werte, die `ManagementbewertungVorlageApiTest` prüft. */
export function r13Abzug(
  datenstand: string,
  eingaben: { sitzung: AbzugSitzung | null; beschluesse: AbzugBeschluss[] } = { sitzung: null, beschluesse: [] },
): Record<string, unknown> {
  const w = r12Wiedervorlage();
  return {
    kopf: {
      bericht: MB_KENNUNG, vorlage: 'managementbewertung', vorlage_fassung: 1,
      geltung: { art: 'unternehmen', kennzeichen: 'U', name_zum_datenstand: 'Kunststoffwerk Ahrenberg GmbH' },
      unternehmen: 'Kunststoffwerk Ahrenberg GmbH', sitz: 'Ahrenberg',
      zeitraum: { art: 'jahr', schluessel: '2028', von: '2028-01-01T00:00:00+01:00', bis: '2029-01-01T00:00:00+01:00', zone: ZONE },
      vergleichszeitraeume: [], datenstand, stichtag: '2029-02-12',
      regelwerk: { software: 'voltpilot-api', vertraege: { bericht: '1.5', energiemanagement: '1.10' } },
      darstellung: { zeitzone: ZONE, zahlenformat: 'de-DE', dezimal: '.', rundung: 'AP-08 E11', sommerzeit: 'AP-08 E10' },
      grenz_satz: UEMS_NORMGRENZE, verantwortung: UEMS_VERANTWORTUNG,
    },
    vorige_beschluesse: { managementbewertung: null, satz: SAETZE.managementbewertung_erste, beschluesse: [] },
    grundlagen: {
      energiepolitik: [{
        dokument: 'D-0001', titel: 'Energiepolitik', zustand: 'gueltig', fassung: 1, pruefsumme: SUMME(1),
        entschieden_am: '2026-12-15', freigegeben_am: '2026-12-15', entschieden_von: 'Robert Falk', form: 'wortlaut', ueberpruefung: frist('2028-12-10', 64),
      }],
      anwendungsbereich: [{
        dokument: 'D-0002', titel: 'Anwendungsbereich des Energiemanagements', zustand: 'gueltig', fassung: 1, pruefsumme: SUMME(2),
        entschieden_am: '2026-12-15', freigegeben_am: '2026-12-15', entschieden_von: 'Robert Falk', form: 'wortlaut', ueberpruefung: frist('2028-12-10', 64),
      }],
      rechtliche_anforderungen: [{
        dokument: 'D-0003', titel: 'Rechtliche Anforderungen zum Energieeinsatz', zustand: 'gueltig', fassung: 1, pruefsumme: null,
        entschieden_am: '2028-12-05', freigegeben_am: '2028-12-05', entschieden_von: 'Ines Kaltenbach', form: 'verweis',
        ablage: 'Rechtskataster-Dienst (Abonnement)', fassungsangabe: 'Stand 01.12.2028', ueberpruefung: null,
      }],
      risiken_chancen: SAETZE.verzeichnis_leer,
      aufgaben: { laufend: 10, ohne_person: ['bezugsbasen'] },
    },
    energieziele: [{
      kennzeichen: 'EZ-2028-0001', zielwert_prozent: -5.0, zielperiode: '2028-01/2028-12', zustand: 'bewertet', ergebnis: 'verfehlt',
      bewertet_am: '2029-01-15', person: 'Ines Kaltenbach', pruefsumme: SUMME(3), stand: { delta_prozent: -2.7, monate: '11 von 12' },
    }],
    energieleistung: {
      leistungsvergleiche: [{
        kennung: 'BR-2028-0001', zeitraum: '2027-12', stand: 1, freigegeben_am: '2028-01-12', delta_prozent: 12.9, urteil: 'schlechter',
        pruefsumme: SUMME(4), anstoesse_offen: [{ anlass: 'K-2028-0001', erkannt_am: '2028-04-03' }],
      }],
      bezugsbasen: [
        { kennzeichen: 'BB-0002', titel: 'Bezugsbasis BB-0002 (KZ-0001)', ueberpruefung: frist('2027-11-13', 457) },
        { kennzeichen: 'BB-0003', titel: 'Bezugsbasis BB-0003 (KZ-0002)', ueberpruefung: frist('2028-03-05', 344) },
        { kennzeichen: 'BB-0004', titel: 'Bezugsbasis BB-0004 (KZ-0004)', ueberpruefung: frist('2028-11-24', 80) },
        { kennzeichen: 'BB-0005', titel: 'Bezugsbasis BB-0005 (KZ-0005)', ueberpruefung: frist('2027-11-20', 450) },
      ],
    },
    massnahmen: [
      {
        kennzeichen: 'M-2028-0001', titel: 'Werkzeugheizungen in Betriebspausen abschalten (Zeitschaltung Maschinen 3–6)', herkunft_art: 'abweichung', herkunft_kennung: 'AW-2028-0001',
        zustand: 'bewertet', termin: '2028-05-31', umgesetzt_am: '2028-05-15',
        bewertung: { stand: 1, ergebnis: 'belegt', am: '2028-11-15', wirkung_prozent: -2.4, monate_bewertbar: 8, erwartet_prozent: -3.0, pruefsumme: SUMME(5) },
      },
      {
        kennzeichen: 'M-2028-0002', titel: 'Druckluft-Leckagen orten und beseitigen (Halle 1, Ringleitung)', herkunft_art: 'einsatz', herkunft_kennung: 'EE-3',
        zustand: 'bewertet', termin: '2028-09-30', umgesetzt_am: '2028-09-12',
        bewertung: { stand: 1, ergebnis: 'nicht_messbar', am: '2028-11-20', wirkung_prozent: null, monate_bewertbar: null, erwartet_prozent: null, pruefsumme: null },
      },
      {
        kennzeichen: 'M-2029-0001', titel: 'Aufgabe „Bezugsbasen pflegen und freigeben“ festlegen und über die zweite Prüfung entscheiden',
        herkunft_art: 'nichtkonformitaet', herkunft_kennung: 'F-2029-0001', zustand: 'geplant', termin: '2029-02-28', umgesetzt_am: null, bewertung: null,
      },
      {
        kennzeichen: 'M-2029-0002', titel: 'Energiepolitik in die Einarbeitung neuer Mitarbeitender aufnehmen', herkunft_art: 'audit',
        herkunft_kennung: 'AU-2029-0001', zustand: 'geplant', termin: '2029-03-31', umgesetzt_am: null, bewertung: null,
      },
    ],
    abweichungen: {
      im_jahr: [{ kennzeichen: 'AW-2028-0001', monate: ['2027-11', '2027-12'], zustand: 'abgeschlossen', ergebnis: 'massnahme', abgeschlossen_am: '2028-01-15', massnahme: 'M-2028-0001' }],
      auffaelligkeiten: [{ kennzahl: 'KZ-0004', monat: '2028-07', zustand: 'beantwortet', antwort: 'zur_kenntnis', am: '2028-08-10' }],
      offen: 0,
    },
    audits_feststellungen: {
      audits: [{ kennzeichen: 'AU-2029-0001', titel: 'Internes Audit 2029: Bezugsbasen, Energieziele, Maßnahmen und Grundlagen', termin: '2029-01-22', zustand: 'abgeschlossen', durchgefuehrt_am: '2029-01-22', abgeschlossen_am: '2029-01-31', pruefsumme: SUMME(6) }],
      feststellungen: [{ kennzeichen: 'F-2029-0001', quelle: 'internes_audit', festgestellt_am: '2029-01-22', frist: '2029-04-22', zustand: 'offen', wirksamkeit: null }],
      offen: 1,
    },
    bewertung_messplanung: {
      bewertungen: [{ kennung: 'BR-2027-0001', zeitraum: '2026-11/2027-10', stand: 1, freigegeben_am: '2027-11-24', pruefsumme: SUMME(7), ueberpruefung: frist('2028-11-24', 80) }],
      messbedarfe: [{ kennzeichen: 'MB-1', zustand: 'eingeloest', frist: null }],
      messbedarfe_offen: 0,
    },
    wiedervorlage: {
      stichtag: '2029-02-12', vorschau_tage: 30, anzahl_faellig: w.anzahl_faellig, anzahl_vorschau: w.anzahl_vorschau,
      faellig: w.faellig.map(({ art, kennzeichen, titel, faellig_am, satz }) => ({ art, kennzeichen, titel, faellig_am, satz })),
      vorschau: w.vorschau.map(({ art, kennzeichen, titel, faellig_am, satz }) => ({ art, kennzeichen, titel, faellig_am, satz })),
    },
    beschluesse: eingaben.beschluesse,
    sitzung: eingaben.sitzung,
    quellenverzeichnis: [
      { art: 'dokument', kennzeichen: 'D-0001', name_zum_datenstand: 'Energiepolitik', bezug: 'unmittelbar', version: null, fassung: 1, erster_tag: '2028-01-01', letzter_tag: '2028-12-31' },
      { art: 'energieziel', kennzeichen: 'EZ-2028-0001', name_zum_datenstand: 'Energieziel 2028', bezug: 'unmittelbar', version: 1, fassung: null, erster_tag: '2028-01-01', letzter_tag: '2028-12-31' },
      { art: 'berichtsstand', kennzeichen: 'BR-2028-0001', name_zum_datenstand: 'Leistungsvergleich 2027', bezug: 'unmittelbar', version: 1, fassung: null, erster_tag: '2028-01-01', letzter_tag: '2028-12-31' },
      { art: 'massnahme', kennzeichen: 'M-2028-0001', name_zum_datenstand: 'Zeitschaltung der Trocknerlüfter in Halle 1', bezug: 'unmittelbar', version: 1, fassung: null, erster_tag: '2028-01-01', letzter_tag: '2028-12-31' },
      { art: 'internes_audit', kennzeichen: 'AU-2029-0001', name_zum_datenstand: 'Internes Audit 2029', bezug: 'unmittelbar', version: null, fassung: null, erster_tag: '2028-01-01', letzter_tag: '2028-12-31' },
      { art: 'feststellung', kennzeichen: 'F-2029-0001', name_zum_datenstand: 'Feststellung F-2029-0001', bezug: 'unmittelbar', version: null, fassung: null, erster_tag: '2028-01-01', letzter_tag: '2028-12-31' },
    ],
  };
}

// ------------------------------------------------------------------ R13: Sitzung und die sechs Beschlüsse der Referenz

const P = { RF: EM_IDS.RF, IK: EM_IDS.IK, JW: EM_IDS.JW, PH: EM_IDS.PH, CB: EM_IDS.CB } as const;
const R13_BESCHLUESSE: { art: ManagementbewertungBeschluss['art']; wortlaut: string; zustaendig: string | null; termin: string | null }[] = [
  { art: 'energieziel', wortlaut: 'Energieziel 2029 für den Spritzguss: 4 % weniger Strom, als die Bezugsbasis erwarten lässt; die Arbeit an den Werkzeugheizungen geht weiter.', zustaendig: P.IK, termin: '2029-02-28' },
  { art: 'massnahme', wortlaut: 'Druckluft: Leckagen jährlich orten, 2029 im zweiten Quartal.', zustaendig: P.IK, termin: '2029-06-30' },
  { art: 'dokument', wortlaut: 'Energiepolitik um Einkauf und Planung ergänzen; neue Fassung bis 31.03.2029.', zustaendig: P.IK, termin: '2029-03-31' },
  { art: 'aufgabe', wortlaut: 'Die Aufgabe „Bezugsbasen pflegen und freigeben“ übernimmt Ines Kaltenbach, Vertretung Jonas Wendlinger. Eine zweite Prüfung bei Freigaben bleibt aus, solange nur zwei Personen freigeben dürfen; die Leitung sieht die Freigaben in der Managementbewertung durch.', zustaendig: P.JW, termin: '2029-02-28' },
  { art: 'ressourcen', wortlaut: 'Für 2029 stehen 25 000 € für Maßnahmen an der Druckluft bereit.', zustaendig: P.RF, termin: null },
  { art: 'keine_aenderung', wortlaut: 'Der Anwendungsbereich (D-0002, Fassung 1) bleibt unverändert.', zustaendig: P.IK, termin: null },
];

// ------------------------------------------------------------------ Die Routen

type Routen = Partial<Record<keyof typeof api, unknown>>;

/** Was die Bühne aus den übrigen Routen liest: Namen, Leitung am Tag, Folge-Objekte, Maßnahmen mit Herkunft. */
export type MbHilfen = {
  name: (id: string) => Promise<string | null>;
  leitungAm: (tag: string) => Promise<string[]>;
  objekt: (art: string, objekt: string) => Promise<{ zustand: string; angabe: string | null } | null>;
  massnahmen?: () => Promise<{ kennzeichen: string; zustand: string; herkunft: { art: string; kennung: string | null }; angelegt_am?: string }[]>;
};

type Eingaben = {
  sitzung: (ManagementbewertungSitzungFesthalten & { eingetragen_von: string; eingetragen_am: string }) | null;
  beschluesse: (ManagementbewertungBeschlussFesthalten & { nr: number; entschieden_von: string; eingetragen_von: string; eingetragen_am: string })[];
  folgen: { nr: number; art: string; objekt: string; verknuepft_am: string; eingetragen_von: string }[];
};

/**
 * Die Routen der Bühne: Berichte (nur Managementbewertungen), Sitzung, Beschlüsse und Folgen (IP-23), Unternehmen,
 * Wiedervorlage und Kalender-Abzug. `jetzt` liefert die Uhr der Spec (`page.clock`).
 */
export function managementbewertungBuehne(lage: MbLage, jetzt: () => string, hilfen: MbHilfen) {
  const gesendet: { route: string; body: unknown }[] = [];
  const eingaben = new Map<string, Eingaben>();
  const eingabe = (kennung: string) => {
    if (!eingaben.has(kennung)) eingaben.set(kennung, { sitzung: null, beschluesse: [], folgen: [] });
    return eingaben.get(kennung)!;
  };
  const heute = () => jetzt().slice(0, 10);
  const person = async (id: string | null | undefined) => (id ? { id, name: await hilfen.name(id) } : null);
  /** Die Eingaben, wie der Abzug sie zum Datenstand nennt (Namen, die Leitung nur mit der Aufgabe am Tag). */
  const abzugEingaben = async (kennung: string) => {
    const e = eingabe(kennung);
    const s = e.sitzung;
    const leitungGilt = s ? (await hilfen.leitungAm(s.tag)).includes(s.leitung) : false;
    return {
      sitzung: s
        ? {
            tag: s.tag, leitung: leitungGilt ? await hilfen.name(s.leitung) : null,
            teilnehmende: await Promise.all((s.teilnehmende ?? []).map(async (p) => (await hilfen.name(p)) ?? '')),
            ort: s.ort ?? null, eingetragen_von: s.eingetragen_von, eingetragen_am: s.eingetragen_am,
          }
        : null,
      beschluesse: await Promise.all(
        e.beschluesse.map(async (b) => ({
          nr: b.nr, kennung: `${kennung}/B${b.nr}`, art: b.art, wortlaut: b.wortlaut, entschieden_von: (await hilfen.name(b.entschieden_von)) ?? '',
          eingetragen_von: b.eingetragen_von, eingetragen_am: b.eingetragen_am, zustaendig: b.zustaendig ? await hilfen.name(b.zustaendig) : null,
          termin: b.termin ?? null,
        })),
      ),
    };
  };
  const berichte = new Map<string, { bericht: Bericht; staende: (BerichtStandKurz & { abzug: Record<string, unknown>; datenstand: string })[] }>();
  const neu = (kennung: string, zeitraum: string, angelegt: string): Bericht => ({
    kennung, vorlage: 'managementbewertung', vorlage_fassung: 1, geltung_art: 'unternehmen', geltung_id: UNTERNEHMEN_ID,
    geltung_name: 'Kunststoffwerk Ahrenberg GmbH', zeitraum_art: 'jahr', zeitraum, zeitraum_text: zeitraum, zeitzone: ZONE,
    angelegt_von: IK, angelegt_am: angelegt, archiviert_am: null, stand_zeichen: 'entwurf', stand_text: null, neueste_nr: null,
    entwurf_datenstand: angelegt, wiedervorlage_monate: null, ueberpruefung: null,
  });
  if (lage !== 'leer') berichte.set(MB_KENNUNG, { bericht: neu(MB_KENNUNG, '2028', '2029-02-05T09:00:00Z'), staende: [] });
  let staendeFertig: Promise<void> = Promise.resolve();
  if (lage === 'r13f') {
    const e = eingabe(MB_KENNUNG);
    e.sitzung = { tag: '2029-02-12', leitung: P.RF, teilnehmende: [P.IK, P.JW, P.PH, P.CB], ort: 'Werk Ahrenberg, Besprechungsraum', eingetragen_von: 'Ines Kaltenbach', eingetragen_am: '2029-02-12' };
    R13_BESCHLUESSE.forEach((b, i) =>
      e.beschluesse.push({
        nr: i + 1, art: b.art, wortlaut: b.wortlaut, entschieden_von: P.RF, eingetragen_von: 'Ines Kaltenbach', eingetragen_am: '2029-02-12',
        ...(b.zustaendig ? { zustaendig: b.zustaendig } : {}), ...(b.termin ? { termin: b.termin } : {}),
      }),
    );
    staendeFertig = (async () => {
      const abzug = r13Abzug('2029-02-12T14:00:00+01:00', await abzugEingaben(MB_KENNUNG));
      const pruefsumme = PRUEFSUMME_PRAEFIX + (await sha256Hex(kanonisch(abzug)));
      const b = berichte.get(MB_KENNUNG)!;
      b.staende.push({ nr: 1, datenstand: '2029-02-12T13:00:00Z', freigegeben_am: '2029-02-12T13:10:00Z', freigegeben_von: IK, pruefsumme, ersetzt_durch_nr: null, anlass_anstoss_id: null, abzug });
      b.bericht = { ...b.bericht, stand_zeichen: 'berichtsstand', neueste_nr: 1 };
    })();
  }
  const finde = async (kennung: string) => {
    await staendeFertig;
    const b = berichte.get(kennung);
    if (!b) throw fehler(404, 'nicht_gefunden', 'Diesen Bericht gibt es nicht.');
    return b;
  };
  const kurz = (s: BerichtStandKurz) => ({
    nr: s.nr, datenstand: s.datenstand, freigegeben_am: s.freigegeben_am, freigegeben_von: s.freigegeben_von, pruefsumme: s.pruefsumme,
    ersetzt_durch_nr: s.ersetzt_durch_nr, anlass_anstoss_id: s.anlass_anstoss_id,
  });
  const entwurf = async (kennung: string): Promise<BerichtEntwurf> => {
    const b = await finde(kennung);
    const datenstand = jetzt();
    const abzug = r13Abzug(datenstand, await abzugEingaben(kennung));
    return {
      kennung, datenstand, gebildet_von: 'abruf', neu_gebildet: false, pruefsumme: PRUEFSUMME_PRAEFIX + (await sha256Hex(kanonisch(abzug))),
      kopf: `Managementbewertung ${b.bericht.zeitraum}`, teilansicht: null, abzug,
    };
  };
  const stand = async (kennung: string, nr: number): Promise<BerichtStand> => {
    const b = await finde(kennung);
    const s = b.staende.find((x) => x.nr === nr);
    if (!s) throw fehler(404, 'stand_gibt_es_nicht', 'Diesen Stand gibt es nicht.');
    return {
      ...kurz(s), kennung, pruefsumme_geprueft: true, vorlage_fassung: 1, kopf: `Managementbewertung ${b.bericht.zeitraum}`, teilansicht: null,
      darstellung: (s.abzug.kopf as { darstellung: Record<string, unknown> }).darstellung, regelwerk: {}, abzug: s.abzug,
    };
  };
  const offen = async (kennung: string) => {
    const b = await finde(kennung);
    if (b.staende.length > 0) {
      throw fehler(409, 'managementbewertung_freigegeben', `Die Managementbewertung ${kennung} ist freigegeben — Sitzung und Beschlüsse stehen im Stand und ändern sich nicht mehr. Eine Berichtigung ist eine neue Freigabe mit Grund.`);
    }
  };
  const leitung = async (id: string, tag: string, feld: string) => {
    if (!(await hilfen.name(id))) throw fehler(422, 'person_unbekannt', 'Diese Person gibt es im Energiemanagement nicht.', { feld });
    if (!(await hilfen.leitungAm(tag)).includes(id)) {
      throw fehler(422, 'leitung_fehlt', `Diese Person hat am ${tag.slice(8, 10)}.${tag.slice(5, 7)}.${tag.slice(0, 4)} nicht die Aufgabe ‚Leitung des Unternehmens‘. Ordnen Sie die Leitung unter „Aufgaben“ zu.`, { feld, tag });
    }
  };
  const beschlussPruefen = async (e: Eingaben, body: ManagementbewertungBeschlussFesthalten) => {
    if (!e.sitzung) throw fehler(422, 'sitzung_fehlt', 'Halten Sie zuerst die Sitzung fest — ein Beschluss ist eine Entscheidung der Leitung in dieser Sitzung.');
    const entschieden = body.entschieden_von ?? e.sitzung.leitung;
    await leitung(entschieden, e.sitzung.tag, 'entschieden_von');
    return entschieden;
  };
  /** `GET …/managementbewertungen/{kennung}`: Namen von heute, Folgen mit dem Zustand von heute, Satz ohne Folge. */
  const ansicht = async (kennung: string): Promise<Managementbewertung> => {
    const b = await finde(kennung);
    const e = eingabe(kennung);
    const stand = b.staende[b.staende.length - 1] ?? null;
    const s = e.sitzung;
    const massnahmen = hilfen.massnahmen ? await hilfen.massnahmen().catch(() => []) : [];
    return {
      kennung, freigegeben: !!stand, stand_nr: stand?.nr ?? null,
      sitzung: s
        ? {
            tag: s.tag, leitung: (await person(s.leitung))!, leitung_gilt: (await hilfen.leitungAm(s.tag)).includes(s.leitung),
            teilnehmende: await Promise.all((s.teilnehmende ?? []).map(async (p) => (await person(p))!)), ort: s.ort ?? null,
            eingetragen_von: s.eingetragen_von, eingetragen_am: s.eingetragen_am,
          }
        : null,
      beschluesse: await Promise.all(
        e.beschluesse.map(async (x): Promise<ManagementbewertungBeschluss> => {
          const bn = `${kennung}/B${x.nr}`;
          const folgen: ManagementbewertungFolge[] = [
            ...(await Promise.all(
              e.folgen.filter((f) => f.nr === x.nr).map(async (f) => {
                const o = await hilfen.objekt(f.art, f.objekt);
                return { art: f.art as ManagementbewertungFolge['art'], objekt: f.objekt, wie: 'von_hand' as const, zustand: o?.zustand ?? '', angabe: o?.angabe ?? null, tag: null, verknuepft_am: f.verknuepft_am, eingetragen_von: f.eingetragen_von };
              }),
            )),
            ...massnahmen
              .filter((m) => m.herkunft.art === 'managementbewertung' && m.herkunft.kennung === bn)
              .map((m) => ({ art: 'massnahme' as const, objekt: m.kennzeichen, wie: 'herkunft' as const, zustand: m.zustand, angabe: null, tag: m.angelegt_am?.slice(0, 10) ?? null })),
          ];
          return {
            nr: x.nr, kennung: bn, art: x.art, wortlaut: x.wortlaut, entschieden_von: (await person(x.entschieden_von))!,
            zustaendig: await person(x.zustaendig), termin: x.termin ?? null, eingetragen_von: x.eingetragen_von, eingetragen_am: x.eingetragen_am,
            folgen, satz: stand && folgen.length === 0 ? `Keine Folge in VoltPilot — der Beschluss steht im Stand vom ${stand.freigegeben_am.slice(8, 10)}.${stand.freigegeben_am.slice(5, 7)}.${stand.freigegeben_am.slice(0, 4)}.` : null,
          };
        }),
      ),
    };
  };
  const routen: Routen = {
    unternehmen: async () => ({
      zustand: 'angelegt', id: UNTERNEHMEN_ID, name: 'Kunststoffwerk Ahrenberg GmbH', kurzname: 'Ahrenberg', zeitzone: ZONE,
      standortZahl: 2, anlagenZahl: 3, nochNichtZugeordnetZahl: 0,
    }),
    berichte: async () => {
      await staendeFertig;
      return { berichte: [...berichte.values()].map((b) => b.bericht) };
    },
    berichtAnlegen: async (body: { vorlage: string; geltung_id: string; zeitraum: string }) => {
      gesendet.push({ route: 'POST /api/v1/berichte', body });
      const da = [...berichte.values()].find((b) => b.bericht.zeitraum === body.zeitraum);
      if (da) {
        throw fehler(409, 'bericht_gibt_es_schon', `Diesen Bericht gibt es schon: ${da.bericht.kennung} (Managementbewertung Unternehmen Kunststoffwerk Ahrenberg GmbH, ${body.zeitraum}).`, { kennung: da.bericht.kennung });
      }
      const kennung = `BR-${jetzt().slice(0, 4)}-${String(berichte.size + 1).padStart(4, '0')}`;
      const b = neu(kennung, body.zeitraum, jetzt());
      berichte.set(kennung, { bericht: b, staende: [] });
      return b;
    },
    bericht: async (kennung: string): Promise<BerichtDetail> => {
      const b = await finde(kennung);
      return { bericht: b.bericht, staende: b.staende.map(kurz), anstoesse: [] };
    },
    berichtEntwurf: entwurf,
    berichtFreigeben: async (kennung: string, datenstand: string): Promise<BerichtStand> => {
      gesendet.push({ route: `POST /api/v1/berichte/${kennung}/freigeben`, body: { entwurf_datenstand: datenstand } });
      const b = await finde(kennung);
      // Das Freigabe-Tor von IP-23 (`BerichtService#sitzungUndBeschluss`): Sitzung, Leitung am Tag, ein Beschluss.
      const ein = await abzugEingaben(kennung);
      if (!ein.sitzung) throw fehler(422, 'sitzung_fehlt', 'Halten Sie zuerst die Sitzung fest — ohne Sitzung lässt sich die Managementbewertung nicht freigeben.');
      if (!ein.sitzung.leitung) throw fehler(422, 'leitung_fehlt', 'Die Sitzung nennt keine Leitung des Unternehmens am Tag der Sitzung.');
      if (ein.beschluesse.length === 0) throw fehler(422, 'beschluss_fehlt', 'Halten Sie mindestens einen Beschluss der Leitung fest.');
      const abzug = r13Abzug(datenstand, ein);
      const pruefsumme = PRUEFSUMME_PRAEFIX + (await sha256Hex(kanonisch(abzug)));
      const nr = b.staende.length + 1;
      b.staende.push({ nr, datenstand, freigegeben_am: jetzt(), freigegeben_von: IK, pruefsumme, ersetzt_durch_nr: null, anlass_anstoss_id: null, abzug });
      b.bericht = { ...b.bericht, stand_zeichen: 'berichtsstand', neueste_nr: nr };
      return stand(kennung, nr);
    },
    berichtStand: stand,
    berichtDatei: async (kennung: string, nr: number, format: string) => {
      gesendet.push({ route: `GET /api/v1/berichte/${kennung}/staende/${nr}/${format}`, body: null });
      await stand(kennung, nr);
      return new Blob(['%PDF-1.7 Bühne'], { type: 'application/pdf' });
    },
    managementbewertung: async (kennung: string) => ansicht(kennung),
    managementbewertungSitzung: async (kennung: string, body: ManagementbewertungSitzungFesthalten) => {
      gesendet.push({ route: `PUT /api/v1/energiemanagement/managementbewertungen/${kennung}/sitzung`, body });
      await offen(kennung);
      if (body.tag > heute()) throw fehler(422, 'tag_in_der_zukunft', 'Eine Sitzung halten Sie fest, wenn sie stattgefunden hat — der Tag liegt in der Zukunft.', { feld: 'tag' });
      await leitung(body.leitung, body.tag, 'leitung');
      eingabe(kennung).sitzung = { ...body, eingetragen_von: 'Ines Kaltenbach', eingetragen_am: heute() };
      return ansicht(kennung);
    },
    managementbewertungBeschluss: async (kennung: string, body: ManagementbewertungBeschlussFesthalten) => {
      gesendet.push({ route: `POST /api/v1/energiemanagement/managementbewertungen/${kennung}/beschluesse`, body });
      await offen(kennung);
      const e = eingabe(kennung);
      const entschieden = await beschlussPruefen(e, body);
      e.beschluesse.push({ ...body, nr: e.beschluesse.length + 1, entschieden_von: entschieden, eingetragen_von: 'Ines Kaltenbach', eingetragen_am: heute() });
      return ansicht(kennung);
    },
    managementbewertungBeschlussAendern: async (kennung: string, nr: number, body: ManagementbewertungBeschlussFesthalten) => {
      gesendet.push({ route: `PUT /api/v1/energiemanagement/managementbewertungen/${kennung}/beschluesse/${nr}`, body });
      await offen(kennung);
      const e = eingabe(kennung);
      const i = e.beschluesse.findIndex((b) => b.nr === nr);
      if (i < 0) throw fehler(404, 'nicht_gefunden', `Den Beschluss B${nr} gibt es nicht.`);
      const entschieden = await beschlussPruefen(e, body);
      e.beschluesse[i] = { ...body, nr, entschieden_von: entschieden, eingetragen_von: 'Ines Kaltenbach', eingetragen_am: heute() };
      return ansicht(kennung);
    },
    managementbewertungFolge: async (kennung: string, nr: number, body: ManagementbewertungFolgeVerknuepfen) => {
      gesendet.push({ route: `POST /api/v1/energiemanagement/managementbewertungen/${kennung}/beschluesse/${nr}/folgen`, body });
      const b = await finde(kennung);
      if (b.staende.length === 0) throw fehler(409, 'managementbewertung_nicht_freigegeben', 'Folgen verknüpfen Sie nach der Freigabe — erst dann steht der Beschluss im Stand.');
      const e = eingabe(kennung);
      if (!e.beschluesse.some((x) => x.nr === nr)) throw fehler(404, 'nicht_gefunden', `Den Beschluss B${nr} gibt es nicht.`);
      if ((body.art as string) === 'massnahme') throw fehler(422, 'folge_art', `Eine Maßnahme verknüpft sich selbst: legen Sie sie mit der Herkunft „Managementbewertung“ und ${kennung}/B${nr} an.`);
      if (!(await hilfen.objekt(body.art, body.objekt))) throw fehler(422, 'objekt_unbekannt', `${body.objekt} gibt es in Ihrem Kundenbereich nicht.`, { feld: 'objekt' });
      if (!e.folgen.some((f) => f.nr === nr && f.art === body.art && f.objekt === body.objekt)) {
        e.folgen.push({ nr, art: body.art, objekt: body.objekt, verknuepft_am: heute(), eingetragen_von: 'Ines Kaltenbach' });
      }
      return ansicht(kennung);
    },
    // MG7 (IP-23 `ManagementbewertungWiedervorlage`): letzte Sitzung einer freigegebenen Managementbewertung + 12 Monate
    // (Startwert der Einstellung) — im Fenster als Zeile, sonst nur das Kennzeichen in `nicht_in_liste`.
    energiemanagementWiedervorlage: async () => {
      await staendeFertig;
      const w = r12Wiedervorlage();
      const mit = [...berichte.values()].filter((b) => b.staende.length > 0 && eingabe(b.bericht.kennung).sitzung);
      const letzte = mit.sort((x, y) => eingabe(y.bericht.kennung).sitzung!.tag.localeCompare(eingabe(x.bericht.kennung).sitzung!.tag))[0];
      if (letzte) {
        const tagS = eingabe(letzte.bericht.kennung).sitzung!.tag;
        const faellig = `${Number(tagS.slice(0, 4)) + 1}${tagS.slice(4)}`;
        const tage = Math.round((Date.parse(`${heute()}T00:00:00Z`) - Date.parse(`${faellig}T00:00:00Z`)) / 86_400_000);
        const z = zeile('managementbewertung', letzte.bericht.kennung, 'Nächste Managementbewertung', faellig, tage, 'Ines Kaltenbach');
        if (tage >= 0) w.faellig.push(z);
        else if (-tage <= w.vorschau_tage) w.vorschau.push(z);
        else w.nicht_in_liste = [...w.nicht_in_liste, letzte.bericht.kennung].sort();
        w.anzahl_faellig = w.faellig.length;
        w.anzahl_vorschau = w.vorschau.length;
      }
      return w;
    },
    energiemanagementWiedervorlageIcs: async () => {
      gesendet.push({ route: 'GET /api/v1/energiemanagement/wiedervorlage?format=ics', body: null });
      return new Blob(['BEGIN:VCALENDAR\r\nX-WR-CALDESC:Stand vom 12.02.2029 aus VoltPilot; maßgeblich ist die Wiedervorlage im Portal.\r\nEND:VCALENDAR\r\n'], { type: 'text/calendar' });
    },
  };
  return { routen, gesendet };
}
