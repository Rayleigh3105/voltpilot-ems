/**
 * UEMS AP-19 IP-9 (§5.1, §5.8, §6.3, SP1–SP4): das reine Bild des Bereichs „Energiemanagement“ — Reiter, Wörter der
 * Dialoge und die Körper der Routen aus IP-6/IP-7/IP-8. **Hier wird nichts entschieden:** Kopf-Satz, Überprüfung,
 * Sperr-Satz, Vergleich und Verzeichnis kommen von den Routen; die Schablonen der Sätze sind die des Vertrags
 * (`energiemanagement.ts`, Zwilling von `EnergiemanagementRegeln.java`). Keine Datei verlässt das Gerät — ein Verweis
 * trägt nur Ablage, Kennung, Adresse, Fassungsangabe, Tag und die im Browser gebildete Prüfsumme (G3).
 */
import {
  ApiError,
  type EnergiemanagementZuordnung,
  type EnergiemanagementBeleg,
  type EnergiemanagementDokument,
  type EnergiemanagementDokumentAnlegen,
  type EnergiemanagementFassung,
  type EnergiemanagementNachweis,
  type EnergiemanagementPersonKurz,
  type EnergiemanagementVerweis,
  type Selbstauskunft,
} from './api';
import { LEITUNGS_PFLICHT, SAETZE, satz, VOKABULARE, WOERTER, STARTWERTE } from './energiemanagement';
import { UEMS_DOKUMENTE, UEMS_VERZEICHNIS } from './glossar';
import type { EnergiemanagementReiter } from './nav';

// ------------------------------------------------------------------ Rechte (aus `/me`, entschieden wird an der Route)

type Rechte = Pick<Selbstauskunft, 'standorte' | 'unternehmen_rechte'>;

const hat = (s: Rechte | null | undefined, recht: string) =>
  !!s && (s.unternehmen_rechte.includes(recht) || s.standorte.some((st) => st.rechte.includes(recht)));

/** `energiemanagement.ansehen` am Unternehmen oder an einem Standort — sonst gibt es den Bereich nicht. */
export const darfAnsehen = (s: Rechte | null | undefined) => hat(s, 'energiemanagement.ansehen');
export const RECHT_VERWALTEN = 'energiemanagement.verwalten';
export const RECHT_FREIGEBEN = 'energiemanagement.freigeben';

/**
 * Die Rolle „Einsicht“ (IP-12, RE3): unternehmensweit nur lesen. Wer sie hat und an einer Stelle nicht schreiben darf,
 * liest dort den Satz „Mit ‚Einsicht‘ können Sie hier nichts ändern. …“ statt des allgemeinen Recht-Satzes (IP-13, §5.8).
 */
export const mitEinsicht = (s: Pick<Selbstauskunft, 'rollen' | 'standorte'> | null | undefined) =>
  !!s && (s.rollen.includes('einsicht') || s.standorte.some((st) => st.rollen.includes('einsicht')));

// ------------------------------------------------------------------ Wörter

/** Die Reiter in der Reihenfolge von §6.3 — IP-9 Verzeichnis und Dokumente, IP-13 Aufgaben; Wiedervorlage, Audits … kommen mit ihren Paketen. */
export const REITER: readonly { key: Exclude<EnergiemanagementReiter, 'zuschnitt'>; label: string }[] = [
  { key: 'verzeichnis', label: UEMS_VERZEICHNIS },
  { key: 'dokumente', label: UEMS_DOKUMENTE },
  // §6.3 nennt den Reiter „Aufgaben“; die Überschrift darin ist das Glossar-Wort „Aufgaben im Energiemanagement“.
  { key: 'aufgaben', label: 'Aufgaben' },
];

export const KNOPF_ANLEGEN = 'Dokument anlegen';
export const KNOPF_FASSUNG = 'Neue Fassung';
export const KNOPF_ENTWURF = 'Entwurf bearbeiten';
export const KNOPF_FREIGEBEN = 'Freigeben';
export const KNOPF_BEANTRAGEN = 'Freigabe beantragen';
export const KNOPF_BESTAETIGEN = 'Freigabe bestätigen';
export const KNOPF_PERSON = 'Person anlegen';
export const KNOPF_CSV = 'Als CSV abrufen';
export const KNOPF_ZUORDNEN = 'Aufgabe zuordnen';
export const KNOPF_BEENDEN = 'Zuordnung beenden';
export const KNOPF_PERSON_AENDERN = 'Angaben ändern';
export const KNOPF_VERANTWORTUNG = 'Wer ist wofür verantwortlich';
export const KNOPF_NACHWEIS = 'Nachweis festhalten';
/** Der Abschnitt an der Seite eines Energieeinsatzes und einer Person (IP-15, §5.3). */
export const NACHWEISE = 'Nachweise';
export const BEGRUENDUNG_HINWEIS = `${STARTWERTE.begruendung_zeichen_mindestens} bis ${STARTWERTE.begruendung_zeichen_hoechstens} Zeichen.`;

