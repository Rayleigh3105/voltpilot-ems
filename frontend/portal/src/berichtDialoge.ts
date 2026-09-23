import { darfInListen } from './rollen';
/**
 * Die Dialoge der Welt „Berichte“ (UEMS AP-12 IP-14, §5.1–§5.3) als reine Ableitung: „Bericht anlegen“,
 * „Berichtsstand freigeben“, der Vergleich Entwurf gegen Berichtsstand, „Anstoß verwerfen“ und das Banner
 * „Revision nötig“.
 *
 * Die REGELN spricht der Zwilling `uemsBericht.ts` gegen `bericht-vectors.json`: Zeitraum (V1), Freigabe-Voraussetzungen
 * mit ihren Kundensätzen (F1, B4), Abweichungen (R1, B2), Anlass und Kennzeichen. Dieses Modul setzt ihre Ergebnisse in
 * das, was ein Dialog zeigt — es erfindet keine zweite Prüfung und keinen eigenen Satz über dieselbe Lage.
 *
 * RECHTE kommen aus der Selbstauskunft (`GET /api/v1/me`: `standorte[].rechte`, `unternehmen_rechte`) über die Kennungen
 * von `uemsBericht.kennung` (G1). Ist sie nicht zu haben (`null`), bleibt der Hebel geschlossen. Wer eine Handlung nicht darf, sieht ihren Hebel nicht (§5.4, §5.5: nicht
 * „ausgegraut mit Erklärung“, sondern gar nicht da).
 *
 * REIN: kein Netz, kein Zustand, keine Uhr (wer „jetzt“ braucht, bekommt es übergeben).
 */

import { ApiError } from './api';
import type {
  Bericht,
  BerichtAbweichung,
  BerichtAnlegen,
  BerichtDetail,
  BerichtEntwurf,
  BerichtStandKurz,
  Kennzahl,
  Selbstauskunft,
  StandortAmStichtag,
  Unternehmen,
} from './api';
import { abzugAus, GELTUNG_WORT, gueltigerStand, MENGE_ART_WORT, type Abzug } from './berichtSeite';
import katalog from './berichte/bericht-vorlagen.json';
import { iso } from './bezugsPeriode';
import { UEMS_BERICHTSSTAND, UEMS_BERICHTSVORLAGE, UEMS_DATENSTAND, UEMS_ENTWURF, UEMS_FASSUNG, UEMS_REVISION } from './glossar';
import * as B from './uemsBericht';
import { OHNE_ZAHL, TRENNER, uhr, zahlMitStellen } from './uemsErgebnis';
import { einheitWort, VERGLEICH_NACHKOMMASTELLEN, VORLAEUFIG } from './uemsKennzahl';
import { datumText } from './uemsOrtsbaum';

/** Die Zone, wenn die Geltung keine trägt — die der Referenzdatei und der Vektoren. */
export const ZONE_VORGABE = 'Europe/Berlin';

// ------------------------------------------------------------------ Wörter

export const ANLEGEN_KNOPF = 'Bericht anlegen';
export const ANLEGEN_TITEL = 'Bericht anlegen';
export const ANLEGEN = 'Anlegen';
export const ABBRECHEN = 'Abbrechen';
export const SCHLIESSEN = 'Schließen';
export const VORLAGE_TITEL = UEMS_BERICHTSVORLAGE;
export const GELTUNG_TITEL = 'Geltung';
export const ZEITRAUM_TITEL = 'Zeitraum';
export const KENNZAHLEN_TITEL = 'Kennzahlen';
export const KENNZAHLEN_HINWEIS = 'Alle sind gewählt — eine abgewählte Kennzahl fehlt im Bericht.';
export const KENNZAHLEN_KEINE = 'Für diese Geltung gibt es keine Kennzahl.';
export const KENNZAHLEN_LADEFEHLER = 'Die Kennzahlen konnten nicht geladen werden — der Bericht enthält dann alle.';
export const ARCHIVIERTE_KENNZAHL = 'archiviert';
export const VORAUSSETZUNGEN_TITEL = 'Voraussetzungen';
export const LAEDT = 'Wird geladen …';
export const ERNEUT = 'Erneut versuchen';
export const ENTWURF_LADEFEHLER = `Der ${UEMS_ENTWURF} konnte nicht geladen werden.`;
export const ANLEGEN_LADEFEHLER = 'Standorte und Kennzahlen konnten nicht geladen werden.';
export const ANLEGEN_FEHLER = 'Der Bericht konnte nicht angelegt werden.';
export const BERICHT_OEFFNEN = 'Bericht öffnen';
export const FEHLT_VORLAGE = `Wählen Sie eine ${UEMS_BERICHTSVORLAGE}.`;
export const FEHLT_GELTUNG = 'Wählen Sie, wofür der Bericht gilt.';
export const FEHLT_ZEITRAUM = 'Wählen Sie den Zeitraum.';
export const KEINE_GELTUNG = 'Für diese Vorlage gibt es keinen Standort, für den Sie Berichte anlegen dürfen.';

