/**
 * Die Wiedervorlage des Energiemanagements als Arbeitsliste und der Block „Was steht an“ der Übersicht
 * (UEMS AP-19 IP-21/IP-24; Konzept Wiedervorlage w1, Captain-Freigabe 05.10.2026).
 *
 * Fristen, Lage und Reihenfolge leitet der Server beim Abruf ab (`GET /api/v1/energiemanagement/wiedervorlage`,
 * Operation `wiedervorlage`); hier wird keine Frist gerechnet (WV2). Dieses Modul macht aus den Zeilen der Route
 * Einträge (ein Gegenstand, ein Eintrag: zehn Anstöße an einem Bericht sind eine Aufgabe), gibt jedem Eintrag Aufgabe,
 * Grund, Bereich, Zuständig und genau einen Schritt, ordnet nach Dringlichkeit und bündelt für die Übersicht gleiche
 * Arbeit (gleiche Art). Ein Schritt öffnet das Objekt mit offenem Entscheid (`entscheid.ts`); abgehakt wird nichts.
 * Reines Modul: kein React, kein Netz.
 */
import type { IconName } from '../designsystem/components/core/Icon';
import type { EnergiemanagementVerzeichnis } from './api';
import { UNTERNEHMEN_GRUPPEN } from './ebenenNav';
import { artFilterSprung, entscheidSprung, seitenSprung, type Sprung } from './entscheid';
import { DOKUMENT_ART_KLASSE, satz } from './energiemanagement';
import {
  UEMS_BERICHT,
  UEMS_BEZUGSBASIS,
  UEMS_EINGETRAGEN_VON,
  UEMS_ENTSCHIEDEN_VON,
  UEMS_ENERGIEZIEL,
  UEMS_MASSNAHME,
  UEMS_WIEDERVORLAGE_SATZ,
} from './glossar';
import {
  abweichungRoute,
  auditRoute,
  berichtRoute,
  dokumentRoute,
  energiemanagementRoute,
  energiezielRoute,
  feststellungRoute,
  kennzahlRoute,
  managementbewertungRoute,
  massnahmeRoute,
  pageRoute,
  type Route,
} from './nav';

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

/** Eine Zeile: die Ausgabe der Operation `wiedervorlage`; `id`/`kennzahl_id` tragen den Sprung (WV3). */
export type WiedervorlageZeile = {
  art: WiedervorlageArt;
  kennzeichen: string;
  titel: string;
  faellig_am: string;
  /** Abruf − fällig am: positiv = abgelaufen, 0 = heute, negativ = Vorschau. */
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
  /**
   * Additiv (Folge AP-19 IP-24): MG7 mit Herkunft, auch außerhalb des Vorschau-Fensters, gerechnet an derselben Stelle
   * wie die Zeile `managementbewertung`; `null` ohne freigegebene Managementbewertung mit Sitzung.
   */
  naechste_managementbewertung?: NaechsteManagementbewertung | null;
};

/** MG7: fällig am = Tag der letzten Sitzung (`sitzung_am`) der Managementbewertung `kennzeichen` + `rhythmus_monate`. */
export type NaechsteManagementbewertung = {
  faellig_am: string;
  kennzeichen: string;
  sitzung_am: string;
  rhythmus_monate: number;
};

// ------------------------------------------------------------------ Wörter

/** K8: der Titel des Blocks auf der Übersicht ist die Frage, die er beantwortet. */
export const WAS_STEHT_AN = 'Was steht an';
/** Der Sprung in die ganze Wiedervorlage; Link, Reiter und Seitentitel tragen dasselbe Wort. */
export const ZUR_WIEDERVORLAGE = 'Zur Wiedervorlage';
/** Unter dem Titel des Blocks: woher die Zeilen kommen. */
export const WAS_STEHT_AN_SATZ = 'Fristen aus Ihrem Energiemanagement';
export const KALENDER_ABZUG = 'Kalender-Abzug (.ics)';
/** E10, Folgen von Option A: die Termine veralten im Kalender des Kunden; der Hinweis sagt es, der Abzug trägt den Vermerk. */
export const KALENDER_ABZUG_HINWEIS =
  'Die Termine veralten in Ihrem Kalender, wenn sich eine Frist ändert; maßgeblich ist die Wiedervorlage im Portal.';
export const KALENDER_ABZUG_FEHLER = 'Der Kalender-Abzug ließ sich gerade nicht laden. Bitte versuchen Sie es noch einmal.';

