/**
 * Das PORTFOLIO-COCKPIT, reine Hälfte (Anwendungs-Programm Stufe 4; Scout
 * `data/vp-portal-zielbild-anwendungen` §3.5 / §4.3 Fall C, Captain-Entscheide
 * E1 + E5 vom 24.08.2026).
 *
 * Bis hierher gab es ZWEI Flotten-Flächen mit derselben Grammatik und
 * verschiedener Komposition: die feste `PortfolioPage` (Geld- und
 * Speicher-Kacheln zuerst, unabänderlich) für Betreiber und die ruhige
 * `FleetUebersicht` für Endkunden ab zwei Anlagen. Für einen Kunden mit drei
 * Filialen, die nur beobachtet werden, standen dort **„—, —, —"** — die
 * Kacheln fragten nach Speicher und Erlös, die es nicht gibt, während die
 * Zahlen, die es sehr wohl gibt (PV jetzt, Erzeugung heute, Verbrauch heute),
 * nirgends vorkamen.
 *
 * E5 löst das: **EIN Portfolio-Cockpit für jeden Mehr-Anlagen-Kunden,
 * komponiert aus den Anwendungen seiner Anlagen.** Die Betriebsart steuert nur
 * noch DICHTE (Tabelle vs. Karten) und TONALITÄT; die `FleetUebersicht` geht
 * darin auf.
 *
 * ## Die drei Regeln, die diese Fläche ehrlich halten
 *
 * 1. **Aggregiert wird nur, was aggregierbar ist.** Energie DARF man über
 *    Standorte summieren (kWh sind kWh). Ein PROZENTSATZ nicht: der Ladestand
 *    wird deshalb mit der Speicher-KAPAZITÄT gewichtet, und ohne bekannte
 *    Kapazität geht eine Anlage gar nicht in den Mittelwert ein statt ihn zu
 *    verzerren. Autarkie- und Eigenverbrauchsquoten werden über die Flotte
 *    ÜBERHAUPT NICHT gebildet (§4.3 Fall C nennt sie ausdrücklich „nicht
 *    aggregiert") — sie stehen je Anlage in deren Cockpit.
 * 2. **Ein Baustein erscheint nur, wenn eine AKTIVE Anwendung ihn beisteuert.**
 *    Das ist der Unterschied zur festen Kachel-Zeile von früher: der
 *    Nur-Monitoring-Kunde bekommt keine Speicher-Kachel, weil ihm kein
 *    Speicher-Fahrplan läuft — nicht weil sein Wert null ist.
 * 3. **Und auch dann nur mit einem WERT.** Die M0-Ehrlichkeit („kein Baustein
 *    ohne Wert") gilt weiter: ein Baustein, dessen Anwendung läuft, dessen
 *    Zahlen aber noch niemand gemessen hat, wird ausgelassen statt als „—"
 *    hingestellt.
 *
 * Reines Logikmodul (der `surface.ts`/`cockpitLayout.ts`-Präzedenzfall): keine
 * React-Importe, kein Netzwerk, keine Uhr ausser der übergebenen.
 */
import type { Betriebsart, Earnings, EarningsSite, Overview, OverviewSite, Site } from './api';
import { anwendungenFuerPortfolioBaustein } from './anwendungen';
import { bausteineFuer, type BausteinDef } from './cockpitLayout';
import { berlinDay, savedOnDay, siteLiveFresh } from './fleet';
import { sanitizeSoc } from './plausible';
import { activeModes } from './surface';
import { portfolioSurfaceInput, siteSoc } from './portfolio';

// ---------------------------------------------------------------------------
// Vokabular
// ---------------------------------------------------------------------------

/** Ein Baustein-Schlüssel der Kunden-Fläche. */
export type PortfolioBausteinId =
  | 'flotten-status'
  | 'erloese'
  | 'speicher'
  | 'lastspitzen'
  | 'ladepunkte'
  | 'pv-jetzt'
  | 'erzeugung-heute'
  | 'verbrauch-heute'
  | 'netz-heute'
  | 'anlagen';

