/** AP-19 NW-1: Energiemanagement — reine Regeln (docs/contracts/v2/energiemanagement.md). Keine Fläche ruft sie bisher auf.
 * Zwillinge: EnergiemanagementRegeln.java und voltpilot_optimization/energiemanagement.py; alle drei fahren
 * energiemanagement-vectors.json. Die kanonische Form einer Kopie ist `kanonisch` aus ./uemsBericht (A1: -5, nie -5.0);
 * SHA-256 reicht der Aufrufer herein (Browser: crypto.subtle, Test: node:crypto). Der Tag des Abrufs kommt von außen.
 * Die Kundensätze sind eigene Schablonen (§5.8); nur Grenz-, Verantwortungs- und Leer-Satz kommen aus dem Glossar.
 */
import { UEMS_NOCH_NICHTS_FESTGEHALTEN, UEMS_NORMGRENZE, UEMS_VERANTWORTUNG } from './glossar';
import { kanonisch, PRUEFSUMME_PRAEFIX } from './uemsBericht';

export const STARTWERTE = {
  ueberpruefung_monate: 12, ueberpruefung_monate_mindestens: 1, ueberpruefung_monate_hoechstens: 60, audit_rhythmus_monate: 12,
  managementbewertung_rhythmus_monate: 12, feststellung_frist_tage: 90, vorschau_tage: 30, wortlaut_zeichen_hoechstens: 20000,
  begruendung_zeichen_mindestens: 10, begruendung_zeichen_hoechstens: 500, eintrag_zeichen_hoechstens: 2000,
};
export const VOKABULARE: Record<string, string[]> = {
  dokument_art: ['energiepolitik', 'anwendungsbereich', 'kontext', 'rechtliche_anforderungen', 'risiken_chancen', 'bestellung', 'verfahren', 'betrieb', 'beschaffung', 'kommunikation', 'auslegung', 'kompetenz'],
  dokument_klasse: ['vorgabe', 'nachweis'],
  dokument_zustand: ['entwurf', 'gueltig', 'aufgehoben'],
  dokument_bezug: ['unternehmen', 'standort', 'energieeinsatz', 'person', 'aufgabe'],
  fassung_form: ['wortlaut', 'verweis'],
  fassung_status: ['entwurf', 'beantragt', 'freigegeben', 'abgelehnt', 'abgeloest'],
  dokument_eintrag: ['bekannt_gemacht', 'geprueft_bleibt', 'aufgehoben', 'kommentar'],
  bekanntmachung_weg: ['aushang', 'intranet', 'unterweisung', 'besprechung', 'e_mail', 'weiterer'],
  aufgabe: ['unternehmensleitung', 'energiemanagement_leiten', 'energieteam', 'bezugsbasen', 'energieziele_massnahmen', 'bewertung_messplanung', 'interne_audits', 'managementbewertung', 'dokumente', 'weitere'],
  person_zustand: ['aktiv', 'beendet'],
  aufgabe_zustand: ['laufend', 'beendet'],
  audit_zustand: ['geplant', 'durchgefuehrt', 'abgeschlossen', 'abgesagt'],
  audit_eintrag: ['hinweis', 'kommentar'],
  feststellung_quelle: ['internes_audit', 'eigene', 'extern', 'managementbewertung'],
  feststellung_zustand: ['offen', 'abgeschlossen'],
  feststellung_eintrag: ['kommentar', 'behebung', 'ursache_aussage', 'aehnliche_faelle'],
  wirksamkeit_ergebnis: ['wirksam', 'nicht_wirksam', 'ohne_massnahme', 'zurueckgenommen'],
  managementbewertung_zustand: ['entwurf', 'freigegeben'],
  beschluss_art: ['energieziel', 'massnahme', 'dokument', 'aufgabe', 'ressourcen', 'audit', 'keine_aenderung', 'weitere'],
  folge_art: ['energieziel', 'massnahme', 'dokument', 'aufgabe', 'audit'],
  wiedervorlage_art: ['dokument_ueberpruefung', 'internes_audit', 'managementbewertung', 'feststellung', 'bewertung_ueberpruefung', 'bezugsbasis_ueberpruefung', 'energieziel_bewertung', 'massnahme_termin', 'abweichung_frist', 'messbedarf_frist', 'bericht_anstoss'],
  verzeichnis_ort: ['in_voltpilot', 'wortlaut_original_beim_kunden', 'verweis'],
  verzeichnis_gruppe: ['grundlagen', 'verantwortung', 'risiken_chancen', 'kompetenz_kommunikation', 'betrieb_auslegung_beschaffung', 'bewertung_messplanung', 'kennzahlen_bezugsbasen', 'ziele_massnahmen_abweichungen', 'audits_feststellungen', 'managementbewertung', 'berichte'],
  ueberpruefung_art: ['dokument', 'internes_audit', 'managementbewertung', 'feststellung'],
  ueberpruefung_grund: ['nachweis', 'keine_fassung', 'kein_audit', 'keine_managementbewertung', 'abgeschlossen'],
};
export const DOKUMENT_ART_KLASSE: Record<string, string> = Object.fromEntries(
  VOKABULARE.dokument_art.map((art) => [art, art === 'auslegung' || art === 'kompetenz' ? 'nachweis' : 'vorgabe']),
);
export const LEITUNGS_PFLICHT = ['energiepolitik', 'anwendungsbereich', 'bestellung'];
export const WOERTER: Record<string, Record<string, string>> = {
  dokument_art: {
    energiepolitik: 'Energiepolitik', anwendungsbereich: 'Anwendungsbereich', kontext: 'Kontext und interessierte Parteien',
    rechtliche_anforderungen: 'Rechtliche Anforderungen', risiken_chancen: 'Risiken und Chancen', bestellung: 'Bestellung und Aufgaben (Beleg)',
    verfahren: 'Vorgehen', betrieb: 'Betrieb und Instandhaltung', beschaffung: 'Beschaffung', kommunikation: 'Kommunikation',
    auslegung: 'Auslegung (Nachweis)', kompetenz: 'Kompetenz (Nachweis)',
  },
  aufgabe: {
    unternehmensleitung: 'Leitung des Unternehmens', energiemanagement_leiten: 'Energiemanagement leiten und an die Leitung berichten',
    energieteam: 'Mitglied im Energieteam', bezugsbasen: 'Bezugsbasen pflegen und freigeben', energieziele_massnahmen: 'Energieziele und Maßnahmen führen',
    bewertung_messplanung: 'Energetische Bewertung und Messplanung', interne_audits: 'Interne Audits planen und durchführen',
    managementbewertung: 'Managementbewertung vorbereiten', dokumente: 'Dokumente des Energiemanagements pflegen', weitere: 'weitere Aufgabe (mit Wortlaut)',
  },
  verzeichnis_gruppe: {
    grundlagen: 'Anwendungsbereich, Kontext und Energiepolitik', verantwortung: 'Aufgaben und Verantwortliche', risiken_chancen: 'Risiken und Chancen',
    kompetenz_kommunikation: 'Kompetenz und Kommunikation', betrieb_auslegung_beschaffung: 'Betrieb, Auslegung und Beschaffung',
    bewertung_messplanung: 'Energetische Bewertung und Messplanung', kennzahlen_bezugsbasen: 'Kennzahlen, Bezugsbasen und Leistungsvergleiche',
    ziele_massnahmen_abweichungen: 'Energieziele, Maßnahmen und Abweichungen', audits_feststellungen: 'Interne Audits und Feststellungen',
    managementbewertung: 'Managementbewertung', berichte: 'Berichte',
  },
  verzeichnis_ort: { in_voltpilot: 'in VoltPilot', wortlaut_original_beim_kunden: 'Wortlaut in VoltPilot, Original bei Ihnen', verweis: 'Geführt in Ihrem System' },
};
/** Die Kundensätze (Report §5.8) als Schablonen; {name} füllt die Operation `satz`. */
export const SAETZE: Record<string, string> = {
  verantwortung: UEMS_VERANTWORTUNG, // Grenz-, Verantwortungs- und Leer-Satz haben eine Quelle (SP4); der Vektor prüft den Wortlaut
  grenz_satz: UEMS_NORMGRENZE,
  dokument_kopf: '{art} {kennzeichen} · Fassung {fassung} · freigegeben am {am} · entschieden von {entschieden_von} · eingetragen von {eingetragen_von}.',
  ort_wortlaut: 'Wortlaut in VoltPilot, Original bei Ihnen: {ablage}.',
  ort_verweis: 'Geführt in Ihrem System: {ablage} ({angaben}).',
  verweis_pruefsumme: 'Die Prüfsumme wird in Ihrem Browser gebildet; die Datei verlässt Ihren Rechner nicht.',
  verweis_keine_datei: 'VoltPilot speichert keine Dateien. Halten Sie fest, wo das Original liegt; die Prüfsumme zeigt später, ob es noch dasselbe ist.',
  ueberpruefung: 'Überprüfung fällig seit {tage} Tagen.',
  geprueft_bleibt: 'Geprüft, bleibt — entschieden von {person} am {am}: ‚{begruendung}‘',
  bekanntmachung: 'Bekannt gemacht am {am} an {kreis} über {weg} — eingetragen von {person}.',
  anwendungsbereich_deckungsgleich: 'Der Betrachtungsumfang der energetischen Bewertung (Fassung {fassung}, ab {ab}) umfasst dieselben Standorte und Energieträger.',
  anwendungsbereich_unterschied: '{was} gehört zum Anwendungsbereich, aber nicht zum Betrachtungsumfang der energetischen Bewertung (Fassung {fassung}).',
  freigabe_ohne_leitung: 'Diese Fassung braucht eine Entscheidung der Leitung. Für die Aufgabe ‚Leitung des Unternehmens‘ ist keine Person festgelegt.',
  aufgabe_ohne_person: '{aufgabe} — keine Person festgelegt.',
  person_ohne_konto: '{name} · {funktion} · ohne Konto — erscheint als ‚entschieden von‘.',
  einsicht_rolle: 'Einsicht — Sie sehen das Energiemanagement des ganzen Unternehmens und können nichts ändern.',
  einsicht_schreibversuch: 'Mit ‚Einsicht‘ können Sie hier nichts ändern. Festhalten kann, wer das Energiemanagement bearbeitet.',
  audit_kopf: 'Internes Audit {kennzeichen} · durchgeführt am {am} von {auditor} ({unabhaengigkeit}).',
  hinweis: 'Hinweis — festgestellt von {festgestellt_von}, eingetragen von {eingetragen_von} am {am}.',
  feststellung_kopf: 'Feststellung {kennzeichen} · {quelle} · festgestellt von {person} am {am} · Verantwortlich {verantwortlich} · Frist {frist} · {zustand}.',
  behebung: 'Sofortige Behebung — {person}, {am}: {wortlaut}',
  ursache_aussage: 'Ursache — Aussage von {person}, {am}: {wortlaut}',
  herkunft_feststellung: 'Herkunft: Feststellung {kennung}.',
  herkunft_audit: 'Herkunft: internes Audit {kennung}.',
  herkunft_managementbewertung: 'Herkunft: Managementbewertung {kennung} (Beschluss {beschluss}).',
  wirksamkeit: 'Wirksamkeit geprüft am {am} von {person}: {ergebnis} — Stand Nr. {nr} mit Prüfsumme.',
  wirksamkeit_noch_nicht: 'Die Wirksamkeit lässt sich prüfen, sobald jede Maßnahme umgesetzt, bewertet oder verworfen ist.',
  vieraugen_nicht_erfuellbar: 'Vier-Augen nicht erfüllbar: außer {personen} darf niemand freigeben, und {beteiligt} sind hier beteiligt.',
  managementbewertung_kopf: 'Managementbewertung {jahr} · Sitzung am {sitzung} · Leitung {leitung} · Stand Nr. {nr} vom {stand_vom}, mit Prüfsumme.',
  managementbewertung_erste: 'Keine frühere Managementbewertung festgehalten.',
  beschluss: 'Beschluss {nr} — entschieden von {entschieden_von}, eingetragen von {eingetragen_von}: {wortlaut}',
  beschluss_ohne_folge: 'Keine Folge in VoltPilot — der Beschluss steht im Stand vom {am}.',
  stand_seines_tages: 'Dieser Stand zeigt die Eingaben vom {datenstand}. Was sich danach geändert hat, zeigt die nächste Managementbewertung.',
  wiedervorlage_zeile: '{gegenstand}: {was} seit {tage} Tagen fällig.',
  wiedervorlage_leer: 'Zurzeit ist nichts fällig.',
  kalender_abzug: 'Stand vom {am} aus VoltPilot; maßgeblich ist die Wiedervorlage im Portal.',
  baustein: 'Energiemanagement — {faellig} fällig · {vorschau} in den nächsten {tage} Tagen.',
  verzeichnis_leer: UEMS_NOCH_NICHTS_FESTGEHALTEN,
  verzeichnis_filter: 'In meinem Namen festgehalten: {anzahl} Einträge.',
  zuschnitt_titel: 'Was VoltPilot führt — was bei Ihnen liegt.',
};
const PLATZ = /\{([a-z_]+)\}/g;