/** Der Kopf der Wiedervorlage: was die Seite ist und von wann die Fristen stammen. */
export const kopfSatz = (stand: string) => `${UEMS_WIEDERVORLAGE_SATZ}, das am längsten Überfällige zuerst. Stand ${stand}.`;
/** „Woher kommen diese Fristen?“: Festlegung und Rhythmus, erledigt durch eine Entscheidung am Objekt, keine Erinnerung. */
export const WOHER_SATZ =
  'VoltPilot leitet jede Frist aus Ihren Festlegungen ab: Überprüfungen im Rhythmus Ihrer Einstellung, internes Audit und Managementbewertung nach dem letzten Termin, Maßnahmen und Energieziele mit ihrem Termin. Erledigt ist eine Frist, sobald die Entscheidung am Objekt festgehalten ist. VoltPilot verschickt keine Erinnerungen.';
export const NOCH_KEINE_FRISTEN =
  'Noch keine Fristen. Sie entstehen, sobald Sie zum Beispiel eine Bezugsbasis freigeben, ein Dokument festhalten oder ein internes Audit durchführen.';
export const LADEFEHLER_TITEL = 'Wiedervorlage nicht geladen';
export const LADEFEHLER = 'Die Fristen ließen sich gerade nicht laden. Ihre Daten sind nicht betroffen.';
export const ERNEUT_VERSUCHEN = 'Erneut versuchen';
/** Rolle „Einsicht“: Liste und Kalender-Abzug ja, Schritte nein. */
export const NUR_EINSICHT = 'Sie sehen alle Fristen. Erledigen können sie die Zuständigen.';
export const ZULETZT_FEHLER = 'Was zuletzt erledigt wurde, ließ sich gerade nicht laden.';
export const ANSEHEN = 'Ansehen';
export const ALLE = 'Alle';
export const BEREICH_ALLE = 'Bereich: alle';
export const UEBERFAELLIG_ORDNUNG = 'am längsten überfällig zuerst';
/** Am Eintrag ohne Person: die Route nennt am Objekt niemanden (wer laut Aufgabe zuständig ist, kommt mit PR2). */
export const OHNE_PERSON = 'ohne Person am Objekt';

export const markeUeberfaellig = (n: number) => `${n} überfällig`;
export const markeBald = (n: number, tage: number) => `${n} in den nächsten ${tage} Tagen`;
export const abschnittBald = (tage: number) => `In den nächsten ${tage} Tagen`;
export const nichtsBald = (bis: string) => `Bis ${bis} ist nichts fällig.`;
export const danachSatz = (n: number) => (n === 1 ? 'Danach steht eine weitere Frist an.' : `Danach stehen ${n} weitere Fristen an.`);
export const weitereAufgaben = (n: number) => (n === 1 ? 'Eine weitere Aufgabe in der Wiedervorlage' : `${n} weitere Aufgaben in der Wiedervorlage`);

// ------------------------------------------------------------------ Tage (nur Darstellung, keine Frist-Rechnung)

/** `2029-02-12T08:00+01:00` → `12.02.2029`: der Tag des Abrufs, wie der Server ihn stellt. */
export function standTag(stichtag: string): string {
  const [j, m, t] = stichtag.slice(0, 10).split('-');
  return `${t}.${m}.${j}`;
}

/** Ein Kalendertag plus n Tage (das Ende des Vorschau-Fensters und der Rückblick), ohne Zeitzone. */
function tagPlus(iso: string, tage: number): string {
  const [j, m, t] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(j, m - 1, t + tage)).toISOString().slice(0, 10);
}

/** §5.8 „Kalender-Abzug“ (WV4): „Stand vom 12.02.2029 aus VoltPilot; maßgeblich ist die Wiedervorlage im Portal.“ */
export function kalenderVermerk(stichtag: string): string {
  const r = satz('kalender_abzug', { am: standTag(stichtag) });
  if (r.satz === undefined) throw new Error(`Satz nicht bildbar: ${r.fehler}`);
  return r.satz;
}

/**
 * Die Frist als Datum, nie als Tageszähler: links der Datumsblock („seit“ über „13.11.“ und „2027“), relativ nur nahe
 * am Heute („heute“, „morgen“, „in 16 Tagen“). Warnton nur, wenn sie abgelaufen ist.
 */
export type FristBild = {
  /** Das kleine Wort über dem Tag: „seit“, „heute“, „bis“. */
  wort: string;
  tag: string;
  jahr: string;
  /** Für Vorleser: „fällig seit 13.11.2027“, „heute fällig“, „fällig bis 28.02.2029“. */
  satz: string;
  relativ: string | null;
  ueberfaellig: boolean;
};

export function fristBild(faelligAm: string, tage: number): FristBild {
  const [j, m, t] = faelligAm.slice(0, 10).split('-');
  const datum = `${t}.${m}.${j}`;
  const teile = { tag: `${t}.${m}.`, jahr: j };
  if (tage > 0) return { ...teile, wort: 'seit', satz: `fällig seit ${datum}`, relativ: null, ueberfaellig: true };
  if (tage === 0) return { ...teile, wort: 'heute', satz: `heute fällig, ${datum}`, relativ: 'heute', ueberfaellig: false };
  return { ...teile, wort: 'bis', satz: `fällig bis ${datum}`, relativ: tage === -1 ? 'morgen' : `in ${-tage} Tagen`, ueberfaellig: false };
}

