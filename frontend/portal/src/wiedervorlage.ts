/**
 * Die Wiedervorlage des Energiemanagements als Arbeitsliste und der Block „Was steht an“ der Übersicht
 * (UEMS AP-19 IP-21/IP-24; Konzept Wiedervorlage w1, Captain-Freigabe 05.10.2026).
 *
 * Fristen, Lage und Reihenfolge leitet der Server beim Abruf ab (`GET /api/v1/energiemanagement/wiedervorlage`,
 * Operation `wiedervorlage`, Vertrag 1.1 mit dem Jahresplan `spaeter`, 1.2 mit der Zählerablesung); hier wird keine
 * Frist gerechnet (WV2). Dieses Modul macht aus den Zeilen der Route Einträge (ein Gegenstand, ein Eintrag: die
 * Korrekturen an einem Bericht sind eine Aufgabe, die Zähler einer Ablese-Runde auch), gibt jedem Eintrag Aufgabe,
 * Grund (aus der Herleitung der Route), Bereich, Zuständig und genau einen
 * Schritt, ordnet nach Dringlichkeit, gruppiert den Jahresplan nach Monaten und bündelt für die Übersicht gleiche
 * Arbeit (gleiche Art). Ein Schritt öffnet das Objekt mit offenem Entscheid (`entscheid.ts`); abgehakt wird nichts.
 * Reines Modul: kein React, kein Netz.
 */
import type { IconName } from '../designsystem/components/core/Icon';
import { UNTERNEHMEN_GRUPPEN } from './ebenenNav';
import { artFilterSprung, entscheidSprung, seitenSprung, type Sprung } from './entscheid';
import { DOKUMENT_ART_KLASSE, jahresplanBis, satz, WOERTER } from './energiemanagement';
import {
  UEMS_BERICHT,
  UEMS_BEZUGSBASIS,
  UEMS_EINGETRAGEN_VON,
  UEMS_ENTSCHIEDEN_VON,
  UEMS_ENERGIEZIEL,
  UEMS_GEPLANTE_MESSSTELLE,
  UEMS_JAHRESPLAN,
  UEMS_LAUT_AUFGABE,
  UEMS_MASSNAHME,
  UEMS_WIEDERVORLAGE_SATZ,
} from './glossar';
import { herkunftWort, quelleWort } from './managementbewertung';
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
  messstelleRoute,
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
  | 'bericht_anstoss'
  | 'zaehlerablesung';

/** Woran die Regel einer Frist ansetzt (Vertrag 1.1, `wiedervorlage_basis`; 1.2: die Zählerablesung). */
export type WiedervorlageBasis =
  | 'freigabe'
  | 'geprueft_bleibt'
  | 'durchgefuehrt'
  | 'sitzung'
  | 'erkannt'
  | 'festgestellt'
  | 'termin'
  | 'zielperiode'
  | 'abgelesen'
  | 'ablesebeginn';

/**
 * Woraus eine Frist folgt, als Angaben der Route (keine Sätze): `am` der Tag, an dem die Regel ansetzt; `fassung` die
 * Fassung bzw. der Stand Nr., `monate` der Rhythmus, `kennung` das Objekt, an dem die Regel ansetzt, oder die Herkunft,
 * `quelle_art` die Herkunft einer Maßnahme bzw. die Quelle einer Feststellung, `anzahl` die Korrekturen eines Berichts
 * oder die Zähler einer Ablese-Runde.
 */
export type WiedervorlageHerleitung = {
  basis: WiedervorlageBasis;
  am: string | null;
  fassung: number | null;
  monate: number | null;
  kennung: string | null;
  quelle_art: string | null;
  anzahl: number | null;
};

/** Wer die Frist erledigt: die Person am Objekt oder die der Aufgabe im Energiemanagement; `ich` = die angemeldete. */
export type Zustaendig = { name: string; herkunft: 'objekt' | 'aufgabe'; ich: boolean };

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
  /** Vertrag 1.1: woraus die Frist folgt; `null`, wo die Quelle es nicht nennt. */
  herleitung: WiedervorlageHerleitung | null;
  /** Der Gegenstand, wo der Titel ihn nicht trägt: die Kennzahl einer Bezugsbasis, der Bericht, ein Wortlaut, der Ort einer Ablesung. */
  bezug: string | null;
  /** Der Energieeinsatz eines Messbedarfs: dort wird die Messstelle eingerichtet. */
  einsatz_id: string | null;
  /** Die Aufgabe im Energiemanagement (Vokabular `aufgabe`), zu der diese Art Frist gehört; auch ohne Person. */
  aufgabe: string | null;
  /** Die Person am Objekt oder laut Aufgabe; `null`, wo niemand festgelegt ist. */
  zustaendig: Zustaendig | null;
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
  /** Vertrag 1.1: der Jahresplan, nach dem Fenster bis Abruf + 12 Monate, nach Tag und Kennzeichen. */
  spaeter: WiedervorlageZeile[];
  /** Abgelaufen (`tage` > 0); zählt Zeilen, und eine Zeile ist ein Gegenstand. */
  anzahl_ueberfaellig: number;
  /** Heute fällig und das Vorschau-Fenster. */
  anzahl_naechste: number;
  anzahl_spaeter: number;
  /**
   * Die angemeldete Person liest die Aufgaben im Energiemanagement (unternehmensweit). Sonst kennt die Route nur die
   * Person am Objekt, und eine Zeile ohne sie heißt nicht, dass niemand zuständig ist.
   */
  aufgaben_lesbar: boolean;
};

