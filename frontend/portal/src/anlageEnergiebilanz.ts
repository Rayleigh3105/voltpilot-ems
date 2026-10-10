import type {
  Bilanz,
  BilanzAbschnitt,
  BilanzEingang,
  BilanzHauptzaehler,
  BilanzLive,
  BilanzMessstelleRef,
  BilanzRest,
  BilanzSumme,
  BilanzWerte,
  Funktionen,
} from './api';
import type { BerichtRechte } from './berichtDialoge';
import { prozentText } from './bewertung';
import { dez, dezVergleich, dezVon, type Dez } from './dez';
import { UEMS_HAUPTZAEHLER, uemsGeteiltSatz } from './glossar';
import { anlageRoute, hashForRoute } from './nav';
import { datumZeit } from './rechte';
import { beginn, laeuftNoch, letzterGebildeter, zeitraumText, type BilanzPeriode } from './uebersichtBausteine';
import { nenner, prozent } from './uemsBewertung';
import { BERECHNET_DIFFERENZ, BERECHNET_SUMME, NICHT_ZUGEORDNET, VOLLSTAENDIG } from './uemsBilanz';
import { zahl } from './uemsErgebnis';
import {
  herkunftsZeile,
  kennzeichenSprung,
  OHNE_HAUPTZAEHLER,
  periodeSchluessel,
  sprungziel,
  type Leerzustand,
  type Sprung,
  type Stueck,
} from './uemsOberflaechen';

/**
 * Die Energiebilanz je Anlage (UEMS AP-13 IP-8 = AP-10 IP-14; Konzept Auswerten a1 §6.9) - der Reiter „Energiebilanz“
 * im Bereich „Verlauf“ einer Anlage, rein abgeleitet aus `GET /api/v1/sites/{id}/bilanz` (AP-10 IP-9/IP-12). Die Fläche
 * beantwortet EINE Frage: Erfassen die Zähler den ganzen Bezug dieser Anlage? Zuerst der Antwortsatz, dann der
 * Zwei-Teile-Balken mit drei Zeilen (Bezug laut Hauptzähler · durch Zähler erfasst · ohne eigenen Zähler), dann die
 * Unterzähler nach Menge, zuletzt „Woraus gerechnet“ mit der Herkunft.
 *
 * ⚠ **Keine eigene Rechnung.** Jede Menge ist ein Feld der Route: Bezug/Zufluss/Abfluss/erfasst sind `werte.*.menge` (und
 * „mindestens …“ ist `anzeige` wörtlich), „ohne eigenen Zähler“ ist `rest.menge` mit `rest.kundensatz`. Der Verbrauch der
 * Anlage (Zufluss − Abfluss) und jeder Anteil kommen aus dem Vertrags-Zwilling der Bewertung (`uemsBewertung.nenner` und
 * `.prozent`, AP-16 KR4) - dieselbe Regel, mit der die Bewertung „x % der Anlage“ nennt; so sagen Energiebilanz,
 * Verbrauch und Bewertung dieselbe Zahl (Konzept a1, Entscheid 5). Formatiert wird über `uemsErgebnis.zahl` (E11) und
 * `bewertung.prozentText`.
 *
 * ⚠ **„Ohne eigenen Zähler“ ist eine Aussage, keine Fehlerzeile:** die Zeile steht IMMER, auch mit 0 kWh, negativ mit dem
 * Satz der Route, ohne Zahl als „—“ mit dem fehlenden Eingang (AP-10 §4.9 Punkt 2–4). Fehlend ist keine Null.
 *
 * ⚠ **Stellungswechsel:** die Route liefert dann Abschnitte Tag für Tag (`raster = tag`). Sie stehen untereinander,
 * jeder Tag für sich - nie zusammengerechnet, nie gemittelt (AP-13 B1, AP-10 IP-9 Falle 2).
 */

export const ENERGIEBILANZ_SUB = 'energiebilanz' as const;

// ------------------------------------------------------------------------------------------------ Wörter

/** Konzept a1 §6.9: die Unterzeile unter dem Titel - sie sagt, welche Frage die Fläche beantwortet. */
export const ENERGIEBILANZ_UNTERZEILE = 'Ob die Zähler den ganzen Bezug dieser Anlage erfassen - und was ohne eigenen Zähler bleibt.';

/** Die Wörter der vier Zeilen der Route - in „Woraus gerechnet“ und an jedem Eingang der Herkunft. */
export const ZEILE_WORT = {
  zufluss: 'Hinein',
  abfluss: 'Hinaus',
  zugeordnet: 'Durch Zähler erfasst',
  rest: 'Ohne eigenen Zähler',
} as const;
export type ZeileArt = keyof typeof ZEILE_WORT;

/**
 * Die drei Zeilen der Karte (Konzept a1 §6.9) - dieselben Wörter wie Verbrauch und Bewertung. „Bezug laut Hauptzähler“,
 * wenn nur der Hauptzähler hineinzählt; mit Erzeugung, Speicher oder Einspeisung ist das Ganze der Verbrauch in der Anlage.
 */
export const KARTE_WORT = {
  bezug: 'Bezug laut Hauptzähler',
  verbrauch: 'Verbrauch in der Anlage',
  erfasst: { keiner: 'durch Zähler erfasst', singular: 'durch 1 Zähler erfasst', plural: 'durch {n} Zähler erfasst' },
  ohne: 'ohne eigenen Zähler',
} as const;
/** „41,4 % des Bezugs“ · „41,4 % des Verbrauchs“ - der Anteil eines Unterzählers am Ganzen der Karte. */
export const ANTEIL_AM = { bezug: 'des Bezugs', verbrauch: 'des Verbrauchs' } as const;
/** Was das Ganze ist, wenn mehr als der Hauptzähler hinein- oder hinauszählt. */
export const VERBRAUCH_AUS = 'was hineinkommt ({zufluss}) minus was hinausgeht ({abfluss})';
export const KEIN_UNTERZAEHLER = 'Diesem Hauptzähler ist kein Unterzähler zugeordnet.';

/** Der Antwortsatz (Konzept a1 §6.9, Copy-Prinzip „Antwort zuerst“). */
export const ANTWORT = {
  erfasst: '{prozent} {am} messen eigene Zähler; {rest} laufen ohne eigenen Zähler.',
  alles: 'Eigene Zähler messen den ganzen {ganz}; nichts läuft ohne eigenen Zähler.',
  keinUnterzaehler: 'Kein Unterzähler misst einen Teil {am}: alle {rest} laufen ohne eigenen Zähler.',
  ohneAnteil: '{rest} laufen ohne eigenen Zähler.',
  fehlt: 'Für {zeitraum} fehlen Werte von {namen} - darum bleibt offen, wie viel ohne eigenen Zähler läuft.',
  fehltViele: 'Für {zeitraum} fehlen Werte von {n} Zählern - darum bleibt offen, wie viel ohne eigenen Zähler läuft.',
  keinZaehler: 'Für {zeitraum} liegt von keinem Zähler dieser Anlage ein Wert vor - darum bleibt offen, wie viel ohne eigenen Zähler läuft.',
  keineWerte: 'Für {zeitraum} liegen keine Werte vor - darum bleibt offen, wie viel ohne eigenen Zähler läuft.',
} as const;
/**
 * Konzept a1 §6.13 („April läuft noch - …“): ein Zeitraum ohne Abschluss hat noch keine Bilanz - nie eine Hochrechnung
 * (E11). Ein Zeitraum nach heute hat noch gar keine Werte.
 */