export const FREIGEBEN_TITEL = `${UEMS_BERICHTSSTAND} freigeben`;
export const FREIGEBEN_FEHLER = 'Die Freigabe hat nicht geklappt.';
export const ENTWURF_NEU_LADEN = `${UEMS_ENTWURF} neu laden`;
export const WAS_SIE_FREIGEBEN = 'Was Sie freigeben';

export const VERGLEICHEN = `${UEMS_ENTWURF} vergleichen`;
export const VERGLEICH_QUELLE = 'Quelle';
export const VERGLEICH_ENTWURF = UEMS_ENTWURF;
export const VERGLEICH_VERSION = 'Version';
export const VERGLEICH_ANLASS = 'Anlass';
export const VERGLEICH_LADEFEHLER = 'Der Vergleich konnte nicht geladen werden.';

export const VERWERFEN = 'Anstoß verwerfen';
export const BEGRUENDUNG = 'Begründung';
export const BEGRUENDUNG_MIN = 10;
export const BEGRUENDUNG_MAX = 500;
export const BEGRUENDUNG_HINWEIS = `Pflicht, ${BEGRUENDUNG_MIN} bis ${BEGRUENDUNG_MAX} Zeichen — sie steht danach im Vermerk.`;
export const BEGRUENDUNG_BEISPIEL = 'z. B. Korrektur betrifft nur den 31.10. nach Betriebsschluss, Bericht bleibt';
export const BEGRUENDUNG_FEHLT = 'Die Begründung fehlt.';
export const BEGRUENDUNG_ZU_KURZ = `Die Begründung braucht mindestens ${BEGRUENDUNG_MIN} Zeichen.`;
export const BEGRUENDUNG_ZU_LANG = `Höchstens ${BEGRUENDUNG_MAX} Zeichen.`;
export const VERWERFEN_FEHLER = 'Der Anstoß konnte nicht verworfen werden.';

// ------------------------------------------------------------------ Rechte (G1)

/** Was die Person darf: je Standort die Kennungen der Matrix, dazu die des Unternehmens. */
export interface BerichtRechte {
  standorte: ReadonlyMap<string, readonly string[]>;
  unternehmen: readonly string[];
}

export const rechteAus = (s: Pick<Selbstauskunft, 'standorte' | 'unternehmen_rechte'>): BerichtRechte => ({
  standorte: new Map(s.standorte.map((x) => [x.id, x.rechte])),
  unternehmen: s.unternehmen_rechte,
});

/** Solange die Selbstauskunft fehlt: keine schreibenden Hebel (kein Aufblitzen für einen Leser). */
export const KEINE_RECHTE: BerichtRechte = { standorte: new Map(), unternehmen: [] };

export type Handlung = 'anlegen' | 'freigeben' | 'verwerfen';

/** AP-16: Vorlage und Kennung der energetischen Bewertung (Rechte-Matrix AP-16 §6.1). */
export const BEWERTUNG_VORLAGE = 'energetische_bewertung';
export const BEWERTUNG_KENNUNG = 'bewertung.abrufen';

/**
 * Darf die Person die Handlung an dieser Geltung? `rechte = null` heißt: unbekannt — es gibt noch keinen schreibenden Hebel. `geltungId = null` am Standort fragt „an irgendeinem Standort“.
 */