// ------------------------------------------------------------------ Bereich (dieselben Wörter und Zeichen wie die Navigation)

export type Bereich = 'messen' | 'auswerten' | 'verbessern' | 'nachweisen';
export const BEREICHE: readonly Bereich[] = ['messen', 'auswerten', 'verbessern', 'nachweisen'];

export function bereichBild(b: Bereich): { wort: string; icon: IconName } {
  const g = UNTERNEHMEN_GRUPPEN.find((x) => x.key === b);
  return { wort: g?.label ?? b, icon: g?.icon ?? 'list' };
}

// ------------------------------------------------------------------ Je Art: Aufgabe, Grund, Bereich, Schritt

/** WV3: die Art einer Zeile als Kundenwort, der Gegenstand (Einzahl). */
export const ART_WORT: Record<WiedervorlageArt, string> = {
  dokument_ueberpruefung: 'Dokument',
  internes_audit: 'Internes Audit',
  managementbewertung: 'Managementbewertung',
  feststellung: 'Feststellung',
  bewertung_ueberpruefung: 'Energetische Bewertung',
  bezugsbasis_ueberpruefung: 'Bezugsbasis',
  energieziel_bewertung: 'Energieziel',
  massnahme_termin: 'Maßnahme',
  abweichung_frist: 'Abweichung',
  messbedarf_frist: 'Messbedarf',
  bericht_anstoss: 'Bericht',
};

/** Die Menge im Kundenwort (Statuszeile): Einzahl und Mehrzahl. */
const ART_MENGE: Record<WiedervorlageArt, [string, string]> = {
  dokument_ueberpruefung: ['Dokument', 'Dokumente'],
  internes_audit: ['internes Audit', 'interne Audits'],
  managementbewertung: ['Managementbewertung', 'Managementbewertungen'],
  feststellung: ['Feststellung', 'Feststellungen'],
  bewertung_ueberpruefung: ['energetische Bewertung', 'energetische Bewertungen'],
  bezugsbasis_ueberpruefung: ['Bezugsbasis', 'Bezugsbasen'],
  energieziel_bewertung: ['Energieziel', 'Energieziele'],
  massnahme_termin: ['Maßnahme', 'Maßnahmen'],
  abweichung_frist: ['Abweichung', 'Abweichungen'],
  messbedarf_frist: ['Messbedarf', 'Messbedarfe'],
  bericht_anstoss: ['Bericht', 'Berichte'],
};

const ART_BEREICH: Record<WiedervorlageArt, Bereich> = {
  dokument_ueberpruefung: 'nachweisen',
  internes_audit: 'nachweisen',
  managementbewertung: 'nachweisen',
  feststellung: 'nachweisen',
  bericht_anstoss: 'nachweisen',
  bewertung_ueberpruefung: 'auswerten',
  bezugsbasis_ueberpruefung: 'auswerten',
  massnahme_termin: 'verbessern',
  energieziel_bewertung: 'verbessern',
  abweichung_frist: 'verbessern',
  messbedarf_frist: 'messen',
};

/** Der eine Schritt je Art; er öffnet das Objekt mit dem offenen Entscheid. */
export const SCHRITT: Record<WiedervorlageArt, string> = {
  dokument_ueberpruefung: 'Bestätigen oder neu fassen',
  internes_audit: 'Audit planen',
  managementbewertung: 'Managementbewertung anlegen',
  feststellung: 'Wirksamkeit prüfen',
  bewertung_ueberpruefung: 'Neuen Stand freigeben',
  bezugsbasis_ueberpruefung: 'Bestätigen oder neu fassen',
  energieziel_bewertung: 'Bewerten',
  massnahme_termin: 'Umsetzung melden',
  abweichung_frist: 'Abschließen',
  messbedarf_frist: 'Messstelle anlegen',
  bericht_anstoss: 'Entwurf vergleichen',
};

// Die Titel der Route (die Quellen bilden sie, `WiedervorlageBestand.java` u. a.); die Kennzeichen stehen am Objekt.
const DOKUMENT_TITEL = /\s+[—-]\s+Überprüfung$/;
const ANSTOSS_TITEL = /^(.*?)\s+[—-]\s+Revision angestoßen \(([^)]+)\)$/;
const BEZUGSBASIS_TITEL = /, Fassung (\d+)\s+[—-]\s+Überprüfung \((Freigabe|geprüft, bleibt) (\d{2}\.\d{2}\.\d{4}) \+ (\d+) Monate\)$/;

const dokumentGegenstand = (z: WiedervorlageZeile) => z.titel.replace(DOKUMENT_TITEL, '').trim() || ART_WORT[z.art];
const berichtName = (z: WiedervorlageZeile) => ANSTOSS_TITEL.exec(z.titel)?.[1] ?? `${UEMS_BERICHT} ${z.kennzeichen}`;
const anlass = (z: WiedervorlageZeile) => ANSTOSS_TITEL.exec(z.titel)?.[2] ?? null;

