/**
 * Die Welt „Berichte“ (UEMS AP-12 IP-13, E14) als reine Ableitung: aus den Antworten der Berichts-Routen (IP-7) und
 * dem Abzug eines Entwurfs oder Berichtsstands wird, was die Liste und die Berichtsseite zeigen.
 *
 * Der Abzug IST das Dokument (E1): die Seite spricht ihn wörtlich — Zahlen angezeigt nach DA1
 * (`uemsBericht.anzeige`), Zustand, Kennzeichen, Namen und Orte zum Datenstand, wie sie gespeichert sind. Sie prüft
 * ihn nicht gegen den Wert-Vertrag nach (die Prüfsumme hat der Server geprüft, A6) — ein „berechnet“, das
 * `uemsErgebnis` nicht kennt, bleibt stehen, statt die Zahl eines freigegebenen Stands stumm zu machen. Aus lebenden
 * Zeilen liest sie nur zwei HINWEISE, beide als solche erkennbar: „heute: …“ (A5, der Name aus dem Register) und
 * „heutigen Wert zeigen“ (§5.6).
 *
 * Ein Abschnitt der Vorlage, den der Abzug nicht trägt (Vertrag 1.0: Tagesverlauf, Monatswerte, Standorte,
 * Kostenstellen), erscheint nicht — es gibt keine zweite Quelle dafür (`ohneInhalt` nennt ihn).
 *
 * REIN: kein Netz, kein Zustand, keine Uhr (wer „jetzt“ braucht, bekommt es übergeben).
 */

import { ApiError } from './api';
import type {
  Bericht,
  BerichtAbzug,
  BerichtAnstoss,
  BerichtDetail,
  BerichtEntwurf,
  BerichtStand,
  BerichtStandKurz,
  BerichtStandZeichen,
  MessstelleWerte,
} from './api';
import katalog from './berichte/bericht-vorlagen.json';
import {
  UEMS_BERECHNUNG,
  UEMS_BERICHTE,
  UEMS_BERICHTSSTAND,
  UEMS_DATENSTAND,
  UEMS_ENTWURF,
  UEMS_FASSUNG,
  UEMS_KENNZAHL,
  UEMS_MESSSTELLE,
  UEMS_PRUEFSUMME,
  UEMS_VERSION,
} from './glossar';
import { abdeckungText, betragText, tonVon } from './kennzahlKarte';
import { zeitpunktText } from './messstellen';
import * as B from './uemsBericht';
import { fassung as fassungWort, menge, OHNE_ZAHL, PROZENT, TRENNER, zahl } from './uemsErgebnis';
import { periodeText } from './uemsKennzahl';
import { herkunftsZeile, kennzeichenSprung, type Sprung, type Stueck } from './uemsOberflaechen';
import { datumText } from './uemsOrtsbaum';
import { RICHTUNGSPAAR } from './uemsMessstelle';
import type { Karte, Ton } from './uemsWerteKarte';

// ------------------------------------------------------------------ Wörter

export const TITEL = UEMS_BERICHTE;
export const LADEN = 'Berichte werden geladen …';
export const LADEFEHLER = 'Die Berichte konnten nicht geladen werden.';
export const LADEFEHLER_SEITE = 'Der Bericht konnte nicht geladen werden.';
export const LADEFEHLER_STAND = 'Dieser Stand konnte nicht geladen werden.';
export const LEER = 'Es gibt noch keinen Bericht.';
/** AP-13 IP-2: „Berichte dieses Standorts“ ohne Eintrag — ein Unternehmensbericht zählt dort nicht. */
export const LEER_STANDORT = 'Für diesen Standort gibt es noch keinen Bericht.';
export const NICHT_GEFUNDEN = 'Diesen Bericht gibt es nicht (mehr).';
export const ZUR_LISTE = `Alle ${UEMS_BERICHTE}`;

/**
 * AP-13 IP-2 (Ü8, K3): „Berichte dieses Standorts“ — nur Berichte mit `geltung_art = standort` für genau diesen
 * Standort; ein Unternehmensbericht erscheint dort nicht (R-A1).
 */
export function amStandort<B extends Pick<Bericht, 'geltung_art' | 'geltung_id'>>(liste: readonly B[], standortId: string): B[] {
  return liste.filter((b) => b.geltung_art === 'standort' && b.geltung_id === standortId);
}
export const ARCHIVIERT = 'archiviert';
/** Die Wahl über den Reitern: „Berichtsstand“ — die Reiter selbst heißen „Nr. 1“ … und „Entwurf“. */
export const STAND_WAHL = UEMS_BERICHTSSTAND;
export const KEIN_STAND = `noch kein ${UEMS_BERICHTSSTAND}`;
export const NEU_GEBILDET = 'eben neu gebildet';
export const PRUEFSUMME_GEPRUEFT = `${UEMS_PRUEFSUMME} geprüft`;
export const VERLAUF_TITEL = 'Verlauf der Berichtsstände';
export const NACHWEIS = 'Nachweis';
export const HEUTIGEN_WERT = 'heutigen Wert zeigen';
/**
 * AP-13 IP-11 (K4): der Weg vom Nachweis zum Objekt der Zahl. Er steht NEBEN „heutigen Wert zeigen“,
 * nicht statt dessen — die eine Angabe ist die des Stands, die andere die von heute.
 */
export const ZUR_MESSSTELLE = `Zur ${UEMS_MESSSTELLE}`;
export const ZUR_KENNZAHL = `Zur ${UEMS_KENNZAHL}`;
export const HEUTIGER_WERT_LAEDT = 'Der heutige Wert wird geladen …';
export const HEUTIGER_WERT_FEHLER = 'Der heutige Wert konnte nicht geladen werden.';
/** Der Satz der Bildung (IP-5), solange ein Abzug keine Kennzahl trägt. */
export const KEINE_KENNZAHLEN = 'Keine Kennzahlen definiert';
export const KEIN_TAGESVERLAUF = 'In diesem Berichtsstand sind keine Tageswerte gespeichert.';
export const RICHTUNGSPAAR_FEHLT =
  'Laden und Entladen sind für diesen Zeitraum nicht vollständig getrennt gespeichert. Fehlende Mengen bleiben leer und werden nicht als 0 gezeigt.';
