import { dez, dezRunde, dezText, halbAuf, type Dez } from './dez';
import { iso, mitternacht, schluesselVon, spanneVon, tagPlus, zwei } from './bezugsPeriode';
import { KEINE_WERTE as ZUSTAND_KEINE_WERTE, OHNE_ZAHL as ERGEBNIS_OHNE_ZAHL, PLATZHALTER, PROZENT, TRENNER, uhr, zahl, zahlMitStellen, zoneKurz } from './uemsErgebnis';
import {
  ANSEHEN,
  anzeige as kennzahlAnzeige,
  periodeText,
  STANDORT as KENNZAHL_STANDORT,
  UNTERNEHMEN as KENNZAHL_UNTERNEHMEN,
  VOR_BESTEHEN as KENNZAHL_VOR_BESTEHEN,
  VORLAEUFIG,
  WERT_NACHKOMMASTELLEN,
} from './uemsKennzahl';
import { datumText } from './uemsOrtsbaum';
import { darf, type Benutzer, type Kundenbereich, type Matrix } from './rechte';

/**
 * Die reinen Regeln des BERICHTS (UEMS AP-12 IP-1/IP-3) — der TS-Zwilling von
 * `services/api .../uems/BerichtRegeln`, beide gegen `docs/contracts/v2/bericht-vectors.json`.
 *
 * Ein Bericht ist ein eigenes Objekt (Vorlage × Geltung × Zeitraum) mit einem Entwurf und
 * freigegebenen Berichtsständen; ein Berichtsstand ist ein ABZUG — Text mit Prüfsumme, nie ein
 * Verweis (E1). Hier: Zeitraum und Vergleichszeiträume (V1, Q5), Freigabe-Voraussetzungen (F1),
 * Datenstand (D2–D4), Betroffenheit (B1, B4, B6), Abweichung zweier Abzüge (R1), kanonische Form
 * (A1 — byte-gleich zu Java), Berichts-CSV (DA3), Teilansicht (G3), Kopf, Kennzeichen und Sätze.
 *
 * Aufgerufen, nicht kopiert: Perioden `spanneVon`/`mitternacht`, Uhrzeit und Zone `uhr`/`zoneKurz`,
 * Zahlform `zahl`/`zahlMitStellen`, Kennzahl-Anzeige und Periodenname aus `uemsKennzahl`, Datum
 * `datumText`, Recht `darf`. Den SHA-256 rechnet das Portal nicht: die Prüfsumme prüft der Server
 * beim Lesen eines Stands (A6); der Test hasht den kanonischen Text mit `node:crypto`.
 * Noch ruft niemand an (Portal IP-13/IP-14).
 */

type Json = any;

// ============================================================== Vokabulare

export const ENTWURF = 'entwurf';
export const FREIGEGEBEN = 'freigegeben';
export const STAENDE = [ENTWURF, FREIGEGEBEN];

export const STANDORT = KENNZAHL_STANDORT;
export const UNTERNEHMEN = KENNZAHL_UNTERNEHMEN;
export const GELTUNG_ARTEN = [STANDORT, UNTERNEHMEN];

export const MONAT = 'monat';
export const JAHR = 'jahr';
export const DATENGRUNDLAGE = 'datengrundlage';
export const ZEITRAUM_ARTEN = [MONAT, JAHR, DATENGRUNDLAGE];

export const VORMONAT = 'vormonat';
export const VORJAHRESMONAT = 'vorjahresmonat';
export const VORJAHR = 'vorjahr';
export const VERGLEICH_ARTEN = [VORMONAT, VORJAHRESMONAT, VORJAHR];

export const QUELLE_ARTEN = ['messstelle', 'kostenstelle', 'bezugsgroesse', 'stammdatum', 'kennzahl', 'umfang', 'energieeinsatz', 'messbedarf', 'messmittel', 'bezugsbasis'];
export const QUELLE_BEZUEGE = ['unmittelbar', 'mittelbar', 'vergleich'];

export const KORREKTUR_FREIGEGEBEN = 'korrektur_freigegeben';
export const KORREKTUR_ZURUECKGENOMMEN = 'korrektur_zurueckgenommen';
export const ERSATZWERT_WIRKSAM = 'ersatzwert_wirksam';
export const ERSATZWERT_ZURUECKGENOMMEN = 'ersatzwert_zurueckgenommen';
export const BEZUGSGROESSE_FASSUNG = 'bezugsgroesse_fassung';
export const KENNZAHL_FASSUNG_RUECKWIRKEND = 'kennzahl_fassung_rueckwirkend';
export const ZUORDNUNG_RUECKWIRKEND = 'zuordnung_rueckwirkend';
export const ANLAGE_UMZUG_RUECKWIRKEND = 'anlage_umzug_rueckwirkend';
export const FLAECHE_RUECKWIRKEND = 'flaeche_rueckwirkend';
export const VERTEILUNG_RUECKWIRKEND = 'verteilung_rueckwirkend';
export const EINSTUFUNG_FASSUNG = 'einstufung_fassung';
export const KRITERIEN_FASSUNG = 'kriterien_fassung';
export const UMFANG_FASSUNG = 'umfang_fassung';
export const MESSBEDARF_ZUSTAND = 'messbedarf_zustand';
export const PROZESS_ZUORDNUNG_RUECKWIRKEND = 'prozess_zuordnung_rueckwirkend';
export const MESSMITTEL_ANGABE = 'messmittel_angabe';
export const BEZUGSBASIS_ANSTOSS = 'bezugsbasis_anstoss';
export const BEZUGSBASIS_FASSUNG = 'bezugsbasis_fassung';
export const BEZUGSBASIS_BEENDET = 'bezugsbasis_beendet';
/** B4 — die Anstoß-Arten, geschlossen. */
export const ANSTOSS_ARTEN = [
  KORREKTUR_FREIGEGEBEN, KORREKTUR_ZURUECKGENOMMEN, ERSATZWERT_WIRKSAM, ERSATZWERT_ZURUECKGENOMMEN,
  BEZUGSGROESSE_FASSUNG, KENNZAHL_FASSUNG_RUECKWIRKEND, ZUORDNUNG_RUECKWIRKEND, ANLAGE_UMZUG_RUECKWIRKEND,
  FLAECHE_RUECKWIRKEND, VERTEILUNG_RUECKWIRKEND, EINSTUFUNG_FASSUNG, KRITERIEN_FASSUNG,
  UMFANG_FASSUNG, MESSBEDARF_ZUSTAND, PROZESS_ZUORDNUNG_RUECKWIRKEND, MESSMITTEL_ANGABE,
  BEZUGSBASIS_ANSTOSS, BEZUGSBASIS_FASSUNG, BEZUGSBASIS_BEENDET,
];
export const ANSTOSS_ZUSTAENDE = ['offen', 'erledigt', 'verworfen'];

export const VOR_BESTEHEN = KENNZAHL_VOR_BESTEHEN;
export const QUELLE_BEENDET = 'quelle_beendet';
export const KEINE_WERTE = 'keine_werte';
export const GRUENDE_OHNE_VERGLEICH = [VOR_BESTEHEN, QUELLE_BEENDET, KEINE_WERTE];

export const UMBENENNUNG = 'umbenennung';
export const NICHT_RUECKWIRKEND = 'nicht_rueckwirkend';
export const KEINE_STRUKTURAENDERUNG = 'keine_strukturaenderung';
export const KEIN_ANSTOSS = [UMBENENNUNG, NICHT_RUECKWIRKEND, KEINE_STRUKTURAENDERUNG];

export const ORT_AENDERUNG = 'ort_aenderung';
export const MESSSTELLE_AENDERUNG = 'messstelle_aenderung';
export const ENERGIEEINSATZ_AENDERUNG = 'energieeinsatz_aenderung';
export const BEWERTUNG_AENDERUNG = 'bewertung_aenderung';
export const MESSBEDARF_AENDERUNG = 'messbedarf_aenderung';
export const GERAET_AENDERUNG = 'geraet_aenderung';
export const STRUKTUR_PROTOKOLLE = [ORT_AENDERUNG, MESSSTELLE_AENDERUNG, ENERGIEEINSATZ_AENDERUNG,
  BEWERTUNG_AENDERUNG, MESSBEDARF_AENDERUNG, GERAET_AENDERUNG];

