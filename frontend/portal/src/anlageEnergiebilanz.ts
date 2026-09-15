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
import { UEMS_HAUPTZAEHLER, UEMS_NOCH_NICHT_GERECHNET_SATZ } from './glossar';
import { anlageRoute, hashForRoute } from './nav';
import { datumZeit } from './rechte';
import type { AnlageSurface } from './surface';
import { beginn, laeuftNoch, letzterGebildeter, zeitraumText, type BilanzPeriode } from './uebersichtBausteine';
import { BERECHNET_DIFFERENZ, BERECHNET_SUMME, NICHT_ZUGEORDNET, VOLLSTAENDIG } from './uemsBilanz';
import { zahl } from './uemsErgebnis';
import { OHNE_HAUPTZAEHLER, type Leerzustand } from './uemsOberflaechen';

/**
 * Die Energiebilanz je Anlage (UEMS AP-13 IP-8 = AP-10 IP-14, E7 = A, B1/B2) — der Reiter „Energiebilanz“ im Bereich
 * „Verlauf“ einer Anlage, rein abgeleitet aus `GET /api/v1/sites/{id}/bilanz` (AP-10 IP-9/IP-12).
 *
 * ⚠ **Keine Rechnung.** Jede Zahl ist ein Feld der Route: Zufluss/Abfluss/zugeordnet sind `werte.*.menge` (und
 * „mindestens …“ ist `anzeige` wörtlich), „nicht zugeordnet“ ist `rest.menge` mit `rest.kundensatz`. Das Portal
 * formatiert nur über `uemsErgebnis.zahl` (E11). Die einzige Division ist die LÄNGE eines Anteils-Balkens gegen den
 * Zufluss (B2) — Zeichnung, nie eine angezeigte Zahl, nie eine Prozentzahl.
 *
 * ⚠ **„Nicht zugeordnet“ ist eine Aussage, keine Fehlerzeile:** die Zeile steht IMMER, auch mit 0 kWh, negativ mit dem
 * Satz der Route, ohne Zahl als „— keine Werte“ mit dem fehlenden Eingang (AP-10 §4.9 Punkt 2–4).
 *
 * ⚠ **Stellungswechsel:** die Route liefert dann Abschnitte Tag für Tag (`raster = tag`). Sie stehen untereinander,
 * jeder Tag für sich — nie zusammengerechnet, nie gemittelt (AP-13 B1, AP-10 IP-9 Falle 2).
 */

export const ENERGIEBILANZ_SUB = 'energiebilanz' as const;

// ------------------------------------------------------------------------------------------------ Wörter

export const ZEILE_WORT = {
  zufluss: 'Zufluss',
  abfluss: 'Abfluss',
  zugeordnet: 'Zugeordnet',
  rest: 'Nicht zugeordnet',
} as const;
export type ZeileArt = keyof typeof ZEILE_WORT;

/** Die Herkunfts-Art einer Messstelle, wie das Register sie nennt (`MessstelleRegisterZeile.art`). */
export type MessstellenArt = 'gemessen' | 'berechnet';

/** Speicher-Anteile als zwei Zeilen (AP-10 E4): das Wort des Anteils, nie eine saldierte Zahl. */
export const ANTEIL_WORT: Record<BilanzEingang['anteil'], string | null> = {
  gesamt: null,
  positiv: 'positiver Anteil',
  negativ: 'negativer Anteil',
};

export const UNTERZAEHLER_ANZAHL = '{n} Unterzähler';
export const MESSSTELLEN_ANZAHL = { singular: '{n} Messstelle', plural: '{n} Messstellen' } as const;
export const KEIN_UNTERZAEHLER = 'kein Unterzähler in der Stellung';
/** AP-10 §5.2 (F6): der Hilfe-Satz zum negativen Rest — er nennt keine Ursache. */
export const HILFE_NEGATIV = 'Die Unterzähler zählen mehr als der Hauptzähler. VoltPilot nennt keine Ursache.';

export const LIVE_JETZT = 'jetzt: {zahl} nicht zugeordnet';
export const LIVE_OHNE_ZAHL = 'jetzt: —';
export const LIVE_STAND = 'Stand {stand}';
/** AP-13 §5.8: der Grund-Satz je `fehlende[].grund` der Live-Zeile, mit dem Namen der Messstelle. */
export const LIVE_GRUND: Record<BilanzLive['fehlende'][number]['grund'], string> = {
  kein_geraet: '{name} hat kein Gerät',
  kein_wert: '{name} hat noch keinen Wert',
  veraltet: '{name} meldet sich gerade nicht',
};