export const QUELLEN_ANZAHL = (n: number): string => (n === 1 ? '1 Quelle' : `${n} Quellen`);
/** Der zugeklappte Kopf-Abschnitt (Variante B): „8 Angaben“ — Datenstand, Stand und Prüfsumme stehen schon im Seitenkopf. */
export const ANGABEN_ANZAHL = (n: number): string => (n === 1 ? '1 Angabe' : `${n} Angaben`);

/** Die Wörter der Zusammenfassung — die Inhalte der Vorlage (`bericht-vorlagen.json`), in ihrer Reihenfolge. */
export const ZUSAMMENFASSUNG: ReadonlyArray<readonly [string, string]> = [
  ['netzbezug_kwh', 'Netzbezug'],
  ['einspeisung_kwh', 'Einspeisung'],
  ['pv_erzeugung_kwh', 'PV-Erzeugung'],
  ['speicher_laden_kwh', 'Speicher laden'],
  ['speicher_entladen_kwh', 'Speicher entladen'],
];

export const VERGLEICH_WORT: Record<string, string> = { vormonat: 'Vormonat', vorjahresmonat: 'Vorjahresmonat', vorjahr: 'Vorjahr' };
export const GELTUNG_WORT: Record<Bericht['geltung_art'], string> = { standort: 'Standort', unternehmen: 'Unternehmen' };
export const MENGE_ART_WORT: Record<string, string> = {
  laden: RICHTUNGSPAAR.charge_discharge.positiv,
  entladen: RICHTUNGSPAAR.charge_discharge.negativ,
};

export const KOPF_WORT = {
  unternehmen: 'Unternehmen',
  zeitraum: 'Zeitraum',
  datenstand: UEMS_DATENSTAND,
  darstellung: 'Darstellung',
  regelwerk: 'Regelwerk',
} as const;

export const QUALITAET_WORT = {
  abdeckung: 'Abdeckung (geringste)',
  luecken: 'Lücken',
  ersatzwerte: 'Ersatzwerte',
  korrekturen: 'Korrekturen im Zeitraum',
  vorlaeufig: 'Vorläufige Werte',
} as const;

// ------------------------------------------------------------------ Der Abzug (bericht.schema.json $defs/abzug)

export interface AbzugWert {
  quelle: string;
  name_zum_datenstand: string;
  ort_zum_datenstand: string | null;
  periode: string;
  menge: number | null;
  menge_art?: 'laden' | 'entladen';
  einheit: string;
  zustand: string;
  abdeckung_prozent: number;
  kennzeichen: string[];
  fassung: 'vorläufig' | 'endgültig' | null;
  endgueltig_ab: string | null;
  version: number;
  berechnet_am: string;
  zeitzone: string;
  formel?: string;
  formel_fassung?: number;
}

/**
 * Der Tagesverlauf EINER Wert-Zeile (Vertrag 1.2, `$defs/tagesverlauf_reihe`) - je Tag Menge und
 * Zustand, abgeschrieben aus den gespeicherten Tageszeilen. Die Zeile wird ueber `quelle` plus
 * `menge_art` angesprochen, also genau wie in `werte`; ein Speicher hat zwei.
 *
 * Eine leere `tage`-Liste ist die LUECKE (keine gespeicherte Tageszeile), nicht die Null.
 */
export interface AbzugTagesverlauf {
  quelle: string;
  menge_art?: 'laden' | 'entladen';
  tage: Array<{ tag: string; menge: number | null; zustand: string }>;
}

export interface AbzugKennzahl {
  quelle: string;
  name_zum_datenstand: string;
  /** 1.2 - wie an `AbzugWert`; ein Abzug nach 1.0/1.1 traegt es nicht. */
  ort_zum_datenstand?: string | null;
  /** 1.2 - wie an `AbzugWert`; fuellt mit `ort_zum_datenstand` die zwei Zellen der CSV (B14). */
  endgueltig_ab?: string | null;
  wert: number | null;
  einheit: string;
  zustand: string;
  abdeckung_prozent: number;
  kennzeichen: string[];
  fassung: 'vorläufig' | 'endgültig';
  version: number;
  definition_fassung: number;
  eingaenge: Array<{ art: string; kennzeichen: string; wert: number; einheit: string; version?: number; fassung?: number; stichtag?: string }>;
  berechnet_am: string;
}

export interface AbzugKopf {
  bericht: string;
  vorlage: string;
  vorlage_fassung: number;
  geltung: { art: 'standort' | 'unternehmen'; kennzeichen: string; name_zum_datenstand: string };
  unternehmen: string;
  sitz: string;
  zeitraum: { art: 'monat' | 'jahr'; schluessel: string; von: string; bis: string; zone: string };
  vergleichszeitraeume: Array<{ art: string; schluessel: string; ergebnis: string }>;
  datenstand: string;
  regelwerk: { software: string; vertraege: Record<string, string> };
  darstellung: { zeitzone: string; zahlenformat: string; dezimal: string; rundung: string; sommerzeit: string };
  quellenverzeichnis: string[];
}

export interface Abzug {
  kopf: AbzugKopf;
  zusammenfassung: Record<string, number>;
  werte: AbzugWert[];
  /** 1.2, nur in der Monatsvorlage; ein Abzug nach 1.0/1.1 traegt den Abschnitt nicht. */
  tagesverlauf?: AbzugTagesverlauf[];
  kennzahlen: AbzugKennzahl[];
  qualitaet: {
    abdeckung_min_prozent: number;
    luecken: number;
    ersatzwerte: number;
    korrekturen_im_zeitraum: number;
    vorlaeufig: number;
    korrekturen?: Array<{ kennung: string; reihe: string; freigegeben: string; wer: string; warum: string }>;
  };
}

/** Die Antwort trägt den Abzug roh (`@JsonRawValue`); seine Form ist der Vertrag. */
export const abzugAus = (a: BerichtAbzug): Abzug => a as unknown as Abzug;

/** Eine Zahl des Abzugs als Dezimaltext, so wie die kanonische Form sie schreibt („6100“, „0.1488“). */
const dezimal = (n: number): string => B.kanonisch(n);

// ------------------------------------------------------------------ Vorlagen

interface KatalogVorlage {
  schluessel: string;
  fassung: number;
  name: string;
  abschnitte: Array<{ schluessel: string; titel: string }>;
}

const VORLAGEN = (katalog as { vorlagen: KatalogVorlage[] }).vorlagen;

export const vorlageName = (schluessel: string): string => VORLAGEN.find((v) => v.schluessel === schluessel)?.name ?? schluessel;