export const darf = (
  rechte: BerichtRechte | null,
  handlung: Handlung,
  geltungArt: Bericht['geltung_art'],
  geltungId: string | null,
  vorlage: string | null = null,
): boolean => {
  if (rechte === null) return false;
  // AP-16 §6.1: die energetische Bewertung hat für jede Handlung ihre eigene Kennung (`BerichtRechte.kennung` mit Vorlage).
  const kennung = vorlage === BEWERTUNG_VORLAGE ? BEWERTUNG_KENNUNG : B.kennung(handlung, geltungArt);
  if (geltungArt === 'unternehmen') return darfInListen(rechte, kennung, null);
  if (geltungId !== null) return darfInListen(rechte, kennung, geltungId);
  return [...rechte.standorte.keys()].some((id) => darfInListen(rechte, kennung, id));
};

// ------------------------------------------------------------------ Bericht anlegen (§5.1)

interface KatalogVorlage {
  schluessel: string;
  fassung: number;
  name: string;
  geltung_art: Bericht['geltung_art'];
  zeitraum_art: Bericht['zeitraum_art'];
  abschnitte: Array<{ schluessel: string; titel: string }>;
}

const VORLAGEN = (katalog as unknown as { vorlagen: KatalogVorlage[] }).vorlagen;

/** Eine Karte der Vorlage-Wahl: Name, Fassung und die Abschnitte, die der Bericht haben wird (V2). */
export interface VorlageKarte {
  schluessel: string;
  name: string;
  fassung: string;
  abschnitte: string;
  geltungArt: Bericht['geltung_art'];
  zeitraumArt: Bericht['zeitraum_art'];
}

/**
 * Die Karten, die die Person anlegen darf: Standort-Vorlagen, wenn sie an einem Standort anlegen darf, die des
 * Unternehmens nur mit `bericht.unternehmen` — sonst fehlen sie ganz (§5.5).
 */
export const vorlageKarten = (rechte: BerichtRechte | null, standortIds: readonly string[]): VorlageKarte[] =>
  // AP-16 IP-25: die energetische Bewertung erscheint nur mit `bewertung.abrufen` (ihre eigene Kennung, §6.1).
  // AP-17 IP-21a: eine Vorlage ohne Leser bekommt keine Karte (seit IP-21b hat der Leistungsvergleich seinen Leser).
  VORLAGEN.filter((v) => !B.OHNE_LESER.includes(v.schluessel)).filter((v) =>
    v.geltung_art === 'unternehmen'
      ? darf(rechte, 'anlegen', 'unternehmen', null, v.schluessel)
      : standortIds.some((id) => darf(rechte, 'anlegen', 'standort', id)),
  ).map((v) => ({
    schluessel: v.schluessel,
    name: v.name,
    fassung: `${UEMS_FASSUNG} ${v.fassung}`,
    abschnitte: v.abschnitte.filter((a) => a.schluessel !== 'kopf').map((a) => a.titel).join(TRENNER),
    geltungArt: v.geltung_art,
    zeitraumArt: v.zeitraum_art,
  }));

export interface GeltungWahl {
  id: string;
  name: string;
  zone: string;
}

/** Wofür der Bericht gelten kann: die Standorte, an denen die Person anlegen darf — oder das Unternehmen. */
export const geltungen = (
  art: Bericht['geltung_art'],
  standorte: ReadonlyArray<Pick<StandortAmStichtag, 'id' | 'name' | 'zeitzone' | 'zustand'>>,
  unternehmen: Pick<Unternehmen, 'id' | 'name' | 'zeitzone'> | null,
  rechte: BerichtRechte | null,
  vorlage: string | null = null,
): GeltungWahl[] => {
  if (art === 'unternehmen') {
    if (!unternehmen?.id || !darf(rechte, 'anlegen', 'unternehmen', null, vorlage)) return [];
    return [{ id: unternehmen.id, name: unternehmen.name ?? GELTUNG_WORT.unternehmen, zone: unternehmen.zeitzone ?? ZONE_VORGABE }];
  }
  return standorte
    .filter((s) => s.zustand !== 'archiviert' && darf(rechte, 'anlegen', 'standort', s.id))
    .map((s) => ({ id: s.id, name: s.name, zone: s.zeitzone || ZONE_VORGABE }));
};

const heuteIn = (jetzt: number, zone: string): string => iso(jetzt, zone).slice(0, 10);

const monatZurueck = (schluessel: string, n: number): string => {
  const [jahr, monat] = schluessel.split('-').map(Number);
  const i = jahr * 12 + monat - 1 - n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
};

const MONATE_ZUR_WAHL = 24;
const JAHRE_ZUR_WAHL = 5;