/** Alle Portfolio-Bausteine aus dem EINEN Katalog, in Katalog-Reihenfolge. */
export const PORTFOLIO_BAUSTEINE: BausteinDef[] = bausteineFuer('portfolio');

/**
 * Die kanonische Reihenfolge der Kunden-Fläche — der VoltPilot-Standard, gegen
 * den ein „Zurücksetzen" fällt.
 *
 * Sie führt mit dem Flotten-Status (dem Kopf) und dem Geld, weil das die zwei
 * Fragen sind, wegen derer jemand eine Flotten-Seite öffnet; danach kommen die
 * Anlagen-Kennzahlen und zuletzt die Anlagen selbst.
 *
 * ⚠ Anders als am Cockpit gibt es hier NUR EINE Liste: das Portfolio ordnet am
 * Telefon dieselben Bausteine untereinander, es gibt keine abgenommene
 * Umsortierung je Bildschirmbreite (am Cockpit führen am Telefon Fahrplan und
 * Preis als Zeilen — eine echte Entscheidung, hier gäbe es nichts zu
 * entscheiden).
 */
export const CANONICAL_PORTFOLIO: PortfolioBausteinId[] = [
  'flotten-status',
  'erloese',
  'speicher',
  'lastspitzen',
  'ladepunkte',
  'pv-jetzt',
  'erzeugung-heute',
  'verbrauch-heute',
  'netz-heute',
  'anlagen',
];

/** Wie dicht die Fläche rendert — die EINZIGE Wirkung der Betriebsart (E5). */
export type Dichte = 'tabelle' | 'karten';

/**
 * Die Dichte einer Flotte: ein BETREIBER bekommt die Tabelle (er vergleicht
 * viele Anlagen in einer Zeile), jeder andere die ruhigen Karten. Ein
 * unbekannter Rahmen (`null` — jede Bestandsorganisation, ein älteres Backend)
 * fällt auf die Karten, also byte-identisch auf das, was ein Endkunde mit zwei
 * Anlagen bis hierher gesehen hat.
 */
export function portfolioDichte(betriebsart: Betriebsart | null | undefined): Dichte {
  return betriebsart === 'betreiber' ? 'tabelle' : 'karten';
}

// ---------------------------------------------------------------------------
// Welche Anwendungen hat diese FLOTTE?
// ---------------------------------------------------------------------------

/**
 * Die Vereinigung der aktiven Anwendungen über alle Anlagen, in
 * Katalog-Reihenfolge — die Menge, aus der die Fläche komponiert wird. Eine
 * Anwendung zählt, sobald sie auf EINER Anlage läuft (§3.5).
 *
 * ⚠ **Die Wahrheit kommt vom Server** (`OverviewSite.anwendungen`): dort liegt
 * der gespeicherte Kundenwille (`site_profile_state`), den die Flotten-Zeile
 * sonst nicht kennt — ohne ihn bliebe eine ABGESCHALTETE Anwendung sichtbar.
 * Meldet eine Zeile das Feld gar nicht (ein älteres Backend), wird für DIESE
 * Anlage aus dem abgeleitet, was die Zeile trägt: die M0-Projektion plus die
 * zwei Basis-Anwendungen. Das ist ein ehrlicher Rückfall, nie eine Erfindung —
 * er kann nur zu wenig sagen, nie zu viel.
 */
export function portfolioAnwendungen(
  overview: Overview | null,
  configById?: Map<string, Pick<Site, 'tarifArt' | 'leistungspreisEurKw'>> | null,
): string[] {
  const aktiv = new Set<string>();
  for (const site of overview?.sites ?? []) {
    for (const id of anwendungenVonAnlage(site, configById?.get(site.id) ?? null)) {
      aktiv.add(id);
    }
  }
  return [...aktiv];
}