export const HANDLUNGEN = ['abrufen', 'pdf', 'csv', 'anlegen', 'freigeben', 'verwerfen', 'archivieren', 'wiedervorlage_aendern'];

/** §5.8 — der HTTP-Status je Fehler-Code. */
export const FEHLER_STATUS: Record<string, number> = {
  zeitraum_nicht_zu_ende: 422,
  werte_vorlaeufig: 422,
  entwurf_veraltet: 409,
  keine_quellen: 422,
  bericht_gibt_es_schon: 409,
  stand_gibt_es_nicht: 404,
  wert_nicht_mehr_gespeichert: 404,
  berichts_belege: 409,
  abzug_beschaedigt: 500,
  vorlage_unbekannt: 422,
  geltung_unbekannt: 404,
};
export const FEHLER = Object.keys(FEHLER_STATUS);

/** Reserviert im Ereignis-Vokabular, angelegt mit den Berichts-Tabellen (IP-4) — Art/Bezug. */
export const EREIGNISSE_RESERVIERT = [
  'bericht_freigegeben/bericht', 'bericht_revision_angestossen/bericht', 'bericht_entwurf_neu_gebildet/bericht',
  'bericht_abgerufen/bericht',
];

/** Die Rechte der Berichte; seit AP-19 IP-11 (RE4, W10) je eine Lese-Kennung neben dem Freigabe-Recht am Unternehmen. */
export const RECHTE = ['bericht.standort_abrufen', 'bericht.standort_freigeben', 'bericht.unternehmen',
  'bericht.unternehmen_abrufen', 'bewertung.abrufen', 'bewertung.ansehen', 'export.standort', 'export.unternehmen'];

/** G1 — Handlung × Geltung → Kennung der Rechte-Matrix, Schlüssel `<geltung>/<handlung>`. */
export const KENNUNG: Record<string, string> = Object.fromEntries(
  GELTUNG_ARTEN.flatMap((g) => HANDLUNGEN.map((h) => {
    const standort = g === STANDORT;
    const lesen = h === 'abrufen' || h === 'pdf';
    // AP-19 IP-11 (RE4, W10): am Unternehmen trägt das Lesen seine eigene Kennung, wie am Standort.
    const k = h === 'csv' ? (standort ? 'export.standort' : 'export.unternehmen')
      : standort ? (lesen ? 'bericht.standort_abrufen' : 'bericht.standort_freigeben')
        : lesen ? 'bericht.unternehmen_abrufen' : 'bericht.unternehmen';
    return [`${g}/${h}`, k];
  })),
);

/** G3 — die Standorte einer Teilansicht sind die, deren Messwerte die Person ansehen darf. */
export const TEILANSICHT_RECHT = ANSEHEN;

// ============================================================== Regeln der Darstellung

/** F1 — ein Stand ist frühestens Periodenende + diese Frist freigebbar (Java: `TagRegeln.FRIST`). */
export const FREIGABE_FRIST_TAGE = 7;
const TAG_MS = 86_400_000;
export const PROZENT_NACHKOMMASTELLEN = 1;
export const PROZENT_RECHEN_NACHKOMMASTELLEN = WERT_NACHKOMMASTELLEN;
export const QUELLEN_IM_SATZ = 3;
export const PRUEFSUMME_PRAEFIX = 'sha256:';
export const KENNZEICHEN_TRENNER = TRENNER;
export const OHNE_ZAHL = ERGEBNIS_OHNE_ZAHL;
export const CSV_TRENNER = ';';
export const CSV_DEZIMAL = ',';
export const CSV_SPALTEN = ['quelle', 'name', 'ort', 'periode', 'menge', 'einheit', 'zustand', 'abdeckung_prozent', 'kennzeichen', 'fassung', 'endgueltig_ab', 'version', 'berechnet_am'];
export const CSV_KOPF = ['bericht', 'vorlage', 'geltung', 'zeitraum', 'stand', 'datenstand', 'freigegeben_am', 'freigegeben_von', 'zeitzone', 'dezimal', 'trenner', 'zahlen', 'pruefsumme', 'erzeugt_am', 'erzeugt_von', 'teilansicht'];

/** E14 — Wörter, die ein Bericht nie über sich sagt („Version“ gehört den Werten). */
export const VERBOTENE_WOERTER = ['Version des Berichts', 'Ausgabe', 'Snapshot', 'Report', 'Freigabe zurücknehmen'];

/** §5.8 und der Kopf — die Satzvorlagen; `{name}` füllt die Regel. */
export const SAETZE: Record<string, string> = {
  zeitraum_nicht_zu_ende: '{zeitraum} ist noch nicht zu Ende — ein Berichtsstand ist ab dem {datum} möglich ({tage} Tage nach {ende}).',
  zeitraum_monat: 'Der {name}',
  zeitraum_jahr: 'Das Jahr {name}',
  zeitraum_datengrundlage: 'Die Datengrundlage {name}',
  ende_monat: 'Monatsende',
  ende_jahr: 'Jahresende',
  ende_datengrundlage: 'Ende der Datengrundlage',
  werte_vorlaeufig: '{werte} noch vorläufig (endgültig ab {datum}): {quellen} — ein Berichtsstand braucht endgültige Werte.',
  werte_mehrere: '{anzahl} Werte sind',
  werte_einer: '1 Wert ist',
  quellen_weitere: '…',
  entwurf_veraltet: 'Der Entwurf hat sich seit dem {zeitpunkt} geändert{anlass}. Laden Sie ihn neu{pruefen}.',
  entwurf_veraltet_anlass: ' ({anlass})',
  entwurf_veraltet_pruefen: ' und prüfen Sie die {anzahl} Abweichungen',
  entwurf_veraltet_pruefen_eine: ' und prüfen Sie die Abweichung',
  keine_quellen: 'Für {geltung} gibt es {zeitraum} keine Messstellen.',
  keine_quellen_seit: 'Für {geltung} gibt es {zeitraum} keine Messstellen — der Standort besteht seit dem {datum}.',
  im_monat: 'im {name}',
  im_jahr: 'im Jahr {name}',
  bericht_gibt_es_schon: 'Diesen Bericht gibt es schon: {kennung} ({vorlage} {geltung}, {zeitraum}).',
  vorlage_monat: 'Monatsbericht',
  vorlage_jahr: 'Jahresbericht',
  stand_gibt_es_nicht: 'Berichtsstand Nr. {nr} gibt es nicht — der neueste ist Nr. {neueste} vom {datum}.',
  stand_gibt_es_nicht_keiner: 'Berichtsstand Nr. {nr} gibt es nicht — der Bericht hat noch keinen freigegebenen Berichtsstand.',
  wert_nicht_mehr_gespeichert: 'Der Wert {zeitraum} wird nicht mehr gespeichert (Aufbewahrung 10 Jahre). Der Berichtsstand Nr. {nr} vom {datum} hält ihn fest.',
  wert_nicht_mehr_gespeichert_ohne_stand: 'Der Wert {zeitraum} wird nicht mehr gespeichert (Aufbewahrung 10 Jahre).',
  vom_monat: 'vom {name}',
  vom_jahr: 'vom Jahr {name}',
  berichts_belege: 'Diese Komponente ist Beleg in {anzahl} freigegebenen Berichtsständen ({staende}). Löschen ist nicht möglich — beenden Sie die Bindung stattdessen.',
  berichts_belege_eins: 'Diese Komponente ist Beleg in einem freigegebenen Berichtsstand ({staende}). Löschen ist nicht möglich — beenden Sie die Bindung stattdessen.',
  stand_bezeichnung: '{kennung} Nr. {nr}',
  abzug_beschaedigt: 'Der Berichtsstand Nr. {nr} kann nicht gelesen werden: die Prüfsumme stimmt nicht. Bitte wenden Sie sich an VoltPilot.',
  vorlage_unbekannt: 'Diese Berichtsvorlage gibt es nicht.',
  geltung_unbekannt: 'Diesen Standort gibt es nicht.',
  kopf_stand: 'Datenstand {datenstand} · Berichtsstand Nr. {nr} · freigegeben {freigegeben} von {person}',
  kopf_entwurf: 'Entwurf · Datenstand {datenstand}',
  zeit_mit_zone: '{zeitpunkt} ({zone})',
  anlass_korrektur: 'Korrektur {kennung}',
  anlass_ersatzwert: 'Ersatzwert {kennung}',
  anlass_zuordnung_rueckwirkend: 'Zuordnung {objekt} geändert, gilt ab {ab}, eingetragen {am}',
  anlass_anlage_umzug_rueckwirkend: 'Anlage {objekt} umgezogen, gilt ab {ab}, eingetragen {am}',
  anlass_flaeche_rueckwirkend: 'Fläche {objekt} geändert, gilt ab {ab}, eingetragen {am}',
  anlass_verteilung_rueckwirkend: 'Verteilung {objekt} berichtigt, gilt ab {ab}, eingetragen {am}',
  anlass_einstufung_fassung: 'Einstufung {objekt} geändert',
  anlass_kriterien_fassung: 'Kriterien-Fassung geändert',
  anlass_umfang_fassung: 'Betrachtungsumfang geändert',
  anlass_messbedarf_zustand: 'Messbedarf {objekt} geändert',
  anlass_prozess_zuordnung_rueckwirkend: 'Prozess-Zuordnung {objekt} rückwirkend geändert',
  anlass_messmittel_angabe: 'Messmittel-Angaben {objekt} geändert',
  anlass_bezugsbasis_anstoss: 'Bezugsbasis {basis}, Fassung {fassung}: Anstoß liegt vor',
  anlass_bezugsbasis_fassung: 'Bezugsbasis {basis}: Fassung {fassung} freigegeben',
  anlass_bezugsbasis_beendet: 'Bezugsbasis {basis} beendet',
  ueber_formel: '{anlass} (über die Formel)',
  ueber_kennzahl: '{anlass} (über die Kennzahl)',
  csv_geltung_standort: 'Standort {kennzeichen} {name}',
  csv_geltung_unternehmen: 'Unternehmen {kennzeichen} {name}',
  csv_zeitraum: '{schluessel} ({erster}–{letzter})',
  leistungsvergleich_stand: 'Leistungsvergleich {name}, {zeitraum} · Stand Nr. {nr} vom {datum} · Bezugsbasis {bezugsbasis}, Fassung {fassung} · Prüfsumme {pruefsumme}…',
  leistungsvergleich_ohne_stand: 'ungesichert — noch kein Stand',
};