function bezugsbasisHerleitung(z: WiedervorlageZeile): string | null {
  const m = BEZUGSBASIS_TITEL.exec(z.titel);
  if (!m) return null;
  const [, fassung, beginn, tag, monate] = m;
  return beginn === 'Freigabe' ? `Fassung ${fassung} vom ${tag} + ${monate} Monate` : `„geprüft, bleibt“ am ${tag} + ${monate} Monate`;
}

const STAND_BLEIBT = 'Der freigegebene Stand bleibt, bis Sie entscheiden.';

/** Aufgabe mit Verb: Gegenstand plus überprüfen, neu freigeben, durchführen, abhalten, bewerten, klären, einrichten. */
function aufgabe(z: WiedervorlageZeile): string {
  const { titel } = z;
  switch (z.art) {
    case 'dokument_ueberpruefung':
      return `${dokumentGegenstand(z)} überprüfen`;
    case 'internes_audit':
      return 'Internes Audit durchführen';
    case 'managementbewertung':
      return 'Managementbewertung abhalten';
    case 'feststellung':
      return `Feststellung ${z.kennzeichen} klären`;
    case 'bewertung_ueberpruefung':
      return 'Energetische Bewertung überprüfen';
    case 'bezugsbasis_ueberpruefung':
      return `${UEMS_BEZUGSBASIS} ${z.kennzeichen} überprüfen`;
    case 'energieziel_bewertung':
      return `${UEMS_ENERGIEZIEL} ${z.kennzeichen} bewerten`;
    case 'massnahme_termin':
      return z.titel;
    case 'abweichung_frist':
      return `Abweichung ${z.kennzeichen} klären`;
    case 'messbedarf_frist':
      return `Messstelle für Messbedarf ${z.kennzeichen} einrichten`;
    case 'bericht_anstoss':
      return `${berichtName(z)} neu freigeben`;
    default:
      // Eine Art, die dieses Portal noch nicht kennt, steht mit dem Titel der Route.
      return titel;
  }
}

/** Grund: wofür das Objekt da ist und, wo die Route es sagt, woraus die Frist folgt. Kein Wort über Normerfüllung. */
function grund(zeilen: WiedervorlageZeile[], w: Wiedervorlage, kurz: boolean): string {
  const z = zeilen[0];
  const { kennzeichen } = z;
  switch (z.art) {
    case 'dokument_ueberpruefung':
      return `Vorgabe Ihres Energiemanagements (${z.kennzeichen})`;
    case 'internes_audit':
      return `Nach dem letzten internen Audit ${z.kennzeichen}, im Rhythmus Ihrer Einstellung`;
    case 'managementbewertung': {
      const n = w.naechste_managementbewertung;
      return n && n.kennzeichen === z.kennzeichen
        ? `Letzte Sitzung am ${standTag(n.sitzung_am)} (${n.kennzeichen}), alle ${n.rhythmus_monate} Monate`
        : `Nach der letzten Managementbewertung ${z.kennzeichen}`;
    }
    case 'feststellung':
      return 'Offen, bis ihre Wirksamkeit geprüft oder sie abgeschlossen ist';
    case 'bewertung_ueberpruefung':
      return `Grundlage der wesentlichen Energieeinsätze (${z.kennzeichen})`;
    case 'bezugsbasis_ueberpruefung': {
      const herleitung = bezugsbasisHerleitung(z);
      return herleitung ? `Vergleichsgrundlage einer Kennzahl · ${herleitung}` : 'Vergleichsgrundlage einer Kennzahl';
    }
    case 'energieziel_bewertung':
      return z.titel;
    case 'massnahme_termin':
      return `${UEMS_MASSNAHME} ${z.kennzeichen}`;
    case 'abweichung_frist':
      return `An der Kennzahl ${z.titel}`;
    case 'messbedarf_frist':
      return 'Aus der Messplanung der energetischen Bewertung';
    case 'bericht_anstoss': {
      const anlaesse = zeilen.map(anlass).filter((a): a is string => !!a);
      if (zeilen.length === 1) {
        const a = anlaesse[0];
        if (kurz) return a ? `Werte nach der Freigabe korrigiert (${a})` : 'Werte nach der Freigabe korrigiert';
        return a ? `Korrektur ${a} hat nach der Freigabe Werte geändert. ${STAND_BLEIBT}` : `Nach der Freigabe korrigiert. ${STAND_BLEIBT}`;
      }
      return kurz ? `${zeilen.length} Korrekturen nach der Freigabe` : `${zeilen.length} Korrekturen nach der Freigabe. ${STAND_BLEIBT}`;
    }
    default:
      return kennzeichen;
  }
}