/** Wozu jede der zwölf Arten dient — ein Satz je Art (§5.1), in Kundenwörtern. */
export const ART_SATZ: Record<string, string> = {
  energiepolitik: 'Ihre Verpflichtung zum Energieeinsatz — Wortlaut hier, das unterschriebene Original bei Ihnen. Die Leitung entscheidet.',
  anwendungsbereich: 'Wo Ihr Energiemanagement gilt: Standorte, Energieträger und Ausschlüsse. Die Leitung entscheidet.',
  kontext: 'Themen und interessierte Parteien — meist ein Verweis auf Ihr Handbuch oder Strategiepapier.',
  rechtliche_anforderungen: 'Die für Sie geltenden rechtlichen Anforderungen — ein Verweis auf Ihr Rechtskataster.',
  risiken_chancen: 'Risiken und Chancen für Ihren Energieeinsatz — ein Verweis auf Ihr Register oder ein kurzer Wortlaut.',
  bestellung: 'Die Bestellung der Personen im Energiemanagement als Beleg. Die Leitung entscheidet.',
  verfahren: 'Ein Vorgehen Ihres Energiemanagements, etwa wie Sie Dokumente pflegen.',
  betrieb: 'Kriterien für Betrieb und Instandhaltung — ein Verweis auf Ihre Arbeitspläne.',
  beschaffung: 'Ihre Vorgabe für die Beschaffung energierelevanter Güter und Leistungen.',
  kommunikation: 'Wie Sie im Unternehmen über Ihr Energiemanagement informieren.',
  auslegung: 'Ein Nachweis zur Auslegung von Anlagen oder Prozessen — ohne Überprüfung.',
  kompetenz: 'Ein Nachweis zur Kompetenz einer Person, etwa eine Unterweisung — ohne Überprüfung.',
};

export const artOptionen = () =>
  VOKABULARE.dokument_art.map((art) => ({ value: art, label: WOERTER.dokument_art[art], sub: ART_SATZ[art] }));

export const leitungsPflicht = (art: string) => LEITUNGS_PFLICHT.includes(art);

/** Ein Satz des Vertrags (§5.8) mit seinen Werten — die Schablone füllt `satz` aus `energiemanagement.ts`. */
export function satzText(schluessel: string, werte: Record<string, string>): string {
  const r = satz(schluessel, werte);
  return r.satz ?? '';
}

/** Die Energieträger des Betrachtungsumfangs (openapi `EnergiemanagementAnwendungsbereichEingang.traeger`). */
export const TRAEGER = ['Strom', 'Gas', 'Wärme', 'Kälte', 'Wasser', 'Druckluft'] as const;

export const ZUSTAND_WORT: Record<string, string> = { entwurf: 'Entwurf', gueltig: 'gültig', aufgehoben: 'aufgehoben' };
export const FASSUNG_STATUS_WORT: Record<string, string> = {
  entwurf: 'Entwurf', beantragt: 'Freigabe beantragt', freigegeben: 'freigegeben', abgelehnt: 'abgelehnt', abgeloest: 'abgelöst',
};
export const FORM_WORT: Record<string, string> = { wortlaut: 'Wortlaut', verweis: 'Verweis' };
export const WEG_WORT: Record<string, string> = {
  aushang: 'Aushang', intranet: 'Intranet', unterweisung: 'Unterweisung', besprechung: 'Besprechung', e_mail: 'E-Mail', weiterer: 'weiterer Weg',
};

/** „2026-12-15“ → „15.12.2026“; ein Zeitpunkt wird auf seinen Tag gekürzt. */
export const tagText = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '');

/** „Robert Falk (Geschäftsführer)“ — so steht eine Person hinter „entschieden von“. */
export const personWort = (p: EnergiemanagementPersonKurz | null | undefined) => (p ? `${p.name} (${p.funktion})` : '');

/** „3f1f…9b9b“ — die ganze Prüfsumme steht im `title`. */
export const kurz = (sha: string | null | undefined) => {
  if (!sha) return '';
  const hex = sha.replace(/^sha256:/, '');
  return `${hex.slice(0, 4)}…${hex.slice(-4)}`;
};