const fuelle = (vorlage: string, werte: Record<string, string | number>): string =>
  Object.entries(werte).reduce((t, [k, v]) => t.split(`{${k}}`).join(String(v)), vorlage);

// ============================================================== Kennzeichen (ergebnis-zustand 1.10)

export type Kennzeichen = { schluessel: string; muster: string; platzhalter: Record<string, string>; stelle: string };

/** Die Platzhalter-Typen; `uhr` ist der von `uemsErgebnis.PLATZHALTER`. */
export const KENNZEICHEN_PLATZHALTER: Record<string, string> = {
  nr: '[1-9][0-9]*',
  datum: '(?:0[1-9]|[12][0-9]|3[01])\\.(?:0[1-9]|1[0-2])\\.[0-9]{4}',
  uhr: PLATZHALTER.uhr,
  text: '.+',
};

export const KENNZEICHEN: Kennzeichen[] = [
  { schluessel: 'berichtsstand', muster: 'Berichtsstand Nr. {nr}', platzhalter: { nr: 'nr' }, stelle: 'bericht' },
  { schluessel: 'ersetzt_durch', muster: 'ersetzt durch Nr. {nr} ({datum})', platzhalter: { nr: 'nr', datum: 'datum' }, stelle: 'stand' },
  { schluessel: 'revision_noetig', muster: 'Revision nötig — {anlass}', platzhalter: { anlass: 'text' }, stelle: 'bericht' },
  { schluessel: 'entwurf', muster: 'Entwurf · Datenstand {datum} {uhr}', platzhalter: { datum: 'datum', uhr: 'uhr' }, stelle: 'bericht' },
  { schluessel: 'zeitraum_laeuft', muster: 'Zeitraum läuft', platzhalter: {}, stelle: 'entwurf' },
  { schluessel: 'vorlaeufig', muster: 'vorläufig — endgültig ab {datum}', platzhalter: { datum: 'datum' }, stelle: 'wert' },
  { schluessel: 'heute', muster: 'heute: {name}', platzhalter: { name: 'text' }, stelle: 'quelle' },
  { schluessel: 'teilansicht', muster: 'Teilansicht: {standorte}', platzhalter: { standorte: 'text' }, stelle: 'datei' },
  { schluessel: 'vor_beginn', muster: 'vor Beginn (Energiemanagement seit {datum})', platzhalter: { datum: 'datum' }, stelle: 'wert' },
  { schluessel: 'anstoss_verworfen', muster: 'Anstoß verworfen ({begruendung})', platzhalter: { begruendung: 'text' }, stelle: 'bericht' },
];

const muster = (schluessel: string): string => {
  const k = KENNZEICHEN.find((x) => x.schluessel === schluessel);
  if (!k) throw new Error(`unbekanntes Kennzeichen ${schluessel}`);
  return k.muster;
};

export const ZEITRAUM_LAEUFT = muster('zeitraum_laeuft');

// ============================================================== Vorlagen (V2)

/**
 * `geltung_art`/`zeitraum_art` sind die Vorgabe; `geltung_arten` × `zeitraum_arten` die Paare, für die die Vorlage gilt
 * (1.4: der Leistungsvergleich kennt sechs, jede andere Vorlage genau eines).
 */
export type Vorlage = { schluessel: string; fassung: number; geltung_art: string; zeitraum_art: string; geltung_arten: string[]; zeitraum_arten: string[]; vergleiche: string[]; abschnitte: string[] };

/** AP-17 IP-21a (S1, W8): Vertrag 1.4 — die Kennzahl im Vergleich mit ihrer Bezugsbasis. */
export const LEISTUNGSVERGLEICH = 'leistungsvergleich';
/**
 * Vorlagen im Katalog, deren Leser noch fehlt: der Server lehnt das Anlegen ab, das Portal zeigt keine Karte. Seit
 * AP-17 IP-21b (der Abzug des Leistungsvergleichs) leer — wie `BerichtRegeln.OHNE_LESER`.
 */
export const OHNE_LESER: readonly string[] = [];

export const VORLAGEN: Vorlage[] = [
  { schluessel: 'monatsbericht_standort', fassung: 1, geltung_art: STANDORT, zeitraum_art: MONAT, geltung_arten: [STANDORT], zeitraum_arten: [MONAT], vergleiche: [VORMONAT, VORJAHRESMONAT], abschnitte: ['kopf', 'zusammenfassung', 'verbrauch_je_messstelle', 'tagesverlauf', 'kennzahlen', 'qualitaet', 'quellenverzeichnis'] },
  { schluessel: 'jahresbericht_standort', fassung: 1, geltung_art: STANDORT, zeitraum_art: JAHR, geltung_arten: [STANDORT], zeitraum_arten: [JAHR], vergleiche: [VORJAHR], abschnitte: ['kopf', 'zusammenfassung', 'verbrauch_je_messstelle', 'monatswerte', 'kennzahlen', 'qualitaet', 'quellenverzeichnis'] },
  { schluessel: 'monatsbericht_unternehmen', fassung: 1, geltung_art: UNTERNEHMEN, zeitraum_art: MONAT, geltung_arten: [UNTERNEHMEN], zeitraum_arten: [MONAT], vergleiche: [VORMONAT, VORJAHRESMONAT], abschnitte: ['kopf', 'zusammenfassung', 'standorte', 'kostenstellen', 'kennzahlen', 'qualitaet', 'quellenverzeichnis'] },
  { schluessel: 'jahresbericht_unternehmen', fassung: 1, geltung_art: UNTERNEHMEN, zeitraum_art: JAHR, geltung_arten: [UNTERNEHMEN], zeitraum_arten: [JAHR], vergleiche: [VORJAHR], abschnitte: ['kopf', 'zusammenfassung', 'standorte', 'kostenstellen', 'monatswerte', 'kennzahlen', 'qualitaet', 'quellenverzeichnis'] },
  { schluessel: 'energetische_bewertung', fassung: 1, geltung_art: UNTERNEHMEN, zeitraum_art: DATENGRUNDLAGE, geltung_arten: [UNTERNEHMEN], zeitraum_arten: [DATENGRUNDLAGE], vergleiche: [], abschnitte: ['umfang', 'rangliste', 'einstufungen', 'messabdeckung', 'messplanung', 'messmittel', 'qualitaet', 'quellenverzeichnis'] },
  { schluessel: LEISTUNGSVERGLEICH, fassung: 1, geltung_art: UNTERNEHMEN, zeitraum_art: MONAT, geltung_arten: [UNTERNEHMEN, STANDORT], zeitraum_arten: [MONAT, JAHR, DATENGRUNDLAGE], vergleiche: [], abschnitte: ['kopf', 'kennzahl', 'bezugsbasis', 'vergleich_je_periode', 'urteil', 'grenzen_und_vorbehalte', 'statische_faktoren', 'quellenverzeichnis'] },
];