/**
 * WV3: der Sprung einer Zeile auf ihre Seite: nur zu einer Seite, die es gibt, und nur mit der Kennung, die die Route
 * mitgibt. Bleibt für die Abschnitte der Managementbewertung; die Arbeitsliste springt über {@link eintragSprung}.
 */
export function wiedervorlageSprung(z: Pick<WiedervorlageZeile, 'art' | 'kennzeichen' | 'id' | 'kennzahl_id'>): Route | null {
  switch (z.art) {
    case 'dokument_ueberpruefung':
      return z.id ? dokumentRoute(z.id) : null;
    case 'internes_audit':
      return z.id ? auditRoute(z.id) : null;
    case 'feststellung':
      return z.id ? feststellungRoute(z.id) : null;
    case 'managementbewertung':
      return managementbewertungRoute(z.kennzeichen);
    case 'massnahme_termin':
      return z.id ? massnahmeRoute(z.id) : null;
    case 'energieziel_bewertung':
      return z.id ? energiezielRoute(z.id) : null;
    case 'abweichung_frist':
      return z.id ? abweichungRoute(z.id) : null;
    case 'bezugsbasis_ueberpruefung':
      return z.kennzahl_id ? kennzahlRoute(z.kennzahl_id) : null;
    case 'bewertung_ueberpruefung':
      return pageRoute('portfolio-bewertung');
    case 'bericht_anstoss':
      return berichtRoute(z.kennzeichen);
    default:
      return null;
  }
}

/**
 * Entscheid 8: der Schritt öffnet das Objekt dort, wo die Entscheidung fällt. Audit und Managementbewertung legt man
 * im Reiter neu an, der Messbedarf wird in der Messplanung eingelöst (sie trägt mehrere, daher das Kennzeichen).
 */
export function eintragSprung(z: Pick<WiedervorlageZeile, 'art' | 'kennzeichen' | 'id' | 'kennzahl_id'>): Sprung | null {
  switch (z.art) {
    case 'internes_audit':
      return entscheidSprung(energiemanagementRoute('audits'), z.art);
    case 'managementbewertung':
      return entscheidSprung(energiemanagementRoute('managementbewertung'), z.art);
    case 'messbedarf_frist':
      return entscheidSprung(pageRoute('portfolio-bewertung'), z.art, z.kennzeichen);
    default: {
      const ziel = wiedervorlageSprung(z);
      return ziel ? entscheidSprung(ziel, z.art) : null;
    }
  }
}

// ------------------------------------------------------------------ Eintrag und Arbeitsliste

export type Eintrag = {
  key: string;
  art: WiedervorlageArt;
  kennzeichen: string;
  aufgabe: string;
  grund: string;
  /** Der kurze Grund für die Übersicht (beim Bericht ohne den Satz zum freigegebenen Stand). */
  grundKurz: string;
  faellig_am: string;
  tage: number;
  frist: FristBild;
  bereich: Bereich;
  /** Die Person am Objekt, wie die Route sie nennt; `null`, wenn sie dort niemanden nennt. */
  verantwortlich: string | null;
  schritt: string;
  sprung: Sprung | null;
  /** So viele Zeilen der Route trägt der Eintrag (Anstöße an einem Bericht). */
  zeilen: number;
  /** Die Kennzahl einer Bezugsbasis (zählt die Kennzahlen eines Bündels). */
  kennzahlId: string | null;
};

export type Arbeitsliste = {
  stand: string;
  vorschauTage: number;
  /** Das Ende des Vorschau-Fensters: Abruf + Vorschau-Tage. */
  fensterBis: string;
  ueberfaellig: Eintrag[];
  bald: Eintrag[];
  /** Fristen nach dem Fenster; die Route nennt heute nur ihre Kennzeichen (`nicht_in_liste`). */
  spaeter: number;
  bereiche: Bereich[];
};

/** Ein Gegenstand, ein Eintrag: die Zeilen derselben Art und desselben Kennzeichens, in der Reihenfolge der Route. */
function eintraege(zeilen: WiedervorlageZeile[], w: Wiedervorlage): Eintrag[] {
  const gruppen = new Map<string, WiedervorlageZeile[]>();
  for (const z of zeilen) {
    const key = `${z.art}/${z.kennzeichen}`;
    const g = gruppen.get(key);
    if (g) g.push(z);
    else gruppen.set(key, [z]);
  }
  return [...gruppen.entries()].map(([key, g]) => {
    // Die Route ordnet nach „fällig am“: die erste Zeile ist die älteste, sie bestimmt den Tag des Eintrags.
    const z = g[0];
    return {
      key,
      art: z.art,
      kennzeichen: z.kennzeichen,
      aufgabe: aufgabe(z),
      grund: grund(g, w, false),
      grundKurz: grund(g, w, true),
      faellig_am: z.faellig_am,
      tage: z.tage,
      frist: fristBild(z.faellig_am, z.tage),
      bereich: ART_BEREICH[z.art] ?? 'nachweisen',
      verantwortlich: g.find((x) => x.verantwortlich)?.verantwortlich ?? null,
      schritt: SCHRITT[z.art] ?? ANSEHEN,
      sprung: eintragSprung(z),
      zeilen: g.length,
      kennzahlId: z.kennzahl_id,
    };
  });
}