// ------------------------------------------------------------------ Liste

export interface ListenKarte {
  kennung: string;
  /** „Monatsbericht Werk Ahrenberg Oktober 2026“ — Vorlage, Geltung und Zeitraum. */
  titel: string;
  /** „Monatsbericht Standort · Fassung 1“. */
  unter: string;
  /** R5 — der Vermerk, wie die Route ihn spricht. */
  stand: string | null;
  standTon: BadgeTon;
  archiviert: string | null;
}

export type BadgeTon = Ton | 'tint';

const STAND_TON: Record<BerichtStandZeichen, BadgeTon> = {
  entwurf: 'tint',
  berichtsstand: 'ok',
  revision_noetig: 'warn',
  anstoss_verworfen: 'ok',
};

export const berichtTitel = (b: Pick<Bericht, 'zeitraum_art' | 'geltung_name' | 'zeitraum_text'>): string =>
  [B.SAETZE[`vorlage_${b.zeitraum_art}`], b.geltung_name, b.zeitraum_text].filter((t): t is string => !!t).join(' ');

export const listenKarte = (b: Bericht): ListenKarte => ({
  kennung: b.kennung,
  titel: berichtTitel(b),
  unter: [vorlageName(b.vorlage), `${UEMS_FASSUNG} ${b.vorlage_fassung}`].join(TRENNER),
  stand: b.stand_text,
  standTon: STAND_TON[b.stand_zeichen],
  archiviert: b.archiviert_am === null ? null : ARCHIVIERT,
});

/** Archivierte stehen hinten, sonst die Reihenfolge der Route. */
export const sortiert = (liste: readonly Bericht[]): Bericht[] =>
  [...liste].sort((a, b) => Number(a.archiviert_am !== null) - Number(b.archiviert_am !== null));

/**
 * Warum die Liste nichts zeigt. Eine 403 ist keine Störung: die Route sagt, wer keinen Bericht lesen darf (G2 —
 * die Unterstützung nie), und ihr Satz steht da, ohne „Erneut versuchen“.
 */
export const listenFehler = (e: unknown): { satz: string; erneut: boolean } =>
  e instanceof ApiError && e.status === 403 ? { satz: e.message, erneut: false } : { satz: LADEFEHLER, erneut: true };

// ------------------------------------------------------------------ Welcher Stand

export type Ansicht = { art: 'entwurf'; entwurf: BerichtEntwurf } | { art: 'stand'; stand: BerichtStand };

export const ENTWURF_WAHL = 'entwurf';
export const standId = (nr: number): string => `nr-${nr}`;
export const nrAus = (id: string): number | null => (id.startsWith('nr-') ? Number(id.slice(3)) : null);

/** Der gültige Stand: der, den keiner ersetzt; `null` = noch keiner. */
export const gueltigerStand = (staende: readonly BerichtStandKurz[]): BerichtStandKurz | null =>
  [...staende].sort((a, b) => b.nr - a.nr).find((s) => s.ersetzt_durch_nr === null) ?? null;

/** Die Reiter „Nr. 1 · Nr. 2 · Entwurf“; vorgewählt ist der gültige Stand, ohne Stand der Entwurf (§5.2). */
export const standWahl = (detail: BerichtDetail): { optionen: Array<{ id: string; label: string }>; vorgabe: string } => {
  const staende = [...detail.staende].sort((a, b) => a.nr - b.nr);
  const gueltig = gueltigerStand(staende);
  return {
    optionen: [...staende.map((s) => ({ id: standId(s.nr), label: `Nr. ${s.nr}` })), { id: ENTWURF_WAHL, label: UEMS_ENTWURF }],
    vorgabe: gueltig ? standId(gueltig.nr) : ENTWURF_WAHL,
  };
};

// ------------------------------------------------------------------ Kopf der Seite

export interface Abzeichen {
  text: string;
  ton: BadgeTon;
}

export interface SeitenKopf {
  kennung: string;
  titel: string;
  /** „Monatsbericht Standort · Fassung 1“ — die Fassung, mit der DIESER Abzug gebildet wurde. */
  vorlage: string;
  /** D5 — „Datenstand 10.11.2026 08:55 (MEZ) · Berichtsstand Nr. 1 · freigegeben 10.11.2026 09:02 von …“. */
  zeile: string;
  abzeichen: Abzeichen[];
  /** Nur am Stand: die geprüfte Prüfsumme (A6). */
  pruefsumme: string | null;
  /** G3 — „Teilansicht: …“. */
  teilansicht: string | null;
}

export const seitenKopf = (detail: BerichtDetail, ansicht: Ansicht, jetzt: number): SeitenKopf => {
  const b = detail.bericht;
  const zone = b.zeitzone;
  const abzeichen: Abzeichen[] = [];
  const gueltig = gueltigerStand(detail.staende);
  if (ansicht.art === 'stand') {
    const s = ansicht.stand;
    if (s.ersetzt_durch_nr !== null) {
      const nachfolger = detail.staende.find((x) => x.nr === s.ersetzt_durch_nr);
      if (nachfolger) abzeichen.push({ text: B.ersetztDurch(nachfolger.nr, nachfolger.freigegeben_am, zone), ton: 'off' });
    } else if (gueltig?.nr === s.nr && b.stand_text !== null && b.stand_zeichen !== 'entwurf') {
      // R5 am gültigen Stand: „Berichtsstand Nr. 2“, „Revision nötig — …“ oder „Anstoß verworfen (…)“.
      abzeichen.push({ text: b.stand_text, ton: STAND_TON[b.stand_zeichen] });
    }
  } else {
    if (detail.staende.length === 0) abzeichen.push({ text: KEIN_STAND, ton: 'tint' });
    if (jetzt < Date.parse(B.zeitraum(b.zeitraum_art, b.zeitraum, zone).bis)) abzeichen.push({ text: B.ZEITRAUM_LAEUFT, ton: 'warn' });
    if (ansicht.entwurf.neu_gebildet) abzeichen.push({ text: NEU_GEBILDET, ton: 'tint' });
  }
  if (b.archiviert_am !== null) abzeichen.push({ text: ARCHIVIERT, ton: 'tint' });
  const fassung = ansicht.art === 'stand' ? ansicht.stand.vorlage_fassung : abzugAus(ansicht.entwurf.abzug).kopf.vorlage_fassung;
  const teilansicht = ansicht.art === 'stand' ? ansicht.stand.teilansicht : ansicht.entwurf.teilansicht;
  return {
    kennung: b.kennung,
    titel: berichtTitel(b),
    vorlage: [vorlageName(b.vorlage), `${UEMS_FASSUNG} ${fassung}`].join(TRENNER),
    zeile: ansicht.art === 'stand' ? ansicht.stand.kopf : ansicht.entwurf.kopf,
    abzeichen,
    pruefsumme: ansicht.art === 'stand' && ansicht.stand.pruefsumme_geprueft ? ansicht.stand.pruefsumme : null,
    teilansicht: teilansicht === null ? null : B.teilansichtKennzeichen(teilansicht),
  };
};