/** V2 — die Vorlage zu ihrem Schlüssel; `null` = `vorlage_unbekannt`. */
export const vorlage = (schluessel: string): Vorlage | null => VORLAGEN.find((v) => v.schluessel === schluessel) ?? null;

/** V2 — gilt die Vorlage für Geltung × Zeitraum? Dieselbe Frage stellt `bericht_vorlage_passt()` der Datenbank. */
export const vorlagePasst = (schluessel: string, geltungArt: string, zeitraumArt: string): boolean => {
  const v = vorlage(schluessel);
  return v !== null && v.geltung_arten.includes(geltungArt) && v.zeitraum_arten.includes(zeitraumArt);
};

// ============================================================== Zeit

const ms = (zeitpunkt: string): number => Date.parse(zeitpunkt);
const tagIn = (t: number, zone: string): string => iso(t, zone).slice(0, 10);
const datum = (t: number, zone: string): string => datumText(tagIn(t, zone));
/** „15.01.2027 09:12“ — Datum und Wanduhr (Java: `KorrekturVorschlagRegeln.zeitpunkt`). */
const zeitpunkt = (t: number, zone: string): string => `${datum(t, zone)} ${uhr(t, zone)}`;

// ============================================================== Zeitraum (V1, Q5)

export type Vergleichszeitraum = { art: string; schluessel: string; erster_tag: string; letzter_tag: string; von: string; bis: string };
export type Zeitraum = {
  art: string; schluessel: string; erster_tag: string; letzter_tag: string; von: string; bis: string;
  freigabe_ab: string; bezeichnung: string; vergleiche: Vergleichszeitraum[];
};

const vergleichszeitraum = (art: string, tag: string, periodeArt: string, zone: string): Vergleichszeitraum => {
  const schluessel = schluesselVon(tag, periodeArt);
  const [erster, letzter] = spanneVon(schluessel, periodeArt);
  return { art, schluessel, erster_tag: erster, letzter_tag: letzter, von: iso(mitternacht(erster, zone), zone), bis: iso(mitternacht(tagPlus(letzter, 1), zone), zone) };
};

/** V1/S1 — Kalendermonat, Kalenderjahr oder eine Datengrundlage aus ganzen Monaten. */
export const zeitraum = (art: string, schluessel: string, zone: string): Zeitraum => {
  if (!ZEITRAUM_ARTEN.includes(art)) throw new Error(`Zeitraum-Art ${art} hat keinen Bericht`);
  let erster: string;
  let letzter: string;
  if (art === DATENGRUNDLAGE) {
    const teile = schluessel.split('/');
    if (teile.length < 1 || teile.length > 2 || !/^\d{4}-(0[1-9]|1[0-2])$/.test(teile[0])
      || (teile[1] !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(teile[1]))) throw new Error(`Datengrundlage ${schluessel}`);
    [erster] = spanneVon(teile[0], MONAT);
    [, letzter] = spanneVon(teile[1] ?? teile[0], MONAT);
    if (letzter < erster) throw new Error(`Datengrundlage ${schluessel}`);
  } else {
    [erster, letzter] = spanneVon(schluessel, art);
  }
  const jahr = Number(erster.slice(0, 4));
  const monat = Number(erster.slice(5, 7));
  const vergleiche = art === MONAT
    ? [
      vergleichszeitraum(VORMONAT, monat === 1 ? `${jahr - 1}-12-01` : `${jahr}-${zwei(monat - 1)}-01`, MONAT, zone),
      vergleichszeitraum(VORJAHRESMONAT, `${jahr - 1}-${zwei(monat)}-01`, MONAT, zone),
    ]
    : art === JAHR ? [vergleichszeitraum(VORJAHR, `${jahr - 1}-01-01`, JAHR, zone)] : [];
  const bis = mitternacht(tagPlus(letzter, 1), zone);
  return {
    art, schluessel, erster_tag: erster, letzter_tag: letzter, von: iso(mitternacht(erster, zone), zone), bis: iso(bis, zone),
    freigabe_ab: iso(bis + FREIGABE_FRIST_TAGE * TAG_MS, zone),
    bezeichnung: art === DATENGRUNDLAGE
      ? `${periodeText(MONAT, erster.slice(0, 7))}${erster.slice(0, 7) === letzter.slice(0, 7) ? '' : ` bis ${periodeText(MONAT, letzter.slice(0, 7))}`}`
      : periodeText(art, schluessel), vergleiche,
  };
};

/** Q5 — warum ein Vergleichszeitraum keine Zahl hat; `null` = es gibt eine Zahl. */
export const vergleichGrund = (e: { erster_tag: string; letzter_tag: string; besteht_seit: string | null; beendet_am: string | null; hat_werte: boolean }): string | null => {
  if (e.besteht_seit !== null && e.letzter_tag < e.besteht_seit) return VOR_BESTEHEN;
  if (e.beendet_am !== null && e.erster_tag > e.beendet_am) return QUELLE_BEENDET;
  return e.hat_werte ? null : KEINE_WERTE;
};

/** Ein Betrag als Dezimaltext ohne nachgestellte Nullen — die Schreibweise der Vektoren. */
export const betragText = (d: Dez | null): string | null => {
  if (d === null) return null;
  if (d.z === 0n) return '0';
  let { z, e } = d;
  while (e > 0 && z % 10n === 0n) {
    z /= 10n;
    e -= 1;
  }
  return dezText({ z, e });
};

const minus = (a: Dez, b: Dez): Dez => {
  const e = Math.max(a.e, b.e);
  return { z: a.z * 10n ** BigInt(e - a.e) - b.z * 10n ** BigInt(e - b.e), e };
};

export type Vergleich = { differenz: string | null; prozent: string | null; anzeige_differenz: string; anzeige_prozent: string; zustand: string | null; grund: string | null };

/** Q5, DA1 — ein Wert gegen seinen Vergleichszeitraum: Differenz, Prozent, beide angezeigt; ohne Vergleich der Grund. */
export const vergleich = (e: { aktuell: string | null; vergleich: string | null; einheit: string; ebene: string | null; grund: string | null }): Vergleich => {
  if (e.vergleich === null) return { differenz: null, prozent: null, anzeige_differenz: OHNE_ZAHL, anzeige_prozent: OHNE_ZAHL, zustand: ZUSTAND_KEINE_WERTE, grund: e.grund };
  if (e.aktuell === null) return { differenz: null, prozent: null, anzeige_differenz: OHNE_ZAHL, anzeige_prozent: OHNE_ZAHL, zustand: null, grund: null };
  const v = dez(e.vergleich);
  const d = minus(dez(e.aktuell), v);
  const p: Dez | null = v.z === 0n ? null
    : { z: halbAuf(d.z * 100n * 10n ** BigInt(PROZENT_RECHEN_NACHKOMMASTELLEN + v.e), v.z * 10n ** BigInt(d.e)), e: PROZENT_RECHEN_NACHKOMMASTELLEN };
  const plus = (x: Dez): string => (x.z > 0n ? '+' : '');
  return {
    differenz: betragText(d),
    prozent: betragText(p),
    anzeige_differenz: plus(d) + zahl(dezText(d), e.einheit, e.ebene),
    anzeige_prozent: p === null ? OHNE_ZAHL : plus(dezRunde(p, PROZENT_NACHKOMMASTELLEN)) + zahlMitStellen(dezText(p), PROZENT_NACHKOMMASTELLEN, PROZENT),
    zustand: null,
    grund: null,
  };
};