/**
 * Die Arbeitsliste nach Dringlichkeit (Entscheid 3): überfällig (abgelaufen, das älteste zuerst), dann was in den
 * nächsten Tagen fällig wird (heute eingeschlossen). Lage und Reihenfolge sind die der Route.
 */
export function arbeitsliste(w: Wiedervorlage): Arbeitsliste {
  const alle = eintraege([...w.faellig, ...w.vorschau], w);
  const ueberfaellig = alle.filter((e) => e.tage > 0);
  const bald = alle.filter((e) => e.tage <= 0);
  return {
    stand: standTag(w.stichtag),
    vorschauTage: w.vorschau_tage,
    fensterBis: standTag(tagPlus(w.stichtag, w.vorschau_tage)),
    ueberfaellig,
    bald,
    spaeter: w.nicht_in_liste.length,
    bereiche: BEREICHE.filter((b) => alle.some((e) => e.bereich === b)),
  };
}

export type Filter = { art: WiedervorlageArt | null; bereich: Bereich | null };
export const OHNE_FILTER: Filter = { art: null, bereich: null };

export function gefiltert(liste: readonly Eintrag[], f: Filter): Eintrag[] {
  return liste.filter((e) => (!f.art || e.art === f.art) && (!f.bereich || e.bereich === f.bereich));
}

/** Ein Art-Filter aus der Adresse (`?art=`) gilt nur mit einem Wort aus dem Vokabular. */
export function artAusAdresse(wert: string | null): WiedervorlageArt | null {
  return wert && wert in ART_WORT ? (wert as WiedervorlageArt) : null;
}

/** Die Mehrzahl der Art als Filter-Wort („Bezugsbasen“), großgeschrieben. */
export function artFilterWort(art: WiedervorlageArt): string {
  const wort = ART_MENGE[art]?.[1] ?? art;
  return wort.charAt(0).toUpperCase() + wort.slice(1);
}

// ------------------------------------------------------------------ „Was steht an“ auf der Übersicht (Variante A)

export const WAS_STEHT_AN_ZEILEN = 4;
export const NAECHSTE_ZEILEN = 2;

export type Buendel = {
  key: string;
  art: WiedervorlageArt;
  aufgabe: string;
  grund: string;
  frist: FristBild;
  /** So viele Einträge trägt das Bündel. */
  anzahl: number;
  schritt: string;
  sprung: Sprung | null;
};

export type WasStehtAnBild = {
  ueberfaellig: number;
  bald: number;
  vorschauTage: number;
  fensterBis: string;
  spaeter: number;
  /** Bei Überfälligem: höchstens vier Bündel des Überfälligen; sonst die nächsten zwei Fristen. */
  zeilen: Buendel[];
  /** Bündel, die nicht mehr auf die Übersicht passen. */
  weitere: number;
};

function nameListe(namen: string[]): string {
  return namen.length <= 1 ? (namen[0] ?? '') : `${namen.slice(0, -1).join(', ')} und ${namen[namen.length - 1]}`;
}

/** Gleiche Arbeit (gleiche Art) in einer Zeile: „4 Bezugsbasen überprüfen“, „Energiepolitik und Anwendungsbereich überprüfen“. */
function buendelText(art: WiedervorlageArt, e: Eintrag[]): { aufgabe: string; grund: string } {
  const n = e.length;
  switch (art) {
    case 'dokument_ueberpruefung': {
      const namen = e.map((x) => x.aufgabe.replace(/ überprüfen$/, ''));
      return n === 2
        ? { aufgabe: `${nameListe(namen)} überprüfen`, grund: 'Vorgaben Ihres Energiemanagements' }
        : { aufgabe: `${n} Dokumente überprüfen`, grund: nameListe(namen) };
    }
    case 'bezugsbasis_ueberpruefung': {
      const ids = e.map((x) => x.kennzahlId);
      const k = ids.every((id) => id) ? new Set(ids).size : null;
      return {
        aufgabe: `${n} Bezugsbasen überprüfen`,
        grund: k === null ? nameListe(e.map((x) => x.kennzeichen)) : k === 1 ? 'Vergleichsgrundlagen einer Kennzahl' : `Vergleichsgrundlagen von ${k} Kennzahlen`,
      };
    }
    case 'massnahme_termin':
      return { aufgabe: `${n} Maßnahmen umsetzen`, grund: nameListe(e.map((x) => x.aufgabe)) };
    case 'energieziel_bewertung':
      return { aufgabe: `${n} Energieziele bewerten`, grund: nameListe(e.map((x) => x.kennzeichen)) };
    case 'abweichung_frist':
      return { aufgabe: `${n} Abweichungen klären`, grund: nameListe(e.map((x) => x.kennzeichen)) };
    case 'feststellung':
      return { aufgabe: `${n} Feststellungen klären`, grund: nameListe(e.map((x) => x.kennzeichen)) };
    case 'messbedarf_frist':
      return { aufgabe: `${n} Messstellen einrichten`, grund: `Messbedarfe ${nameListe(e.map((x) => x.kennzeichen))}` };
    case 'bericht_anstoss':
      return { aufgabe: `${n} Berichte neu freigeben`, grund: 'Werte nach der Freigabe korrigiert' };
    case 'bewertung_ueberpruefung':
      return { aufgabe: `${n} energetische Bewertungen überprüfen`, grund: nameListe(e.map((x) => x.kennzeichen)) };
    case 'internes_audit':
      return { aufgabe: `${n} interne Audits durchführen`, grund: nameListe(e.map((x) => x.kennzeichen)) };
    case 'managementbewertung':
      return { aufgabe: `${n} Managementbewertungen abhalten`, grund: nameListe(e.map((x) => x.kennzeichen)) };
    default:
      return { aufgabe: `${n} Fristen`, grund: nameListe(e.map((x) => x.kennzeichen)) };
  }
}