type Fehler = { fehler: string };
export type Frist = { faellig_am: string | null; basis: string | null; fassung: number | null; tage: number | null; satz: string | null; grund: string | null };
export type UeberpruefungEingang =
  | { art: 'dokument'; dokument_art: string; monate: number | null; fassungen: { nr: number; freigegeben_am: string }[]; geprueft_bleibt: { fassung: number; am: string }[]; abruf: string }
  | { art: 'internes_audit' | 'managementbewertung'; monate: number; tage: string[]; abruf: string }
  | { art: 'feststellung'; festgestellt_am: string; frist: string | null; frist_tage: number; zustand: string; abruf: string };
export type WiedervorlageZeile = { art: string; kennzeichen: string; titel: string; faellig_am: string; verantwortlich: string | null };
export type WiedervorlageEingang = { abruf: string; vorschau_tage: number; zeilen: WiedervorlageZeile[] };
export type Menge = { standorte: string[]; traeger: string[] };
export type VerzeichnisEingang = {
  gruppe: string; art: string; kennzeichen: string; titel: string; nr: number | null; entschieden_von: string | null;
  eingetragen_von: string | null; tag: string | null; pruefsumme: string | null; ort: string; ablage: string | null;
};

const TAG_MS = 86_400_000;
const tagZahl = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / TAG_MS;
const tagText = (zahl: number) => new Date(zahl * TAG_MS).toISOString().slice(0, 10);
/** Tag + n Monate, Monatsende geklemmt (wie LocalDate.plusMonths). */
function plusMonate(iso: string, n: number): string {
  const gesamt = Number(iso.slice(5, 7)) - 1 + n;
  const jahr = Number(iso.slice(0, 4)) + Math.floor(gesamt / 12);
  const monat = gesamt % 12;
  const letzter = new Date(Date.UTC(jahr, monat + 1, 0)).getUTCDate();
  return tagText(Date.UTC(jahr, monat, Math.min(Number(iso.slice(8, 10)), letzter)) / TAG_MS);
}