/** Die Route nennt die Zone, aber nicht, woher sie kommt — darum ohne Klammer (Befund, siehe Wegweiser). */
export const ZONE_SATZ = 'Zeiten in {zone}';
export const STELLUNG_GEAENDERT =
  'Die Stellung hat sich in diesem Zeitraum geändert. Jeder Abschnitt steht für sich, Tag für Tag — nie zusammengerechnet.';

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

export const REST_VORSCHLAG = 'Für „nicht zugeordnet“ gibt es noch keine eigene Messstelle. Vorschlag: „{name}“ anlegen.';
export const REST_ANLEGEN = 'Rest anlegen';
export const REST_OHNE_RECHT = 'Eine Messstelle für den Rest legt an, wer berechnete Messstellen anlegen darf.';
export const REST_ANGELEGT = '{kennzeichen} „{name}“ ist angelegt.';
export const REST_GAB_ES_SCHON = '{kennzeichen} „{name}“ gab es schon.';
export const REST_NICHT_ANGELEGT = 'Der Rest konnte nicht angelegt werden.';
/** AP-10 §5.9 — die Ablehnung `rest_ohne_hauptzaehler` von `POST …/bilanz/rest`. */
export const REST_OHNE_HAUPTZAEHLER_SATZ = 'Für diese Anlage gibt es keinen Hauptzähler — ohne ihn keine Bilanz.';

/** Seit AP-03 IP-6 trägt jede Schreibroute ihre Kennung — das Portal fragt sie, statt zu raten. */
export const RECHT_REST_ANLEGEN = 'messstelle.formel';
export const RECHT_STELLUNG = 'messstelle.bearbeiten';

const fuelle = (vorlage: string, werte: Record<string, string | number>): string =>
  vorlage.replace(/\{([a-z_]+)\}/g, (_, k: string) => String(werte[k] ?? `{${k}}`));

const ohneLeere = <T>(xs: Array<T | null | undefined | false>): T[] => xs.filter((x): x is T => x != null && x !== false);
const einmal = (xs: string[]): string[] => [...new Set(xs)];

// ------------------------------------------------------------------------------------ Reiter und Adresse

/** Der Reiter erscheint nur mit Hauptzähler in der Stellung (AP-13 §5.5) — sonst bleibt der Verlauf zeichengleich. */
export const hatHauptzaehler = (b: Bilanz | null | undefined): boolean => (b?.hauptzaehler.length ?? 0) > 0;

/** Die Projektion mit dem Reiter — derselbe Fakt in `useAnlageSurface` und auf der Bühne. */
export const mitEnergiebilanz = (surface: AnlageSurface, bilanz: Bilanz | null): AnlageSurface =>
  hatHauptzaehler(bilanz) ? { ...surface, energiebilanz: true } : surface;

const PERIODEN: readonly BilanzPeriode[] = ['tag', 'monat', 'jahr'];

/** `#/anlage/{id}/energiebilanz?periode=monat&am=2026-10-01` — ein Lesezeichen hält den Zeitraum. */
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

/** Der Standort einer Anlage aus `GET /funktionen` — dieselbe Zuordnung wie `anlageGeld.anlageAufEbene`. */
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

/** Ein Eingang unter seiner Zeile (Unterzähler, Erzeuger, Speicher-Anteil). */
export interface TeilBild {
  key: string;
  kennzeichen: string;
  name: string;
  zahl: string;
  woerter: string[];
  keineWerte: boolean;
  /** B2: Länge gegen den Zufluss (0 … 1) — nur zugeordnet, nur mit Werten; `null` = kein Balken, sondern das Wort. */
  balken: number | null;
}

/** Die Herkunfts-Karte einer Zeile (AP-10 §5.6): Kopfzeilen und je Eingang eine Zeile mit Version. */
export interface HerkunftBild {
  zeilen: string[];
  eingaenge: string[];
}

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

export interface TagBild {
  key: string;
  /** Nur bei Stellungswechsel: der Tag über seinen Zeilen. */
  titel: string | null;
  /** Tag für Tag ohne Teile — die Eingänge stehen in der Herkunft. */
  kompakt: boolean;
  zeilen: ZeileBild[];
}

export interface AbschnittBild {
  key: string;
  titel: string | null;
  tage: TagBild[];
}

export interface LiveBild {
  text: string;
  ton: Ton;
}

export interface VorschlagBild {
  hauptzaehlerId: string;
  name: string;
  satz: string;
}