/**
 * „Zuletzt erledigt“ (`GET …/wiedervorlage/zuletzt`): eine Entscheidung, die eine Frist beendet oder neu begonnen hat.
 * `art` ist die Art der Verzeichnis-Zeile (`gruppe` ihre Gruppe) oder `dokument_geprueft_bleibt` bzw.
 * `bezugsbasis_geprueft_bleibt`; `nr` Fassung bzw. Stand Nr.
 */
export type WiedervorlageErledigt = {
  art: string;
  gruppe: string | null;
  kennzeichen: string;
  titel: string;
  nr: number | null;
  am: string;
  entschieden_von: string | null;
  eingetragen_von: string | null;
};

export type WiedervorlageZuletzt = { stichtag: string; tage: number; eintraege: WiedervorlageErledigt[] };

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
/**
 * „Woher kommen diese Fristen?“: Festlegung und Rhythmus, erledigt durch eine Entscheidung oder eine Ablesung am
 * Objekt, keine Erinnerung. Die Zählerablesung (Vertrag 1.2) folgt der Regel des Registers: zwei Monate nach der
 * letzten Ablesung.
 */
export const WOHER_SATZ =
  'VoltPilot leitet jede Frist aus Ihren Festlegungen ab: Überprüfungen im Rhythmus Ihrer Einstellung, internes Audit und Managementbewertung nach dem letzten Termin, Maßnahmen und Energieziele mit ihrem Termin, Zählerablesungen zwei Monate nach der letzten Ablesung. Erledigt ist eine Frist, sobald die Entscheidung oder die Ablesung am Objekt festgehalten ist. VoltPilot verschickt keine Erinnerungen.';
export const NOCH_KEINE_FRISTEN =
  'Noch keine Fristen. Sie entstehen, sobald Sie zum Beispiel eine Bezugsbasis freigeben, ein Dokument festhalten oder ein internes Audit durchführen.';
export const LADEFEHLER_TITEL = 'Wiedervorlage nicht geladen';
export const LADEFEHLER = 'Die Fristen ließen sich gerade nicht laden. Ihre Daten sind nicht betroffen.';
export const ERNEUT_VERSUCHEN = 'Erneut versuchen';
/** Rolle „Einsicht“: Liste und Kalender-Abzug ja, Schritte nein. */
export const NUR_EINSICHT = 'Sie sehen alle Fristen. Erledigen können sie die Zuständigen.';
export const ZULETZT_FEHLER = 'Was zuletzt erledigt wurde, ließ sich gerade nicht laden.';
export const ANSEHEN = 'Ansehen';
/** Der Schritt im Jahresplan: noch nichts zu entscheiden, das Objekt lässt sich ansehen. */
export const OEFFNEN = 'Öffnen';
export const ALLE = 'Alle';
/** Filter für die Arbeitsteilung: was der angemeldeten Person zugeordnet ist, was niemandem. */
export const MEINE = 'Meine';
export const OHNE_ZUSTAENDIGE = 'Ohne Zuständige';
export const BEREICH_ALLE = 'Bereich: alle';
export const UEBERFAELLIG_ORDNUNG = 'am längsten überfällig zuerst';
/** Am Eintrag ohne Person: weder das Objekt noch seine Aufgabe im Energiemanagement nennt jemanden. */
export const NIEMAND_ZUSTAENDIG = 'Niemand zuständig';
export const AUFGABE_FESTLEGEN = 'Aufgabe festlegen';
export const JAHRESPLAN_ANZEIGEN = `${UEMS_JAHRESPLAN} anzeigen`;
export const JAHRESPLAN_ZUKLAPPEN = `${UEMS_JAHRESPLAN} zuklappen`;

export const markeUeberfaellig = (n: number) => `${n} überfällig`;
export const markeBald = (n: number, tage: number) => `${n} in den nächsten ${tage} Tagen`;
export const markeJahresplan = (n: number) => `${n} im ${UEMS_JAHRESPLAN}`;
export const abschnittBald = (tage: number) => `In den nächsten ${tage} Tagen`;
export const nichtsBald = (bis: string) => `Bis ${bis} ist nichts fällig.`;
export const naechsteFrist = (tag: string) => `Die nächste Frist ist am ${tag}.`;
export const jahresplanSatz = (tage: number) => `Alle Fristen nach den nächsten ${tage} Tagen, nach Monaten`;
export const weitereAufgaben = (n: number) => (n === 1 ? 'Eine weitere Aufgabe in der Wiedervorlage' : `${n} weitere Aufgaben in der Wiedervorlage`);
/** „laut Aufgabe „Dokumente des Energiemanagements pflegen““: woher die Person kommt, wenn das Objekt keine nennt. */
export const lautAufgabe = (aufgabe: string | null) =>
  aufgabe ? `${UEMS_LAUT_AUFGABE} „${WOERTER.aufgabe[aufgabe] ?? aufgabe}“` : UEMS_LAUT_AUFGABE;

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