/** Die Lage einer Frist zum Abruf — die Wörter der Wiedervorlage (k_faelle `zeile`). */
export function lage(tage: number): string {
  if (tage > 0) return `seit ${tage} Tagen fällig`;
  if (tage === 0) return 'heute fällig';
  return `fällig in ${-tage} Tagen`;
}

function frist(faelligAm: string, basis: string, fassung: number | null, abruf: string): Frist {
  const tage = tagZahl(abruf) - tagZahl(faelligAm);
  return { faellig_am: faelligAm, basis, fassung, tage, satz: lage(tage), grund: null };
}
const ohne = (grund: string, basis: string | null = null): Frist => ({ faellig_am: null, basis, fassung: null, tage: null, satz: null, grund });

/** DK5, IA4, MG7, FS1: wann die Sache wieder vorliegt — beim Abruf; der Tag kommt von außen (`abruf`). */
export function ueberpruefung(e: UeberpruefungEingang): Frist | Fehler {
  const abruf = tagZahl(e.abruf);
  switch (e.art) {
    case 'dokument': {
      const klasse = DOKUMENT_ART_KLASSE[e.dokument_art];
      if (klasse === undefined) return { fehler: 'dokument_art' };
      if (klasse === 'nachweis') return ohne('nachweis');
      const m = e.monate;
      if (m === null || m < STARTWERTE.ueberpruefung_monate_mindestens || m > STARTWERTE.ueberpruefung_monate_hoechstens) return { fehler: 'ueberpruefung_monate' };
      const frei = e.fassungen.filter((f) => tagZahl(f.freigegeben_am) <= abruf);
      if (!frei.length) return ohne('keine_fassung');
      const gilt = frei.reduce((a, b) => (b.nr > a.nr ? b : a));
      const basis = e.geprueft_bleibt
        .filter((b) => b.fassung === gilt.nr && tagZahl(b.am) <= abruf)
        .reduce((jung, b) => (b.am > jung ? b.am : jung), gilt.freigegeben_am);
      return frist(plusMonate(basis, m), basis, gilt.nr, e.abruf);
    }
    case 'internes_audit':
    case 'managementbewertung': {
      if (e.monate < 1) return { fehler: 'rhythmus_monate' };
      const tage = e.tage.filter((t) => tagZahl(t) <= abruf).sort();
      if (!tage.length) return ohne(e.art === 'internes_audit' ? 'kein_audit' : 'keine_managementbewertung');
      const basis = tage[tage.length - 1];
      return frist(plusMonate(basis, e.monate), basis, null, e.abruf);
    }
    case 'feststellung': {
      if (!VOKABULARE.feststellung_zustand.includes(e.zustand)) return { fehler: 'feststellung_zustand' };
      if (e.frist_tage < 1) return { fehler: 'frist_tage' };
      if (e.zustand !== 'offen') return ohne('abgeschlossen', e.festgestellt_am);
      return frist(e.frist ?? tagText(tagZahl(e.festgestellt_am) + e.frist_tage), e.festgestellt_am, null, e.abruf);
    }
    default:
      return { fehler: 'ueberpruefung_art' };
  }
}