export const OFFEN_SATZ = {
  laeuft: '{zeitraum} läuft noch - die Bilanz steht, sobald {einheit} abgeschlossen ist.',
  kommt: '{zeitraum} hat noch nicht begonnen - dafür gibt es noch keine Werte.',
} as const;
const EINHEIT_IM_SATZ: Record<BilanzPeriode, string> = { tag: 'der Tag', monat: 'der Monat', jahr: 'das Jahr' };
/** Der Wortteil des Ganzen im Satz „Eigene Zähler messen den ganzen …“. */
const GANZ_IM_SATZ = { bezug: 'Bezug', verbrauch: 'Verbrauch' } as const;

/** Die Herkunfts-Art einer Messstelle, wie das Register sie nennt (`MessstelleRegisterZeile.art`). */
export type MessstellenArt = 'gemessen' | 'berechnet';

/** Speicher-Anteile als zwei Zeilen (AP-10 E4): das Wort des Anteils, nie eine saldierte Zahl. */
export const ANTEIL_WORT: Record<BilanzEingang['anteil'], string | null> = {
  gesamt: null,
  positiv: 'Speicher laden',
  negativ: 'Speicher entladen',
};

/** Die Unterzähler-Karte: „Die 7 Unterzähler“ · „Der Unterzähler“. */
export const UNTERZAEHLER_TITEL = { singular: 'Der Unterzähler', plural: 'Die {n} Unterzähler' } as const;
/**
 * Konzept Auswerten a1, Befund 3 - der Bilanz-Vertrag: „Abzweig ohne Vorgänger = außerhalb der Bilanz (benannt)“. Gemessene
 * Abzweige desselben Systems zählen in dieser Bilanz nicht mit; die Seite nennt sie, statt still nur den Rest zu melden.
 */
export const AUSSERHALB_SATZ = {
  singular: '1 Zähler hängt als Abzweig neben dem Hauptzähler und zählt hier nicht mit: {namen}.',
  plural: '{n} Zähler hängen als Abzweig neben dem Hauptzähler und zählen hier nicht mit: {namen}.',
} as const;
/**
 * AP-10 §5.2 (F6): der Hilfe-Satz zum negativen Rest - er nennt keine Ursache. Er vergleicht mit dem Ganzen der Karte:
 * dem Bezug laut Hauptzähler oder, mit Erzeugung, Speicher oder Einspeisung, dem Verbrauch in der Anlage (dort können
 * die Unterzähler unter dem Hauptzähler und trotzdem über dem Verbrauch liegen).
 */
export const HILFE_NEGATIV = 'Die Unterzähler zählen mehr als der Hauptzähler. VoltPilot nennt keine Ursache.';
export const HILFE_NEGATIV_VERBRAUCH = 'Die Unterzähler zählen mehr als der Verbrauch in der Anlage. VoltPilot nennt keine Ursache.';
const hilfeNegativ = (einfach: boolean): string => (einfach ? HILFE_NEGATIV : HILFE_NEGATIV_VERBRAUCH);

/** Die Live-Zeile steht nur mit einer Zahl - ein Strich mit Gerätegründen ist kein Teil der Antwort (Konzept a1 §6.9). */
export const LIVE_JETZT = 'jetzt {zahl} ohne eigenen Zähler';
export const LIVE_STAND = 'Stand {stand}';

/** Der Fuß der Fläche: die Zeitzone steht einmal, mit dem Standort (Messen m1, Entscheid 6). */
export const FUSS_ZONE = 'Zeiten: {zone}';
export const FUSS_ZONE_STANDORT = 'Zeiten: {zone} ({standort})';
export const STELLUNG_GEAENDERT =
  'Die Zuordnung der Zähler hat sich in diesem Zeitraum geändert. VoltPilot rechnet darum jeden Tag für sich - nie zusammengerechnet.';

export const WORAUS = 'Woraus gerechnet';
export const HERKUNFT = 'Herkunft';
export const HERKUNFT_FORMEL = 'Formel: {formel}';
export const HERKUNFT_FASSUNG = 'Fassung {n}';
export const HERKUNFT_BERECHNET_AM = 'berechnet am {am}';
export const HERKUNFT_VERSION = 'Version {n}';
export const HERKUNFT_KORRIGIERT = 'korrigiert: {messstellen} ({periode})';
export const HERKUNFT_ERSATZWERT = 'mit Ersatzwert: {messstellen} ({periode})';
export const HERKUNFT_VERTEILT = 'verteilt {anteil} % an Kostenstelle {ziel}';
export const HERKUNFT_UNVOLLSTAENDIG = 'Zu dieser Zahl liegt keine vollständige Herkunft vor.';
export const HERKUNFT_EINGAENGE = 'Eingänge';

/** E18 in Worten (Konzept a1 §6.9): was es bedeutet, den Teil ohne eigenen Zähler als Messstelle zu führen. */
export const REST_VORSCHLAG = 'Als Messstelle „{name}“ bekommt dieser Teil eine eigene Zeile in Verbrauch und lässt sich einem Bereich zuordnen.';
export const REST_ANLEGEN = 'Als eigene Messstelle führen';
export const REST_GEFUEHRT = 'geführt als Messstelle {name}';
export const REST_OHNE_RECHT = 'Eine eigene Messstelle für diesen Teil legt an, wer berechnete Messstellen anlegen darf.';
export const REST_ANGELEGT = '{kennzeichen} „{name}“ ist angelegt.';
export const REST_GAB_ES_SCHON = '{kennzeichen} „{name}“ gab es schon.';
export const REST_NICHT_ANGELEGT = 'Die Messstelle für diesen Teil ließ sich gerade nicht anlegen. Ihre Daten sind nicht betroffen.';
/** AP-10 §5.9 - die Ablehnung `rest_ohne_hauptzaehler` von `POST …/bilanz/rest`. */
export const REST_OHNE_HAUPTZAEHLER_SATZ = 'Für diese Anlage gibt es keinen Hauptzähler - ohne ihn keine Bilanz.';
/** Das Menü ⋯ des Kopfs: der Weg zur Zuordnung der Zähler (Standort › Messstellen). */
export const ZAEHLER_ZUORDNEN = 'Zähler zuordnen';

/** Seit AP-03 IP-6 trägt jede Schreibroute ihre Kennung - das Portal fragt sie, statt zu raten. */
export const RECHT_REST_ANLEGEN = 'messstelle.formel';
export const RECHT_STELLUNG = 'messstelle.bearbeiten';

const fuelle = (vorlage: string, werte: Record<string, string | number>): string =>
  vorlage.replace(/\{([a-z_]+)\}/g, (_, k: string) => String(werte[k] ?? `{${k}}`));

const ohneLeere = <T>(xs: Array<T | null | undefined | false>): T[] => xs.filter((x): x is T => x != null && x !== false);
const einmal = (xs: string[]): string[] => [...new Set(xs)];

// ------------------------------------------------------------------------------------ Reiter und Adresse