export function fristBild(faelligAm: string, tage: number, art: WiedervorlageArt | null = null): FristBild {
  const [j, m, t] = faelligAm.slice(0, 10).split('-');
  const datum = `${t}.${m}.${j}`;
  const teile = { tag: `${t}.${m}.`, jahr: j };
  if (tage > 0) return { ...teile, wort: 'seit', satz: `fällig seit ${datum}`, relativ: null, ueberfaellig: true };
  if (tage === 0) return { ...teile, wort: 'heute', satz: `heute fällig, ${datum}`, relativ: 'heute', ueberfaellig: false };
  const relativ = tage === -1 ? 'morgen' : `in ${-tage} Tagen`;
  // Ein Energieziel wird mit dem Ende seiner Zielperiode bewertbar (F1): das Datum ist ein „ab“, kein „bis“.
  if (art === 'energieziel_bewertung') return { ...teile, wort: 'ab', satz: `bewertbar ab ${datum}`, relativ, ueberfaellig: false };
  return { ...teile, wort: 'bis', satz: `fällig bis ${datum}`, relativ, ueberfaellig: false };
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
  zaehlerablesung: 'Zählerablesung',
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
  zaehlerablesung: ['Zählerablesung', 'Zählerablesungen'],
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
  zaehlerablesung: 'messen',
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
  zaehlerablesung: 'Ablesungen eintragen',
};

/** Der Knopf an der Messstelle (`Ablesungen.tsx`): bei einem Zähler heißt der Schritt genau so. */
export const ABLESUNG_EINTRAGEN = 'Ablesung eintragen';
/** Woher die Werte einer Ablese-Runde kommen, wie das Register es sagt (`messstellen.ts`, Quelle „Ablesungen“). */
const ABLESUNG_QUELLE = 'Werte aus Ablesungen';

// Die Titel der Route (die Quellen bilden sie, `WiedervorlageBestand.java` u. a.); die Kennzeichen stehen am Objekt.
// Seit Vertrag 1.1 tragen `bezug` und `herleitung` den Gegenstand und die Herleitung; die Titel bleiben, wie sie in
// freigegebenen Managementbewertungen stehen, und dienen nur noch dem Namen eines Dokuments.
const DOKUMENT_TITEL = /\s+[—-]\s+Überprüfung$/;
const ANSTOSS_TITEL = /^(.*?)\s+[—-]\s+Revision angestoßen \(([^)]+)\)$/;

const dokumentGegenstand = (z: WiedervorlageZeile) => z.titel.replace(DOKUMENT_TITEL, '').trim() || ART_WORT[z.art];
const berichtName = (z: WiedervorlageZeile) => z.bezug ?? ANSTOSS_TITEL.exec(z.titel)?.[1] ?? `${UEMS_BERICHT} ${z.kennzeichen}`;

const STAND_BLEIBT = 'Der freigegebene Stand bleibt, bis Sie entscheiden.';
const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/** Aufgabe mit Verb: Gegenstand plus überprüfen, neu freigeben, durchführen, abhalten, bewerten, klären, einrichten, ablesen. */
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
    case 'zaehlerablesung': {
      // Eine Ablese-Runde je Ort: „8 Zähler in Halle 1 ablesen“, bei einem Zähler „Zähler MS-22 in Verwaltung ablesen“.
      const ort = z.bezug ? ` in ${z.bezug}` : '';
      const n = z.herleitung?.anzahl ?? 1;
      if (n > 1) return `${n} Zähler${ort} ablesen`;
      return z.herleitung?.kennung ? `Zähler ${z.herleitung.kennung}${ort} ablesen` : titel;
    }
    default:
      // Eine Art, die dieses Portal noch nicht kennt, steht mit dem Titel der Route.
      return titel;
  }
}

const tagWort = (iso: string | null) => (iso ? standTag(iso) : null);

/**
 * Ein Rhythmus in Monaten: Zahl und Einheit brechen nie auseinander (geschütztes Leerzeichen vor der Einheit, AP-08
 * E11); „+ 2 Monate“ hinter einem Tag bricht nur als Ganzes um, nie „+ 2“ am Zeilenende und „Monate“ darunter.
 */
const monateText = (n: number) => `${n}\u00a0Monate`;
const plusMonate = (n: number | null) => (n ? ` +\u00a0${monateText(n)}` : '');