// ------------------------------------------------------------------ Abschnitte nach Vorlage

export interface Zeile {
  name: string;
  wert: string;
}

export interface Nachweis {
  /** Die Form der Tages- und Monatskarte (`WerteKarte`). */
  karte: Karte;
  /** Die Herkunft Zeile für Zeile: Ort, Version und Endgültigkeit, Berechnung, Eingänge, Regelwerk. */
  herkunft: string[];
  /**
   * AP-13 IP-11 (D1/D2): dieselben Zeilen in Stücken — die Kennzeichen mit Seite sind Sprünge MIT dem
   * ZEITRAUM DES BERICHTS und der Version des Eingangs, nie mit der Periode der offenen Seite.
   */
  herkunftStuecke: Stueck[][];
}

export interface QuellenZahl {
  /** Eindeutig je Abschnitt: Kennzeichen plus Mengen-Art. */
  schluessel: string;
  kennzeichen: string;
  name: string;
  /** A5 — „heute: …“, nur wenn der Name sich seit dem Datenstand geändert hat. */
  heute: string | null;
  zahl: string;
  zustand: string;
  zustandTon: Ton;
  version: string;
  kennzeichenSaetze: string[];
  nachweis: Nachweis;
  /** Die Messstelle für „heutigen Wert zeigen“ — `null`, wo es keinen vergleichbaren heutigen Wert gibt. */
  messstelle: string | null;
  /**
   * AP-13 IP-11 (K4, O10 Schritt 6): der Weg von dieser Zahl zu ihrem Objekt — die Messstellen-Seite im
   * Abschnitt „Werte“ bzw. die Kennzahl-Seite, beide mit dem Zeitraum des Berichts. `null`, wo das Objekt
   * keine Seite hat (Speicher-Mengenarten: der heutige Leseweg trennt Laden und Entladen nicht).
   */
  sprung: Sprung | null;
  /** Das Wort am Weg — „Zur Messstelle“ bzw. „Zur Kennzahl“; `null` ohne Sprung. */
  sprungWort: string | null;
}

export interface ZahlenGruppe {
  schluessel: string;
  kennzeichen: string;
  name: string;
  /** Zwei Richtungen derselben Messstelle stehen als EINE Gruppe beieinander. */
  richtungspaar: boolean;
  /** Alte Perioden können nur einen oder gar keinen gespeicherten Anteil tragen. */
  fehlt: string | null;
  zeilen: QuellenZahl[];
}

export interface TagesverlaufZeile {
  schluessel: string;
  kennzeichen: string;
  name: string;
  einheit: string;
  tage: Array<{ tag: string; label: string; menge: number | null; mengeText: string; zustand: string; ton: string }>;
  leer: string | null;
}

export type Abschnitt =
  | { art: 'kopf'; schluessel: string; titel: string; anzahl: string; zeilen: Zeile[] }
  | { art: 'zusammenfassung'; schluessel: string; titel: string; kacheln: Zeile[]; zaehlung: string | null }
  | { art: 'messstellen'; schluessel: string; titel: string; vergleiche: string[]; zeilen: QuellenZahl[]; gruppen: ZahlenGruppe[] }
  | { art: 'tagesverlauf'; schluessel: string; titel: string; leer: string | null; zeilen: TagesverlaufZeile[] }
  | { art: 'kennzahlen'; schluessel: string; titel: string; leer: string | null; zeilen: QuellenZahl[] }
  | { art: 'qualitaet'; schluessel: string; titel: string; zeilen: Zeile[]; korrekturen: string[] }
  | { art: 'quellen'; schluessel: string; titel: string; anzahl: string; zeilen: QuellenEintrag[] };

export interface QuellenEintrag {
  kennzeichen: string;
  name: string | null;
  heute: string | null;
  /** „Version 2“, „Fassung 1“, „Stichtag 31.10.2026“ — was der Abzug an der Quelle festhält. */
  stand: string | null;
  /**
   * AP-13 IP-11 (D1/D2): auch das Quellenverzeichnis ist ein Weg zu seinen Objekten — mit dem Zeitraum des
   * Berichts und der Version, die der Abzug festhält. Eine Bezugsgröße bleibt Text (D3).
   */
  sprung: Sprung | null;
}

/** Den heutigen Namen einer Quelle — `null`, wo er nicht bekannt ist (kein Hinweis). */
export type HeuteName = (kennzeichen: string) => string | null;

const heuteHinweis = (heuteName: HeuteName, kennzeichen: string, zumDatenstand: string): string | null => {
  const heute = heuteName(kennzeichen);
  return heute === null ? null : B.heute(zumDatenstand, heute);
};

const FASSUNG_WERT: Record<string, 'vorlaeufig' | 'endgueltig'> = { 'vorläufig': 'vorlaeufig', 'endgültig': 'endgueltig' };

const zeitText = (iso: string, zone: string): string => zeitpunktText(iso, zone);

const regelwerkZeile = (kopf: AbzugKopf, vertrag: string): string | null => {
  const fassung = kopf.regelwerk.vertraege[vertrag];
  return fassung === undefined ? null : `${KOPF_WORT.regelwerk} ${vertrag} ${fassung}`;
};