/** Der Fakt „Hauptzähler in der Stellung“ und die Projektion mit dem Reiter wohnen in `energiebilanzReiter.ts` (Einstiegs-Bündel). */
export { hatHauptzaehler, mitEnergiebilanz } from './energiebilanzReiter';

const PERIODEN: readonly BilanzPeriode[] = ['tag', 'monat', 'jahr'];

/** `#/anlage/{id}/energiebilanz?periode=monat&am=2026-10-01` - ein Lesezeichen hält den Zeitraum. */
export const energiebilanzHash = (siteId: string, periode: BilanzPeriode, am: string): string =>
  `${hashForRoute(anlageRoute(siteId, ENERGIEBILANZ_SUB))}?periode=${periode}&am=${am}`;

/** Der Zeitraum aus der Adresse; ohne (oder unlesbar) der letzte GEBILDETE Monat (wie der Baustein der Übersicht, Ü3). */
export function zeitraumAus(hash: string, heute: string): { periode: BilanzPeriode; am: string } {
  const q = new URLSearchParams(hash.split('?')[1] ?? '');
  const p = q.get('periode');
  const periode: BilanzPeriode = (PERIODEN as readonly string[]).includes(p ?? '') ? (p as BilanzPeriode) : 'monat';
  const am = q.get('am');
  const lesbar = am !== null && /^\d{4}-\d{2}-\d{2}$/.test(am) && !Number.isNaN(Date.parse(`${am}T00:00:00Z`));
  return { periode, am: lesbar ? beginn(periode, am) : letzterGebildeter(periode, heute) };
}

// ----------------------------------------------------------------------------------------------- Rechte

/** Der Standort einer Anlage aus `GET /funktionen` - dieselbe Zuordnung wie `anlageGeld.anlageAufEbene`. */
export const standortDerAnlage = (funktionen: Funktionen | null, siteId: string): string | null =>
  funktionen?.standorte.find((st) => st.steuern.anlagen.some((a) => a.id === siteId))?.id ?? null;

/**
 * Darf die Person das an diesem Standort? `undefined` = die Selbstauskunft fehlt noch (kein Aufblitzen eines Knopfs),
 * `null` = nicht zu haben (der Knopf steht, die Route entscheidet mit 403). Ohne Standort: an irgendeinem.
 */
export function darf(rechte: BerichtRechte | null | undefined, standortId: string | null, kennung: string): boolean {
  if (rechte === undefined) return false;
  if (rechte === null) return true;
  if (standortId === null) return [...rechte.standorte.values()].some((r) => r.includes(kennung));
  return rechte.standorte.get(standortId)?.includes(kennung) ?? false;
}

// ------------------------------------------------------------------------------------------------- Bild

export type Ton = 'ok' | 'warn' | 'off';

/** Ein Eingang einer Zeile (Unterzähler, Erzeuger, Speicher-Anteil). */
export interface TeilBild {
  key: string;
  kennzeichen: string;
  /** „Spritzguss (MS-20)“ - die Namensform der Herkunft und der Zeilen „hinein/hinaus“. */
  name: string;
  /** Nur der Name („Spritzguss“), ohne Kennzeichen; ohne Namen das Kennzeichen. */
  nurName: string;
  zahl: string;
  /** Anteil-Wort und Zustand, wenn er nicht „vollständig“ ist - was die Reihe sagen muss. Die Kennzeichen des Eingangs
   * („ab 15.10.2026“, „Ablesezeitraum …“) stehen mit seiner Version in „Woraus gerechnet“ ({@link eingangText}). */
  woerter: string[];
  keineWerte: boolean;
  /** Konzept a1 §6.9: „41,4 % des Bezugs“ - der Anteil am Ganzen der Karte (Zwilling `prozent`); `null` ohne Wert. */
  anteil: string | null;
  /** AP-13 IP-11 (D1): der Weg zu dieser Messstelle, mit der Periode der Bilanz (D2). */
  sprung: Sprung | null;
}

/** Die Herkunfts-Karte einer Zeile (AP-10 §5.6): Kopfzeilen und je Eingang eine Zeile mit Version. */
export interface HerkunftBild {
  zeilen: string[];
  eingaenge: string[];
  /**
   * AP-13 IP-11 (D1/D2): dieselben Zeilen in Stücken - die Messstelle eines Eingangs springt auf ihre
   * Seite MIT der Periode der Bilanz und der Version DIESES Eingangs, die Kostenstelle einer Verteilung
   * auf ihre Karte. Zusammengefügt ergeben die Stücke wieder `zeilen` bzw. `eingaenge`.
   */
  zeilenStuecke: Stueck[][];
  eingaengeStuecke: Stueck[][];
}

/** Eine der vier Zeilen der Route - die Grundlage der Karte und von „Woraus gerechnet“. */
export interface ZeileBild {
  art: ZeileArt;
  wort: string;
  zahl: string;
  zusatz: string | null;
  woerter: string[];
  ton: Ton;
  saetze: string[];
  teile: TeilBild[];
  herkunft: HerkunftBild;
}

/** Eine Zeile der Karte (Konzept a1 §6.9): das Ganze, das Erfasste, der Teil ohne eigenen Zähler. */
export interface KartenZeile {
  art: 'ganz' | 'erfasst' | 'ohne';
  wort: string;
  zahl: string;
  ton: Ton;
  /** Leise Sätze unter der Zeile (Zustand, Grund, Satz der Route). */
  unter: string[];
}

export interface AntwortBild {
  satz: string;
  ton: Ton;
}

export interface TagBild {
  key: string;
  /** Nur bei Stellungswechsel: der Tag über seinen Zeilen. */
  titel: string | null;
  /** Tag für Tag ohne Unterzähler-Karte - die Eingänge stehen in „Woraus gerechnet“. */
  kompakt: boolean;
  /** Bezug laut Hauptzähler (nur der Hauptzähler hinein, nichts hinaus) oder Verbrauch in der Anlage. */
  einfach: boolean;
  antwort: AntwortBild;
  karte: KartenZeile[];
  /** Der Zwei-Teile-Balken: die Anteile des Zwillings als Dezimaltext (`88.6`); `null` = kein ehrlicher Balken. */
  balken: { erfasst: string; ohne: string } | null;
  /** Die Unterzähler nach Menge absteigend; ohne Wert am Ende. */
  unterzaehler: TeilBild[];
  zeilen: ZeileBild[];
  /** Alle Kennzeichen dieses Zeitraums - die Fläche setzt sie in Sätzen ohne Umbruch ({@link kennzeichenTeile}). */
  kennzeichen: string[];
}

export interface AbschnittBild {
  key: string;
  titel: string | null;
  tage: TagBild[];
  /** Summen-Wächter des geteilten Punkts (AP-07 IP-18b): je Fund ein Satz; leer ohne Fund. */
  geteilt: string[];
  /** Die Abzweige außerhalb dieser Bilanz, benannt (Bilanz-Vertrag); `null` ohne Abzweig. */
  ausserhalb: AusserhalbBild | null;
}

/** Der Satz zu den Abzweigen außerhalb der Bilanz, in Stücke geteilt: ein Kennzeichen bricht nie am Bindestrich um. */
export interface AusserhalbBild {
  satz: string;
  teile: { text: string; kennzeichen: boolean }[];
}

export interface LiveBild {
  text: string;
}

export interface VorschlagBild {
  hauptzaehlerId: string;
  name: string;
  satz: string;
}