/** Bündel je Art, geordnet nach der ältesten Frist; ein Bündel aus einem Eintrag ist dieser Eintrag mit seinem Schritt. */
export function buendel(liste: readonly Eintrag[]): Buendel[] {
  const je = new Map<WiedervorlageArt, Eintrag[]>();
  for (const e of liste) {
    const g = je.get(e.art);
    if (g) g.push(e);
    else je.set(e.art, [e]);
  }
  return [...je.entries()].map(([art, e]) => {
    if (e.length === 1) {
      const x = e[0];
      return { key: x.key, art, aufgabe: x.aufgabe, grund: x.grundKurz, frist: x.frist, anzahl: 1, schritt: x.schritt, sprung: x.sprung };
    }
    return {
      key: `art/${art}`,
      art,
      ...buendelText(art, e),
      frist: e[0].frist,
      anzahl: e.length,
      schritt: ANSEHEN,
      sprung: artFilterSprung(energiemanagementRoute('wiedervorlage'), art),
    };
  });
}

/**
 * Das Bild des Blocks „Was steht an“: Marken zählen Einträge (Entscheid 4); bei Überfälligem höchstens vier Bündel des
 * Überfälligen (Variante A), sonst ruhig mit den nächsten Fristen. `null` ohne jede Frist: ohne Inhalt kein Block
 * (AP-13 E3); die Wiedervorlage selbst erklärt dann, woher Fristen kommen.
 */
export function wasStehtAn(w: Wiedervorlage | null): WasStehtAnBild | null {
  if (!w || (w.faellig.length === 0 && w.vorschau.length === 0 && w.nicht_in_liste.length === 0)) return null;
  const l = arbeitsliste(w);
  const alle = l.ueberfaellig.length > 0 ? buendel(l.ueberfaellig) : buendel(l.bald);
  const platz = l.ueberfaellig.length > 0 ? WAS_STEHT_AN_ZEILEN : NAECHSTE_ZEILEN;
  return {
    ueberfaellig: l.ueberfaellig.length,
    bald: l.bald.length,
    vorschauTage: l.vorschauTage,
    fensterBis: l.fensterBis,
    spaeter: l.spaeter,
    zeilen: alle.slice(0, platz),
    weitere: Math.max(0, alle.length - platz),
  };
}

// ------------------------------------------------------------------ Status-Eskalation (Entscheid 9)

/**
 * Für die Statuszeile der Übersicht (Status-Variante A des Portfolio-Konzepts): nur bei Überfälligem, sonst `null`.
 * Zählt Einträge, nennt die älteste Frist und die Arten in der Reihenfolge ihrer ältesten Frist.
 */
export type WiedervorlageStatus = {
  ueberfaellig: number;
  /** Die älteste Frist als Tag: „13.11.2027“. */
  aeltesteSeit: string;
  /** Die Arten im Kundenwort, älteste zuerst: „Bezugsbasen“, „Bericht“, „energetische Bewertung“, „Dokumente“. */
  arten: string[];
  bereiche: Bereich[];
  /** „8 Fristen überfällig“ */
  titel: string;
  /** „Älteste seit 13.11.2027 · Bezugsbasen, Bericht, energetische Bewertung, Dokumente“ */
  satz: string;
  sprung: Sprung;
};