const wertZahl = (w: AbzugWert, kopf: AbzugKopf): QuellenZahl => {
  const ebene = kopf.zeitraum.art;
  const zone = w.zeitzone;
  const zahlText = w.menge === null ? OHNE_ZAHL : B.anzeige('menge', dezimal(w.menge), w.einheit, ebene);
  const fassung = w.fassung === null ? null : FASSUNG_WERT[w.fassung] ?? null;
  const saetze = [...w.kennzeichen, ...(fassung === 'vorlaeufig' && w.endgueltig_ab ? [B.vorlaeufig(w.endgueltig_ab, zone)] : [])];
  const art = w.menge_art ? MENGE_ART_WORT[w.menge_art] : null;
  const titel = [periodeText(ebene, w.periode), art].filter((t): t is string => t !== null).join(TRENNER);
  const karte: Karte = {
    titel,
    tagesdauer: null,
    fassung: fassung === null ? null : fassungWort(fassung),
    fassungWert: fassung,
    zahl: zahlText,
    zustand: w.zustand,
    abdeckung: abdeckungText(dezimal(w.abdeckung_prozent)),
    kennzeichen: saetze,
    zustandTon: tonVon(w.zustand),
    abdeckungTon: w.abdeckung_prozent === 100 ? 'ok' : 'warn',
  };
  const endgueltig = fassung === 'endgueltig' && w.endgueltig_ab ? [`endgültig ab ${zeitText(w.endgueltig_ab, zone)}`] : [];
  const herkunft = [
    ...(w.ort_zum_datenstand ? [`Ort zum ${UEMS_DATENSTAND} ${w.ort_zum_datenstand}`] : []),
    [`${UEMS_VERSION} ${w.version}`, ...endgueltig, `gerechnet ${zeitText(w.berechnet_am, zone)}`].join(TRENNER),
    ...(w.formel ? [[`${UEMS_BERECHNUNG} ${w.formel}`, ...(w.formel_fassung ? [`${UEMS_FASSUNG} ${w.formel_fassung}`] : [])].join(TRENNER)] : []),
    // RW1 — die Fassung des Regelwerks, nach dem die Zahl entstand: gemessen = verbrauch, berechnet = bilanz.
    ...[regelwerkZeile(kopf, w.formel ? 'bilanz' : 'verbrauch')].filter((t): t is string => t !== null),
  ];
  return {
    schluessel: w.menge_art ? `${w.quelle}/${w.menge_art}` : w.quelle,
    kennzeichen: w.quelle,
    name: art ?? w.name_zum_datenstand,
    heute: null,
    zahl: zahlText,
    zustand: w.zustand,
    zustandTon: tonVon(w.zustand),
    version: `${UEMS_VERSION} ${w.version}`,
    kennzeichenSaetze: saetze,
    // AP-13 IP-11: die Zeilen einer gemessenen Zahl nennen kein fremdes Objekt — ihre Kante hängt an der Zahl
    // selbst (`sprung`). Die Stücke entstehen trotzdem, damit jede Zeile durch dieselbe Form läuft.
    nachweis: { karte, herkunft, herkunftStuecke: herkunft.map((t) => herkunftsZeile(t, () => null)) },
    // Eine Richtungs-Zeile (Laden/Entladen, Vertrag 1.2) ist KEINE eigene Messstelle: sie springt nicht,
    // denn ihr Ziel waere dieselbe Reihe wie die der anderen Richtung.
    messstelle: w.menge_art ? null : w.quelle,
    sprung: w.menge_art ? null : kennzeichenSprung(w.quelle, { periode: kopf.zeitraum.schluessel }),
    sprungWort: w.menge_art ? null : ZUR_MESSSTELLE,
  };
};

const eingangText = (e: AbzugKennzahl['eingaenge'][number]): string => {
  const stand =
    e.version !== undefined
      ? `${UEMS_VERSION} ${e.version}`
      : e.fassung !== undefined
        ? `${UEMS_FASSUNG} ${e.fassung}`
        : e.stichtag !== undefined
          ? `Stichtag ${datumText(e.stichtag)}`
          : null;
  return `${e.kennzeichen} ${betragText(dezimal(e.wert), e.einheit)}${stand ? ` (${stand})` : ''}`;
};

const kennzahlZahl = (k: AbzugKennzahl, kopf: AbzugKopf): QuellenZahl => {
  const zeitraum = kopf.zeitraum;
  const zahlText = k.wert === null ? OHNE_ZAHL : B.anzeige('kennzahl', dezimal(k.wert), k.einheit, null);
  const fassung = FASSUNG_WERT[k.fassung] ?? null;
  const karte: Karte = {
    titel: periodeText(zeitraum.art, zeitraum.schluessel),
    tagesdauer: null,
    fassung: fassung === null ? null : fassungWort(fassung),
    fassungWert: fassung,
    zahl: zahlText,
    zustand: k.zustand,
    abdeckung: abdeckungText(dezimal(k.abdeckung_prozent)),
    kennzeichen: [...k.kennzeichen],
    zustandTon: tonVon(k.zustand),
    abdeckungTon: k.abdeckung_prozent === 100 ? 'ok' : 'warn',
  };
  return {
    schluessel: k.quelle,
    kennzeichen: k.quelle,
    name: k.name_zum_datenstand,
    heute: null,
    zahl: zahlText,
    zustand: k.zustand,
    zustandTon: tonVon(k.zustand),
    version: `${UEMS_VERSION} ${k.version}`,
    kennzeichenSaetze: [...k.kennzeichen],
    nachweis: nachweisDerKennzahl(k, kopf, karte),
    messstelle: null,
    // AP-13 IP-11: die Kennzahl-Zeile des Berichts führt auf ihre Kennzahl-Seite.
    sprung: kennzeichenSprung(k.quelle, { periode: zeitraum.schluessel }),
    sprungWort: ZUR_KENNZAHL,
  };
};

/**
 * AP-13 IP-11 (D1/D2): der Nachweis einer Kennzahl — dieselben Zeilen, aber jedes Kennzeichen eines
 * Eingangs ein Sprung. Die Periode ist die des BERICHTS (sein Zeitraum), die Version die des Eingangs,
 * wie der Abzug sie festhält; eine Bezugsgröße bleibt Text (D3).
 */