export interface HauptzaehlerBild {
  key: string;
  /** „Hauptzähler Halle 1 (HZ-1)“ - nie zweimal „Hauptzähler“. */
  titel: string;
  kennzeichen: string;
  /** Nur mit Zahl; ohne Zahl steht keine Live-Zeile. */
  live: LiveBild | null;
  vorschlag: VorschlagBild | null;
  /** Die schon geführte Messstelle des Teils ohne eigenen Zähler; `teile` halten ihr Kennzeichen am Stück. */
  restMessstelle: { text: string; teile: { text: string; kennzeichen: boolean }[]; sprung: Sprung | null } | null;
  /** Stellungswechsel: statt eines Antwortsatzes der Satz, dass jeder Tag für sich steht. */
  hinweis: string | null;
  abschnitte: AbschnittBild[];
}

export interface EnergiebilanzBild {
  zeitraum: string;
  /** Die Zone der Route (`Europe/Berlin`) - einmal am Fuß. */
  zone: string;
  /** Ein laufender Zeitraum: dieser Satz statt der Zeilen - nie eine Hochrechnung (E11). */
  laeuft: string | null;
  leer: Leerzustand | null;
  hauptzaehler: HauptzaehlerBild[];
}

export interface BilanzKontext {
  /** Heute in der Zone der Anlage (`JJJJ-MM-TT`). */
  heute: string;
  /** Die Herkunfts-Art je Kennzeichen aus dem Register - fehlt eine, steht kein Wort (nie geraten). */
  arten: ReadonlyMap<string, MessstellenArt>;
  /** Der Name je Kennzeichen aus dem Register - fehlt einer, steht nur das Kennzeichen. */
  namen?: ReadonlyMap<string, string>;
  /**
   * AP-13 IP-11 (D2): die Periode DIESER Fläche. Jeder Sprung einer Zeile nimmt sie mit - ohne sie
   * landet der Kunde auf der Messstelle bei einer anderen Zahl als der, auf die er geklickt hat.
   * `energiebilanzBild` setzt sie aus der Antwort; fehlt sie, springt die Zeile ohne Periode.
   */
  periode?: { art: 'tag' | 'monat' | 'jahr'; am: string } | null;
}

const periodeDes = (ctx: BilanzKontext): string | null => (ctx.periode ? periodeSchluessel(ctx.periode.art, ctx.periode.am) : null);

/**
 * AP-13 IP-11 (D1/D2): jeder Eingang einer Bilanz IST eine Messstelle - er springt auf ihre Seite im Abschnitt „Werte“
 * mit der Periode der Bilanz, gleich welches Kennzeichen-Präfix sie trägt (auch „AZ-2“, „HZ-1“).
 */
const messstellenSprung = (ctx: BilanzKontext, kennzeichen: string, version: number | null = null): Sprung | null =>
  sprungziel({ art: 'messstelle', id: kennzeichen, periode: periodeDes(ctx), version });

type Terme = BilanzAbschnitt['terme'];

const nameVon = (terme: Terme, kennzeichen: string): string | null =>
  terme.find((t) => t.messstelle === kennzeichen)?.name ?? null;

/** „Netzbezug Halle 2 (MS-10)“ · „Netzbezug Halle 2 (MS-10, Hauptzähler)“ · ohne Namen „MS-10“. */
const benannt = (name: string | null, kennzeichen: string, zusatz?: string): string => {
  const klammer = zusatz ? `${kennzeichen}, ${zusatz}` : kennzeichen;
  return name ? `${name} (${klammer})` : zusatz ? `${kennzeichen} (${zusatz})` : kennzeichen;
};

/** „(MS-14 fehlt)“ - dieselbe Form wie `anzeige` der Summe (`saetze.summe_mindestens`). */
const fehltText = (fehlend: string[]): string => `(${fehlend.join(', ')} ${fehlend.length === 1 ? 'fehlt' : 'fehlen'})`;

const tagText = (tag: string): string => {
  const [j, m, t] = tag.split('-');
  return `${t}.${m}.${j}`;
};

/** „04.11.2026“ · „01.10.–14.10.2026“ · „20.12.2026–10.01.2027“. */
export function spanneText(von: string, bis: string): string {
  if (von === bis) return tagText(von);
  if (von.slice(0, 4) === bis.slice(0, 4)) return `${tagText(von).slice(0, 6)}–${tagText(bis)}`;
  return `${tagText(von)}–${tagText(bis)}`;
}

/** „10:15“ am selben Tag, sonst „19.10.2026 10:15“ - die Uhr in der Zone der Route. */
export function standText(stand: string, zone: string, heute: string): string {
  const dz = datumZeit(stand, zone);
  const [datum, uhr] = dz.split(' ');
  return datum === tagText(heute) ? uhr : dz;
}

/** Die Periode eines Auslösers in Worten: „18.10.2026“ · „Oktober 2026“ · „2026“. */
const periodeWort = (schluessel: string): string => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(schluessel)) return tagText(schluessel);
  if (/^\d{4}-\d{2}$/.test(schluessel)) return zeitraumText('monat', `${schluessel}-01`);
  return schluessel;
};

/**
 * Der Auslöser einer Version (`BilanzwertHerkunft.ausloeser`: „correction MS-17 2026-10-18 Version 2“) in Worten -
 * die Werkstatt-Form erreicht nie den Bildschirm. Eine unbekannte Form bleibt weg, statt roh zu erscheinen.
 */
export function ausloeserText(ausloeser: string | null): string | null {
  const m = /^(correction|substitute) (.+) (\d{4}(?:-\d{2}){0,2}) Version \d+$/.exec(ausloeser ?? '');
  if (!m) return null;
  return fuelle(m[1] === 'correction' ? HERKUNFT_KORRIGIERT : HERKUNFT_ERSATZWERT, {
    messstellen: m[2],
    periode: periodeWort(m[3]),
  });
}

/** F3: „verteilt 100 % an Kostenstelle 4300“ - nur, wenn die Route eine Verteilung der ganzen Periode nennt. */
function verteilungText(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null;
  const { ziel, anteil_prozent } = v as { ziel?: unknown; anteil_prozent?: unknown };
  if (typeof ziel !== 'string' || (typeof anteil_prozent !== 'string' && typeof anteil_prozent !== 'number')) return null;
  return fuelle(HERKUNFT_VERTEILT, { anteil: String(anteil_prozent).replace('.', ','), ziel });
}

interface EingangZeile {
  messstelle: string;
  rolle: string | null;
  anteil: string | null;
  menge: string | number | null;
  zustand: string;
  version: number;
  kennzeichen: string[];
}

const ROLLE_WORT: Record<string, string> = { zufluss: ZEILE_WORT.zufluss, abfluss: ZEILE_WORT.abfluss, zugeordnet: ZEILE_WORT.zugeordnet };

function eingangText(e: EingangZeile, terme: Terme, ebene: string, ctx: BilanzKontext): string {
  return ohneLeere([
    benannt(nameVon(terme, e.messstelle), e.messstelle),
    e.rolle ? ROLLE_WORT[e.rolle] ?? null : null,
    e.anteil ? ANTEIL_WORT[e.anteil as BilanzEingang['anteil']] ?? null : null,
    ctx.arten.get(e.messstelle) ?? null,
    zahl(e.menge, 'kWh', ebene),
    e.zustand,
    fuelle(HERKUNFT_VERSION, { n: e.version }),
    ...e.kennzeichen,
  ]).join(' · ');
}