/** Die Angaben eines Verweises in der Klammer des Ort-Satzes: „IH-SG-01, Rev. 4 vom 03.11.2028“. */
export function verweisAngaben(v: EnergiemanagementVerweis | EnergiemanagementBeleg): string {
  const fassung = 'fassungsangabe' in v ? v.fassungsangabe : null;
  const datum = 'datum' in v ? v.datum : null;
  const teil = [v.kennung, fassung].filter((t): t is string => !!t && !!t.trim()).join(', ');
  return datum ? `${teil}${teil ? ' ' : ''}vom ${tagText(datum)}` : teil;
}

/**
 * Wo das Original liegt (G1): „Wortlaut in VoltPilot, Original bei Ihnen: …“ an einer Wortlaut-Fassung mit Beleg,
 * „Geführt in Ihrem System: …“ an einer Verweis-Fassung, sonst nichts (ein Wortlaut ohne Beleg liegt nur hier).
 */
export function ortSatz(d: Pick<EnergiemanagementDokument, 'beleg'>, f: Pick<EnergiemanagementFassung, 'form' | 'verweis'> | null): string | null {
  if (f?.form === 'verweis' && f.verweis?.ablage) {
    const angaben = verweisAngaben(f.verweis);
    return angaben ? satzText('ort_verweis', { ablage: f.verweis.ablage, angaben }) : `Geführt in Ihrem System: ${f.verweis.ablage}.`;
  }
  if (d.beleg?.ablage) return satzText('ort_wortlaut', { ablage: d.beleg.ablage });
  return null;
}

/** Der Bezug eines Dokuments als Wort: Unternehmen, Standort, Energieeinsatz, Person oder Aufgabe (seit IP-14). */
export function bezugWort(b: EnergiemanagementDokument['bezug']): string {
  if (b.energieeinsatz) return [b.energieeinsatz.kennzeichen, b.energieeinsatz.name].filter(Boolean).join(' ');
  if (b.person) return b.person.name;
  if (b.aufgabe) return [b.aufgabe.wort, b.aufgabe.person?.name].filter(Boolean).join(': ');
  if (b.standort) return b.standort.name ?? b.standort.kurzzeichen ?? '';
  return 'Unternehmen';
}

/** Die Fassung, die die Seite zeigt: die gültige, sonst die jüngste. */
export const gezeigteFassung = (d: EnergiemanagementDokument) =>
  d.fassungen.find((f) => f.nr === d.gueltige_fassung) ?? d.fassungen[d.fassungen.length - 1] ?? null;

/** Die offene Fassung (Entwurf oder beantragt) — höchstens eine. */
export const offeneFassung = (d: EnergiemanagementDokument) =>
  d.fassungen.find((f) => f.status === 'entwurf' || f.status === 'beantragt') ?? null;

// ------------------------------------------------------------------ Entwürfe → Körper

export type Feldfehler = Record<string, string>;
const leer = (t: string | null | undefined) => !t || !t.trim();
const leerNull = (t: string | null | undefined) => (leer(t) ? null : t!.trim());
const begruendungFehler = (t: string) => {
  const n = t.trim().length;
  return n < STARTWERTE.begruendung_zeichen_mindestens || n > STARTWERTE.begruendung_zeichen_hoechstens
    ? `Bitte begründen Sie in ${BEGRUENDUNG_HINWEIS.replace(/\.$/, '')}.`
    : null;
};

/** Ein Verweis im Dialog; `datei` gibt es hier nicht — nur die im Browser gebildete Prüfsumme. */
export interface VerweisEntwurf {
  bezeichnung: string;
  ablage: string;
  kennung: string;
  adresse: string;
  fassungsangabe: string;
  datum: string;
  sha256: string | null;
}
export const LEERER_VERWEIS: VerweisEntwurf = { bezeichnung: '', ablage: '', kennung: '', adresse: '', fassungsangabe: '', datum: '', sha256: null };

const verweisLeer = (v: VerweisEntwurf) => [v.bezeichnung, v.ablage, v.kennung, v.adresse, v.fassungsangabe, v.datum].every(leer) && !v.sha256;