function nachweisDerKennzahl(k: AbzugKennzahl, kopf: AbzugKopf, karte: Karte): Nachweis {
  const zeitraum = kopf.zeitraum;
  const endgueltig = k.fassung === 'endgültig' && k.endgueltig_ab
    ? [`endgültig ab ${zeitText(k.endgueltig_ab, zeitraum.zone)}`]
    : [];
  const herkunft = [
    ...(k.ort_zum_datenstand ? [`Ort zum ${UEMS_DATENSTAND} ${k.ort_zum_datenstand}`] : []),
    ...k.eingaenge.map(eingangText),
    [`${UEMS_BERECHNUNG} ${UEMS_FASSUNG} ${k.definition_fassung}`, ...endgueltig, `gerechnet ${zeitText(k.berechnet_am, zeitraum.zone)}`].join(TRENNER),
    ...[regelwerkZeile(kopf, 'kennzahl')].filter((t): t is string => t !== null),
  ];
  const rahmen = new Map(k.eingaenge.map((e) => [e.kennzeichen, { periode: zeitraum.schluessel, version: e.version ?? null }]));
  const ziel = (kennzeichen: string) => kennzeichenSprung(kennzeichen, rahmen.get(kennzeichen) ?? { periode: zeitraum.schluessel });
  return { karte, herkunft, herkunftStuecke: herkunft.map((t) => herkunftsZeile(t, ziel)) };
}

const wertSchluessel = (w: Pick<AbzugWert | AbzugTagesverlauf, 'quelle' | 'menge_art'>): string =>
  w.menge_art ? `${w.quelle}/${w.menge_art}` : w.quelle;

const gruppiereZahlen = (werte: readonly AbzugWert[], zeilen: QuellenZahl[]): ZahlenGruppe[] => {
  const gruppen = new Map<string, { werte: AbzugWert[]; zeilen: QuellenZahl[] }>();
  for (let i = 0; i < werte.length; i++) {
    const w = werte[i];
    const g = gruppen.get(w.quelle) ?? { werte: [], zeilen: [] };
    g.werte.push(w);
    g.zeilen.push(zeilen[i]);
    gruppen.set(w.quelle, g);
  }
  return [...gruppen.entries()].map(([quelle, g]) => {
    const richtungspaar = g.werte.some((w) => w.menge_art !== undefined);
    const arten = new Set(g.werte.map((w) => w.menge_art).filter((x): x is 'laden' | 'entladen' => x !== undefined));
    const fehlt = richtungspaar && (arten.size < 2 || g.werte.some((w) => w.menge === null)) ? RICHTUNGSPAAR_FEHLT : null;
    return {
      schluessel: quelle,
      kennzeichen: quelle,
      name: g.werte[0]?.name_zum_datenstand ?? quelle,
      richtungspaar,
      fehlt,
      zeilen: g.zeilen,
    };
  });
};

const zustandTon = (zustand: string): string => {
  if (zustand === 'vollständig') return 'vollstaendig';
  if (zustand === 'unvollständig') return 'unvollstaendig';
  if (zustand === 'mit Ersatzwert') return 'ersatzwert';
  return 'keine-werte';
};

const tagesverlaufZeilen = (a: Abzug): TagesverlaufZeile[] => (a.tagesverlauf ?? []).map((reihe) => {
  const schluessel = wertSchluessel(reihe);
  const wert = a.werte.find((w) => wertSchluessel(w) === schluessel);
  const richtung = reihe.menge_art ? MENGE_ART_WORT[reihe.menge_art] : null;
  const einheit = wert?.einheit ?? '';
  return {
    schluessel,
    kennzeichen: reihe.quelle,
    name: [wert?.name_zum_datenstand ?? reihe.quelle, richtung].filter((x): x is string => x !== null).join(TRENNER),
    einheit,
    tage: reihe.tage.map((t) => ({
      tag: t.tag,
      label: datumText(t.tag),
      menge: t.menge,
      mengeText: t.menge === null || einheit === '' ? OHNE_ZAHL : B.anzeige('menge', dezimal(t.menge), einheit, 'tag'),
      zustand: t.zustand,
      ton: zustandTon(t.zustand),
    })),
    leer: reihe.tage.length === 0 ? KEIN_TAGESVERLAUF : null,
  };
});

const kopfZeilen = (kopf: AbzugKopf): Zeile[] => {
  const z = B.zeitraum(kopf.zeitraum.art, kopf.zeitraum.schluessel, kopf.zeitraum.zone);
  return [
    { name: KOPF_WORT.unternehmen, wert: `${kopf.unternehmen}, ${kopf.sitz}` },
    { name: GELTUNG_WORT[kopf.geltung.art], wert: `${kopf.geltung.name_zum_datenstand} (${kopf.geltung.kennzeichen})` },
    {
      name: KOPF_WORT.zeitraum,
      wert: `${z.bezeichnung} (${datumText(z.erster_tag)}–${datumText(z.letzter_tag)})`,
    },
    ...kopf.vergleichszeitraeume.map((v) => ({
      name: `${VERGLEICH_WORT[v.art] ?? v.art} ${periodeText(v.art === 'vorjahr' ? 'jahr' : 'monat', v.schluessel)}`,
      wert: v.ergebnis,
    })),
    { name: KOPF_WORT.datenstand, wert: zeitText(kopf.datenstand, kopf.zeitraum.zone) },
    // Rundung und Sommerzeit trägt der Abzug als Verweis auf die Konzept-Regel — das ist kein Kundensatz (Befund, IP-11).
    { name: KOPF_WORT.darstellung, wert: [`Zeitzone ${kopf.darstellung.zeitzone}`, `Zahlen ${kopf.darstellung.zahlenformat}`].join(TRENNER) },
    {
      name: KOPF_WORT.regelwerk,
      wert: [
        `Software ${kopf.regelwerk.software}`,
        ...Object.entries(kopf.regelwerk.vertraege).map(([vertrag, fassung]) => `${vertrag} ${fassung}`),
      ].join(TRENNER),
    },
  ];
};

/**
 * Die Abschnitte in der Reihenfolge der Vorlage (V2). `heuteName` liefert den heutigen Namen einer Quelle (A5);
 * ohne ihn gibt es keinen Hinweis.
 */