/**
 * AP-10 §5.6 - die Herkunfts-Karte des Rests aus `rest.herkunft {satz, fehlt}` (AP-10 IP-12): Formel-Fassung,
 * Eingänge in ihrer Version, Rechenzeitpunkt, Version und Auslöser. Ohne Satz stehen die Eingänge der Route selbst da
 * (dieselben Zahlen), und der Satz sagt, dass die Herkunft nicht vollständig ist.
 */
export function restHerkunft(
  herkunft: BilanzRest['herkunft'],
  eingaenge: BilanzEingang[],
  terme: Terme,
  ebene: string,
  zone: string,
  ctx: BilanzKontext,
): HerkunftBild {
  const satz = herkunft?.satz ?? null;
  if (!satz) {
    return herkunftMitStuecken(
      ohneLeere([BERECHNET_DIFFERENZ, herkunft && herkunft.fehlt.length > 0 ? HERKUNFT_UNVOLLSTAENDIG : null]),
      eingaenge.map((e) => eingangText(e, terme, ebene, ctx)),
      ctx,
      new Map(eingaenge.map((e) => [e.messstelle, e.version])),
    );
  }
  const formel = satz.formel_fassung;
  const berechnetAm = typeof satz.berechnet_am === 'string' && !Number.isNaN(Date.parse(satz.berechnet_am)) ? satz.berechnet_am : null;
  const version = typeof satz.version === 'number' ? satz.version : 1;
  const quelle = Array.isArray(satz.eingaenge) ? (satz.eingaenge as Array<Record<string, unknown>>) : [];
  const ausSatz = quelle.map(eingangDesSatzes);
  return herkunftMitStuecken(
    ohneLeere([
      ohneLeere([
        BERECHNET_DIFFERENZ,
        typeof formel === 'number'
          ? fuelle(HERKUNFT_FORMEL, { formel: fuelle(HERKUNFT_FASSUNG, { n: formel }) })
          : typeof formel === 'string'
            ? fuelle(HERKUNFT_FORMEL, { formel })
            : null,
      ]).join(' · '),
      verteilungText(satz.verteilung),
      berechnetAm ? fuelle(HERKUNFT_BERECHNET_AM, { am: datumZeit(berechnetAm, zone) }) : null,
      ohneLeere([fuelle(HERKUNFT_VERSION, { n: version }), ausloeserText(typeof satz.ausloeser === 'string' ? satz.ausloeser : null)]).join(' · '),
    ]),
    ausSatz.map((e) => eingangText(e, terme, ebene, ctx)),
    ctx,
    new Map(ausSatz.map((e) => [e.messstelle, e.version])),
    kostenstelleDerVerteilung(satz.verteilung),
  );
}

/** Ein Eingang des Herkunfts-Satzes in der Form, die {@link eingangText} liest - jedes Feld geprüft, nie geraten. */
function eingangDesSatzes(e: Record<string, unknown>): EingangZeile {
  return {
    messstelle: String(e.messstelle),
    rolle: typeof e.bilanz_rolle === 'string' ? e.bilanz_rolle : null,
    anteil: typeof e.anteil === 'string' ? e.anteil : null,
    menge: typeof e.menge === 'string' || typeof e.menge === 'number' ? e.menge : null,
    zustand: String(e.zustand),
    version: typeof e.version === 'number' ? e.version : 1,
    kennzeichen: Array.isArray(e.kennzeichen) ? e.kennzeichen.map(String) : [],
  };
}

/** Das Ziel einer Verteilung (`verteilung.ziel`) - die Kostenstelle, auf deren Karte die Zeile springt (D1). */
function kostenstelleDerVerteilung(v: unknown): string | null {
  if (v === null || typeof v !== 'object') return null;
  const ziel = (v as { ziel?: unknown }).ziel;
  return typeof ziel === 'string' && ziel.length > 0 ? ziel : null;
}

/**
 * AP-13 IP-11 (D1/D2): dieselben Zeilen mit ihren Kanten. Eine Messstelle springt mit der Periode der
 * Bilanz und ihrer eigenen Version; die Kostenstelle einer Verteilung steht als Zahl im Satz - sie hat
 * kein MS-/KZ-Kennzeichen und bekommt darum ihr Ziel gesagt, statt es aus dem Text zu lesen.
 */
function herkunftMitStuecken(
  zeilen: string[],
  eingaenge: string[],
  ctx: BilanzKontext,
  versionen: ReadonlyMap<string, number>,
  kostenstelle: string | null = null,
): HerkunftBild {
  const periode = periodeDes(ctx);
  const ziel = (kennzeichen: string) => kennzeichenSprung(kennzeichen, { periode, version: versionen.get(kennzeichen) ?? null });
  const ksSprung = kostenstelle
    ? sprungziel({ art: 'kostenstelle', kennzeichen: kostenstelle, periode: ctx.periode?.art ?? null, am: ctx.periode?.am ?? null })
    : null;
  return {
    zeilen,
    eingaenge,
    zeilenStuecke: zeilen.map((t) => (ksSprung ? mitKostenstelle(t, kostenstelle as string, ksSprung, ziel) : herkunftsZeile(t, ziel))),
    eingaengeStuecke: eingaenge.map((t) => herkunftsZeile(t, ziel)),
  };
}

/** Die Verteilungs-Zeile: ihre Kostenstellen-Nummer wird der Sprung, der Rest bleibt Satz. */
function mitKostenstelle(text: string, kennzeichen: string, sprung: Sprung, ziel: (k: string) => Sprung | null): Stueck[] {
  const von = text.lastIndexOf(kennzeichen);
  if (von < 0) return herkunftsZeile(text, ziel);
  return ohneLeere([
    von > 0 ? { text: text.slice(0, von), sprung: null } : null,
    { text: kennzeichen, sprung },
    von + kennzeichen.length < text.length ? { text: text.slice(von + kennzeichen.length), sprung: null } : null,
  ]);
}

/** Eine Menge der Route als Dezimalbetrag für den Zwilling; was kein Dezimaltext ist, bleibt `null` (nie geraten). */
function alsDez(menge: number | null): Dez | null {
  if (menge === null) return null;
  try {
    return dezVon(menge);
  } catch {
    return null;
  }
}

/** Der Anteil am Ganzen als Text des Zwillings („41.4“) - `null`, wenn Teil oder Ganzes fehlt oder das Ganze ≤ 0 ist. */
const anteilVon = (teil: number | null, ganz: Dez | null): string | null => prozent(alsDez(teil), ganz);