/** Die aktiven Anwendungen EINER Flotten-Zeile (siehe {@link portfolioAnwendungen}). */
export function anwendungenVonAnlage(
  site: OverviewSite,
  config?: Pick<Site, 'tarifArt' | 'leistungspreisEurKw'> | null,
): string[] {
  if (site.anwendungen) return site.anwendungen;
  const ids = new Set<string>(['monitoring']);
  if ((site.roleCounts?.storage ?? 0) > 0) ids.add('speicher-fahrplan');
  for (const m of activeModes(portfolioSurfaceInput(site, config ?? null))) ids.add(m.kind);
  return [...ids];
}

// ---------------------------------------------------------------------------
// Die Kennzahlen — Σ nur, wo Σ ehrlich ist
// ---------------------------------------------------------------------------

/**
 * Die Zahlen der Kunden-Fläche. **Jedes Feld ist `null`, wenn nicht eine
 * einzige Anlage etwas beigetragen hat** — nie eine erfundene 0, und genau
 * dieses `null` blendet den Baustein aus statt ihn als „—" hinzustellen.
 */
export interface PortfolioKennzahlen {
  /** Σ Speicher-Kapazität (kWh). */
  speicherKwh: number | null;
  /** Σ Lade-/Entladeleistung (kW). */
  speicherKw: number | null;
  /**
   * Der Ladestand der Flotte (%), mit der Speicher-Kapazität GEWICHTET —
   * `Σ(soc × kWh) / Σ kWh`. Eine Anlage ohne bekannte Kapazität geht NICHT
   * ein: sie hätte kein Gewicht, und sie ungewichtet einzumischen wäre genau
   * das Prozent-Mittel, das diese Fläche nicht behauptet.
   */
  ladestandPct: number | null;
  /** Wie viele Anlagen den Ladestand tragen — die Fläche sagt es dazu. */
  ladestandAnlagen: number;
  /** Σ realisierter Erlös HEUTE (Berliner Tag). */
  erloesHeuteEur: number | null;
  /** Σ realisierter Erlös über den gewählten Zeitraum. */
  erloesZeitraumEur: number | null;
  /** Σ vermiedene Spitze (EUR) über die Anlagen mit Lastspitzenkappung. */
  vermiedeneSpitzeEur: number | null;
  /** Σ vermiedene Spitze (kW). */
  vermiedeneSpitzeKw: number | null;
  /** Σ Ladepunkte der Flotte. */
  ladepunkte: number | null;
  /** Σ PV-Leistung JETZT (kW) — nur über Anlagen mit FRISCHEM Messwert. */
  pvJetztKw: number | null;
  /** Wie viele Anlagen dazu einen frischen Messwert hatten. */
  pvJetztAnlagen: number;
  /** Σ Erzeugung heute (kWh). */
  erzeugungHeuteKwh: number | null;
  /** Σ Verbrauch heute (kWh). */
  verbrauchHeuteKwh: number | null;
  /** Σ Netzbezug heute (kWh). */
  bezugHeuteKwh: number | null;
  /** Σ Einspeisung heute (kWh). */
  einspeisungHeuteKwh: number | null;
}

/** Summiert, aber gibt `null` zurück, wenn KEIN Summand da war. */
function summe(werte: (number | null | undefined)[]): number | null {
  let sum: number | null = null;
  for (const v of werte) {
    if (v == null || !Number.isFinite(v)) continue;
    sum = (sum ?? 0) + v;
  }
  return sum;
}