export interface HauptzaehlerBild {
  key: string;
  titel: string;
  live: LiveBild;
  vorschlag: VorschlagBild | null;
  hinweis: string | null;
  abschnitte: AbschnittBild[];
}

export interface EnergiebilanzBild {
  zeitraum: string;
  zone: string;
  /** Ein laufender Zeitraum: dieser Satz statt der Zeilen — nie eine Hochrechnung (E11). */
  laeuft: string | null;
  leer: Leerzustand | null;
  hauptzaehler: HauptzaehlerBild[];
}

export interface BilanzKontext {
  /** Heute in der Zone der Anlage (`JJJJ-MM-TT`). */
  heute: string;
  /** Die Herkunfts-Art je Kennzeichen aus dem Register — fehlt eine, steht kein Wort (nie geraten). */
  arten: ReadonlyMap<string, MessstellenArt>;
}

type Terme = BilanzAbschnitt['terme'];

const nameVon = (terme: Terme, kennzeichen: string): string | null =>
  terme.find((t) => t.messstelle === kennzeichen)?.name ?? null;

/** „Netzbezug Halle 2 (MS-10)“ · „Netzbezug Halle 2 (MS-10, Hauptzähler)“ · ohne Namen „MS-10“. */
const benannt = (name: string | null, kennzeichen: string, zusatz?: string): string => {
  const klammer = zusatz ? `${kennzeichen}, ${zusatz}` : kennzeichen;
  return name ? `${name} (${klammer})` : zusatz ? `${kennzeichen} (${zusatz})` : kennzeichen;
};

/** „(MS-14 fehlt)“ — dieselbe Form wie `anzeige` der Summe (`saetze.summe_mindestens`). */
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

/** „10:15“ am selben Tag, sonst „19.10.2026 10:15“ — die Uhr in der Zone der Route. */
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
 * Der Auslöser einer Version (`BilanzwertHerkunft.ausloeser`: „correction MS-17 2026-10-18 Version 2“) in Worten —
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