export function wiedervorlageStatus(w: Wiedervorlage | null): WiedervorlageStatus | null {
  if (!w) return null;
  const l = arbeitsliste(w);
  const u = l.ueberfaellig;
  if (u.length === 0) return null;
  const arten = buendel(u).map((b) => (ART_MENGE[b.art] ?? [ART_WORT[b.art] ?? b.art, ART_WORT[b.art] ?? b.art])[b.anzahl === 1 ? 0 : 1]);
  const aeltesteSeit = standTag(u[0].faellig_am);
  return {
    ueberfaellig: u.length,
    aeltesteSeit,
    arten,
    bereiche: BEREICHE.filter((b) => u.some((e) => e.bereich === b)),
    titel: u.length === 1 ? '1 Frist überfällig' : `${u.length} Fristen überfällig`,
    satz: `Älteste seit ${aeltesteSeit} · ${arten.join(', ')}`,
    sprung: seitenSprung(energiemanagementRoute('wiedervorlage')),
  };
}

// ------------------------------------------------------------------ Zuletzt erledigt (aus dem Verzeichnis)

export const ZULETZT_TAGE = 90;
export const ZULETZT_ANZAHL = 5;

export type Erledigt = {
  key: string;
  am: string;
  tag: string;
  jahr: string;
  titel: string;
  wer: string | null;
};

/**
 * Was eine Frist beendet oder neu startet, so wie das Verzeichnis es festhält (Tag der Entscheidung): eine freigegebene
 * Fassung einer Vorgabe oder Bezugsbasis, ein abgeschlossenes Audit, eine festgehaltene Wirksamkeit, ein freigegebener
 * Stand der energetischen Bewertung oder Managementbewertung, ein neuer Stand eines Berichts nach einer Korrektur, eine
 * bewertete Maßnahme oder ein bewertetes Energieziel, eine abgeschlossene Abweichung. Alles andere zählt nicht.
 */
function erledigtTitel(gruppe: string, z: { art: string; kennzeichen: string; titel: string; nr: number | null }): string | null {
  const nr = z.nr;
  if (DOKUMENT_ART_KLASSE[z.art] === 'vorgabe') return nr ? `${z.titel}: Fassung ${nr} freigegeben` : `${z.titel} freigegeben`;
  switch (z.art) {
    case 'internes_audit':
      return `Internes Audit ${z.kennzeichen} abgeschlossen`;
    case 'wirksamkeit':
      return `Feststellung ${z.kennzeichen}: Wirksamkeit festgehalten`;
    case 'bezugsbasis_fassung':
      return nr ? `${UEMS_BEZUGSBASIS} ${z.kennzeichen}: Fassung ${nr} freigegeben` : null;
    case 'energieziel_bewertung':
      return `${UEMS_ENERGIEZIEL} ${z.kennzeichen} bewertet`;
    case 'massnahme_bewertung':
      return `${UEMS_MASSNAHME} ${z.kennzeichen} bewertet`;
    case 'abweichung_abschluss':
      return `Abweichung ${z.kennzeichen} abgeschlossen`;
    case 'berichtsstand':
      if (!nr) return null;
      if (gruppe === 'managementbewertung') return `${z.titel}: Stand Nr. ${nr} freigegeben`;
      if (gruppe === 'bewertung_messplanung') return `Energetische Bewertung ${z.kennzeichen}: Stand Nr. ${nr} freigegeben`;
      // Ein Bericht hat seine Frist erst nach einer Korrektur; erledigt ist sie mit dem nächsten Stand.
      return nr > 1 ? `${UEMS_BERICHT} ${z.kennzeichen}: Stand Nr. ${nr} freigegeben` : null;
    default:
      return null;
  }
}

/** Zuletzt erledigt: die letzten Entscheidungen der letzten 90 Tage bis zum Stichtag, die jüngste zuerst. */
export function zuletztErledigt(v: EnergiemanagementVerzeichnis, stichtag: string = v.stichtag): Erledigt[] {
  const bis = stichtag.slice(0, 10);
  const ab = tagPlus(bis, -ZULETZT_TAGE);
  const aus: Erledigt[] = [];
  for (const g of v.gruppen) {
    for (const z of g.zeilen) {
      if (!z.tag || z.tag > bis || z.tag < ab) continue;
      const titel = erledigtTitel(g.gruppe, z);
      if (!titel) continue;
      const [j, m, t] = z.tag.split('-');
      const wer = z.entschieden_von
        ? `${UEMS_ENTSCHIEDEN_VON} ${z.entschieden_von}`
        : z.eingetragen_von
          ? `${UEMS_EINGETRAGEN_VON} ${z.eingetragen_von}`
          : null;
      aus.push({ key: `${g.gruppe}/${z.art}/${z.kennzeichen}/${z.nr ?? ''}`, am: z.tag, tag: `${t}.${m}.`, jahr: j, titel, wer });
    }
  }
  return aus.sort((a, b) => (a.am < b.am ? 1 : a.am > b.am ? -1 : a.titel.localeCompare(b.titel))).slice(0, ZULETZT_ANZAHL);
}