/**
 * Woraus die Frist folgt, in Wörtern aus der Herleitung der Route: „Fassung 2 vom 13.11.2026 + 12 Monate“,
 * „„geprüft, bleibt“ am 10.12.2027 + 12 Monate“, „Stand Nr. 1 vom 24.11.2027 + 12 Monate“. Ohne Herleitung `null`.
 */
function ansatz(h: WiedervorlageHerleitung | null): string | null {
  if (!h) return null;
  const am = tagWort(h.am);
  const plus = plusMonate(h.monate);
  if (!am) return null;
  if (h.basis === 'geprueft_bleibt') return `„geprüft, bleibt“ am ${am}${plus}`;
  if (h.basis === 'freigabe') return h.fassung ? `Fassung ${h.fassung} vom ${am}${plus}` : `Freigabe am ${am}${plus}`;
  return null;
}

/**
 * Woraus die Frist einer Ablese-Runde folgt: „Zuletzt abgelesen am 01.10.2026 + 2 Monate“; ohne Ablesung „Noch keine
 * Ablesung, vorgesehen seit 15.11.2026“ (das Register sagt dort „Noch keine Ablesung“).
 */
function ablesungAnsatz(h: WiedervorlageHerleitung | null): string | null {
  const am = tagWort(h?.am ?? null);
  if (!h || !am) return null;
  if (h.basis === 'abgelesen') return `Zuletzt abgelesen am ${am}${plusMonate(h.monate)}`;
  if (h.basis === 'ablesebeginn') return `Noch keine Ablesung, vorgesehen seit ${am}`;
  return null;
}

/** Die Feststellung kommt aus …: „aus dem internen Audit AU-2029-0001“, „selbst festgestellt“. */
function feststellungHerkunft(h: WiedervorlageHerleitung): string | null {
  if (!h.quelle_art) return null;
  if (h.quelle_art === 'internes_audit') return h.kennung ? herkunftWort('audit', h.kennung) : quelleWort(h.quelle_art);
  if (h.quelle_art === 'managementbewertung') return h.kennung ? herkunftWort('managementbewertung', h.kennung) : quelleWort(h.quelle_art);
  return quelleWort(h.quelle_art);
}

/** Woher eine Maßnahme kommt: „aus dem internen Audit AU-2029-0001“, „aus der Managementbewertung BR-2029-0001 (Beschluss 2)“. */
function massnahmeHerkunft(h: WiedervorlageHerleitung): string | null {
  if (!h.quelle_art) return null;
  if (h.quelle_art === 'managementbewertung' && h.kennung?.includes('/')) {
    const [br, b] = h.kennung.split('/');
    return `${herkunftWort('managementbewertung', br)} (Beschluss ${b.replace(/^B/, '')})`;
  }
  return herkunftWort(h.quelle_art, h.kennung);
}

const mitPunkt = (...teile: (string | null | undefined)[]) => teile.filter(Boolean).join(' · ');

/**
 * Grund: wofür das Objekt da ist und woraus die Frist folgt (Herleitung der Route). Kein Wort über Normerfüllung.
 * `kurz` ist der Grund der Übersicht (beim Bericht ohne den Satz zum freigegebenen Stand).
 */