/** F3: „verteilt 100 % an Kostenstelle 4300“ — nur, wenn die Route eine Verteilung der ganzen Periode nennt. */
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
 * AP-10 §5.6 — die Herkunfts-Karte des Rests aus `rest.herkunft {satz, fehlt}` (AP-10 IP-12): Formel-Fassung,
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
    return {
      zeilen: ohneLeere([BERECHNET_DIFFERENZ, herkunft && herkunft.fehlt.length > 0 ? HERKUNFT_UNVOLLSTAENDIG : null]),
      eingaenge: eingaenge.map((e) => eingangText(e, terme, ebene, ctx)),
    };
  }
  const formel = satz.formel_fassung;
  const berechnetAm = typeof satz.berechnet_am === 'string' && !Number.isNaN(Date.parse(satz.berechnet_am)) ? satz.berechnet_am : null;
  const version = typeof satz.version === 'number' ? satz.version : 1;
  const quelle = Array.isArray(satz.eingaenge) ? (satz.eingaenge as Array<Record<string, unknown>>) : [];
  return {
    zeilen: ohneLeere([
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
    eingaenge: quelle.map((e) =>
      eingangText(
        {
          messstelle: String(e.messstelle),
          rolle: typeof e.bilanz_rolle === 'string' ? e.bilanz_rolle : null,
          anteil: typeof e.anteil === 'string' ? e.anteil : null,
          menge: typeof e.menge === 'string' || typeof e.menge === 'number' ? e.menge : null,
          zustand: String(e.zustand),
          version: typeof e.version === 'number' ? e.version : 1,
          kennzeichen: Array.isArray(e.kennzeichen) ? e.kennzeichen.map(String) : [],
        },
        terme,
        ebene,
        ctx,
      ),
    ),
  };
}

function teilBild(e: BilanzEingang, terme: Terme, hauptzaehler: string, zufluss: number | null, ebene: string, ctx: BilanzKontext): TeilBild {
  const keineWerte = e.menge === null;
  return {
    key: `${e.rolle}-${e.messstelle}-${e.anteil}`,
    kennzeichen: e.messstelle,
    name: benannt(nameVon(terme, e.messstelle), e.messstelle, e.messstelle === hauptzaehler ? UEMS_HAUPTZAEHLER : undefined),
    zahl: zahl(e.menge, 'kWh', ebene),
    woerter: einmal(
      ohneLeere([ctx.arten.get(e.messstelle), ANTEIL_WORT[e.anteil], e.zustand !== VOLLSTAENDIG ? e.zustand : null, ...e.kennzeichen]),
    ),
    keineWerte,
    // B2: Zeichnung gegen den Zufluss — ein negativer oder übergroßer Wert füllt höchstens die Bahn (MiniShareBar klemmt).
    balken: e.rolle === 'zugeordnet' && e.menge !== null && zufluss !== null && zufluss > 0 ? Math.max(0, e.menge) / zufluss : null,
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
): ZeileBild | null {
  const teile = w.eingaenge.filter((e) => e.rolle === art).map((e) => teilBild(e, terme, hauptzaehler, w.zufluss.menge, ebene, ctx));
  const herkunft: HerkunftBild = { zeilen: [], eingaenge: w.eingaenge.filter((e) => e.rolle === art).map((e) => eingangText(e, terme, ebene, ctx)) };
  if (teile.length === 0) {
    // Ein Abfluss ohne Messstelle in der Stellung existiert nicht (Halle 2 hat keinen) — er FEHLT nicht, er ist keiner.
    if (art === 'abfluss') return null;
    return { art, wort: ZEILE_WORT[art], zahl: zahl(null, 'kWh', ebene), zusatz: KEIN_UNTERZAEHLER, woerter: [], ton: 'off', saetze: [], teile, herkunft };
  }
  const arten = new Set(teile.map((t) => ctx.arten.get(t.kennzeichen) ?? null));
  const herkunftWort = arten.size === 1 ? [...arten][0] : null;
  const anzahl =
    teile.length === 1
      ? teile[0].name
      : art === 'zugeordnet'
        ? fuelle(UNTERZAEHLER_ANZAHL, { n: teile.length })
        : fuelle(MESSSTELLEN_ANZAHL.plural, { n: teile.length });
  // Hat KEIN Eingang einen Wert, sagt die Route „keine Werte“ (Menge 0 der leeren Summe) — ein Strich, nie „mindestens 0“.
  const ohneZahl = s.menge === null || s.mit_werten === 0;
  return {
    art,
    wort: ZEILE_WORT[art],
    // „mindestens 1.055 kWh (MS-14 fehlt)“ ist `anzeige` der Route — wörtlich, nie nachgebaut.
    zahl: ohneZahl ? zahl(null, 'kWh', ebene) : s.anzeige ?? zahl(s.menge, 'kWh', ebene),
    zusatz: ohneZahl && s.fehlend.length > 0 ? fehltText(s.fehlend) : s.anzeige && !ohneZahl ? null : anzahl,
    // „berechnet (Summe)“ trägt jede Summe der Route; die Zeile nennt statt dessen die Herkunft ihrer Eingänge (O5).
    woerter: einmal(ohneLeere([herkunftWort, s.zustand && s.zustand !== VOLLSTAENDIG ? s.zustand : null, ...s.kennzeichen.filter((k) => k !== BERECHNET_SUMME)])),
    ton: ohneZahl ? 'off' : s.anzeige || (s.zustand && s.zustand !== VOLLSTAENDIG) ? 'warn' : 'ok',
    saetze: [],
    teile,
    herkunft,
  };
}

function restZeile(w: BilanzWerte, terme: Terme, rest: BilanzMessstelleRef | null, ebene: string, zone: string, ctx: BilanzKontext): ZeileBild {
  const r = w.rest;
  const negativ = r.menge !== null && r.menge < 0;
  return {
    art: 'rest',
    wort: ZEILE_WORT.rest,
    zahl: zahl(r.menge, r.einheit, ebene),
    zusatz: r.menge === null && r.fehlend.length > 0 ? fehltText(r.fehlend) : rest ? benannt(rest.name, rest.kennzeichen) : null,
    // „nicht zugeordnet“ steht als Kennzeichen am Rest UND ist das Wort der Zeile — einmal genügt.
    woerter: einmal(ohneLeere([...r.kennzeichen.filter((k) => k !== NICHT_ZUGEORDNET), r.zustand !== VOLLSTAENDIG ? r.zustand : null])),
    ton: r.menge === null ? 'off' : negativ || r.zustand !== VOLLSTAENDIG ? 'warn' : 'ok',
    saetze: negativ ? ohneLeere([r.kundensatz, HILFE_NEGATIV]) : [],
    teile: [],
    herkunft: restHerkunft(r.herkunft, w.eingaenge, terme, ebene, zone, ctx),
  };
}

/** Die vier Zeilen eines Zeitraums — „nicht zugeordnet“ steht immer (auch 0, negativ oder ohne Zahl). */
export function zeilenBild(w: BilanzWerte, ab: BilanzAbschnitt, h: BilanzHauptzaehler, zone: string, ctx: BilanzKontext): ZeileBild[] {
  const hz = h.messstelle.kennzeichen;
  const ebene = ab.raster;
  return ohneLeere([
    summenZeile('zufluss', w.zufluss, w, ab.terme, hz, ebene, ctx),
    summenZeile('abfluss', w.abfluss, w, ab.terme, hz, ebene, ctx),
    summenZeile('zugeordnet', w.zugeordnet, w, ab.terme, hz, ebene, ctx),
    restZeile(w, ab.terme, h.rest_messstelle, ebene, zone, ctx),
  ]);
}

/** O8 — „jetzt: 1,6 kW nicht zugeordnet · Stand 10:15“; ohne Zahl ein Strich mit dem Grund je fehlendem Term, nie 0. */
export function liveBild(live: BilanzLive, terme: Terme, zone: string, ctx: BilanzKontext): LiveBild {
  if (live.wert !== null) {
    return {
      text: ohneLeere([
        fuelle(LIVE_JETZT, { zahl: zahl(live.wert, live.einheit, null) }),
        live.stand ? fuelle(LIVE_STAND, { stand: standText(live.stand, zone, ctx.heute) }) : null,
      ]).join(' · '),
      ton: 'ok',
    };
  }
  const gruende = live.fehlende.map((f) => fuelle(LIVE_GRUND[f.grund] ?? LIVE_GRUND.kein_wert, { name: nameVon(terme, f.term) ?? f.term }));
  return { text: [LIVE_OHNE_ZAHL, ...gruende].join(' · '), ton: 'off' };
}

function hauptzaehlerBild(h: BilanzHauptzaehler, zone: string, ctx: BilanzKontext): HauptzaehlerBild {
  const heutigeTerme = h.abschnitte[h.abschnitte.length - 1]?.terme ?? [];
  const mehrere = h.stellung_geaendert || h.abschnitte.length > 1;
  return {
    key: h.messstelle.id,
    titel: `${UEMS_HAUPTZAEHLER} ${benannt(nameVon(heutigeTerme, h.messstelle.kennzeichen) ?? h.messstelle.name, h.messstelle.kennzeichen)}`,
    live: liveBild(h.live, heutigeTerme, zone, ctx),
    vorschlag: h.vorschlag
      ? { hauptzaehlerId: h.vorschlag.hauptzaehler_id, name: h.vorschlag.name, satz: fuelle(REST_VORSCHLAG, { name: h.vorschlag.name }) }
      : null,
    hinweis: mehrere ? STELLUNG_GEAENDERT : null,
    abschnitte: h.abschnitte.map((ab, i) => ({
      key: `${ab.von}-${i}`,
      titel: mehrere ? spanneText(ab.von, ab.bis) : null,
      tage: ab.werte.map((w) => ({
        key: w.von,
        titel: mehrere || ab.werte.length > 1 ? spanneText(w.von, w.bis) : null,
        kompakt: ab.werte.length > 1,
        zeilen: zeilenBild(w, ab, h, zone, ctx),
      })),
    })),
  };
}

/** Die ganze Fläche einer Antwort: Kopf, Leerzustand ohne Hauptzähler, je Hauptzähler Live-Zeile, Vorschlag, Abschnitte. */
export function energiebilanzBild(b: Bilanz, ctx: BilanzKontext): EnergiebilanzBild {
  return {
    zeitraum: zeitraumText(b.periode, b.von),
    zone: fuelle(ZONE_SATZ, { zone: b.zeitzone }),
    laeuft: laeuftNoch(b.periode, b.von, ctx.heute) ? UEMS_NOCH_NICHT_GERECHNET_SATZ : null,
    leer: b.hauptzaehler.length === 0 ? OHNE_HAUPTZAEHLER : null,
    hauptzaehler: b.hauptzaehler.map((h) => hauptzaehlerBild(h, b.zeitzone, ctx)),
  };
}

/** Die Rückmeldung nach „Rest anlegen“ — `neu = false` sagt, dass es ihn schon gab (nie ein zweiter). */
export const restAngelegtSatz = (neu: boolean, kennzeichen: string, name: string | null): string =>
  fuelle(neu ? REST_ANGELEGT : REST_GAB_ES_SCHON, { kennzeichen, name: name ?? kennzeichen });