/** Die Zeiträume zur Wahl, der laufende zuerst (V5: sein Entwurf ist erlaubt, eine Freigabe nicht). */
export const zeitraumWahlen = (art: Bericht['zeitraum_art'], jetzt: number, zone: string): Array<{ id: string; label: string }> => {
  const heute = heuteIn(jetzt, zone);
  if (art === 'datengrundlage') {
    // AP-16 §5.5: zwölf volle Monate, zuerst die letzten (Vorgabe) — keine läuft, der jüngste Monat ist zu Ende.
    return Array.from({ length: MONATE_ZUR_WAHL / 2 }, (_, n) => {
      const bis = monatZurueck(heute.slice(0, 7), n + 1);
      const s = `${monatZurueck(bis, 11)}/${bis}`;
      return { id: s, label: B.zeitraum(art, s, zone).bezeichnung };
    });
  }
  const schluessel =
    art === 'monat'
      ? Array.from({ length: MONATE_ZUR_WAHL }, (_, n) => monatZurueck(heute.slice(0, 7), n))
      : Array.from({ length: JAHRE_ZUR_WAHL }, (_, n) => String(Number(heute.slice(0, 4)) - n));
  return schluessel.map((s, n) => {
    const bezeichnung = B.zeitraum(art, s, zone).bezeichnung;
    return { id: s, label: n === 0 ? `${bezeichnung}${TRENNER}läuft` : bezeichnung };
  });
};

/** Vorbelegung: der letzte abgeschlossene Monat bzw. das letzte abgeschlossene Jahr (§5.1). */
export const zeitraumVorgabe = (art: Bericht['zeitraum_art'], jetzt: number, zone: string): string => {
  const heute = heuteIn(jetzt, zone);
  if (art === 'datengrundlage') {
    const bis = monatZurueck(heute.slice(0, 7), 1);
    return `${monatZurueck(bis, 11)}/${bis}`;
  }
  return art === 'monat' ? monatZurueck(heute.slice(0, 7), 1) : String(Number(heute.slice(0, 4)) - 1);
};

/**
 * Die Voraussetzungs-Vorschau (§5.1): „Der Oktober 2026 ist zu Ende · endgültig ab 08.11.2026“ — oder, solange er läuft,
 * „Zeitraum läuft — ein Berichtsstand ist ab 08.11.2026 möglich“. Frist und Zeitpunkte aus `uemsBericht.zeitraum` (V1).
 */
export const zeitraumVorschau = (art: Bericht['zeitraum_art'], schluessel: string, zone: string, jetzt: number): { text: string; laeuft: boolean } => {
  const z = B.zeitraum(art, schluessel, zone);
  const ab = datumText(z.freigabe_ab.slice(0, 10));
  if (jetzt < Date.parse(z.bis)) return { laeuft: true, text: `${B.ZEITRAUM_LAEUFT} — ein ${UEMS_BERICHTSSTAND} ist ab ${ab} möglich` };
  const wer = B.SAETZE[`zeitraum_${art}`].replace('{name}', z.bezeichnung);
  return { laeuft: false, text: `${wer} ist zu Ende${TRENNER}endgültig ${jetzt < Date.parse(z.freigabe_ab) ? 'ab' : 'seit'} ${ab}` };
};

const UNTERNEHMENS_EBENE: ReadonlyArray<Kennzahl['geltung_art']> = ['unternehmen', 'prozess', 'kostenstelle'];

/**
 * Die Kennzahlen, die ein Bericht dieser Geltung zeigen kann (Q4, wie `BerichtKennzahlen` sie wählt): am Standort die
 * Kennzahlen seines Standorts, seiner Gebäude, Bereiche und Messstellen; am Unternehmen die der Unternehmens-Ebene —
 * Unternehmen, Prozess, Kostenstelle und Messstellen ohne Standort. Nach Kennzeichen sortiert.
 */
export const kennzahlenDerGeltung = (kennzahlen: readonly Kennzahl[], art: Bericht['geltung_art'], geltungId: string): Kennzahl[] =>
  kennzahlen
    .filter((k) =>
      art === 'standort'
        ? k.standort_id === geltungId && !UNTERNEHMENS_EBENE.includes(k.geltung_art)
        : UNTERNEHMENS_EBENE.includes(k.geltung_art) || (k.geltung_art === 'messstelle' && k.standort_id === null),
    )
    .sort((a, b) => a.kennzeichen.localeCompare(b.kennzeichen, 'de'));