export const abschnitte = (a: Abzug, heuteName: HeuteName = () => null): { abschnitte: Abschnitt[]; ohneInhalt: string[] } => {
  const kopf = a.kopf;
  const ebene = kopf.zeitraum.art;
  const vorlage = VORLAGEN.find((v) => v.schluessel === kopf.vorlage);
  const out: Abschnitt[] = [];
  const ohneInhalt: string[] = [];
  const mitHeute = (z: QuellenZahl, zumDatenstand: string): QuellenZahl => ({ ...z, heute: heuteHinweis(heuteName, z.kennzeichen, zumDatenstand) });
  for (const { schluessel, titel } of vorlage?.abschnitte ?? []) {
    if (schluessel === 'kopf') {
      const zeilen = kopfZeilen(kopf);
      out.push({ art: 'kopf', schluessel, titel, anzahl: ANGABEN_ANZAHL(zeilen.length), zeilen });
    } else if (schluessel === 'zusammenfassung') {
      const s = a.zusammenfassung;
      // Fehlt ein Wert, fehlt der Schlüssel — unbekannt ist keine Null.
      const kacheln = ZUSAMMENFASSUNG.filter(([k]) => typeof s[k] === 'number').map(([k, name]) => ({
        name,
        wert: B.anzeige('menge', dezimal(s[k]), 'kWh', ebene),
      }));
      const zaehlung =
        typeof s.werte === 'number'
          ? [`${s.werte} Werte`, `davon ${s.davon_endgueltig} endgültig`, `${s.davon_vollstaendig} vollständig`].join(TRENNER)
          : null;
      out.push({ art: 'zusammenfassung', schluessel, titel, kacheln, zaehlung });
    } else if (schluessel === 'verbrauch_je_messstelle') {
      const zeilen = a.werte.map((w) => mitHeute(wertZahl(w, kopf), w.name_zum_datenstand));
      out.push({
        art: 'messstellen',
        schluessel,
        titel,
        vergleiche: kopf.vergleichszeitraeume.map(
          (v) => `${VERGLEICH_WORT[v.art] ?? v.art} ${periodeText(v.art === 'vorjahr' ? 'jahr' : 'monat', v.schluessel)}: ${v.ergebnis}`,
        ),
        zeilen,
        gruppen: gruppiereZahlen(a.werte, zeilen),
      });
    } else if (schluessel === 'tagesverlauf' && a.tagesverlauf !== undefined) {
      const zeilen = tagesverlaufZeilen(a);
      out.push({ art: 'tagesverlauf', schluessel, titel, leer: zeilen.length === 0 ? KEIN_TAGESVERLAUF : null, zeilen });
    } else if (schluessel === 'kennzahlen') {
      out.push({
        art: 'kennzahlen',
        schluessel,
        titel,
        leer: a.kennzahlen.length === 0 ? KEINE_KENNZAHLEN : null,
        zeilen: a.kennzahlen.map((k) => mitHeute(kennzahlZahl(k, kopf), k.name_zum_datenstand)),
      });
    } else if (schluessel === 'qualitaet') {
      const q = a.qualitaet;
      out.push({
        art: 'qualitaet',
        schluessel,
        titel,
        zeilen: [
          { name: QUALITAET_WORT.abdeckung, wert: zahl(dezimal(q.abdeckung_min_prozent), PROZENT, null) },
          { name: QUALITAET_WORT.luecken, wert: String(q.luecken) },
          { name: QUALITAET_WORT.ersatzwerte, wert: String(q.ersatzwerte) },
          { name: QUALITAET_WORT.korrekturen, wert: String(q.korrekturen_im_zeitraum) },
          { name: QUALITAET_WORT.vorlaeufig, wert: String(q.vorlaeufig) },
        ],
        korrekturen: (q.korrekturen ?? []).map((k) =>
          [`${B.anlass(k.kennung)} an ${k.reihe}`, `freigegeben ${zeitText(k.freigegeben, kopf.zeitraum.zone)} von ${k.wer}`, k.warum].join(TRENNER),
        ),
      });
    } else if (schluessel === 'quellenverzeichnis') {
      const zeilen = kopf.quellenverzeichnis.map((kennzeichen): QuellenEintrag => {
        const werte = a.werte.filter((w) => w.quelle === kennzeichen);
        const kz = a.kennzahlen.find((k) => k.quelle === kennzeichen);
        const eingang = a.kennzahlen.flatMap((k) => k.eingaenge).find((e) => e.kennzeichen.split(' ')[0] === kennzeichen);
        const name = werte[0]?.name_zum_datenstand ?? kz?.name_zum_datenstand ?? null;
        const version = werte.length > 0 ? Math.max(...werte.map((w) => w.version)) : (kz?.version ?? null);
        const stand =
          version !== null
            ? `${UEMS_VERSION} ${version}`
            : eingang?.fassung !== undefined
              ? `${UEMS_FASSUNG} ${eingang.fassung}`
              : eingang?.stichtag !== undefined
                ? `Stichtag ${datumText(eingang.stichtag)}`
                : null;
        return {
          kennzeichen,
          name,
          heute: name === null ? null : heuteHinweis(heuteName, kennzeichen, name),
          stand,
          sprung: kennzeichenSprung(kennzeichen, { periode: kopf.zeitraum.schluessel, version }),
        };
      });
      out.push({ art: 'quellen', schluessel, titel, anzahl: QUELLEN_ANZAHL(zeilen.length), zeilen });
    } else {
      // Monatswerte, Standorte, Kostenstellen — und Tagesverlauf in einem Abzug nach 1.0/1.1 — fehlen im Abzug.
      ohneInhalt.push(schluessel);
    }
  }
  return { abschnitte: out, ohneInhalt };
};

// ------------------------------------------------------------------ Verlauf der Stände

export interface VerlaufZeile {
  nr: number;
  titel: string;
  zeile: string;
  /** „Anlass Korrektur K-2026-0007“ — nur an einer Revision. */
  anlass: string | null;
  /** „ersetzt durch Nr. 2 (16.11.2026)“ oder `null` für den gültigen Stand. */
  ersetzt: string | null;
  /** Offene und verworfene Anstöße an diesem Stand (R5). */
  anstoesse: string[];
}

const anstossSatz = (a: BerichtAnstoss): string | null => {
  if (a.zustand === 'offen') return B.revisionNoetig(B.anlass(a.anlass_kennung));
  if (a.zustand === 'verworfen') return B.anstossVerworfen(a.verworfen_begruendung ?? '');
  return null;
};