export function portfolioKennzahlen(
  overview: Overview | null,
  earnings: Earnings | null,
  now: Date = new Date(),
): PortfolioKennzahlen {
  const sites = overview?.sites ?? [];

  // Ladestand: KAPAZITÄTS-GEWICHTET (Regel 1). Eine Anlage ohne gepflegte
  // Kapazität oder ohne plausiblen Messwert bleibt draussen.
  let socGewichtet = 0;
  let socGewicht = 0;
  let socAnlagen = 0;
  for (const s of sites) {
    const soc = s.live ? sanitizeSoc(s.live.socPct) : null;
    const kwh = s.storageCapacityKwh ?? null;
    if (soc == null || kwh == null || !(kwh > 0)) continue;
    socGewichtet += soc * kwh;
    socGewicht += kwh;
    socAnlagen += 1;
  }

  // PV jetzt: nur über Anlagen mit FRISCHEM Messwert (eine wieder verbundene
  // Box spielt ihren Puffer mit alten Zeitstempeln ein - das ist kein „jetzt").
  const pvFrisch = sites.filter((s) => siteLiveFresh(s, now) && s.live?.pvKw != null);

  const heute = berlinDay(now);
  const erloesHeute = summe(
    (earnings?.sites ?? []).map((s: EarningsSite) => savedOnDay(s.dailySaved, heute)),
  );

  const peakSites = (earnings?.sites ?? []).filter((s) => s.peakShaving?.avoidedEur != null);

  const ladepunkte = summe(sites.map((s) => s.chargePointCount));

  return {
    speicherKwh: overview?.totals.storageCapacityKwh ?? null,
    speicherKw: overview?.totals.storagePowerKw ?? null,
    ladestandPct: socGewicht > 0 ? socGewichtet / socGewicht : null,
    ladestandAnlagen: socAnlagen,
    erloesHeuteEur: erloesHeute,
    erloesZeitraumEur: earnings?.totals.savedEur ?? null,
    vermiedeneSpitzeEur: summe(peakSites.map((s) => s.peakShaving?.avoidedEur ?? null)),
    vermiedeneSpitzeKw: summe(peakSites.map((s) => s.peakShaving?.avoidedKw ?? null)),
    ladepunkte: ladepunkte != null && ladepunkte > 0 ? ladepunkte : null,
    pvJetztKw: summe(pvFrisch.map((s) => s.live?.pvKw ?? null)),
    pvJetztAnlagen: pvFrisch.length,
    erzeugungHeuteKwh: summe(sites.map((s) => s.energyToday?.pvKwh ?? null)),
    verbrauchHeuteKwh: summe(sites.map((s) => s.energyToday?.loadKwh ?? null)),
    bezugHeuteKwh: summe(sites.map((s) => s.energyToday?.gridImportKwh ?? null)),
    einspeisungHeuteKwh: summe(sites.map((s) => s.energyToday?.gridExportKwh ?? null)),
  };
}

// ---------------------------------------------------------------------------
// Welche Bausteine hat diese Flotte GERADE?
// ---------------------------------------------------------------------------

/**
 * Hat dieser Baustein einen Wert? Die zweite Hälfte der M0-Ehrlichkeit: eine
 * aktive Anwendung allein macht noch keinen Baustein — es braucht auch etwas
 * zu zeigen. Pflicht-Bausteine (der Flotten-Status und die Anlagen-Liste)
 * beantworten sich aus der Existenz der Flotte selbst.
 */
export function bausteinHatWert(id: string, k: PortfolioKennzahlen, anlagen: number): boolean {
  switch (id) {
    case 'flotten-status':
    case 'anlagen':
      return anlagen > 0;
    case 'erloese':
      return k.erloesHeuteEur != null || k.erloesZeitraumEur != null;
    case 'speicher':
      return k.speicherKwh != null || k.speicherKw != null || k.ladestandPct != null;
    case 'lastspitzen':
      return k.vermiedeneSpitzeEur != null;
    case 'ladepunkte':
      return k.ladepunkte != null;
    case 'pv-jetzt':
      return k.pvJetztKw != null;
    case 'erzeugung-heute':
      return k.erzeugungHeuteKwh != null;
    case 'verbrauch-heute':
      return k.verbrauchHeuteKwh != null;
    case 'netz-heute':
      return k.bezugHeuteKwh != null || k.einspeisungHeuteKwh != null;
    default:
      // Ein Baustein, den dieses Portal noch nicht kennt (neuerer Server),
      // wird nicht erfunden.
      return false;
  }
}

/**
 * Die Bausteine, die diese Flotte GERADE hat — beigesteuert von einer aktiven
 * Anwendung UND mit einem Wert (Regeln 2 und 3). In Katalog-Reihenfolge; die
 * ANORDNUNG macht danach `layoutResolve`.
 */