function grund(zeilen: WiedervorlageZeile[], w: Wiedervorlage, kurz: boolean): string {
  const z = zeilen[0];
  const h = z.herleitung;
  switch (z.art) {
    case 'dokument_ueberpruefung':
      return mitPunkt(`Vorgabe Ihres Energiemanagements (${z.kennzeichen})`, ansatz(h));
    case 'internes_audit':
      return h?.am
        ? mitPunkt(`Zuletzt ${h.kennung ?? z.kennzeichen} am ${standTag(h.am)}`, h.monate ? `alle ${monateText(h.monate)}` : null)
        : `Nach dem letzten internen Audit ${z.kennzeichen}, im Rhythmus Ihrer Einstellung`;
    case 'managementbewertung': {
      if (h?.am) return mitPunkt(`Letzte Sitzung am ${standTag(h.am)} (${h.kennung ?? z.kennzeichen})`, h.monate ? `alle ${monateText(h.monate)}` : null);
      const n = w.naechste_managementbewertung;
      return n && n.kennzeichen === z.kennzeichen
        ? `Letzte Sitzung am ${standTag(n.sitzung_am)} (${n.kennzeichen}) · alle ${monateText(n.rhythmus_monate)}`
        : `Nach der letzten Managementbewertung ${z.kennzeichen}`;
    }
    case 'feststellung':
      return h
        ? mitPunkt(z.bezug, feststellungHerkunft(h), h.am ? `festgestellt am ${standTag(h.am)}` : null)
        : 'Offen, bis ihre Wirksamkeit geprüft oder sie abgeschlossen ist';
    case 'bewertung_ueberpruefung':
      return mitPunkt('Grundlage der wesentlichen Energieeinsätze', h?.am ? `Stand Nr. ${h.fassung ?? 1} vom ${standTag(h.am)}${plusMonate(h.monate)}` : null);
    case 'bezugsbasis_ueberpruefung':
      return mitPunkt(z.bezug ? `Grundlage für „${z.bezug}“` : 'Vergleichsgrundlage einer Kennzahl', ansatz(h));
    case 'energieziel_bewertung': {
      if (h?.basis !== 'zielperiode' || !h.am) return z.titel;
      const ende = standTag(h.am);
      return z.tage > 0
        ? `Zielperiode bis ${ende}`
        : `Zielperiode bis ${ende} · bewertbar, sobald ${MONATE[Number(h.am.slice(5, 7)) - 1]} endgültig ist`;
    }
    case 'massnahme_termin':
      return mitPunkt(`${UEMS_MASSNAHME} ${z.kennzeichen}`, h ? massnahmeHerkunft(h) : null);
    case 'abweichung_frist':
      return `An der Kennzahl ${z.bezug ?? z.titel}`;
    case 'messbedarf_frist':
      return z.bezug ?? `${UEMS_GEPLANTE_MESSSTELLE.charAt(0).toUpperCase()}${UEMS_GEPLANTE_MESSSTELLE.slice(1)} unter Messen`;
    case 'bericht_anstoss': {
      // Seit Vertrag 1.1 ist ein Bericht EINE Zeile ab der ersten Korrektur; ältere Zeilen kamen je Korrektur.
      const anzahl = h?.anzahl ?? zeilen.length;
      const erste = h?.kennung ?? ANSTOSS_TITEL.exec(z.titel)?.[2] ?? null;
      if (anzahl === 1) {
        if (kurz) return erste ? `Werte nach der Freigabe korrigiert (${erste})` : 'Werte nach der Freigabe korrigiert';
        return erste ? `Korrektur ${erste} hat nach der Freigabe Werte geändert. ${STAND_BLEIBT}` : `Nach der Freigabe korrigiert. ${STAND_BLEIBT}`;
      }
      const korrekturen = erste ? `${anzahl} Korrekturen nach der Freigabe, zuerst ${erste}` : `${anzahl} Korrekturen nach der Freigabe`;
      return kurz ? `${anzahl} Korrekturen nach der Freigabe` : `${korrekturen}. ${STAND_BLEIBT}`;
    }
    case 'zaehlerablesung':
      // Ohne Herleitung nur, woher die Werte kommen; ein Tag wird nie geraten.
      return ablesungAnsatz(h) ?? ABLESUNG_QUELLE;
    default:
      return z.kennzeichen;
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
    case 'zaehlerablesung':
      // Ohne die Zahl der Zähler ist `id` nicht sicher eine Messstelle: das Register (den Ort setzt {@link eintragSprung}).
      return pageRoute('portfolio-messstellen');
    default:
      return null;
  }
}

/**
 * Entscheid 8: der Schritt öffnet das Objekt dort, wo die Entscheidung fällt. Audit und Managementbewertung legt man
 * im Reiter neu an; der Messbedarf wird an seinem Energieeinsatz eingelöst (dort steht „Messstelle einrichten“), ohne
 * Einsatz in der Messplanung der Bewertung (sie trägt mehrere, daher das Kennzeichen). Eine Ablesung trägt man an der
 * Messstelle ein: bei einem Zähler direkt dort, bei mehreren in der Ablese-Runde ihres Orts (`?ablesen=G-1`, Konzept
 * Messen m1 §6.5 Variante 3A) - das erste offene Feld der Runde trägt den Entscheid.
 */