/** Ganz oder gar nicht (G3): ohne Ablage keiner seiner Teile. */
function verweisKoerper(v: VerweisEntwurf, mitFassung: boolean): EnergiemanagementVerweis | { fehler: string } | null {
  if (verweisLeer(v)) return null;
  if (leer(v.ablage)) return { fehler: 'Bitte nennen Sie, wo das Original bei Ihnen liegt.' };
  return {
    bezeichnung: leerNull(v.bezeichnung),
    ablage: v.ablage.trim(),
    kennung: leerNull(v.kennung),
    adresse: leerNull(v.adresse),
    ...(mitFassung ? { fassungsangabe: leerNull(v.fassungsangabe), datum: leerNull(v.datum) } : {}),
    sha256: v.sha256,
  };
}

export interface AnlegenEntwurf {
  art: string;
  titel: string;
  bezug: 'unternehmen' | 'standort';
  standortId: string;
  original: VerweisEntwurf;
}

/**
 * „Nachweis festhalten“ (IP-15, §5.3): der Bezug steht fest — der Energieeinsatz oder die Person, von deren Seite der
 * Dialog kommt; `wort` ist, wie er im Dialog steht („EE-1 Spritzguss“, „Murat Demirci“).
 */
export interface NachweisBezug {
  art: 'energieeinsatz' | 'person';
  id: string;
  wort: string;
}

/**
 * Die Arten, die „Nachweis festhalten“ je Bezug anbietet (§3.5, §3.7): am Einsatz Betrieb und Instandhaltung, Auslegung
 * und Beschaffung, an der Person die Kompetenz. Die Route nimmt jede Art an jedem Bezug — die Auswahl ist Hilfe, kein Verbot.
 */
export const NACHWEIS_ARTEN: Record<NachweisBezug['art'], readonly string[]> = {
  energieeinsatz: ['betrieb', 'auslegung', 'beschaffung'],
  person: ['kompetenz'],
};

export const nachweisArtOptionen = (bezug: NachweisBezug['art']) =>
  NACHWEIS_ARTEN[bezug].map((art) => ({ value: art, label: WOERTER.dokument_art[art], sub: ART_SATZ[art] }));

/** „Energieeinsatz EE-1 Spritzguss“ — so steht der feste Bezug im Dialog. */
export const nachweisBezugWort = (b: NachweisBezug) => `${b.art === 'energieeinsatz' ? 'Energieeinsatz' : 'Person'} ${b.wort}`;

/** Der Körper von „Nachweis festhalten“: genau die Kennung der Art (`EnergiemanagementDokumentBezug`). */
export function nachweisBezugKoerper(b: NachweisBezug): EnergiemanagementDokumentAnlegen['bezug'] {
  return b.art === 'energieeinsatz' ? { art: 'energieeinsatz', energieeinsatz_id: b.id } : { art: 'person', person_id: b.id };
}

/** `fest` ist der Bezug von „Nachweis festhalten“ (IP-15) — dann gilt er statt Unternehmen/Standort. */
export function anlegenKoerper(e: AnlegenEntwurf, fest: NachweisBezug | null = null) {
  const fehler: Feldfehler = {};
  if (!e.art) fehler.art = 'Bitte wählen Sie die Art.';
  if (leer(e.titel)) fehler.titel = 'Bitte geben Sie einen Titel an.';
  if (!fest && e.bezug === 'standort' && !e.standortId) fehler.bezug = 'Bitte wählen Sie den Standort.';
  const beleg = verweisKoerper(e.original, false);
  if (beleg && 'fehler' in beleg) fehler.original = beleg.fehler;
  if (Object.keys(fehler).length) return { fehler };
  return {
    koerper: {
      art: e.art,
      titel: e.titel.trim(),
      bezug: fest ? nachweisBezugKoerper(fest) : e.bezug === 'standort' ? { art: 'standort' as const, standort_id: e.standortId } : { art: 'unternehmen' as const },
      ...(beleg ? { beleg: beleg as EnergiemanagementBeleg } : {}),
    },
  };
}

// ------------------------------------------------------------------ Nachweise am Einsatz und an der Person (IP-15, §5.3)

/**
 * Die Zeile eines Nachweises (R7 „Was man sieht“): der Ort der gültigen Fassung wörtlich von der Route („Geführt in
 * Ihrem System: …“), die Prüfsumme als Tag, an dem sie festgehalten wurde — VoltPilot hat den Inhalt nicht. Ohne gültige
 * Fassung sagt die Zeile nur, dass noch keine freigegeben ist.
 */
export function nachweisOrt(n: Pick<EnergiemanagementNachweis, 'ort' | 'zustand'>): string {
  if (!n.ort) return `${ZUSTAND_WORT[n.zustand]} — noch keine Fassung freigegeben.`;
  return n.ort.satz ?? `${n.ort.ort_satz}.`;
}