// ============================================================== Freigabe (F1)

export type FreigabeWert = { quelle: string; name: string | null; fassung: string | null; endgueltig_ab: string | null };
export type FreigabeAntrag = {
  zeitraum_art: string; schluessel: string; zone: string; jetzt: string; werte: FreigabeWert[];
  datenstand_uebermittelt: string; datenstand_entwurf: string; letzte_nr: number; anlass: string | null; abweichungen: number;
};
export type Freigabe = {
  erlaubt: boolean; status: number | null; code: string | null; nr: number | null; moeglich_ab: string | null;
  vorlaeufig: number | null; vorlaeufige: string[] | null; datenstand_uebermittelt: string | null; datenstand_aktuell: string | null;
  datenstand: string | null; freigegeben_am: string | null; kundensatz: string | null;
};

/**
 * F1 — die Voraussetzungen einer Freigabe in ihrer Reihenfolge: Zeitraum zu Ende, jeder Wert
 * endgültig, der gesehene Entwurf ist der gespeicherte. Das Recht prüft die Route davor (G2).
 */
export const freigabe = (a: FreigabeAntrag): Freigabe => {
  const leer: Freigabe = {
    erlaubt: false, status: null, code: null, nr: null, moeglich_ab: null, vorlaeufig: null, vorlaeufige: null,
    datenstand_uebermittelt: null, datenstand_aktuell: null, datenstand: null, freigegeben_am: null, kundensatz: null,
  };
  const z = zeitraum(a.zeitraum_art, a.schluessel, a.zone);
  const jetzt = ms(a.jetzt);
  if (jetzt < ms(z.bis)) {
    const satz = fuelle(SAETZE.zeitraum_nicht_zu_ende, {
      zeitraum: fuelle(SAETZE[`zeitraum_${a.zeitraum_art}`], { name: z.bezeichnung }),
      datum: datum(ms(z.freigabe_ab), a.zone), tage: FREIGABE_FRIST_TAGE, ende: SAETZE[`ende_${a.zeitraum_art}`],
    });
    return { ...leer, status: FEHLER_STATUS.zeitraum_nicht_zu_ende, code: 'zeitraum_nicht_zu_ende', moeglich_ab: z.freigabe_ab, kundensatz: satz };
  }
  const vorlaeufig = a.werte.filter((w) => w.fassung === VORLAEUFIG);
  if (vorlaeufig.length > 0) {
    const zeiten = vorlaeufig.map((w) => w.endgueltig_ab).filter((t): t is string => t !== null).map(ms);
    const ab = zeiten.length === 0 ? null : Math.max(...zeiten);
    const quellen = [...new Set(vorlaeufig.map((w) => w.quelle))];
    const namen = [...new Set(vorlaeufig.map((w) => (w.name === null ? w.quelle : `${w.quelle} ${w.name}`)))];
    const genannt = namen.slice(0, QUELLEN_IM_SATZ).concat(namen.length > QUELLEN_IM_SATZ ? [SAETZE.quellen_weitere] : []);
    const werte = vorlaeufig.length === 1 ? SAETZE.werte_einer : fuelle(SAETZE.werte_mehrere, { anzahl: vorlaeufig.length });
    const satz = fuelle(SAETZE.werte_vorlaeufig, { werte, datum: ab === null ? OHNE_ZAHL : datum(ab, a.zone), quellen: genannt.join(', ') });
    return {
      ...leer, status: FEHLER_STATUS.werte_vorlaeufig, code: 'werte_vorlaeufig', moeglich_ab: ab === null ? null : iso(ab, a.zone),
      vorlaeufig: vorlaeufig.length, vorlaeufige: quellen, kundensatz: satz,
    };
  }
  const uebermittelt = ms(a.datenstand_uebermittelt);
  const entwurf = ms(a.datenstand_entwurf);
  if (uebermittelt !== entwurf) {
    const pruefen = a.abweichungen === 0 ? '' : a.abweichungen === 1 ? SAETZE.entwurf_veraltet_pruefen_eine
      : fuelle(SAETZE.entwurf_veraltet_pruefen, { anzahl: a.abweichungen });
    const satz = fuelle(SAETZE.entwurf_veraltet, {
      zeitpunkt: zeitpunkt(uebermittelt, a.zone),
      anlass: a.anlass === null ? '' : fuelle(SAETZE.entwurf_veraltet_anlass, { anlass: anlass(a.anlass) }),
      pruefen,
    });
    return {
      ...leer, status: FEHLER_STATUS.entwurf_veraltet, code: 'entwurf_veraltet',
      datenstand_uebermittelt: iso(uebermittelt, a.zone), datenstand_aktuell: iso(entwurf, a.zone), kundensatz: satz,
    };
  }
  return { ...leer, erlaubt: true, status: 201, nr: a.letzte_nr + 1, datenstand: iso(entwurf, a.zone), freigegeben_am: iso(jetzt, a.zone) };
};

// ============================================================== Datenstand (D2–D4)

export type Aenderung = { quelle: string | null; art: string; zeitpunkt: string };

/** D2 — jede Berechnungszeit ≤ Datenstand; bei der Freigabe jedes „endgültig ab“ ≤ Datenstand. Leer = gilt. */
export const d2 = (datenstand: string, berechnetAm: string[], endgueltigAb: string[], beiFreigabe: boolean): Array<{ art: string; zeitpunkt: string }> => {
  const ds = ms(datenstand);
  return [
    ...berechnetAm.filter((t) => ms(t) > ds).map((t) => ({ art: 'berechnet_am', zeitpunkt: t })),
    ...(beiFreigabe ? endgueltigAb.filter((t) => ms(t) > ds).map((t) => ({ art: 'endgueltig_ab', zeitpunkt: t })) : []),
  ];
};

/** D3 — Freigabe ≥ Datenstand und keine Änderung einer Quelle in (Datenstand, Freigabe]. Leer = gilt. */
export const d3 = (datenstand: string, freigabeAm: string, aenderungen: Aenderung[]): Aenderung[] => {
  const ds = ms(datenstand);
  const fr = ms(freigabeAm);
  return [
    ...(fr < ds ? [{ quelle: null, art: 'freigabe_vor_datenstand', zeitpunkt: freigabeAm }] : []),
    ...aenderungen.filter((x) => ms(x.zeitpunkt) > ds && ms(x.zeitpunkt) <= fr),
  ];
};

/** D4 — die Änderungen, die neuer sind als der Datenstand; leer = der Entwurf ist aktuell. */
export const d4 = (datenstand: string, aenderungen: Aenderung[]): Aenderung[] =>
  aenderungen.filter((x) => ms(x.zeitpunkt) > ms(datenstand));

// ============================================================== Betroffenheit (B1, B4, B6)

export type Quelle = { bericht: string; nr: number | null; ersetzt: boolean; objekt: string; bezug: string; erster_tag: string; letzter_tag: string };
export type Reihe = { entity: string; kanal: string };
/** Die Form von `KorrekturKaskade.Bezugsgroesse` (Java, AP-11 IP-9). */
export type BetroffeneBezugsgroesse = {
  id: string; kennzeichen: string; periode_von: string; periode_bis: string; fassung: number; status: string;
};
/** Die Form von `KorrekturKaskade.Betroffen` (Java); `bezugsgroessen` seit AP-11 IP-9 (fehlt = keine). */
export type Betroffen = {
  tenant: string; anlass: string; fassung: number; status: string; reihen: Reihe[]; von: string; bis: string; zone: string;
  erster_tag: string; letzter_tag: string; messstellen: string[]; ereignisse: string[]; versionen: number;
  bezugsgroessen?: BetroffeneBezugsgroesse[];
};
export type Bericht = { kennung: string; stand: 'FREIGEGEBEN' | 'ENTWURF' };