export function eintragSprung(
  z: Pick<WiedervorlageZeile, 'art' | 'kennzeichen' | 'id' | 'kennzahl_id'> &
    Partial<Pick<WiedervorlageZeile, 'einsatz_id' | 'herleitung'>>,
): Sprung | null {
  switch (z.art) {
    case 'internes_audit':
      return entscheidSprung(energiemanagementRoute('audits'), z.art);
    case 'managementbewertung':
      return entscheidSprung(energiemanagementRoute('managementbewertung'), z.art);
    case 'messbedarf_frist':
      // Konzept Auswerten a1, Entscheid 9: ein offener Messbedarf steht unter Messen als geplante Messstelle - der Schritt
      // „Messstelle anlegen“ öffnet die Liste bei ihm („Einrichten“), nicht mehr den Energieeinsatz.
      return entscheidSprung(pageRoute('portfolio-messstellen'), z.art, z.kennzeichen);
    case 'zaehlerablesung':
      return z.herleitung?.anzahl === 1 && z.id
        ? entscheidSprung(messstelleRoute(z.id), z.art)
        : entscheidSprung(pageRoute('portfolio-messstellen'), z.art, null, { ablesen: z.kennzeichen });
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
  /** Die Person am Objekt oder laut Aufgabe; `null`, wenn niemand festgelegt ist. */
  zustaendig: Zustaendig | null;
  /** Die Aufgabe im Energiemanagement, zu der die Frist gehört: ihr Wort hinter „laut Aufgabe“, ihr Sprung ohne Person. */
  aufgabeIm: string | null;
  schritt: string;
  sprung: Sprung | null;
  /** So viele Zeilen der Route trägt der Eintrag (ältere Server: je Anstoß eine Zeile). */
  zeilen: number;
  /** Die Kennzahl einer Bezugsbasis (zählt die Kennzahlen eines Bündels). */
  kennzahlId: string | null;
  /** Der Gegenstand der Route (`bezug`): bei einer Ablese-Runde ihr Ort. */
  bezug: string | null;
  /** Die Zähler einer Ablese-Runde (zählt die Zähler eines Bündels); sonst `null`. */
  zaehler: number | null;
};

export type Arbeitsliste = {
  stand: string;
  vorschauTage: number;
  /** Das Ende des Vorschau-Fensters: Abruf + Vorschau-Tage. */
  fensterBis: string;
  ueberfaellig: Eintrag[];
  bald: Eintrag[];
  /** Der Jahresplan: die Fristen nach dem Fenster bis Abruf + 12 Monate (Vertrag 1.1, `spaeter`). */
  jahresplan: Eintrag[];
  /** Das Ende des Jahresplans als Tag: „30.04.2030“. */
  jahresplanBis: string;
  bereiche: Bereich[];
  /** Nur dann ist „ohne Person“ ein „Niemand zuständig“ (sonst weiß die Route es nicht). */
  aufgabenLesbar: boolean;
};

/**
 * Zuständig, wie die Route es sagt; nennt eine Zeile nur `verantwortlich` (ein Leser vor Vertrag 1.1), ist das die
 * Person am Objekt. Ohne beides: `null`.
 */
function zustaendigAus(zeilen: WiedervorlageZeile[]): Zustaendig | null {
  const mit = zeilen.find((x) => x.zustaendig)?.zustaendig;
  if (mit) return mit;
  const name = zeilen.find((x) => x.verantwortlich)?.verantwortlich;
  return name ? { name, herkunft: 'objekt', ich: false } : null;
}

/**
 * Ein Gegenstand, ein Eintrag: die Zeilen derselben Art und desselben Kennzeichens, in der Reihenfolge der Route. Eine
 * Ablese-Runde ist Ort UND Tag: derselbe Ort kann an zwei Tagen fällig sein (Vertrag 1.2), das sind zwei Einträge.
 */
function eintraege(zeilen: WiedervorlageZeile[], w: Wiedervorlage): Eintrag[] {
  const gruppen = new Map<string, WiedervorlageZeile[]>();
  for (const z of zeilen) {
    const key = z.art === 'zaehlerablesung' ? `${z.art}/${z.kennzeichen}/${z.faellig_am}` : `${z.art}/${z.kennzeichen}`;
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
      frist: fristBild(z.faellig_am, z.tage, z.art),
      bereich: ART_BEREICH[z.art] ?? 'nachweisen',
      zustaendig: zustaendigAus(g),
      aufgabeIm: z.aufgabe,
      schritt: z.art === 'zaehlerablesung' && z.herleitung?.anzahl === 1 ? ABLESUNG_EINTRAGEN : (SCHRITT[z.art] ?? ANSEHEN),
      sprung: eintragSprung(z),
      zeilen: g.length,
      kennzahlId: z.kennzahl_id,
      bezug: z.bezug,
      zaehler: z.art === 'zaehlerablesung' ? (z.herleitung?.anzahl ?? 1) : null,
    };
  });
}

/**
 * Die Arbeitsliste nach Dringlichkeit (Entscheid 3): überfällig (abgelaufen, das älteste zuerst), dann was in den
 * nächsten Tagen fällig wird (heute eingeschlossen), dann der Jahresplan. Lage und Reihenfolge sind die der Route.
 */
export function arbeitsliste(w: Wiedervorlage): Arbeitsliste {
  const alle = eintraege([...w.faellig, ...w.vorschau], w);
  const jahresplan = eintraege(w.spaeter ?? [], w);
  const ueberfaellig = alle.filter((e) => e.tage > 0);
  const bald = alle.filter((e) => e.tage <= 0);
  return {
    stand: standTag(w.stichtag),
    vorschauTage: w.vorschau_tage,
    fensterBis: standTag(tagPlus(w.stichtag, w.vorschau_tage)),
    ueberfaellig,
    bald,
    jahresplan,
    jahresplanBis: standTag(jahresplanBis(w.stichtag.slice(0, 10))),
    bereiche: BEREICHE.filter((b) => [...alle, ...jahresplan].some((e) => e.bereich === b)),
    aufgabenLesbar: w.aufgaben_lesbar === true,
  };
}

/** Wer: alle, die der angemeldeten Person zugeordneten („Meine“) oder die ohne Person („Ohne Zuständige“). */
export type WerFilter = 'alle' | 'meine' | 'ohne';
export type Filter = { art: WiedervorlageArt | null; bereich: Bereich | null; wer: WerFilter };
export const OHNE_FILTER: Filter = { art: null, bereich: null, wer: 'alle' };