/** „Prüfsumme der Datei festgehalten am 10.11.2028.“ — nur an einem Verweis mit Prüfsumme. */
export function nachweisPruefsumme(n: Pick<EnergiemanagementNachweis, 'ort'>): string | null {
  const o = n.ort;
  if (!o?.sha256) return null;
  return o.festgehalten_am ? `Prüfsumme der Datei festgehalten am ${tagText(o.festgehalten_am)}.` : 'Prüfsumme der Datei festgehalten.';
}

/**
 * Die Überprüfung beim Abruf (DK5), wie die Dokument-Seite sie sagt: fällig → „Überprüfung fällig seit n Tagen.“ (§5.8),
 * sonst „Überprüfung fällig am …“; ein Nachweis (Kompetenz, Auslegung) wird aufbewahrt, nicht überprüft — „ohne
 * Überprüfung“; ohne freigegebene Fassung nichts.
 */
export function nachweisUeberpruefung(n: Pick<EnergiemanagementNachweis, 'ueberpruefung' | 'klasse'>): string | null {
  const u = n.ueberpruefung;
  if (n.klasse === 'nachweis' || u?.grund === 'nachweis') return 'Ein Nachweis — ohne Überprüfung.';
  if (!u?.faellig_am) return null;
  if (u.tage !== null && u.tage > 0) return satzText('ueberpruefung', { tage: String(u.tage) });
  return `Überprüfung fällig am ${tagText(u.faellig_am)}.`;
}

export interface FassungEntwurf {
  form: 'wortlaut' | 'verweis';
  wortlaut: string;
  verweis: VerweisEntwurf;
  standortIds: string[];
  traeger: string[];
  begruendung: string;
}

/** `nr` ist die Nummer, die die Fassung bekommt — ab Fassung 2 ist die Begründung Pflicht. */
export function fassungKoerper(e: FassungEntwurf, art: string, nr: number) {
  const fehler: Feldfehler = {};
  let verweis: EnergiemanagementVerweis | null = null;
  if (e.form === 'wortlaut') {
    if (leer(e.wortlaut)) fehler.wortlaut = 'Bitte schreiben Sie den Wortlaut.';
    else if (e.wortlaut.length > STARTWERTE.wortlaut_zeichen_hoechstens)
      fehler.wortlaut = `Höchstens ${STARTWERTE.wortlaut_zeichen_hoechstens.toLocaleString('de-DE')} Zeichen.`;
  } else {
    const v = verweisKoerper(e.verweis, true);
    if (!v) fehler.verweis = 'Bitte nennen Sie, wo das Original bei Ihnen liegt.';
    else if ('fehler' in v) fehler.verweis = v.fehler;
    else verweis = v;
  }
  if (art === 'anwendungsbereich') {
    if (!e.standortIds.length) fehler.standorte = 'Bitte wählen Sie mindestens einen Standort.';
    if (!e.traeger.length) fehler.traeger = 'Bitte wählen Sie mindestens einen Energieträger.';
  }
  const b = nr >= 2 || !leer(e.begruendung) ? begruendungFehler(e.begruendung) : null;
  if (b) fehler.begruendung = b;
  if (Object.keys(fehler).length) return { fehler };
  return {
    koerper: {
      form: e.form,
      ...(e.form === 'wortlaut' ? { wortlaut: e.wortlaut } : { verweis }),
      ...(art === 'anwendungsbereich' ? { anwendungsbereich: { standort_ids: e.standortIds, traeger: e.traeger, ausschluesse: [] } } : {}),
      ...(leer(e.begruendung) ? {} : { begruendung: e.begruendung.trim() }),
    },
  };
}

export interface FreigabeEntwurf {
  entschiedenVon: string;
  entschiedenAm: string;
  begruendung: string;
}

/** Ohne Vier-Augen und beim Antrag: „entschieden von“, Tag und Begründung. Die zweite Person schickt nur die Begründung. */
export function freigabeKoerper(e: FreigabeEntwurf, zweitePerson: boolean) {
  const fehler: Feldfehler = {};
  if (zweitePerson) {
    const b = leer(e.begruendung) ? null : begruendungFehler(e.begruendung);
    if (b) return { fehler: { begruendung: b } };
    return { koerper: leer(e.begruendung) ? {} : { begruendung: e.begruendung.trim() } };
  }
  if (!e.entschiedenVon) fehler.entschiedenVon = 'Bitte wählen Sie, wer entschieden hat.';
  const b = begruendungFehler(e.begruendung);
  if (b) fehler.begruendung = b;
  if (Object.keys(fehler).length) return { fehler };
  return { koerper: { entschieden_von: e.entschiedenVon, entschieden_am: e.entschiedenAm || null, begruendung: e.begruendung.trim() } };
}