function teilBild(e: BilanzEingang, terme: Terme, hauptzaehler: string, ebene: string, ctx: BilanzKontext, ganz: Dez | null, am: string): TeilBild {
  const keineWerte = e.menge === null;
  const name = nameVon(terme, e.messstelle) ?? ctx.namen?.get(e.messstelle) ?? null;
  const anteil = e.rolle === 'zugeordnet' ? anteilVon(e.menge, ganz) : null;
  return {
    key: `${e.rolle}-${e.messstelle}-${e.anteil}`,
    kennzeichen: e.messstelle,
    name: benannt(name, e.messstelle, e.messstelle === hauptzaehler ? UEMS_HAUPTZAEHLER : undefined),
    nurName: name ?? e.messstelle,
    zahl: zahl(e.menge, 'kWh', ebene),
    woerter: einmal(ohneLeere([ANTEIL_WORT[e.anteil], e.zustand !== VOLLSTAENDIG ? e.zustand : null])),
    keineWerte,
    anteil: anteil === null ? null : `${prozentText(anteil)} ${am}`,
    // AP-13 IP-11 (D1/D2): der Unterzähler führt auf seine Seite - im Zeitraum, den die Bilanz-Leiste zeigt.
    sprung: messstellenSprung(ctx, e.messstelle),
  };
}

function summenZeile(
  art: 'zufluss' | 'abfluss' | 'zugeordnet',
  s: BilanzSumme,
  w: BilanzWerte,
  terme: Terme,
  hauptzaehler: string,
  ebene: string,
  ctx: BilanzKontext,
  ganz: Dez | null,
  am: string,
): ZeileBild | null {
  const eigene = w.eingaenge.filter((e) => e.rolle === art);
  const teile = eigene.map((e) => teilBild(e, terme, hauptzaehler, ebene, ctx, ganz, am));
  const herkunft: HerkunftBild = herkunftMitStuecken(
    [],
    eigene.map((e) => eingangText(e, terme, ebene, ctx)),
    ctx,
    new Map(eigene.map((e) => [e.messstelle, e.version])),
  );
  if (teile.length === 0) {
    // Ein Abfluss ohne Messstelle in der Stellung existiert nicht (Halle 2 hat keinen) - er FEHLT nicht, er ist keiner.
    if (art === 'abfluss') return null;
    return { art, wort: ZEILE_WORT[art], zahl: zahl(null, 'kWh', ebene), zusatz: null, woerter: [], ton: 'off', saetze: [], teile, herkunft };
  }
  const arten = new Set(teile.map((t) => ctx.arten.get(t.kennzeichen) ?? null));
  const herkunftWort = arten.size === 1 ? [...arten][0] : null;
  // Hat KEIN Eingang einen Wert, sagt die Route „keine Werte“ (Menge 0 der leeren Summe) - ein Strich, nie „mindestens 0“.
  const ohneZahl = s.menge === null || s.mit_werten === 0;
  return {
    art,
    wort: ZEILE_WORT[art],
    // „mindestens 1.055 kWh (MS-14 fehlt)“ ist `anzeige` der Route - wörtlich, nie nachgebaut.
    zahl: ohneZahl ? zahl(null, 'kWh', ebene) : s.anzeige ?? zahl(s.menge, 'kWh', ebene),
    zusatz: ohneZahl && s.fehlend.length > 0 ? fehltText(s.fehlend) : null,
    // „berechnet (Summe)“ trägt jede Summe der Route; die Zeile nennt statt dessen die Herkunft ihrer Eingänge (O5).
    woerter: einmal(ohneLeere([herkunftWort, s.zustand && s.zustand !== VOLLSTAENDIG ? s.zustand : null, ...s.kennzeichen.filter((k) => k !== BERECHNET_SUMME)])),
    ton: ohneZahl ? 'off' : s.anzeige || (s.zustand && s.zustand !== VOLLSTAENDIG) ? 'warn' : 'ok',
    saetze: [],
    teile,
    herkunft,
  };
}

function restZeile(w: BilanzWerte, terme: Terme, rest: BilanzMessstelleRef | null, ebene: string, zone: string, ctx: BilanzKontext, einfach: boolean): ZeileBild {
  const r = w.rest;
  const negativ = r.menge !== null && r.menge < 0;
  return {
    art: 'rest',
    wort: ZEILE_WORT.rest,
    zahl: zahl(r.menge, r.einheit, ebene),
    zusatz: r.menge === null && r.fehlend.length > 0 ? fehltText(r.fehlend) : rest ? benannt(rest.name, rest.kennzeichen) : null,
    // „nicht zugeordnet“ steht als Kennzeichen am Rest; die Zeile heißt „ohne eigenen Zähler“ - einmal genügt.
    woerter: einmal(ohneLeere([...r.kennzeichen.filter((k) => k !== NICHT_ZUGEORDNET), r.zustand !== VOLLSTAENDIG ? r.zustand : null])),
    ton: r.menge === null ? 'off' : negativ || r.zustand !== VOLLSTAENDIG ? 'warn' : 'ok',
    saetze: negativ ? ohneLeere([r.kundensatz, hilfeNegativ(einfach)]) : [],
    teile: [],
    herkunft: restHerkunft(r.herkunft, w.eingaenge, terme, ebene, zone, ctx),
  };
}

/** Nur der Hauptzähler zählt hinein, nichts hinaus: das Ganze ist der Bezug laut Hauptzähler. */
const istEinfach = (w: BilanzWerte, hauptzaehler: string): boolean =>
  w.eingaenge.every((e) => e.rolle !== 'abfluss' && (e.rolle !== 'zufluss' || (e.messstelle === hauptzaehler && e.anteil === 'gesamt')));

/** Eine Summe der Route ist nur dann ein Teil des Ganzen, wenn ihr kein Eingang fehlt. */
const vollstaendig = (s: BilanzSumme): boolean => s.menge !== null && s.fehlend.length === 0 && s.mit_werten === s.gesamt;

/**
 * Das Ganze der Karte als Dezimaltext: der Verbrauch der Anlage = Zufluss − Abfluss, gebildet vom Zwilling der Bewertung
 * (`nenner`, AP-16: Zufluss − Abgabe − Laden; die Route liefert Abgabe und Laden zusammen als Abfluss). Ohne Abfluss in
 * der Stellung ist der Abfluss keiner (0), nicht „fehlt“. `null`, sobald ein Eingang fehlt.
 */
function ganzesDer(w: BilanzWerte): string | null {
  const ohneAbfluss = w.abfluss.gesamt === 0;
  if (!vollstaendig(w.zufluss) || (!ohneAbfluss && !vollstaendig(w.abfluss))) return null;
  const abgabe = ohneAbfluss ? '0' : String(w.abfluss.menge);
  return nenner([{ kennung: 'anlage', hauptzaehler: true, zufluss: String(w.zufluss.menge), abgabe, laden: '0' }]).wert;
}

/** Die Unterzähler nach Menge absteigend (Vergleich der gelieferten Beträge, keine Rechnung); ohne Wert am Ende. */
function absteigend(teile: TeilBild[], w: BilanzWerte): TeilBild[] {
  const menge = new Map(w.eingaenge.filter((e) => e.rolle === 'zugeordnet').map((e) => [e.messstelle, alsDez(e.menge)]));
  const mit = teile.filter((t) => menge.get(t.kennzeichen));
  const ohne = teile.filter((t) => !menge.get(t.kennzeichen));
  return [...mit.sort((a, b) => dezVergleich(menge.get(b.kennzeichen) as Dez, menge.get(a.kennzeichen) as Dez)), ...ohne];
}