export interface AnlegenWahl {
  vorlage: string | null;
  geltungId: string | null;
  zeitraum: string | null;
  /** Die abgewählten Kennzahlen (IDs); leer = alle gewählt. */
  abgewaehlt: readonly string[];
}

export type AnlegenFeld = 'vorlage' | 'geltung' | 'zeitraum';

export const anlegenPruefen = (w: AnlegenWahl): Partial<Record<AnlegenFeld, string>> => ({
  ...(w.vorlage ? {} : { vorlage: FEHLT_VORLAGE }),
  ...(w.geltungId ? {} : { geltung: FEHLT_GELTUNG }),
  ...(w.zeitraum ? {} : { zeitraum: FEHLT_ZEITRAUM }),
});

/** Der Körper von `POST /api/v1/berichte`; ohne Abwahl ohne das Feld — so bleibt das Anlegen, wie es war. */
export const anlegenAnfrage = (w: AnlegenWahl, gueltigeKennzahlen: readonly string[]): BerichtAnlegen => {
  const abgewaehlt = w.abgewaehlt.filter((id) => gueltigeKennzahlen.includes(id));
  return {
    vorlage: w.vorlage ?? '',
    geltung_id: w.geltungId ?? '',
    zeitraum: w.zeitraum ?? '',
    ...(abgewaehlt.length > 0 ? { kennzahlen_abgewaehlt: [...abgewaehlt].sort() } : {}),
  };
};

const code = (e: unknown): string | null => {
  const body = e instanceof ApiError ? (e.body as { code?: unknown } | undefined) : undefined;
  return typeof body?.code === 'string' ? body.code : null;
};

/**
 * Warum Anlegen nicht ging — der Satz der Route (§5.8: `bericht_gibt_es_schon`, `keine_quellen`, 403 …); gibt es den
 * Bericht schon, die Kennung dazu, damit der Dialog ihn öffnen kann.
 */
export const anlegenFehler = (e: unknown): { satz: string; kennung: string | null } => {
  if (!(e instanceof ApiError) || e.body === undefined) return { satz: ANLEGEN_FEHLER, kennung: null };
  const kennung = (e.body as { kennung?: unknown }).kennung;
  return { satz: e.message, kennung: code(e) === 'bericht_gibt_es_schon' && typeof kennung === 'string' ? kennung : null };
};

// ------------------------------------------------------------------ Berichtsstand freigeben (§5.2)

/** „10.11.2026 08:55“ in der Zone der Geltung. */
const zeitpunkt = (zeit: string, zone: string): string => {
  const t = Date.parse(zeit);
  return `${datumText(iso(t, zone).slice(0, 10))} ${uhr(t, zone)}`;
};

/**
 * Der Antrag an F1 für den Entwurf, den die Person sieht — dieselbe Form, die die Route prüft: jeder Wert UND jede
 * Kennzahl des Abzugs mit Fassung und „endgültig ab“ (`BerichtService.freigabeWerte`), der gesehene Datenstand als
 * übermittelter und gespeicherter (die Seite hat den Entwurf eben über die D4-Prüfung gelesen).
 */
export const freigabeAntrag = (
  bericht: Pick<Bericht, 'zeitraum_art' | 'zeitraum' | 'zeitzone'>,
  entwurf: Pick<BerichtEntwurf, 'datenstand' | 'abzug'>,
  staende: readonly Pick<BerichtStandKurz, 'nr'>[],
  jetzt: number,
): B.FreigabeAntrag => {
  const a = abzugAus(entwurf.abzug);
  const werte: B.FreigabeWert[] = [
    // Die energetische Bewertung (AP-16) trägt keine Werte-/Kennzahl-Liste — ihre Zahlen stehen in den Abschnitten.
    ...(a.werte ?? []).map((w) => ({ quelle: w.quelle, name: w.name_zum_datenstand ?? null, fassung: w.fassung ?? null, endgueltig_ab: w.endgueltig_ab ?? null })),
    ...(a.kennzahlen ?? []).map((k) => ({ quelle: k.quelle, name: k.name_zum_datenstand ?? null, fassung: k.fassung ?? null, endgueltig_ab: null })),
  ];
  return {
    zeitraum_art: bericht.zeitraum_art,
    schluessel: bericht.zeitraum,
    zone: bericht.zeitzone,
    jetzt: iso(jetzt, bericht.zeitzone),
    werte,
    datenstand_uebermittelt: entwurf.datenstand,
    datenstand_entwurf: entwurf.datenstand,
    letzte_nr: staende.reduce((m, s) => Math.max(m, s.nr), 0),
    anlass: null,
    abweichungen: 0,
  };
};