export interface PersonEntwurf {
  name: string;
  funktion: string;
  kuerzel: string;
  organisation: string;
  leitung: boolean;
  leitungAb: string;
  begruendung: string;
}

export function personKoerper(e: PersonEntwurf) {
  const fehler: Feldfehler = {};
  if (leer(e.name)) fehler.name = 'Bitte geben Sie den Namen an.';
  if (leer(e.funktion)) fehler.funktion = 'Bitte geben Sie die Funktion an.';
  if (e.kuerzel.trim().length > 10) fehler.kuerzel = 'Höchstens 10 Zeichen.';
  if (e.leitung) {
    if (!e.leitungAb) fehler.leitungAb = 'Bitte wählen Sie, ab wann.';
    const b = begruendungFehler(e.begruendung);
    if (b) fehler.begruendung = b;
  }
  if (Object.keys(fehler).length) return { fehler };
  return {
    person: { name: e.name.trim(), funktion: e.funktion.trim(), kuerzel: leerNull(e.kuerzel), organisation: leerNull(e.organisation) },
    leitung: e.leitung ? { aufgabe: 'unternehmensleitung', gilt_ab: e.leitungAb, begruendung: e.begruendung.trim() } : null,
  };
}

export interface ZuordnenEntwurf {
  aufgabe: string;
  wortlaut: string;
  personId: string;
  giltAb: string;
  vertretungId: string;
  entschiedenVon: string;
  begruendung: string;
  beleg: VerweisEntwurf;
  beschluss: string;
}

/** Aufgabe × Person × gilt ab (PA2): „entschieden von“ Pflicht außer bei „Leitung des Unternehmens“; nur anhängen. */
export function zuordnenKoerper(e: ZuordnenEntwurf) {
  const fehler: Feldfehler = {};
  if (!e.aufgabe) fehler.aufgabe = 'Bitte wählen Sie die Aufgabe.';
  if (e.aufgabe === 'weitere' && leer(e.wortlaut)) fehler.wortlaut = 'Bitte beschreiben Sie die Aufgabe.';
  if (!e.personId) fehler.personId = 'Bitte wählen Sie die Person.';
  if (!e.giltAb) fehler.giltAb = 'Bitte wählen Sie, ab wann.';
  if (e.vertretungId && e.vertretungId === e.personId) fehler.vertretungId = 'Die Vertretung ist eine andere Person.';
  if (e.aufgabe !== 'unternehmensleitung' && !e.entschiedenVon) fehler.entschiedenVon = 'Bitte wählen Sie, wer entschieden hat.';
  const b = begruendungFehler(e.begruendung);
  if (b) fehler.begruendung = b;
  const beleg = verweisKoerper(e.beleg, false);
  if (beleg && 'fehler' in beleg) fehler.beleg = beleg.fehler;
  if (!leer(e.beschluss) && !/^BR-\d{4}-\d{4,}\/B\d{1,3}$/.test(e.beschluss.trim())) fehler.beschluss = 'Bitte in der Form BR-2029-0001/B4.';
  if (Object.keys(fehler).length) return { fehler };
  return {
    koerper: {
      aufgabe: e.aufgabe,
      ...(e.aufgabe === 'weitere' ? { aufgabe_wortlaut: e.wortlaut.trim() } : {}),
      person_id: e.personId,
      gilt_ab: e.giltAb,
      vertretung_person_id: e.vertretungId || null,
      entschieden_von: e.aufgabe === 'unternehmensleitung' ? e.entschiedenVon || null : e.entschiedenVon,
      begruendung: e.begruendung.trim(),
      beleg: beleg ? (beleg as EnergiemanagementBeleg) : null,
      beschluss_kennung: leerNull(e.beschluss),
    },
  };
}

/** Beenden (PA2): der letzte Tag zählt mit, nicht vor „gilt ab“; die Begründung ist Pflicht. */
export function beendenKoerper(e: { giltBis: string; begruendung: string }, giltAb: string) {
  const fehler: Feldfehler = {};
  if (!e.giltBis) fehler.giltBis = 'Bitte wählen Sie den letzten Tag.';
  else if (e.giltBis < giltAb) fehler.giltBis = `Der letzte Tag liegt nicht vor dem ${tagText(giltAb)}.`;
  const b = begruendungFehler(e.begruendung);
  if (b) fehler.begruendung = b;
  if (Object.keys(fehler).length) return { fehler };
  return { koerper: { gilt_bis: e.giltBis, begruendung: e.begruendung.trim() } };
}