const schnitt = (quellen: Quelle[], objekte: Set<string>, von: string, bis: string | null): Bericht[] => {
  const treffer = new Map<string, Set<Bericht['stand']>>();
  for (const q of quellen) {
    const imZeitraum = q.letzter_tag >= von && (bis === null || q.erster_tag <= bis);
    if (!objekte.has(q.objekt) || !imZeitraum || (q.nr !== null && q.ersetzt)) continue;
    const s = treffer.get(q.bericht) ?? new Set<Bericht['stand']>();
    s.add(q.nr === null ? 'ENTWURF' : 'FREIGEGEBEN');
    treffer.set(q.bericht, s);
  }
  return [...treffer.keys()].sort().flatMap((kennung) =>
    (['FREIGEGEBEN', 'ENTWURF'] as const).filter((s) => treffer.get(kennung)?.has(s)).map((stand) => ({ kennung, stand })));
};

const K_BERECHNUNG_GEAENDERT = 'berechnung_geaendert';

/**
 * B1, Pfad 1 — die Berichte, die eine Verarbeitung der Kaskade trifft (Reihen über die Quellenbindung, dazu die berechneten
 * Messstellen; seit AP-11 IP-9 die Bezugsgrößen und bei geänderter Berechnung die Kennzahl selbst).
 */
export const betroffene = (quellen: Quelle[], b: Betroffen, bindung: (r: Reihe) => string[]): Bericht[] =>
  schnitt(quellen, new Set([
    ...b.reihen.flatMap(bindung),
    ...b.messstellen,
    ...(b.bezugsgroessen ?? []).map((g) => g.kennzeichen),
    ...(b.status === K_BERECHNUNG_GEAENDERT ? [b.anlass] : []),
  ]), b.erster_tag, b.letzter_tag);

/** B1, Pfad 2 — die Berichte, deren Quellen eine Strukturänderung ab `giltAb` trifft. */
export const betroffeneStruktur = (quellen: Quelle[], objekte: string[], giltAb: string): Bericht[] =>
  schnitt(quellen, new Set(objekte), giltAb, null);

const K_FREIGEGEBEN = 'freigegeben';
const K_ZURUECKGENOMMEN = 'zurueckgenommen';
const K_WIRKSAM = 'wirksam';

/**
 * B4, Pfad 1 — die Anstoß-Art einer Verarbeitung der Kaskade (Korrektur K-…, Ersatzwert EW-…; seit AP-11 IP-9 die
 * rückwirkend geänderte Berechnung und jede geänderte Bezugsgröße).
 */
export const anstossArt = (b: Betroffen): string => {
  if (b.status === K_BERECHNUNG_GEAENDERT) return KENNZAHL_FASSUNG_RUECKWIRKEND;
  if ((b.bezugsgroessen ?? []).length > 0) return BEZUGSGROESSE_FASSUNG;
  const korrektur = b.anlass.startsWith('K-');
  const ersatzwert = b.anlass.startsWith('EW-');
  if (korrektur && b.status === K_FREIGEGEBEN) return KORREKTUR_FREIGEGEBEN;
  if (korrektur && b.status === K_ZURUECKGENOMMEN) return KORREKTUR_ZURUECKGENOMMEN;
  if (ersatzwert && b.status === K_WIRKSAM) return ERSATZWERT_WIRKSAM;
  if (ersatzwert && b.status === K_ZURUECKGENOMMEN) return ERSATZWERT_ZURUECKGENOMMEN;
  throw new Error(`Anlass ${b.anlass} mit Status ${b.status} hat keine Anstoß-Art`);
};

export type Struktur = { anstoss_art: string | null; grund: string | null };

/** B3/B4/B6, Pfad 2 — was eine Zeile eines Änderungsprotokolls für Berichte ist. */
export const struktur = (protokoll: string, objektArt: string, art: string, rueckwirkend: boolean, korrektur: boolean): Struktur => {
  if (!STRUKTUR_PROTOKOLLE.includes(protokoll)) throw new Error(`Protokoll ${protokoll} ist kein Strukturänderungs-Protokoll`);
  if (protokoll === ENERGIEEINSATZ_AENDERUNG) {
    return ['einstufung_gesetzt', 'einstufung_bestaetigt'].includes(art)
      ? { anstoss_art: EINSTUFUNG_FASSUNG, grund: null } : { anstoss_art: null, grund: KEINE_STRUKTURAENDERUNG };
  }
  if (protokoll === BEWERTUNG_AENDERUNG) {
    if (art === 'umfang_geaendert') return { anstoss_art: UMFANG_FASSUNG, grund: null };
    if (['kriterien_geaendert', 'kriterien_freigegeben'].includes(art)) {
      return { anstoss_art: KRITERIEN_FASSUNG, grund: null };
    }
    return { anstoss_art: null, grund: KEINE_STRUKTURAENDERUNG };
  }
  if (protokoll === MESSBEDARF_AENDERUNG) {
    return ['erfasst', 'bearbeitet', 'eingeloest', 'verworfen'].includes(art)
      ? { anstoss_art: MESSBEDARF_ZUSTAND, grund: null } : { anstoss_art: null, grund: KEINE_STRUKTURAENDERUNG };
  }
  if (protokoll === GERAET_AENDERUNG) {
    return art === 'messmittel_angabe' ? { anstoss_art: MESSMITTEL_ANGABE, grund: null }
      : { anstoss_art: null, grund: KEINE_STRUKTURAENDERUNG };
  }
  if (protokoll === MESSSTELLE_AENDERUNG && art === 'prozesse_zugeordnet') {
    return rueckwirkend ? { anstoss_art: PROZESS_ZUORDNUNG_RUECKWIRKEND, grund: null }
      : { anstoss_art: null, grund: NICHT_RUECKWIRKEND };
  }
  if (art === 'bearbeitet') return { anstoss_art: null, grund: UMBENENNUNG };
  let anstoss: string;
  let wirkt = rueckwirkend;
  if (protokoll === ORT_AENDERUNG && (art === 'verschoben' || art === 'korrigiert')) {
    anstoss = objektArt === 'anlage' ? ANLAGE_UMZUG_RUECKWIRKEND : ZUORDNUNG_RUECKWIRKEND;
  } else if (protokoll === ORT_AENDERUNG && art === 'flaeche_geaendert') {
    anstoss = FLAECHE_RUECKWIRKEND;
  } else if (protokoll === MESSSTELLE_AENDERUNG && (art === 'ort_zugeordnet' || art === 'ort_korrigiert')) {
    anstoss = ZUORDNUNG_RUECKWIRKEND;
  } else if (protokoll === MESSSTELLE_AENDERUNG && art === 'verteilung_geaendert') {
    anstoss = VERTEILUNG_RUECKWIRKEND;
    wirkt = korrektur;
  } else {
    return { anstoss_art: null, grund: KEINE_STRUKTURAENDERUNG };
  }
  return wirkt ? { anstoss_art: anstoss, grund: null } : { anstoss_art: null, grund: NICHT_RUECKWIRKEND };
};

// ============================================================== Abweichung (R1)

export type Abweichung = { quelle: string; menge_art: string | null; vorher: string | null; nachher: string | null; version: string; anlass: string | null };

const zahlText = (x: unknown): string => {
  const s = String(x);
  return s.includes('e') || s.includes('E') ? ohneExponent(s) : s;
};