export interface Voraussetzung {
  schluessel: 'zeitraum' | 'werte' | 'entwurf';
  text: string;
  erfuellt: boolean;
}

export interface FreigabeVorschau {
  /** „Zeitraum zu Ende ✓ · Alle 17 Werte endgültig ✓ · Entwurf aktuell (Datenstand 10.11.2026 08:55) ✓“ als Liste. */
  punkte: Voraussetzung[];
  /** Der Kundensatz der ERSTEN nicht erfüllten Voraussetzung (F1-Reihenfolge, B4) — `null`, wenn alles erfüllt ist. */
  satz: string | null;
  erlaubt: boolean;
  nr: number;
  /** „ersetzt Berichtsstand Nr. 1“ — nur mit gültigem Stand (§5.3). */
  ersetzt: string | null;
  /** „Berichtsstand Nr. 1 freigeben“. */
  knopf: string;
  /** „genau diesen Entwurf — Datenstand, Zeitzone Europe/Berlin, Zahlenformat de-DE werden festgehalten“. */
  festgehalten: string;
}

/**
 * F1 als Liste (§5.2): jede Voraussetzung mit ihrem Stand; der Satz darunter ist genau der, den `uemsBericht.freigabe`
 * für den Antrag spricht — also der Satz der Route bei derselben Lage.
 */
export const freigabeVorschau = (a: B.FreigabeAntrag, ersetztNr: number | null, zahlenformat: string): FreigabeVorschau => {
  const f = B.freigabe(a);
  const z = B.zeitraum(a.zeitraum_art, a.schluessel, a.zone);
  const n = a.werte.length;
  const nr = a.letzte_nr + 1;
  return {
    punkte: [
      { schluessel: 'zeitraum', text: 'Zeitraum zu Ende', erfuellt: Date.parse(a.jetzt) >= Date.parse(z.bis) },
      // Ohne Wert-Liste (energetische Bewertung, AP-16) gibt es keinen Punkt „Alle 0 Werte endgültig“.
      ...(n === 0 ? [] : [{ schluessel: 'werte' as const, text: n === 1 ? 'Der Wert ist endgültig' : `Alle ${n} Werte endgültig`, erfuellt: a.werte.every((w) => w.fassung !== VORLAEUFIG) }]),
      {
        schluessel: 'entwurf',
        text: `${UEMS_ENTWURF} aktuell (${UEMS_DATENSTAND} ${zeitpunkt(a.datenstand_entwurf, a.zone)})`,
        erfuellt: Date.parse(a.datenstand_uebermittelt) === Date.parse(a.datenstand_entwurf),
      },
    ],
    satz: f.kundensatz,
    erlaubt: f.erlaubt,
    nr,
    ersetzt: ersetztNr === null ? null : `ersetzt ${B.berichtsstand(ersetztNr)}`,
    knopf: `${B.berichtsstand(nr)} freigeben`,
    festgehalten: `genau diesen ${UEMS_ENTWURF} — ${UEMS_DATENSTAND}, Zeitzone ${a.zone}, Zahlenformat ${zahlenformat} werden festgehalten`,
  };
};

/** Warum die Freigabe abgelehnt wurde — der Satz der Route; bei `entwurf_veraltet` mit dem Hebel „Entwurf neu laden“. */
export const freigabeFehler = (e: unknown): { satz: string; neuLaden: boolean } =>
  e instanceof ApiError && e.body !== undefined
    ? { satz: e.message, neuLaden: code(e) === 'entwurf_veraltet' }
    : { satz: FREIGEBEN_FEHLER, neuLaden: false };

// ------------------------------------------------------------------ Vergleich Entwurf gegen Stand (§5.3, R1)