export interface PersonAendernEntwurf {
  name: string;
  funktion: string;
  kuerzel: string;
  organisation: string;
  kontoSub: string;
  seit: string;
  bis: string;
  begruendung: string;
}

/**
 * Der ganze Stand einer Person (PUT ist der ganze Stand, IP-6): ein anderes Konto (verknüpfen, wechseln, lösen) und
 * „bis“ verlangen eine Begründung; „bis“ beendet die Person endgültig und liegt nicht vor „seit“.
 */
export function personAendernKoerper(e: PersonAendernEntwurf, bisherKonto: string | null) {
  const fehler: Feldfehler = {};
  if (leer(e.name)) fehler.name = 'Bitte geben Sie den Namen an.';
  if (leer(e.funktion)) fehler.funktion = 'Bitte geben Sie die Funktion an.';
  if (e.kuerzel.trim().length > 10) fehler.kuerzel = 'Höchstens 10 Zeichen.';
  if (e.bis && e.seit && e.bis < e.seit) fehler.bis = `Der letzte Tag liegt nicht vor dem ${tagText(e.seit)}.`;
  const kontoNeu = (e.kontoSub || null) !== bisherKonto;
  const b = kontoNeu || e.bis || !leer(e.begruendung) ? begruendungFehler(e.begruendung) : null;
  if (b) fehler.begruendung = b;
  if (Object.keys(fehler).length) return { fehler };
  return {
    koerper: {
      name: e.name.trim(),
      funktion: e.funktion.trim(),
      kuerzel: leerNull(e.kuerzel),
      organisation: leerNull(e.organisation),
      konto_sub: e.kontoSub || null,
      seit: e.seit || null,
      bis: e.bis || null,
      begruendung: leerNull(e.begruendung),
    },
  };
}

/**
 * Eine Zuordnung als Satz hinter dem Namen (R5, R11): „ seit 01.03.2029, Vertretung Jonas Wendlinger, entschieden von
 * Robert Falk.“ — eine künftige sagt „ab“, eine beendete nennt ihren letzten Tag.
 */
export function zuordnungRest(z: Pick<EnergiemanagementZuordnung, 'gilt_ab' | 'gilt_bis' | 'vertretung' | 'entschieden_von'>, tag: string): string {
  const beginn = z.gilt_ab > tag ? 'ab' : 'seit';
  return [
    ` ${beginn} ${tagText(z.gilt_ab)}${z.gilt_bis ? ` bis ${tagText(z.gilt_bis)}` : ''}`,
    z.vertretung ? ` Vertretung ${z.vertretung.name}` : null,
    z.entschieden_von ? ` entschieden von ${z.entschieden_von.name}` : null,
  ].filter(Boolean).join(',') + '.';
}

/** Die künftigen Zuordnungen einer Aufgabe am Tag (gilt ab nach dem Tag) — sie stehen unter der Aufgabe, nicht an ihrer Stelle. */
export const kuenftige = (zuordnungen: EnergiemanagementZuordnung[], aufgabe: string, tag: string) =>
  zuordnungen.filter((z) => z.aufgabe === aufgabe && z.zustand === 'laufend' && z.gilt_ab > tag);

/** Die Zuordnungen einer Person — als Person oder als Vertretung, jüngste zuerst. */
export const zuordnungenVon = (zuordnungen: EnergiemanagementZuordnung[], personId: string) =>
  zuordnungen.filter((z) => z.person.id === personId || z.vertretung?.id === personId).sort((a, b) => b.gilt_ab.localeCompare(a.gilt_ab));

/** Alle Freigaben der Bezugsbasen von einer Person: „Alle 5 Bezugsbasen hat Ines Kaltenbach freigegeben.“ — sonst nichts. */
export function freigabenSatz(freigaben: { bezugsbasis: string; freigegeben_von: string | null }[]): string | null {
  const von = [...new Set(freigaben.map((f) => f.freigegeben_von))];
  const basen = new Set(freigaben.map((f) => f.bezugsbasis)).size;
  if (basen < 2 || von.length !== 1 || !von[0]) return null;
  return `Alle ${basen} Bezugsbasen hat ${von[0]} freigegeben.`;
}

export const VERLAUF_WORT: Record<string, string> = {
  person_erfasst: 'erfasst', person_geaendert: 'geändert', person_beendet: 'beendet', aufgabe_zugeordnet: 'Aufgabe zugeordnet', aufgabe_beendet: 'Zuordnung beendet',
};