/** Die vier Zeilen eines Zeitraums - „ohne eigenen Zähler“ steht immer (auch 0, negativ oder ohne Zahl). */
export function zeilenBild(w: BilanzWerte, ab: BilanzAbschnitt, h: BilanzHauptzaehler, zone: string, ctx: BilanzKontext): ZeileBild[] {
  const hz = h.messstelle.kennzeichen;
  const ebene = ab.raster;
  const ganz = ganzesDer(w);
  const einfach = istEinfach(w, hz);
  const am = einfach ? ANTEIL_AM.bezug : ANTEIL_AM.verbrauch;
  const g = ganz === null ? null : dez(ganz);
  return ohneLeere([
    summenZeile('zufluss', w.zufluss, w, ab.terme, hz, ebene, ctx, g, am),
    summenZeile('abfluss', w.abfluss, w, ab.terme, hz, ebene, ctx, g, am),
    summenZeile('zugeordnet', w.zugeordnet, w, ab.terme, hz, ebene, ctx, g, am),
    restZeile(w, ab.terme, h.rest_messstelle, ebene, zone, ctx, einfach),
  ]);
}

/** Der Antwortsatz eines Zeitraums (Konzept a1 §6.9) - Richtung, Größe, Zeitraum; fehlend und negativ mit Grund. */
function antwortBild(w: BilanzWerte, zeilen: ZeileBild[], ganz: Dez | null, einfach: boolean, zeitraum: string, namen: (k: string) => string): AntwortBild {
  const r = w.rest;
  const rest = zeilen.find((z) => z.art === 'rest');
  const am = einfach ? ANTEIL_AM.bezug : ANTEIL_AM.verbrauch;
  if (r.menge === null) {
    // Ein, zwei fehlende Zähler beim Namen; mehr als zwei als Anzahl - die Namen stehen in den Zeilen darunter.
    if (w.eingaenge.length > 0 && w.eingaenge.every((e) => e.menge === null)) return { satz: fuelle(ANTWORT.keinZaehler, { zeitraum }), ton: 'off' };
    if (r.fehlend.length > 2) return { satz: fuelle(ANTWORT.fehltViele, { zeitraum, n: r.fehlend.length }), ton: 'off' };
    return r.fehlend.length > 0
      ? { satz: fuelle(ANTWORT.fehlt, { zeitraum, namen: r.fehlend.map(namen).join(', ') }), ton: 'off' }
      : { satz: fuelle(ANTWORT.keineWerte, { zeitraum }), ton: 'off' };
  }
  if (r.menge < 0) return { satz: hilfeNegativ(einfach), ton: 'warn' };
  const restZahl = rest?.zahl ?? zahl(r.menge, r.einheit, null);
  if (w.zugeordnet.gesamt === 0) return { satz: fuelle(ANTWORT.keinUnterzaehler, { am, rest: restZahl }), ton: 'ok' };
  if (r.menge === 0) return { satz: fuelle(ANTWORT.alles, { ganz: einfach ? GANZ_IM_SATZ.bezug : GANZ_IM_SATZ.verbrauch }), ton: 'ok' };
  const erfasst = anteilVon(w.zugeordnet.menge, ganz);
  return erfasst === null
    ? { satz: fuelle(ANTWORT.ohneAnteil, { rest: restZahl }), ton: 'ok' }
    : { satz: fuelle(ANTWORT.erfasst, { prozent: prozentText(erfasst), am, rest: restZahl }), ton: 'ok' };
}

/** Die drei Zeilen der Karte aus den vier Zeilen der Route. */
function kartenZeilen(w: BilanzWerte, zeilen: ZeileBild[], ganzText: string | null, einfach: boolean, ebene: string): KartenZeile[] {
  const zeile = (art: ZeileArt) => zeilen.find((z) => z.art === art);
  const zufluss = zeile('zufluss');
  const abfluss = zeile('abfluss');
  const erfasst = zeile('zugeordnet');
  const rest = zeile('rest');
  const n = w.zugeordnet.gesamt;
  const ganz: KartenZeile = einfach
    ? { art: 'ganz', wort: KARTE_WORT.bezug, zahl: zufluss?.zahl ?? zahl(null, 'kWh', ebene), ton: zufluss?.ton ?? 'off', unter: ohneLeere([zufluss?.zusatz]) }
    : {
        art: 'ganz',
        wort: KARTE_WORT.verbrauch,
        zahl: zahl(ganzText, 'kWh', ebene),
        ton: ganzText === null ? 'off' : 'ok',
        unter: [fuelle(VERBRAUCH_AUS, { zufluss: zufluss?.zahl ?? zahl(null, 'kWh', ebene), abfluss: abfluss?.zahl ?? zahl(0, 'kWh', ebene) })],
      };
  return [
    ganz,
    {
      art: 'erfasst',
      wort: n === 0 ? KARTE_WORT.erfasst.keiner : n === 1 ? KARTE_WORT.erfasst.singular : fuelle(KARTE_WORT.erfasst.plural, { n }),
      zahl: erfasst?.zahl ?? zahl(null, 'kWh', ebene),
      ton: erfasst?.ton ?? 'off',
      unter: n === 0 ? [KEIN_UNTERZAEHLER] : ohneLeere([erfasst?.zusatz, ...(erfasst?.woerter ?? []).filter((x) => x !== 'gemessen' && x !== 'berechnet')]),
    },
    {
      art: 'ohne',
      wort: KARTE_WORT.ohne,
      zahl: rest?.zahl ?? zahl(null, 'kWh', ebene),
      ton: rest?.ton ?? 'off',
      // „berechnet (Differenz)“ steht in „Woraus gerechnet“; unter der Zeile nur, was der Kunde wissen muss.
      unter: ohneLeere([
        w.rest.menge === null && w.rest.fehlend.length > 0 ? fehltText(w.rest.fehlend) : null,
        ...(rest?.woerter ?? []).filter((x) => x !== BERECHNET_DIFFERENZ),
        ...(rest?.saetze ?? []).filter((x) => x !== hilfeNegativ(einfach)),
      ]),
    },
  ];
}

function tagBild(w: BilanzWerte, ab: BilanzAbschnitt, h: BilanzHauptzaehler, zone: string, ctx: BilanzKontext, titel: string | null, kompakt: boolean, zeitraum: string): TagBild {
  const zeilen = zeilenBild(w, ab, h, zone, ctx);
  const hz = h.messstelle.kennzeichen;
  const einfach = istEinfach(w, hz);
  const ganzText = ganzesDer(w);
  const ganz = ganzText === null ? null : dez(ganzText);
  const erfasst = w.zugeordnet.gesamt === 0 ? '0.0' : vollstaendig(w.zugeordnet) ? anteilVon(w.zugeordnet.menge, ganz) : null;
  const ohne = w.rest.menge !== null && w.rest.menge >= 0 ? anteilVon(w.rest.menge, ganz) : null;
  const namen = (k: string) => {
    const n = nameVon(ab.terme, k) ?? ctx.namen?.get(k) ?? null;
    return n ? `${n} (${k})` : k;
  };
  return {
    key: w.von,
    titel,
    kompakt,
    einfach,
    antwort: antwortBild(w, zeilen, ganz, einfach, zeitraum, namen),
    karte: kartenZeilen(w, zeilen, ganzText, einfach, ab.raster),
    balken: erfasst !== null && ohne !== null ? { erfasst, ohne } : null,
    unterzaehler: absteigend(zeilen.find((z) => z.art === 'zugeordnet')?.teile ?? [], w),
    zeilen,
    kennzeichen: einmal([hz, ...ab.terme.map((t) => t.messstelle), ...w.eingaenge.map((e) => e.messstelle)]),
  };
}