export interface VergleichZeile {
  quelle: string;
  name: string | null;
  vorher: string;
  nachher: string;
  version: string;
  anlass: string | null;
  /** R1 „wer/wann/warum“ — aus der Beleg-Fassung im Qualitäts-Abschnitt des Entwurfs; ohne Beleg `null`. */
  beleg: string | null;
}

const BELEG_KENNUNG = /^((?:K|EW)-\d{4}-\d{4})/;

/**
 * Die Abweichungen der Route (R1) als Zeilen: Zahlen nach DA1 in der Einheit des Abzugs, der Anlass in Kundensprache
 * (`uemsBericht.anlass`: „K-2026-0007 (über die Formel)“ → „Korrektur K-2026-0007 (über die Formel)“). Name und Einheit
 * stehen im Entwurf; eine Quelle, die nur noch der Stand kennt, findet sie dort (`stand`).
 */
export const vergleichZeilen = (abweichungen: readonly BerichtAbweichung[], entwurf: Abzug, stand: Abzug | null = null): VergleichZeile[] =>
  abweichungen.map((x) => {
    const suche = (a: Abzug | null) => ({
      kennzahl: a?.kennzahlen.find((k) => k.quelle === x.quelle) ?? null,
      wert: a?.werte.find((w) => w.quelle === x.quelle && (w.menge_art ?? null) === x.menge_art) ?? null,
    });
    const hier = suche(entwurf);
    const dort = suche(stand);
    const kennzahl = hier.kennzahl ?? dort.kennzahl;
    const wert = hier.wert ?? dort.wert;
    const einheit = kennzahl?.einheit ?? wert?.einheit ?? '';
    // Eine Kennzahl mit den vier Stellen des Kennzahl-Vergleichs (AP-11): mit den zwei der Karte stünde „0,15 → 0,15“ da.
    const zahl = (v: string | null): string =>
      v === null
        ? OHNE_ZAHL
        : kennzahl
          ? zahlMitStellen(v, VERGLEICH_NACHKOMMASTELLEN, einheitWort(einheit))
          : B.anzeige('menge', v, einheit, entwurf.kopf.zeitraum.art);
    const name = kennzahl?.name_zum_datenstand ?? wert?.name_zum_datenstand ?? null;
    const belegKennung = x.anlass === null ? null : BELEG_KENNUNG.exec(x.anlass)?.[1] ?? null;
    const k = (entwurf.qualitaet.korrekturen ?? []).find((q) => q.kennung === belegKennung) ?? null;
    return {
      quelle: x.quelle,
      name: name === null ? null : x.menge_art ? `${name} (${MENGE_ART_WORT[x.menge_art] ?? x.menge_art})` : name,
      vorher: zahl(x.vorher),
      nachher: zahl(x.nachher),
      version: x.version,
      anlass: x.anlass === null ? null : B.anlass(x.anlass),
      beleg: k === null ? null : `${k.wer}, ${zeitpunkt(k.freigegeben, entwurf.kopf.zeitraum.zone)}: ${k.warum}`,
    };
  });

/** „3 Abweichungen“. */
export const abweichungenAnzahl = (n: number): string => (n === 1 ? '1 Abweichung' : `${n} Abweichungen`);

/** „15 Werte unverändert“ — jede Zahl des Entwurfs, die keine Abweichung ist. */
export const unveraendert = (entwurf: Abzug, abweichungen: number): string => {
  const n = Math.max(0, entwurf.werte.length + entwurf.kennzahlen.length - abweichungen);
  return n === 1 ? '1 Wert unverändert' : `${n} Werte unverändert`;
};

/** Kurz, weil der Titel des Dialogs bei 375 px einzeilig bleibt: „Entwurf gegen Nr. 1“. */
export const vergleichTitel = (nr: number): string => `${UEMS_ENTWURF} gegen Nr. ${nr}`;
export const keineAbweichung = (nr: number): string => `Keine Abweichung — der ${UEMS_ENTWURF} zeigt dieselben Zahlen wie Nr. ${nr}.`;

// ------------------------------------------------------------------ Revision nötig, Anstoß verwerfen (§5.3, R1, R4)