/** WV1–WV3: jede Frist kommt fertig aus ihrer Regel (WV2) — hier nur Lage, Vorschau-Fenster und Reihenfolge. */
export function wiedervorlage(e: WiedervorlageEingang) {
  if (e.vorschau_tage < 0) return { fehler: 'vorschau_tage' };
  if (e.zeilen.some((z) => !VOKABULARE.wiedervorlage_art.includes(z.art))) return { fehler: 'wiedervorlage_art' };
  const zeilen = e.zeilen.map((z) => {
    const tage = tagZahl(e.abruf) - tagZahl(z.faellig_am);
    return { art: z.art, kennzeichen: z.kennzeichen, titel: z.titel, faellig_am: z.faellig_am, tage, satz: lage(tage), verantwortlich: z.verantwortlich };
  });
  const vergleich = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const liste = zeilen
    .filter((z) => z.tage >= -e.vorschau_tage)
    .sort((a, b) => vergleich(a.faellig_am, b.faellig_am) || vergleich(a.kennzeichen, b.kennzeichen));
  const faellig = liste.filter((z) => z.tage >= 0);
  const vorschau = liste.filter((z) => z.tage < 0);
  return {
    faellig, vorschau, anzahl_faellig: faellig.length, anzahl_vorschau: vorschau.length,
    nicht_in_liste: zeilen.filter((z) => z.tage < -e.vorschau_tage).map((z) => z.kennzeichen).sort(),
  };
}