export function verfuegbareBausteine(input: {
  anwendungen: readonly string[];
  kennzahlen: PortfolioKennzahlen;
  anlagen: number;
}): PortfolioBausteinId[] {
  const aktiv = new Set(input.anwendungen);
  const out: PortfolioBausteinId[] = [];
  for (const b of PORTFOLIO_BAUSTEINE) {
    const von = anwendungenFuerPortfolioBaustein(b.id);
    if (!von.some((a) => aktiv.has(a))) continue;
    if (!bausteinHatWert(b.id, input.kennzahlen, input.anlagen)) continue;
    out.push(b.id as PortfolioBausteinId);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/**
 * Der eine Satz über der Fläche, wenn ein Baustein FEHLT, weil seine Anwendung
 * nicht läuft — er wird bewusst NICHT gesagt. Eine Flotte, die keinen Speicher
 * hat, braucht keine Erklärung dafür, dass keine Speicher-Kachel dasteht; die
 * Erklärung wäre die Zeile, die früher „—" hiess.
 *
 * Diese Funktion beantwortet stattdessen den EINEN Fall, in dem ein Satz nötig
 * ist: die Flotte trägt gar keine Kennzahl (frisch angelegte Anlagen, noch
 * keine Messwerte).
 */
export function ruheSatz(bausteine: readonly string[]): string | null {
  const ohnePflicht = bausteine.filter((b) => b !== 'flotten-status' && b !== 'anlagen');
  if (ohnePflicht.length > 0) return null;
  return 'Sobald Ihre Anlagen Messwerte liefern, erscheinen hier die Kennzahlen Ihres Portfolios.';
}

/**
 * Welche der OPTIONALEN Spalten der Anlagen-Tabelle trägt diese Flotte?
 *
 * Dieselbe Regel wie bei den Kacheln, eine Ebene tiefer: eine Spalte, die
 * KEINE Anlage füllen kann, wird weggelassen statt als Reihe von „—"
 * hingestellt — genau das Bild, gegen das diese Stufe gebaut ist (der
 * Nur-Monitoring-Kunde trug eine tote „Ladestand"-Spalte). Ein EINZELNES „—"
 * bleibt dagegen stehen: in einer GEMISCHTEN Flotte ist es die wahre Aussage
 * über genau diese Anlage („dieses Werk hat keinen Speicher").
 *
 * Die Pflicht-Spalten (Anlage, Anwendungen, Komponenten, PV jetzt, Status)
 * stehen immer — sie beantworten sich aus der Existenz der Anlage selbst.
 */
export function tabellenSpalten(
  overview: Overview | null,
  earnings: Earnings | null,
  now: Date = new Date(),
): { ladestand: boolean; erloes: boolean } {
  const sites = overview?.sites ?? [];
  const erloesBySite = new Map((earnings?.sites ?? []).map((s: EarningsSite) => [s.id, s]));
  const heute = berlinDay(now);
  return {
    ladestand: sites.some((s) => siteSoc(s) != null),
    erloes: sites.some((s) => savedOnDay(erloesBySite.get(s.id)?.dailySaved ?? [], heute) != null),
  };
}

/** Die Beschriftung der Ladestand-Kachel — sie SAGT, worüber gemittelt wurde. */
export function ladestandFussnote(k: PortfolioKennzahlen, anlagen: number): string | null {
  if (k.ladestandPct == null) return null;
  if (k.ladestandAnlagen >= anlagen) return 'nach Speichergröße gewichtet';
  return `nach Speichergröße gewichtet · ${k.ladestandAnlagen} von ${anlagen} Anlagen`;
}

/** Die Fussnote der PV-Kachel — „jetzt" gilt nur für Anlagen, die gerade melden. */
export function pvJetztFussnote(k: PortfolioKennzahlen, anlagen: number): string | null {
  if (k.pvJetztKw == null) return null;
  if (k.pvJetztAnlagen >= anlagen) return null;
  return `${k.pvJetztAnlagen} von ${anlagen} Anlagen melden gerade`;
}