/** Die Arten der Objekte in „Wer ist wofür verantwortlich“ (openapi `EnergiemanagementVerantwortungObjekt.art`). */
export const OBJEKT_ART_WORT: Record<string, string> = {
  kennzahl: 'Kennzahlen',
  energieeinsatz: 'Energieeinsätze',
  bezugsbasis: 'Bezugsbasen',
  energieziel: 'Energieziele',
  massnahme: 'Maßnahmen',
  abweichung: 'Abweichungen',
  internes_audit: 'Interne Audits',
  feststellung: 'Feststellungen',
};

/** Die Objekte nach Art, in der Reihenfolge der Route (ihre Quellen in `@Order`); unbekannte Arten bleiben mit ihrem Schlüssel. */
export function objekteNachArt<T extends { art: string }>(objekte: T[]): { art: string; wort: string; objekte: T[] }[] {
  const arten = [...new Set(objekte.map((o) => o.art))];
  return arten.map((art) => ({ art, wort: OBJEKT_ART_WORT[art] ?? art, objekte: objekte.filter((o) => o.art === art) }));
}

/** „Robert Falk (Geschäftsführer)“ oder bei einer Person ohne Konto der Satz aus §5.8. */
export const personOhneKontoSatz = (p: { name: string; funktion: string }) =>
  satzText('person_ohne_konto', { name: p.name, funktion: p.funktion });

// ------------------------------------------------------------------ Ablehnungen

/** Die Codes der Routen (openapi `EnergiemanagementAbgelehnt`), die ein Dialog in eigenen Worten sagt. */
const ABLEHNUNG: Record<string, string> = {
  leitung_fehlt: SAETZE.freigabe_ohne_leitung,
  vieraugen_beantragen: 'Bei Ihnen gilt Vier-Augen: die Freigabe wird beantragt, und eine zweite Person bestätigt sie.',
  vieraugen_urheber: 'Diese Fassung haben Sie entworfen oder beantragt — bestätigen muss eine zweite Person.',
  vieraugen_rolle: 'Bestätigen kann nur, wer Kundenadministrator oder Energiemanager ist.',
  fassung_beantragt: 'Für diese Fassung ist die Freigabe beantragt — ein neuer Entwurf geht erst nach der Entscheidung.',
  dokument_aufgehoben: 'Das Dokument ist aufgehoben und bleibt so, wie es ist, lesbar.',
  tag_in_der_zukunft: 'Der Tag der Entscheidung liegt in der Zukunft.',
  recht_fehlt: 'Dafür fehlt Ihnen das Recht.',
  konto_vergeben: 'Dieses Konto gehört schon einer anderen Person.',
  kuerzel_vergeben: 'Dieses Kürzel trägt schon eine andere Person.',
  zuordnung_laeuft_bereits: 'Diese Person hat die Aufgabe in diesem Zeitraum schon.',
  entschieden_von_fehlt: 'Bitte wählen Sie, wer entschieden hat.',
  vertretung_gleich_person: 'Die Vertretung ist eine andere Person.',
  person_beendet: 'Diese Person ist zu diesem Tag nicht mehr im Energiemanagement.',
  aufgabe_beendet: 'Diese Zuordnung ist schon beendet.',
  aufgaben_laufen: 'Diese Person trägt danach noch eine Aufgabe oder eine Vertretung. Beenden Sie zuerst diese Zuordnungen.',
  zeitraum_ungueltig: 'Der letzte Tag liegt vor dem ersten.',
  konto_unbekannt: 'Dieses Konto gibt es in Ihrem Unternehmen nicht.',
  beschluss_ungueltig: 'Bitte nennen Sie den Beschluss in der Form BR-2029-0001/B4.',
};

export const ablehnungCode = (e: unknown) =>
  e instanceof ApiError && e.body && typeof e.body === 'object' && typeof (e.body as { code?: unknown }).code === 'string'
    ? ((e.body as { code: string }).code)
    : null;

export function ablehnungSatz(e: unknown): string {
  const c = ablehnungCode(e);
  if (c && ABLEHNUNG[c]) return ABLEHNUNG[c];
  const body = e instanceof ApiError && e.body && typeof e.body === 'object' ? (e.body as { message?: unknown }) : null;
  if (typeof body?.message === 'string' && body.message) return body.message;
  return e instanceof Error && e.message ? e.message : 'Das hat nicht geklappt. Bitte versuchen Sie es erneut.';
}