/** R1 — der Vergleich zweier Abzüge: je Menge (Quelle + Mengen-Art) und je Kennzahl jede andere Zahl oder Version. */
export const abweichungen = (alt: Json, neu: Json): Abweichung[] => {
  const alteK = new Set(((alt.qualitaet?.korrekturen ?? []) as Json[]).map((k) => k.kennung));
  const neueK = ((neu.qualitaet?.korrekturen ?? []) as Json[]).filter((k) => !alteK.has(k.kennung));
  const anlassText = neueK.length === 0 ? null : neueK.map((k) => k.kennung).join(', ');
  const reihen = new Set(neueK.map((k) => k.reihe));
  const raus: Abweichung[] = [];
  const vergleiche = (a: Json[], n: Json[], feld: 'menge' | 'wert'): void => {
    const schluessel = (w: Json): string => JSON.stringify([w.quelle, w.menge_art ?? null]);
    const alte = new Map(a.map((w) => [schluessel(w), w]));
    const neue = new Map(n.map((w) => [schluessel(w), w]));
    const zeile = (x: Json | undefined, y: Json | undefined): void => {
      const vorher = x === undefined || x[feld] === null ? null : dez(zahlText(x[feld]));
      const nachher = y === undefined || y[feld] === null ? null : dez(zahlText(y[feld]));
      const gleich = vorher === null || nachher === null ? vorher === nachher
        : minus(vorher, nachher).z === 0n;
      if (x !== undefined && y !== undefined && gleich && x.version === y.version) return;
      const w = y ?? x;
      const grund = anlassText === null ? null
        : feld === 'wert' ? fuelle(SAETZE.ueber_kennzahl, { anlass: anlassText })
          : reihen.has(w.quelle) ? anlassText
            : 'formel' in w ? fuelle(SAETZE.ueber_formel, { anlass: anlassText }) : anlassText;
      raus.push({
        quelle: w.quelle, menge_art: w.menge_art ?? null, vorher: betragText(vorher), nachher: betragText(nachher),
        version: `${x === undefined ? OHNE_ZAHL : x.version} → ${y === undefined ? OHNE_ZAHL : y.version}`, anlass: grund,
      });
    };
    for (const [k, y] of neue) zeile(alte.get(k), y);
    for (const [k, x] of alte) if (!neue.has(k)) zeile(x, undefined);
  };
  vergleiche(alt.werte ?? [], neu.werte ?? [], 'menge');
  vergleiche(alt.kennzahlen ?? [], neu.kennzahlen ?? [], 'wert');
  return raus;
};

// ============================================================== Rechte (G1, G3)

/** G1 — die Kennung der Rechte-Matrix für eine Handlung an einem Bericht dieser Geltung. */
export const kennung = (handlung: string, geltungArt: string): string => {
  const k = KENNUNG[`${geltungArt}/${handlung}`];
  if (k === undefined) throw new Error(`Handlung ${handlung} an ${geltungArt} hat keine Kennung`);
  return k;
};

/** G3 (R-A4) — die Teilansicht einer Person; `null` = keine. Beide Urteile spricht `darf`. */
export const teilansicht = (m: Matrix, b: Benutzer, k: Kundenbereich, jetzt: string): string[] | null => {
  if (darf(m, b, k, kennung('csv', UNTERNEHMEN), { standort: null, anlage: null, stichtag: null }, jetzt).darf) return null;
  return k.standorte
    .filter((s) => darf(m, b, k, TEILANSICHT_RECHT, { standort: s.kennzeichen, anlage: null, stichtag: null }, jetzt).darf)
    .map((s) => s.name);
};

// ============================================================== Abzug: kanonische Form (A1)

const ohneExponent = (s: string): string => {
  const m = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s);
  if (!m) return s;
  const ziffern = `${m[2]}${m[3] ?? ''}`;
  const punkt = m[2].length + Number(m[4]);
  const text = punkt <= 0 ? `0.${'0'.repeat(-punkt)}${ziffern}`
    : punkt >= ziffern.length ? `${ziffern}${'0'.repeat(punkt - ziffern.length)}`
      : `${ziffern.slice(0, punkt)}.${ziffern.slice(punkt)}`;
  const sauber = text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
  return `${m[1]}${sauber.replace(/^0+(?=\d)/, '')}`;
};

/**
 * A1 — der kanonische Text eines Abzugs: Schlüssel nach UTF-16-Codeeinheiten sortiert, kein
 * Leerraum, Zeichenketten wie `JSON.stringify`, Zahlen ohne Exponent und ohne nachgestellte
 * Nullen. Byte-gleich zu `BerichtRegeln.kanonisch`.
 */
export const kanonisch = (x: unknown): string => {
  if (x === null || x === undefined) return 'null';
  if (Array.isArray(x)) return `[${x.map(kanonisch).join(',')}]`;
  if (typeof x === 'object') {
    const o = x as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${kanonisch(o[k])}`).join(',')}}`;
  }
  if (typeof x === 'number') return x === 0 ? '0' : zahlText(x);
  return JSON.stringify(x);
};

// ============================================================== Berichts-CSV (DA3)

export type CsvKopf = {
  bericht: string; vorlage: string; vorlage_fassung: number; geltung: { art: string; kennzeichen: string; name: string };
  zeitraum: { art: string; schluessel: string }; zone: string; stand: number; datenstand: string; freigegeben_am: string;
  freigegeben_von: string; pruefsumme: string; erzeugt_am: string; erzeugt_von: string; teilansicht: string[];
};

/** DA3 — der Kopfblock: eine Zeile `# schlüssel=wert` je `CSV_KOPF`, Zeiten in der Zone mit Offset. */
export const csvKopf = (k: CsvKopf): string[] => {
  const z = zeitraum(k.zeitraum.art, k.zeitraum.schluessel, k.zone);
  const werte = [
    k.bericht, `${k.vorlage} ${k.vorlage_fassung}`,
    fuelle(SAETZE[`csv_geltung_${k.geltung.art}`], { kennzeichen: k.geltung.kennzeichen, name: k.geltung.name }),
    fuelle(SAETZE.csv_zeitraum, { schluessel: k.zeitraum.schluessel, erster: datumText(z.erster_tag), letzter: datumText(z.letzter_tag) }),
    String(k.stand), iso(ms(k.datenstand), k.zone), iso(ms(k.freigegeben_am), k.zone), k.freigegeben_von, k.zone, CSV_DEZIMAL, CSV_TRENNER,
    'ungerundet', k.pruefsumme, iso(ms(k.erzeugt_am), k.zone), k.erzeugt_von, k.teilansicht.join(', '),
  ];
  return CSV_KOPF.map((s, i) => `# ${s}=${werte[i]}`);
};

export type CsvZeile = {
  quelle: string; name: string | null; ort: string | null; periode: string | null; menge: string | null; einheit: string | null;
  zustand: string | null; abdeckung_prozent: string | null; kennzeichen: string[]; fassung: string | null;
  endgueltig_ab: string | null; version: number | null; berechnet_am: string | null;
};