export function gefiltert(liste: readonly Eintrag[], f: Filter): Eintrag[] {
  return liste.filter(
    (e) =>
      (!f.art || e.art === f.art) &&
      (!f.bereich || e.bereich === f.bereich) &&
      (f.wer === 'alle' || (f.wer === 'meine' ? e.zustaendig?.ich === true : e.zustaendig === null)),
  );
}

/** Der Sprung „Aufgabe festlegen“: die Aufgaben im Energiemanagement mit genau dieser Aufgabe im Blick. */
export function aufgabeFestlegenSprung(aufgabeIm: string): Sprung {
  return entscheidSprung(energiemanagementRoute('aufgaben'), 'aufgabe_festlegen', aufgabeIm);
}

// ------------------------------------------------------------------ Jahresplan nach Monaten

export type MonatsGruppe = { key: string; titel: string; eintraege: Eintrag[] };

/**
 * Der Jahresplan nach Monaten: aufeinanderfolgende Monate desselben Jahres mit Fristen stehen unter einer Überschrift
 * („Juni 2029“, „November und Dezember 2029“, „Januar bis April 2030“); ein Monat ohne Frist und ein Jahreswechsel
 * trennen. Die Einträge kommen in der Reihenfolge der Route (nach Tag).
 */
export function jahresplanGruppen(liste: readonly Eintrag[]): MonatsGruppe[] {
  const gruppen: { jahr: number; von: number; bis: number; eintraege: Eintrag[] }[] = [];
  for (const e of liste) {
    const jahr = Number(e.faellig_am.slice(0, 4));
    const monat = Number(e.faellig_am.slice(5, 7));
    const g = gruppen[gruppen.length - 1];
    if (g && g.jahr === jahr && (monat === g.bis || monat === g.bis + 1)) {
      g.bis = monat;
      g.eintraege.push(e);
    } else {
      gruppen.push({ jahr, von: monat, bis: monat, eintraege: [e] });
    }
  }
  return gruppen.map((g) => {
    const von = MONATE[g.von - 1];
    const bis = MONATE[g.bis - 1];
    const titel = g.von === g.bis ? `${von} ${g.jahr}` : g.bis === g.von + 1 ? `${von} und ${bis} ${g.jahr}` : `${von} bis ${bis} ${g.jahr}`;
    return { key: `${g.jahr}-${g.von}`, titel, eintraege: g.eintraege };
  });
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
  /** Einträge im Jahresplan (nach dem Fenster bis Abruf + 12 Monate). */
  spaeter: number;
  /** Bei Überfälligem: höchstens vier Bündel des Überfälligen; sonst die nächsten zwei Fristen, auch aus dem Jahresplan. */
  zeilen: Buendel[];
  /** Bündel des Überfälligen, die nicht mehr auf die Übersicht passen. */
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
    case 'zaehlerablesung': {
      // Die Runden zählen ihre Zähler: „10 Zähler ablesen“ in „Halle 1, Halle 2 und Verwaltung“.
      const zaehler = e.reduce((summe, x) => summe + (x.zaehler ?? 1), 0);
      const orte = [...new Set(e.map((x) => x.bezug ?? x.kennzeichen))];
      return orte.length === 1
        ? { aufgabe: `${zaehler} Zähler in ${orte[0]} ablesen`, grund: e[0].grundKurz }
        : { aufgabe: `${zaehler} Zähler ablesen`, grund: nameListe(orte) };
    }
    default:
      return { aufgabe: `${n} Fristen`, grund: nameListe(e.map((x) => x.kennzeichen)) };
  }
}

/**
 * Bündel je Art, geordnet nach der ältesten Frist; ein Bündel aus einem Eintrag ist dieser Eintrag mit seinem Schritt.
 * `jeMonat` bündelt nur innerhalb eines Monats (die nächsten Fristen aus dem Jahresplan: „2 Maßnahmen umsetzen“ am
 * selben Termin, nicht dieselbe Art über ein ganzes Jahr).
 */