/** „jetzt 1,6 kW ohne eigenen Zähler · Stand 10:15“ - nur mit Zahl; ohne Zahl keine Zeile, nie 0 (O8). */
export function liveBild(live: BilanzLive, zone: string, ctx: Pick<BilanzKontext, 'heute'>): LiveBild | null {
  if (live.wert === null) return null;
  return {
    text: ohneLeere([
      fuelle(LIVE_JETZT, { zahl: zahl(live.wert, live.einheit, null) }),
      live.stand ? fuelle(LIVE_STAND, { stand: standText(live.stand, zone, ctx.heute) }) : null,
    ]).join(' · '),
  };
}

/** „Hauptzähler Halle 1 (HZ-1)“ - trägt der Name das Wort schon, steht es nicht zweimal davor. */
export function hauptzaehlerTitel(name: string | null, kennzeichen: string): string {
  const b = benannt(name, kennzeichen);
  return name && name.toLocaleLowerCase('de-DE').startsWith(UEMS_HAUPTZAEHLER.toLocaleLowerCase('de-DE')) ? b : `${UEMS_HAUPTZAEHLER} ${b}`;
}

function hauptzaehlerBild(h: BilanzHauptzaehler, b: Bilanz, ctx: BilanzKontext): HauptzaehlerBild {
  const zone = b.zeitzone;
  const heutigeTerme = h.abschnitte[h.abschnitte.length - 1]?.terme ?? [];
  const mehrere = h.stellung_geaendert || h.abschnitte.length > 1;
  const zeitraum = zeitraumText(b.periode, b.von);
  const rest = h.rest_messstelle;
  return {
    key: h.messstelle.id,
    kennzeichen: h.messstelle.kennzeichen,
    titel: hauptzaehlerTitel(nameVon(heutigeTerme, h.messstelle.kennzeichen) ?? h.messstelle.name, h.messstelle.kennzeichen),
    live: liveBild(h.live, zone, ctx),
    vorschlag: h.vorschlag
      ? { hauptzaehlerId: h.vorschlag.hauptzaehler_id, name: h.vorschlag.name, satz: fuelle(REST_VORSCHLAG, { name: h.vorschlag.name }) }
      : null,
    restMessstelle: rest ? restMessstelleBild(rest, ctx) : null,
    hinweis: mehrere ? STELLUNG_GEAENDERT : null,
    abschnitte: h.abschnitte.map((ab, i) => ({
      key: `${ab.von}-${i}`,
      titel: mehrere ? spanneText(ab.von, ab.bis) : null,
      tage: ab.werte.map((w) => {
        const eigenerTitel = mehrere || ab.werte.length > 1;
        return tagBild(w, ab, h, zone, ctx, eigenerTitel ? spanneText(w.von, w.bis) : null, ab.werte.length > 1, eigenerTitel ? spanneText(w.von, w.bis) : zeitraum);
      }),
      geteilt: (ab.geteilte_register ?? []).map((g) => uemsGeteiltSatz(g.messstellen)),
      ausserhalb: ausserhalbSatz(ab.ausserhalb ?? [], ctx),
    })),
  };
}

function restMessstelleBild(rest: BilanzMessstelleRef, ctx: BilanzKontext): NonNullable<HauptzaehlerBild['restMessstelle']> {
  const text = fuelle(REST_GEFUEHRT, { name: benannt(rest.name, rest.kennzeichen) });
  return { text, teile: kennzeichenTeile(text, [rest.kennzeichen]), sprung: messstellenSprung(ctx, rest.kennzeichen) };
}

/** Die Abzweige außerhalb der Bilanz als ein Satz mit Namen und Kennzeichen; `null` ohne Abzweig. */
export function ausserhalbSatz(kennzeichen: readonly string[], ctx: Pick<BilanzKontext, 'namen'>): AusserhalbBild | null {
  if (kennzeichen.length === 0) return null;
  const namen = kennzeichen.map((k) => {
    const name = ctx.namen?.get(k);
    return name && name !== k ? `${name} (${k})` : k;
  });
  const satz = fuelle(kennzeichen.length === 1 ? AUSSERHALB_SATZ.singular : AUSSERHALB_SATZ.plural, { n: kennzeichen.length, namen: namen.join(', ') });
  return { satz, teile: kennzeichenTeile(satz, kennzeichen) };
}

/**
 * Teilt einen Satz an den genannten Kennzeichen; die Fläche setzt jedes Kennzeichen-Stück ohne Umbruch. Ein Kennzeichen
 * zählt nur als ganzes Wort: „MS-2“ trifft nicht den Anfang von „MS-20“.
 */
export function kennzeichenTeile(satz: string, kennzeichen: readonly string[]): { text: string; kennzeichen: boolean }[] {
  const muster = [...new Set(kennzeichen)].filter(Boolean);
  if (muster.length === 0) return [{ text: satz, kennzeichen: false }];
  const trenner = new RegExp(`(?<![\\p{L}\\p{N}-])(${muster.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\p{L}\\p{N}-])`, 'u');
  return satz
    .split(trenner)
    .filter((t) => t !== '')
    .map((text) => ({ text, kennzeichen: muster.includes(text) }));
}

/** Der Satz für einen Zeitraum ohne Abschluss: läuft noch, oder hat (nach der Uhr des Browsers) noch nicht begonnen. */
function offenSatz(b: Bilanz, heute: string): string | null {
  if (!laeuftNoch(b.periode, b.von, heute)) return null;
  const zeitraum = zeitraumText(b.periode, b.von);
  return b.von > heute ? fuelle(OFFEN_SATZ.kommt, { zeitraum }) : fuelle(OFFEN_SATZ.laeuft, { zeitraum, einheit: EINHEIT_IM_SATZ[b.periode] });
}

/** Die ganze Fläche einer Antwort: Leerzustand ohne Hauptzähler, je Hauptzähler Antwort, Karte, Unterzähler, Herkunft. */
export function energiebilanzBild(b: Bilanz, ctx: BilanzKontext): EnergiebilanzBild {
  // AP-13 IP-11 (D2): die Periode der ANTWORT - nicht die der Leiste, die schon weitergeklickt sein kann.
  // Sie hängt an jedem Sprung dieser Fläche, damit die Messstelle dieselbe Zahl zeigt wie die Zeile.
  const mitPeriode: BilanzKontext = { ...ctx, periode: { art: b.periode, am: b.am } };
  return {
    zeitraum: zeitraumText(b.periode, b.von),
    zone: b.zeitzone,
    laeuft: offenSatz(b, ctx.heute),
    leer: b.hauptzaehler.length === 0 ? OHNE_HAUPTZAEHLER : null,
    hauptzaehler: b.hauptzaehler.map((h) => hauptzaehlerBild(h, b, mitPeriode)),
  };
}

/** Die Rückmeldung nach „Als eigene Messstelle führen“ - `neu = false` sagt, dass es sie schon gab (nie eine zweite). */
export const restAngelegtSatz = (neu: boolean, kennzeichen: string, name: string | null): string =>
  fuelle(neu ? REST_ANGELEGT : REST_GAB_ES_SCHON, { kennzeichen, name: name ?? kennzeichen });