const csvZelle = (s: string | null): string => {
  if (s === null) return '';
  return /[;"\n\r]/.test(s) ? `"${s.split('"').join('""')}"` : s;
};

/** DA3 — eine Zeile je Wert mit den 13 Spalten: Zahlen ungerundet mit Dezimalkomma, Zeiten mit Offset, Kennzeichen mit „ · “. */
export const csvZeile = (z: CsvZeile, zone: string): string => {
  const zahlCsv = (s: string | null): string | null => (s === null ? null : s.replace('.', CSV_DEZIMAL));
  const zeit = (s: string | null): string | null => (s === null ? null : iso(ms(s), zone));
  return [
    z.quelle, z.name, z.ort, z.periode, zahlCsv(z.menge), z.einheit, z.zustand, zahlCsv(z.abdeckung_prozent),
    z.kennzeichen.join(KENNZEICHEN_TRENNER), z.fassung, zeit(z.endgueltig_ab), z.version === null ? null : String(z.version), zeit(z.berechnet_am),
  ].map(csvZelle).join(CSV_TRENNER);
};

// ============================================================== Kopf, Kennzeichen, Anlass (D5, R5, A5, G3)

/** D5 — „Datenstand 10.11.2026 08:55 (MEZ) · Berichtsstand Nr. 1 · freigegeben 10.11.2026 09:02 von …“; ohne Stand der Entwurf. */
export const kopf = (datenstand: string, zone: string, stand: { nr: number; freigegeben_am: string; freigegeben_von: string } | null): string => {
  const t = ms(datenstand);
  const ds = uhr(t, zone).includes(' ') ? zeitpunkt(t, zone) : fuelle(SAETZE.zeit_mit_zone, { zeitpunkt: zeitpunkt(t, zone), zone: zoneKurz(t, zone) });
  if (stand === null) return fuelle(SAETZE.kopf_entwurf, { datenstand: ds });
  return fuelle(SAETZE.kopf_stand, { datenstand: ds, nr: stand.nr, freigegeben: zeitpunkt(ms(stand.freigegeben_am), zone), person: stand.freigegeben_von });
};

export const berichtsstand = (nr: number): string => fuelle(muster('berichtsstand'), { nr });
export const ersetztDurch = (nr: number, am: string, zone: string): string => fuelle(muster('ersetzt_durch'), { nr, datum: datum(ms(am), zone) });
export const revisionNoetig = (anlassText: string): string => fuelle(muster('revision_noetig'), { anlass: anlassText });
export const entwurf = (datenstand: string, zone: string): string =>
  fuelle(muster('entwurf'), { datum: datum(ms(datenstand), zone), uhr: uhr(ms(datenstand), zone) });
export const vorlaeufig = (endgueltigAb: string, zone: string): string => fuelle(muster('vorlaeufig'), { datum: datum(ms(endgueltigAb), zone) });
/** A5 — „heute: …“, nur wenn der Name sich seit dem Datenstand geändert hat. */
export const heute = (nameZumDatenstand: string, nameHeute: string): string | null =>
  nameHeute === nameZumDatenstand ? null : fuelle(muster('heute'), { name: nameHeute });
/** G3 — „Teilansicht: …“; ohne Standorte keine. */
export const teilansichtKennzeichen = (standorte: string[]): string | null =>
  standorte.length === 0 ? null : fuelle(muster('teilansicht'), { standorte: standorte.join(', ') });
export const vorBeginn = (seit: string): string => fuelle(muster('vor_beginn'), { datum: datumText(seit) });
export const anstossVerworfen = (begruendung: string): string => fuelle(muster('anstoss_verworfen'), { begruendung });

/** Pfad 2 (IP-9): `<Anstoß-Art>/<Kennzeichen>/<gilt ab>/<eingetragen>/<Protokoll>-<Zeile>` — Java `strukturKennung`. */
const STRUKTUR_KENNUNG =
  /^(zuordnung_rueckwirkend|anlage_umzug_rueckwirkend|flaeche_rueckwirkend|verteilung_rueckwirkend)\/([A-Za-z0-9][A-Za-z0-9._-]*)?\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})\/(ort_aenderung|messstelle_aenderung)-(\d+)$/;
const BEWERTUNG_KENNUNG =
  /^(einstufung_fassung|kriterien_fassung|umfang_fassung|messbedarf_zustand|prozess_zuordnung_rueckwirkend|messmittel_angabe)\/([A-Za-z0-9][A-Za-z0-9._-]*)?\/((?:energieeinsatz|bewertung|messbedarf|messstelle|geraet)_aenderung)-(\d+)$/;
/** A5 (AP-17 IP-23): `BB-…/Fassung-n`, `BB-…/Fassung-n/anstoss:<id>`, `BB-…/beendet` — Java `BezugsbasisAnstoss`. */
const BASIS_KENNUNG = /^(BB-\d{4,})\/(Fassung-(\d+)(\/anstoss:[0-9a-f-]+)?|beendet)$/;

/**
 * Der Anlass in Kundensprache: „Korrektur K-2026-0007“, „Ersatzwert EW-2026-0001“, die Kennung einer
 * Strukturänderung als „Verteilung MS-07 berichtigt, gilt ab 01.10.2026, eingetragen 20.11.2026“ (ohne
 * Kennzeichen entfällt es), sonst der Text selbst.
 */
export const anlass = (kennungText: string): string => {
  if (kennungText.startsWith('K-')) return fuelle(SAETZE.anlass_korrektur, { kennung: kennungText });
  if (kennungText.startsWith('EW-')) return fuelle(SAETZE.anlass_ersatzwert, { kennung: kennungText });
  const s = STRUKTUR_KENNUNG.exec(kennungText);
  if (s) {
    const satz = SAETZE[`anlass_${s[1]}`];
    const tage = { ab: datumText(s[3]), am: datumText(s[4]) };
    return s[2] === undefined ? fuelle(satz.replace(' {objekt}', ''), tage) : fuelle(satz, { objekt: s[2], ...tage });
  }
  const bb = BASIS_KENNUNG.exec(kennungText);
  if (bb) {
    if (bb[2] === 'beendet') return fuelle(SAETZE.anlass_bezugsbasis_beendet, { basis: bb[1] });
    return fuelle(SAETZE[bb[4] === undefined ? 'anlass_bezugsbasis_fassung' : 'anlass_bezugsbasis_anstoss'], { basis: bb[1], fassung: bb[3] });
  }
  const b = BEWERTUNG_KENNUNG.exec(kennungText);
  if (b) {
    const satz = SAETZE[`anlass_${b[1]}`];
    return b[2] === undefined ? satz.replace(' {objekt}', '') : fuelle(satz, { objekt: b[2] });
  }
  return kennungText;
};

// ============================================================== Sätze (§5.8) und Anzeige (DA1)

type Periode = { art: string; schluessel: string };

export const keineQuellen = (geltung: string, z: Periode, bestehtSeit: string | null): string => {
  const zeitraumText = fuelle(SAETZE[`im_${z.art}`], { name: periodeText(z.art, z.schluessel) });
  return bestehtSeit === null ? fuelle(SAETZE.keine_quellen, { geltung, zeitraum: zeitraumText })
    : fuelle(SAETZE.keine_quellen_seit, { geltung, zeitraum: zeitraumText, datum: datumText(bestehtSeit) });
};

export const berichtGibtEsSchon = (kennungText: string, geltung: string, z: Periode): string =>
  fuelle(SAETZE.bericht_gibt_es_schon, { kennung: kennungText, vorlage: SAETZE[`vorlage_${z.art}`], geltung, zeitraum: periodeText(z.art, z.schluessel) });

export const standGibtEsNicht = (nr: number, neueste: { nr: number; freigegeben_am: string } | null, zone: string): string =>
  neueste === null ? fuelle(SAETZE.stand_gibt_es_nicht_keiner, { nr })
    : fuelle(SAETZE.stand_gibt_es_nicht, { nr, neueste: neueste.nr, datum: datum(ms(neueste.freigegeben_am), zone) });

export const wertNichtMehrGespeichert = (z: Periode, stand: { nr: number; freigegeben_am: string } | null, zone: string): string => {
  const zeitraumText = fuelle(SAETZE[`vom_${z.art}`], { name: periodeText(z.art, z.schluessel) });
  return stand === null ? fuelle(SAETZE.wert_nicht_mehr_gespeichert_ohne_stand, { zeitraum: zeitraumText })
    : fuelle(SAETZE.wert_nicht_mehr_gespeichert, { zeitraum: zeitraumText, nr: stand.nr, datum: datum(ms(stand.freigegeben_am), zone) });
};

export const berichtsBelege = (staende: Array<{ kennung: string; nr: number }>): string => {
  const liste = staende.map((s) => fuelle(SAETZE.stand_bezeichnung, { kennung: s.kennung, nr: s.nr })).join(', ');
  return staende.length === 1 ? fuelle(SAETZE.berichts_belege_eins, { staende: liste })
    : fuelle(SAETZE.berichts_belege, { anzahl: staende.length, staende: liste });
};

export const abzugBeschaedigt = (nr: number): string => fuelle(SAETZE.abzug_beschaedigt, { nr });

/** DA1 — eine Zahl des Abzugs angezeigt: Menge je Ebene, Kennzahl wie AP-11, Prozent eines Vergleichs mit einer Nachkommastelle. */
export const anzeige = (art: string, wert: string | null, einheit: string, ebene: string | null): string => {
  if (art === 'menge') return zahl(wert, einheit, ebene);
  if (art === 'kennzahl') return kennzahlAnzeige(wert === null ? null : dez(wert), einheit, null);
  if (art === 'prozent') return zahlMitStellen(wert, PROZENT_NACHKOMMASTELLEN, PROZENT);
  throw new Error(`Anzeige-Art ${art}`);
};