/** DK7: Unterschiede zwischen Anwendungsbereich und Betrachtungsumfang (AP-16 U1) — Mengen, kein Urteil. */
export function anwendungsbereichVergleich(e: { anwendungsbereich: Menge; betrachtungsumfang: Menge }) {
  const ab = e.anwendungsbereich;
  const um = e.betrachtungsumfang;
  const nur = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));
  const aus = {
    standorte_nur_im_anwendungsbereich: nur(ab.standorte, um.standorte), standorte_nur_im_betrachtungsumfang: nur(um.standorte, ab.standorte),
    traeger_nur_im_anwendungsbereich: nur(ab.traeger, um.traeger), traeger_nur_im_betrachtungsumfang: nur(um.traeger, ab.traeger),
  };
  return { ...aus, deckungsgleich: Object.values(aus).every((l) => l.length === 0) };
}

/** VZ2, G1: die Zeile mit ihrem Gruppen-Wort und dem Ort als Wort; Ablage nur, wo das Original beim Kunden liegt. */
export function verzeichnisZeile(e: VerzeichnisEingang) {
  const gruppe = WOERTER.verzeichnis_gruppe[e.gruppe];
  const ort = WOERTER.verzeichnis_ort[e.ort];
  if (gruppe === undefined) return { fehler: 'verzeichnis_gruppe' };
  if (ort === undefined) return { fehler: 'verzeichnis_ort' };
  if (e.ort === 'in_voltpilot' && e.ablage !== null) return { fehler: 'ablage_unerwartet' };
  if (e.ort !== 'in_voltpilot' && !e.ablage) return { fehler: 'ablage_fehlt' };
  const { ablage, ...zeile } = e;
  return { ...zeile, gruppe_wort: gruppe, ort_satz: ablage ? `${ort}: ${ablage}` : ort };
}

/** A6 über A1 von bericht.md: `sha256:` + SHA-256 (vom Aufrufer, hex) der UTF-8-Bytes des kanonischen Texts einer Kopie. */
export function pruefsumme(e: { kopie: unknown }, sha256Hex: (text: string) => string) {
  const text = kanonisch(e.kopie);
  return { kanonisch: text, pruefsumme: PRUEFSUMME_PRAEFIX + sha256Hex(text) };
}

/** SP4: die Schablone aus §5.8, jeder Platzhalter genau aus `werte` — kein Wert fehlt, keiner bleibt übrig. */
export function satz(schluessel: string, werte: Record<string, string>) {
  const vorlage = SAETZE[schluessel];
  if (vorlage === undefined) return { fehler: 'satz_unbekannt' };
  const namen = [...vorlage.matchAll(PLATZ)].map((t) => t[1]);
  const fehlt = namen.find((n) => !(n in werte));
  if (fehlt !== undefined) return { fehler: `wert_fehlt:${fehlt}` };
  const uebrig = Object.keys(werte).filter((k) => !namen.includes(k)).sort();
  if (uebrig.length) return { fehler: `wert_uebrig:${uebrig[0]}` };
  return { satz: vorlage.replace(PLATZ, (_, n: string) => werte[n]) };
}