export interface RevisionBanner {
  /** R5 — „Revision nötig — Korrektur K-2026-0007“ (Kennzeichen `revision_noetig`). */
  titel: string;
  /**
   * Je offener Anstoß: `zeile` für das Banner (bei einem Anstoß nennt der Titel den Anlass schon — die Zeile sagt nur,
   * wann), `text` vollständig mit Anlass und Zeit für die Rückfrage „Anstoß verwerfen“.
   */
  anstoesse: Array<{ id: string; zeile: string; text: string }>;
  /** „Der Berichtsstand Nr. 1 bleibt unverändert.“ */
  satz: string;
  nr: number;
}

/** Das Banner über der Berichtsseite, solange der gültige Stand einen offenen Anstoß hat — sonst `null`. */
export const revisionBanner = (detail: BerichtDetail): RevisionBanner | null => {
  const gueltig = gueltigerStand(detail.staende);
  if (!gueltig) return null;
  const offen = detail.anstoesse.filter((a) => a.zustand === 'offen' && a.nr === gueltig.nr);
  if (offen.length === 0) return null;
  const zone = detail.bericht.zeitzone;
  return {
    titel: B.revisionNoetig(offen.map((a) => a.anlass_text).join(', ')),
    anstoesse: offen.map((a) => {
      const text = `${a.anlass_text}${TRENNER}erkannt ${zeitpunkt(a.erkannt_am, zone)}`;
      return { id: a.id, zeile: offen.length === 1 ? `Erkannt am ${zeitpunkt(a.erkannt_am, zone)}.` : text, text };
    }),
    satz: `Der ${B.berichtsstand(gueltig.nr)} bleibt unverändert.`,
    nr: gueltig.nr,
  };
};

export const verwerfenVorspann = (nr: number): string =>
  `Der ${B.berichtsstand(nr)} bleibt der gültige. Der Vermerk „${UEMS_REVISION} nötig“ wird zu „Anstoß verworfen (…)“ mit Ihrer Begründung.`;

/** R4 — die Begründung ist Pflicht (10 bis 500 Zeichen, wie die Route); `null` = in Ordnung. */
export const begruendungFehler = (text: string): string | null => {
  const t = text.trim();
  if (t.length === 0) return BEGRUENDUNG_FEHLT;
  if (t.length < BEGRUENDUNG_MIN) return BEGRUENDUNG_ZU_KURZ;
  if (t.length > BEGRUENDUNG_MAX) return BEGRUENDUNG_ZU_LANG;
  return null;
};

export const verwerfenFehler = (e: unknown): string => (e instanceof ApiError && e.body !== undefined ? e.message : VERWERFEN_FEHLER);

// ------------------------------------------------------------------ Hebel der Berichtsseite

export interface SeitenHebel {
  /** Am Entwurf, mit Recht, nicht archiviert: „Als Berichtsstand freigeben“ — aus, wenn F1 schon jetzt nein sagt. */
  freigeben: { knopf: string; vorschau: FreigabeVorschau } | null;
  /** Am Entwurf mit gültigem Stand (EW2): „Mit Berichtsstand Nr. 1 vergleichen“. */
  vergleichen: { knopf: string; gegen: number } | null;
  /** Hebel „Anstoß verwerfen“ im Banner — nur mit Freigabe-Recht (R4). */
  verwerfen: boolean;
}

export const seitenHebel = (
  detail: BerichtDetail,
  entwurf: BerichtEntwurf | null,
  rechte: BerichtRechte | null,
  jetzt: number,
): SeitenHebel => {
  const b = detail.bericht;
  const gueltig = gueltigerStand(detail.staende);
  const mitRecht = b.archiviert_am === null && darf(rechte, 'freigeben', b.geltung_art, b.geltung_id);
  const zahlenformat = entwurf ? abzugAus(entwurf.abzug).kopf.darstellung.zahlenformat : '';
  return {
    freigeben:
      entwurf && mitRecht
        ? {
            knopf: gueltig ? `Als ${B.berichtsstand(gueltig.nr + 1)} freigeben` : `Als ${UEMS_BERICHTSSTAND} freigeben`,
            vorschau: freigabeVorschau(freigabeAntrag(b, entwurf, detail.staende, jetzt), gueltig?.nr ?? null, zahlenformat),
          }
        : null,
    vergleichen: entwurf && gueltig ? { knopf: `Mit ${B.berichtsstand(gueltig.nr)} vergleichen`, gegen: gueltig.nr } : null,
    verwerfen: b.archiviert_am === null && darf(rechte, 'verwerfen', b.geltung_art, b.geltung_id),
  };
};