/** Der Verlauf, der neueste zuerst: „Nr. 2 · Anlass …“, „Nr. 1 · ersetzt durch Nr. 2 (16.11.2026)“ (§5.3). */
export const verlaufDerStaende = (detail: BerichtDetail): VerlaufZeile[] => {
  const zone = detail.bericht.zeitzone;
  return [...detail.staende]
    .sort((a, b) => b.nr - a.nr)
    .map((s) => {
      const anlass = detail.anstoesse.find((a) => a.id === s.anlass_anstoss_id);
      const nachfolger = s.ersetzt_durch_nr === null ? null : detail.staende.find((x) => x.nr === s.ersetzt_durch_nr) ?? null;
      return {
        nr: s.nr,
        titel: B.berichtsstand(s.nr),
        zeile: [
          `${UEMS_DATENSTAND} ${zeitText(s.datenstand, zone)}`,
          `freigegeben ${zeitText(s.freigegeben_am, zone)} von ${s.freigegeben_von.name}`,
        ].join(TRENNER),
        anlass: anlass ? `Anlass ${B.anlass(anlass.anlass_kennung)}` : null,
        ersetzt: nachfolger ? B.ersetztDurch(nachfolger.nr, nachfolger.freigegeben_am, zone) : null,
        anstoesse: detail.anstoesse
          .filter((a) => a.nr === s.nr)
          .map(anstossSatz)
          .filter((t): t is string => t !== null),
      };
    });
};

// ------------------------------------------------------------------ PDF und CSV (IP-10, IP-11)

export type Ausgabe = 'pdf' | 'csv';

/**
 * Welche Ausgabe schon ein Ziel hat. Eine Schaltfläche erscheint erst, wenn ihr Ziel eingehängt ist (Captain
 * 14.09.2026, Telefon-Leiste): CSV hängt AP-12 IP-10 ein (`GET …/staende/{nr}/csv`), PDF IP-11
 * (`GET …/staende/{nr}/pdf`) — jeweils hier auf `true` und mit dem Aufruf in `BerichtSeite`.
 */
export const AUSGABE_EINGEHAENGT: Readonly<Record<Ausgabe, boolean>> = { pdf: false, csv: false };

export interface AusgabeKnopf {
  handlung: Ausgabe;
  text: string;
  /** Die Rechte-Kennung der Handlung (G1, `uemsBericht.kennung`). */
  recht: string;
  /** §5.4 — `bericht-BR-2026-0001-nr1.pdf`. */
  datei: string;
}

const AUSGABE_TEXT: Record<Ausgabe, string> = { pdf: 'PDF', csv: 'CSV' };

/**
 * Die Knöpfe PDF und CSV: nur an einem Stand (EW4 — ein Entwurf ist nie eine Datei), nur mit Recht, nur mit Ziel.
 * `darf` antwortet je Kennung `true`, `false` oder `null` (unbekannt) — nur `true` zeigt einen Knopf.
 */
export const ausgabeKnoepfe = (
  bericht: Pick<Bericht, 'kennung' | 'geltung_art'>,
  ansicht: Ansicht | null,
  darf: (recht: string) => boolean | null,
  eingehaengt: Readonly<Record<Ausgabe, boolean>> = AUSGABE_EINGEHAENGT,
): AusgabeKnopf[] => {
  if (ansicht === null || ansicht.art !== 'stand') return [];
  const nr = ansicht.stand.nr;
  return (['pdf', 'csv'] as const)
    .map((handlung) => ({
      handlung,
      text: AUSGABE_TEXT[handlung],
      recht: B.kennung(handlung, bericht.geltung_art),
      datei: `bericht-${bericht.kennung}-nr${nr}.${handlung}`,
    }))
    .filter((k) => eingehaengt[k.handlung] && darf(k.recht) === true);
};

/**
 * Was die Seite über Rechte sicher weiß: sie hat den Bericht über eine Route gelesen, die `abrufen` prüft (G2) —
 * also darf die Person abrufen (und damit PDF, G1). Alles andere (CSV = `export.*`) ist unbekannt, bis IP-10 es sagt.
 */
export const darfNachLesen =
  (bericht: Pick<Bericht, 'geltung_art'>) =>
  (recht: string): boolean | null =>
    recht === B.kennung('abrufen', bericht.geltung_art) ? true : null;

// ------------------------------------------------------------------ „heutigen Wert zeigen“ (§5.6)

/** Die Anfrage an `GET /api/v1/messstellen/{kennzeichen}/werte` für den Zeitraum des Berichts (Tage einschließlich). */
export const heuteAnfrage = (b: Pick<Bericht, 'zeitraum_art' | 'zeitraum' | 'zeitzone'>): { raster: 'monat' | 'jahr'; von: string; bis: string } => {
  const z = B.zeitraum(b.zeitraum_art, b.zeitraum, b.zeitzone);
  return { raster: b.zeitraum_art, von: z.erster_tag, bis: z.letzter_tag };
};

export type HeutigerWert = { art: 'wert' | 'ohne_zahl' | 'nicht_gespeichert' | 'fehler'; text: string };

/**
 * Was „heutigen Wert zeigen“ sagt: die heutige Zahl der Periode mit Version und Kennzeichen — oder, wenn die Zeilen
 * ihre Aufbewahrung überschritten haben (404 `wert_nicht_mehr_gespeichert`, B16), der Satz, der auf den Berichtsstand
 * verweist. Ein Stand ist nie „falsch“, weil die heutige Zahl anders ist.
 */
export const heutigerWert = (
  ergebnis: { antwort: MessstelleWerte } | { fehler: unknown },
  b: Pick<Bericht, 'zeitraum_art' | 'zeitraum' | 'zeitzone'>,
  stand: { nr: number; freigegeben_am: string } | null,
): HeutigerWert => {
  if ('fehler' in ergebnis) {
    const e = ergebnis.fehler;
    const code = e instanceof ApiError ? (e.body as { code?: unknown } | undefined)?.code : undefined;
    if (e instanceof ApiError && e.status === 404 && code === 'wert_nicht_mehr_gespeichert') {
      return { art: 'nicht_gespeichert', text: B.wertNichtMehrGespeichert({ art: b.zeitraum_art, schluessel: b.zeitraum }, stand, b.zeitzone) };
    }
    return { art: 'fehler', text: HEUTIGER_WERT_FEHLER };
  }
  const a = ergebnis.antwort;
  const w = a.werte[0];
  if (!w || w.zustand === null || w.menge === null) return { art: 'ohne_zahl', text: `heute: ${OHNE_ZAHL}` };
  let mengeText: string;
  try {
    mengeText = menge(w.menge, a.messstelle.einheit, a.raster);
  } catch {
    return { art: 'ohne_zahl', text: `heute: ${OHNE_ZAHL}` };
  }
  const teile = [mengeText, w.zustand, ...(w.version !== null ? [`${UEMS_VERSION} ${w.version}`] : []), ...w.kennzeichen];
  return { art: 'wert', text: `heute: ${teile.join(TRENNER)}` };
};