export function buendel(liste: readonly Eintrag[], jeMonat = false): Buendel[] {
  const je = new Map<string, Eintrag[]>();
  for (const e of liste) {
    const key = jeMonat ? `${e.art}/${e.faellig_am.slice(0, 7)}` : e.art;
    const g = je.get(key);
    if (g) g.push(e);
    else je.set(key, [e]);
  }
  return [...je.entries()].map(([key, e]) => {
    const art = e[0].art;
    if (e.length === 1) {
      const x = e[0];
      return { key: x.key, art, aufgabe: x.aufgabe, grund: x.grundKurz, frist: x.frist, anzahl: 1, schritt: x.schritt, sprung: x.sprung };
    }
    return {
      key: `art/${key}`,
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
 * Überfälligen (Variante A), sonst ruhig mit den nächsten zwei Fristen, auch aus dem Jahresplan („30.06.2029 · 2
 * Maßnahmen umsetzen“). `null` ohne jede Frist: ohne Inhalt kein Block (AP-13 E3); die Wiedervorlage selbst erklärt
 * dann, woher Fristen kommen.
 */
export function wasStehtAn(w: Wiedervorlage | null): WasStehtAnBild | null {
  if (!w || (w.faellig.length === 0 && w.vorschau.length === 0 && w.nicht_in_liste.length === 0)) return null;
  const l = arbeitsliste(w);
  const ueber = l.ueberfaellig.length > 0;
  const alle = ueber ? buendel(l.ueberfaellig) : [...buendel(l.bald), ...buendel(l.jahresplan, true)];
  const platz = ueber ? WAS_STEHT_AN_ZEILEN : NAECHSTE_ZEILEN;
  return {
    ueberfaellig: l.ueberfaellig.length,
    bald: l.bald.length,
    vorschauTage: l.vorschauTage,
    fensterBis: l.fensterBis,
    spaeter: l.jahresplan.length,
    zeilen: alle.slice(0, platz),
    weitere: ueber ? Math.max(0, alle.length - platz) : 0,
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

// ------------------------------------------------------------------ Zuletzt erledigt (`GET …/wiedervorlage/zuletzt`)

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
 * Was eine Frist beendet oder neu startet, als Satz (Tag der Entscheidung): eine freigegebene Fassung einer Vorgabe
 * oder Bezugsbasis, „geprüft, bleibt“ an einem Dokument oder einer Bezugsbasis, ein abgeschlossenes Audit, eine
 * festgehaltene Wirksamkeit, ein freigegebener Stand der energetischen Bewertung oder Managementbewertung, ein neuer
 * Stand eines Berichts nach einer Korrektur, eine bewertete Maßnahme oder ein bewertetes Energieziel, eine
 * abgeschlossene Abweichung. Welche Zeilen dazugehören, entscheidet der Server; eine unbekannte Art steht mit ihrem Titel.
 */
function erledigtTitel(z: WiedervorlageErledigt): string {
  const nr = z.nr;
  if (DOKUMENT_ART_KLASSE[z.art] === 'vorgabe') return nr ? `${z.titel}: Fassung ${nr} freigegeben` : `${z.titel} freigegeben`;
  switch (z.art) {
    case 'dokument_geprueft_bleibt':
      return `${z.titel}: geprüft, bleibt`;
    case 'bezugsbasis_geprueft_bleibt':
      return `${UEMS_BEZUGSBASIS} ${z.kennzeichen}: geprüft, bleibt`;
    case 'internes_audit':
      return `Internes Audit ${z.kennzeichen} abgeschlossen`;
    case 'wirksamkeit':
      return `Feststellung ${z.kennzeichen}: Wirksamkeit festgehalten`;
    case 'bezugsbasis_fassung':
      return nr ? `${UEMS_BEZUGSBASIS} ${z.kennzeichen}: Fassung ${nr} freigegeben` : `${UEMS_BEZUGSBASIS} ${z.kennzeichen} freigegeben`;
    case 'energieziel_bewertung':
      return `${UEMS_ENERGIEZIEL} ${z.kennzeichen} bewertet`;
    case 'massnahme_bewertung':
      return `${UEMS_MASSNAHME} ${z.kennzeichen} bewertet`;
    case 'abweichung_abschluss':
      return `Abweichung ${z.kennzeichen} abgeschlossen`;
    case 'berichtsstand':
      if (z.gruppe === 'managementbewertung') return nr ? `${z.titel}: Stand Nr. ${nr} freigegeben` : `${z.titel} freigegeben`;
      if (z.gruppe === 'bewertung_messplanung') return `Energetische Bewertung ${z.kennzeichen}: Stand Nr. ${nr ?? 1} freigegeben`;
      return `${UEMS_BERICHT} ${z.kennzeichen}: Stand Nr. ${nr ?? 1} freigegeben`;
    default:
      return z.titel;
  }
}

/** Zuletzt erledigt: die Entscheidungen der Route (90 Tage bis zum Abruf, die jüngste zuerst) als Zeilen mit Tag und Person. */
export function zuletztErledigt(z: WiedervorlageZuletzt): Erledigt[] {
  return z.eintraege.slice(0, ZULETZT_ANZAHL).map((x) => {
    const [j, m, t] = x.am.slice(0, 10).split('-');
    const wer = x.entschieden_von
      ? `${UEMS_ENTSCHIEDEN_VON} ${x.entschieden_von}`
      : x.eingetragen_von
        ? `${UEMS_EINGETRAGEN_VON} ${x.eingetragen_von}`
        : null;
    return { key: `${x.gruppe ?? ''}/${x.art}/${x.kennzeichen}/${x.nr ?? ''}/${x.am}`, am: x.am, tag: `${t}.${m}.`, jahr: j, titel: erledigtTitel(x), wer };
  });
}
