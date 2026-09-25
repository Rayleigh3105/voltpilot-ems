/**
 * Das PORTFOLIO-COCKPIT, reine Hälfte (Anwendungs-Programm Stufe 4, Scout
 * `data/vp-portal-zielbild-anwendungen` §3.5 / §4.3 Fall C, Captain-Entscheide
 * E1 + E5 vom 24.08.2026 — **Revision 2** nach den Captain-Anmerkungen vom
 * 25.08.2026, Scout `data/vp-portfolio-konzept-r2` §5.2/§5.4 + `…-b3` §6a).
 *
 * Bis Stufe 4 gab es ZWEI Flotten-Flächen mit derselben Grammatik und
 * verschiedener Komposition; E5 hat sie zu EINER gemacht. **Revision 2 gibt
 * dieser einen Fläche die Grammatik des Cockpits:** ein Kopf mit der EINEN
 * Flotten-Aussage, eine Kennzahlen-LEISTE statt neun Icon-Kacheln, und EINE
 * Anlagen-Tabelle, deren Zeile die Komponenten-Zeile des Cockpits eine Ebene
 * höher wiederholt (Ding · Jetzt · Heute · Zustand · Absprung).
 *
 * ## Die drei Regeln, die diese Fläche ehrlich halten
 *
 * 1. **Aggregiert wird nur, was aggregierbar ist.** Energie DARF man über
 *    Standorte summieren (kWh sind kWh). Ein PROZENTSATZ nicht — und seit der
 *    Captain-Schärfung vom 25.08.2026 gilt das auch für den GEWICHTETEN
 *    Ladestand: „Der kumulierte Ladestand ist doch nicht aussagekräftig oder?"
 *    Er steht seither ausschliesslich JE ANLAGE (Spalte bzw. Karte), und die
 *    Leiste trägt nur noch Σ-fähige Zellen. Autarkie- und
 *    Eigenverbrauchsquoten werden über die Flotte ohnehin nie gebildet.
 * 2. **Ein Baustein erscheint nur, wenn eine AKTIVE Anwendung ihn beisteuert.**
 *    Der Nur-Monitoring-Kunde bekommt keine Speicher-Spalte, weil ihm kein
 *    Speicher-Fahrplan läuft — nicht weil sein Wert null ist.
 * 3. **Und auch dann nur mit einem WERT.** Ein Baustein, dessen Anwendung
 *    läuft, dessen Zahlen aber noch niemand gemessen hat, wird ausgelassen
 *    statt als „—" hingestellt.
 *
 * Reines Logikmodul (der `surface.ts`/`cockpitLayout.ts`-Präzedenzfall): keine
 * React-Importe, kein Netzwerk, keine Uhr ausser der übergebenen.
 */
import type { Betriebsart, Earnings, EarningsSite, Overview, OverviewSite, Site } from './api';
import { anwendung, anwendungLabel, anwendungenFuerPortfolioBaustein } from './anwendungen';
import { bausteineFuer, type BausteinDef } from './cockpitLayout';
import { berlinDay, savedOnDay, siteLiveFresh, type FleetKind, type FleetSentence } from './fleet';
import { eur, fmtNum, seitDauer } from './format';
import type { KennzahlZelle } from './kennzahl';
import { batteryState, deriveBatteryKw, gridState } from './live';
import { activeModes } from './surface';
import { portfolioSurfaceInput, siteSoc, siteStatus } from './portfolio';
import { aggregatLiefertDaten, type AggregatErgebnis, type LiefertDatenZustand } from './uemsZustand';

// ---------------------------------------------------------------------------
// Vokabular
// ---------------------------------------------------------------------------

/** Ein Baustein-Schlüssel der Kunden-Fläche. */
export type PortfolioBausteinId =
  | 'flotten-status'
  | 'datenlage'
  | 'netzbezug-gesamt'
  | 'erloese'
  | 'speicher'
  | 'lastspitzen'
  | 'ladepunkte'
  | 'pv-jetzt'
  | 'erzeugung-heute'
  | 'verbrauch-heute'
  | 'netz-heute'
  | 'messstellen'
  | 'energiebilanz'
  | 'kennzahlen'
  | 'bewertung'
  | 'ziele-massnahmen'
  | 'energiemanagement'
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
 * Umsortierung je Bildschirmbreite.
 */
export const CANONICAL_PORTFOLIO: PortfolioBausteinId[] = [
  'flotten-status',
  // UEMS AP-01 IP-6: nur auf der Unternehmens- und Standort-Übersicht verfügbar
  // ({@link UEBERSICHT_BAUSTEINE}) — für jede andere Flotte ändert sich nichts.
  'datenlage',
  'netzbezug-gesamt',
  'erloese',
  'speicher',
  'lastspitzen',
  'ladepunkte',
  'pv-jetzt',
  'erzeugung-heute',
  'verbrauch-heute',
  'netz-heute',
  // UEMS AP-13 IP-7 (Ü1): die Bausteine der Messstellen-Welt — nur auf einer Übersicht und nur mit Inhalt
  // ({@link UEMS_UEBERSICHT_BAUSTEINE}); sie rendern unter der Anlagen-Tabelle, vor der Karte „Funktionen“.
  'messstellen',
  'energiebilanz',
  'kennzahlen',
  // UEMS AP-16 IP-24 (S5/S6): die Frist der energetischen Bewertung — nur am Unternehmen, nur mit Stand und Recht.
  'bewertung',
  // UEMS AP-18 IP-19 (F2/F3): Ziele und Maßnahmen — nur am Unternehmen, nur mit einem Vorgang im Zaun.
  'ziele-massnahmen',
  // UEMS AP-19 IP-21 (WV5): Energiemanagement — nur am Unternehmen, nur mit einer fälligen oder bald fälligen Frist.
  'energiemanagement',
  'anlagen',
];

/**
 * WO ein Portfolio-Baustein rendert (Revision 2).
 *
 * ⚠ **Diese Zuordnung wohnt bewusst im Portal, nicht im Katalog** — dieselbe
 * Begründung wie bei {@link CANONICAL_PORTFOLIO} und den kanonischen
 * Cockpit-Listen: der Server hält Katalog und ABSICHT, das Rendern gehört der
 * Fläche, die rendert (es gibt deshalb auch kein `GET /surface`).
 *
 * Ein Baustein kann in BEIDEN Orten stehen — „PV jetzt" ist eine Zelle der
 * Leiste (Σ über die Flotte) UND eine Spalte der Tabelle (je Anlage). Das ist
 * kein Widerspruch, sondern der Kern der Zeilen-Grammatik: dieselbe Grösse
 * einmal über die Flotte, einmal je Anlage. Deshalb gibt es auch nur EIN Auge
 * je Baustein — wer „PV jetzt" ausblendet, meint die Grösse, nicht den Ort.
 */
export interface BausteinOrt {
  /** Rendert er eine Zelle der Kennzahlen-Leiste? */
  leiste: boolean;
  /** Rendert er eine Spalte der Anlagen-Tabelle (bzw. eine Zahl der Karte)? */
  spalte: boolean;
}

const ORT: Record<PortfolioBausteinId, BausteinOrt> = {
  // Der Kopf-Satz und die Zustands-Spalte — beides Pflicht, beides kein Auge.
  'flotten-status': { leiste: false, spalte: true },
  // UEMS AP-01 IP-6: die Datenlage steht in der KOPFZEILE (je Anlage steht sie
  // schon als Zustands-Spalte); der Netzbezug gesamt ist über die Flotte eine
  // Zelle und je Anlage die Spalte „Netz jetzt" (dieselbe wie bei „Netz heute").
  datenlage: { leiste: false, spalte: false },
  'netzbezug-gesamt': { leiste: true, spalte: true },
  erloese: { leiste: true, spalte: true },
  // ⚠ NUR die Spalte: der kumulierte Ladestand ist raus (Captain 25.08.2026).
  speicher: { leiste: false, spalte: true },
  lastspitzen: { leiste: true, spalte: false },
  ladepunkte: { leiste: true, spalte: false },
  'pv-jetzt': { leiste: true, spalte: true },
  'erzeugung-heute': { leiste: true, spalte: true },
  'verbrauch-heute': { leiste: true, spalte: true },
  'netz-heute': { leiste: true, spalte: true },
  // UEMS AP-13 IP-7: eigene Abschnitte unter der Tabelle — weder Zelle noch Spalte.
  messstellen: { leiste: false, spalte: false },
  energiebilanz: { leiste: false, spalte: false },
  kennzahlen: { leiste: false, spalte: false },
  bewertung: { leiste: false, spalte: false },
  'ziele-massnahmen': { leiste: false, spalte: false },
  energiemanagement: { leiste: false, spalte: false },
  // Die Tabelle SELBST — sie steht immer, und immer zuletzt.
  anlagen: { leiste: false, spalte: false },
};

/** Wo dieser Baustein rendert; ein unbekannter (neuerer Server) nirgends. */
export function bausteinOrt(id: string): BausteinOrt {
  return ORT[id as PortfolioBausteinId] ?? { leiste: false, spalte: false };
}

/**
 * Die GELD-Bausteine der Kunden-Fläche — Vorteil/Erlöse und die vermiedene
 * Spitze in Euro (UEMS AP-01 §4.6, Geld-Regel).
 *
 * ⚠ **Captain-Vorgabe 10.09.2026: „Die Messdatenkunden brauchen keine
 * Geldanzeige."** Auf der Unternehmens- und Standort-Übersicht erscheinen diese
 * Bausteine nur, wenn eine Anlage der Ebene steuert oder Erzeuger/Speicher hat,
 * und zählen dann nur diese Anlagen. Wer einen Baustein mit Euro-Wert ergänzt,
 * trägt ihn HIER ein — `uebersicht.test.ts` (A13) prüft jede Zelle und jede
 * Spalte mit Euro gegen diese Liste.
 */
export const GELD_BAUSTEINE: readonly PortfolioBausteinId[] = ['erloese', 'lastspitzen'];

/**
 * Die Bausteine, die NUR die Unternehmens- und Standort-Übersicht tragen (UEMS
 * AP-01 IP-6, Katalog-Einträge der Funktion „Messen & Auswerten"). Die Flotte
 * eines Betreibers oder eines Kunden ohne Standorte bleibt zeichengleich.
 */
export const UEBERSICHT_BAUSTEINE: readonly PortfolioBausteinId[] = [
  'datenlage',
  'netzbezug-gesamt',
  'messstellen',
  'energiebilanz',
  'kennzahlen',
];

/**
 * UEMS AP-13 IP-7 (E3 = A, Ü1): die drei Bausteine der Messstellen-Welt. Ob sie da sind, entscheidet ihr INHALT
 * (`uebersichtBausteine.bausteineMitInhalt`), nicht eine Kennzahl der Anlagen — ein Baustein ohne Inhalt wird nicht
 * angeboten und nicht gezeigt.
 */
export const UEMS_UEBERSICHT_BAUSTEINE: readonly PortfolioBausteinId[] = [
  'messstellen',
  'energiebilanz',
  'kennzahlen',
  'bewertung',
  'ziele-massnahmen',
  'energiemanagement',
];

/**
 * Wie dicht die Fläche rendert — die EINZIGE Wirkung der Betriebsart neben der
 * Tonalität (E5). **Seit Revision 2 rendern BEIDE Dichten dieselbe Tabelle**
 * (Entscheid E1 „A"): `kompakt` sind 44-px-Zeilen mit Stammdaten-Unterzeile,
 * `komfortabel` 62-px-Zeilen mit einer Satz-Unterzeile. Die frühere Lesart
 * „Tabelle vs. Karten" war der Grund, warum die Betriebsart nicht nur die
 * Dichte, sondern den INHALT änderte (Befund K4).
 */
export type Dichte = 'kompakt' | 'komfortabel';

/**
 * Die Dichte einer Flotte: ein BETREIBER vergleicht viele Anlagen und bekommt
 * die kompakte Zeile, jeder andere die komfortable. Ein unbekannter Rahmen
 * (`null` — jede Bestandsorganisation, ein älteres Backend) fällt auf
 * `komfortabel`, also auf das ruhigere der beiden Bilder.
 */
export function portfolioDichte(betriebsart: Betriebsart | null | undefined): Dichte {
  return betriebsart === 'betreiber' ? 'kompakt' : 'komfortabel';
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
 *
 * ⚠ Es gibt hier seit Revision 2 **keinen Flotten-Ladestand mehr** (weder
 * gewichtet noch ungewichtet). `ladestandAnlagen` zählt nur noch, wie viele
 * Anlagen einen plausiblen Ladestand melden — das entscheidet, ob die SPALTE
 * der Tabelle existiert, nicht ob ein Mittelwert behauptet wird.
 */
export interface PortfolioKennzahlen {
  /** Wie viele Anlagen einen plausiblen Ladestand melden (0 = keine Spalte). */
  ladestandAnlagen: number;
  /** Σ realisierter Erlös HEUTE (Berliner Tag). */
  erloesHeuteEur: number | null;
  erloesHeuteAnlagen: number;
  /** Σ vermiedene Spitze (EUR) über die Anlagen mit Lastspitzenkappung. */
  vermiedeneSpitzeEur: number | null;
  /** Σ vermiedene Spitze (kW). */
  vermiedeneSpitzeKw: number | null;
  vermiedeneSpitzeAnlagen: number;
  /** Σ Ladepunkte der Flotte. */
  ladepunkte: number | null;
  ladepunkteAnlagen: number;
  /** Σ PV-Leistung JETZT (kW) — nur über Anlagen mit FRISCHEM Messwert. */
  pvJetztKw: number | null;
  /** Wie viele Anlagen dazu einen frischen Messwert hatten. */
  pvJetztAnlagen: number;
  /**
   * Wie viele Anlagen überhaupt PV haben (Rolle oder je ein PV-Wert) — der
   * Nenner von „x von y Anlagen melden gerade". Eine Anlage ohne Erzeuger
   * meldet keine PV, sie meldet sich nicht „nicht" (Befund UEMS AP-01 IP-6).
   */
  pvAnlagen: number;
  /** Σ Erzeugung heute (kWh). */
  erzeugungHeuteKwh: number | null;
  erzeugungHeuteAnlagen: number;
  /** Σ Verbrauch heute (kWh). */
  verbrauchHeuteKwh: number | null;
  verbrauchHeuteAnlagen: number;
  /** Σ Netzbezug heute (kWh). */
  bezugHeuteKwh: number | null;
  bezugHeuteAnlagen: number;
  /** Σ Einspeisung heute (kWh). */
  einspeisungHeuteKwh: number | null;
  einspeisungHeuteAnlagen: number;
  /** Σ Netzbezug JETZT (kW) — nur über Anlagen mit FRISCHEM Messwert; Einspeisung zählt 0. */
  netzbezugJetztKw: number | null;
  /** Wie viele Anlagen dazu einen frischen Netz-Messwert hatten. */
  netzbezugJetztAnlagen: number;
  /** „3 von 3 Anlagen liefern Daten" (Vertrag `uemsZustand`); null ohne Anlage. */
  datenlage: AggregatErgebnis | null;
  /**
   * Geld-Regel (UEMS AP-01 IP-6): die Namen der Anlagen, über die Geld zählt;
   * `null` = die Regel ist hier nicht angewendet (jede Flotte ausserhalb der
   * Unternehmens- und Standort-Übersicht).
   */
  geldNamen: string[] | null;
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

function anzahl(werte: (number | null | undefined)[]): number {
  return werte.filter((v) => v != null && Number.isFinite(v)).length;
}

export function portfolioKennzahlen(
  overview: Overview | null,
  earnings: Earnings | null,
  now: Date = new Date(),
  /** Geld-Regel: nur diese Anlagen zählen Geld; `null` = alle (heutiges Verhalten). */
  geld: ReadonlySet<string> | null = null,
): PortfolioKennzahlen {
  const sites = overview?.sites ?? [];

  // PV jetzt: nur über Anlagen mit FRISCHEM Messwert (eine wieder verbundene
  // Box spielt ihren Puffer mit alten Zeitstempeln ein - das ist kein „jetzt").
  const pvFrisch = sites.filter((s) => siteLiveFresh(s, now) && s.live?.pvKw != null);

  const heute = berlinDay(now);
  // Geld-Regel: eine Anlage, die weder steuert noch Erzeuger/Speicher hat, trägt
  // kein Geld bei — auch wenn der Server für sie eine Zahl liefert.
  const geldSites = (earnings?.sites ?? []).filter((s) => geld == null || geld.has(s.id));
  const erloesWerte = geldSites.map((s: EarningsSite) => savedOnDay(s.dailySaved, heute));
  const erloesHeute = summe(erloesWerte);

  const peakSites = geldSites.filter((s) => s.peakShaving?.avoidedEur != null);

  // Netzbezug jetzt: dieselbe Frische-Regel wie PV jetzt; eine einspeisende
  // Anlage bezieht gerade 0 kW (gemessen), ihre Einspeisung wird nie verrechnet.
  const netzFrisch = sites.filter((s) => siteLiveFresh(s, now) && s.live?.gridKw != null);

  const ladepunktWerte = sites.map((s) => s.chargePointCount);
  const ladepunkte = summe(ladepunktWerte);
  const erzeugung = sites.map((s) => s.energyToday?.pvKwh ?? null);
  const verbrauch = sites.map((s) => s.energyToday?.loadKwh ?? null);
  const bezug = sites.map((s) => s.energyToday?.gridImportKwh ?? null);
  const einspeisung = sites.map((s) => s.energyToday?.gridExportKwh ?? null);

  return {
    ladestandAnlagen: sites.filter((s) => siteSoc(s) != null).length,
    erloesHeuteEur: erloesHeute,
    erloesHeuteAnlagen: anzahl(erloesWerte),
    vermiedeneSpitzeEur: summe(peakSites.map((s) => s.peakShaving?.avoidedEur ?? null)),
    vermiedeneSpitzeKw: summe(peakSites.map((s) => s.peakShaving?.avoidedKw ?? null)),
    vermiedeneSpitzeAnlagen: peakSites.length,
    ladepunkte: ladepunkte != null && ladepunkte > 0 ? ladepunkte : null,
    ladepunkteAnlagen: anzahl(ladepunktWerte),
    pvJetztKw: summe(pvFrisch.map((s) => s.live?.pvKw ?? null)),
    pvJetztAnlagen: pvFrisch.length,
    pvAnlagen: sites.filter(
      (s) => (s.roleCounts?.pv ?? 0) > 0 || s.live?.pvKw != null || s.energyToday?.pvKwh != null,
    ).length,
    erzeugungHeuteKwh: summe(erzeugung),
    erzeugungHeuteAnlagen: anzahl(erzeugung),
    verbrauchHeuteKwh: summe(verbrauch),
    verbrauchHeuteAnlagen: anzahl(verbrauch),
    bezugHeuteKwh: summe(bezug),
    bezugHeuteAnlagen: anzahl(bezug),
    einspeisungHeuteKwh: summe(einspeisung),
    einspeisungHeuteAnlagen: anzahl(einspeisung),
    netzbezugJetztKw: summe(netzFrisch.map((s) => Math.max(s.live?.gridKw ?? 0, 0))),
    netzbezugJetztAnlagen: netzFrisch.length,
    datenlage: sites.length > 0 ? datenlageAnlagen(sites) : null,
    geldNamen: geld == null ? null : sites.filter((s) => geld.has(s.id)).map((s) => s.name),
  };
}

/**
 * Das Urteil der Zeile ({@link siteStatus}) im Wort des Vertrags „liefert Daten"
 * (`uemsZustand`). Bis das Messstellen-Register die Datenlage je Messstelle
 * trägt (AP-04), ist das die Datenlage der ANLAGE — zwei Wahrheiten über
 * denselben Zustand gibt es nicht.
 */
export function liefertDatenZustand(site: OverviewSite): LiefertDatenZustand {
  switch (siteStatus(site).label) {
    case 'Online':
      return 'liefert';
    case 'Wartet auf Daten':
      return 'wartet_auf_erste_daten';
    case 'Kein Gerät':
      return 'keine_datenquelle';
    default:
      return 'liefert_nicht_seit';
  }
}

/** „2 von 3 Anlagen liefern Daten" — gezählt vom Vertrag, nie hier formuliert. */
export function datenlageAnlagen(sites: readonly OverviewSite[]): AggregatErgebnis {
  return aggregatLiefertDaten(sites.map(liefertDatenZustand), 'anlage');
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
    case 'datenlage':
      return k.datenlage != null && k.datenlage.gesamt > 0;
    case 'netzbezug-gesamt':
      return k.netzbezugJetztKw != null;
    case 'erloese':
      return k.erloesHeuteEur != null;
    case 'speicher':
      // Die SPALTE lebt, sobald EINE Anlage einen Ladestand meldet — eine
      // Flotten-Zahl gibt es hier nicht mehr.
      return k.ladestandAnlagen > 0;
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
  /**
   * UEMS AP-01 IP-6 — nur auf der Unternehmens- und Standort-Übersicht gesetzt:
   * dann gibt es die Übersichts-Bausteine, und `geld` sagt, ob die Geld-Regel
   * erfüllt ist (eine Anlage der Ebene steuert oder hat Erzeuger/Speicher).
   */
  uebersicht?: { geld: boolean; /** AP-13 IP-7: die Messstellen-Bausteine MIT Inhalt. */ uems?: readonly string[] } | null;
}): PortfolioBausteinId[] {
  const aktiv = new Set(input.anwendungen);
  const out: PortfolioBausteinId[] = [];
  for (const b of PORTFOLIO_BAUSTEINE) {
    const id = b.id as PortfolioBausteinId;
    if (!input.uebersicht && UEBERSICHT_BAUSTEINE.includes(id)) continue;
    // Die Geld-Regel steht VOR der Anwendungs-Frage: auch eine eingeschaltete
    // Anwendung bringt einem reinen Messkunden kein Geld auf die Seite.
    if (input.uebersicht && !input.uebersicht.geld && GELD_BAUSTEINE.includes(id)) continue;
    const von = anwendungenFuerPortfolioBaustein(b.id);
    if (!von.some((a) => aktiv.has(a))) continue;
    if (UEMS_UEBERSICHT_BAUSTEINE.includes(id)) {
      if (input.uebersicht?.uems?.includes(id)) out.push(id);
      continue;
    }
    if (!bausteinHatWert(b.id, input.kennzahlen, input.anlagen)) continue;
    out.push(b.id as PortfolioBausteinId);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Der KOPF: die EINE Flotten-Aussage
// ---------------------------------------------------------------------------

/**
 * Die eine Flotten-Aussage unter dem Titel — **EINE Zeile**, nie eine Karte
 * (Captain 25.08.2026: „Auch das ‚1 Gerät in Hof Lindenberg meldet sich nicht'
 * ist viel zu groß dargestellt.").
 *
 * Sie zählt ANLAGEN, nicht Geräte: auf der Flotten-Ebene ist die Anlage das
 * Ding, das der Kunde kennt, und die Tabelle darunter zählt ebenso. Das Urteil
 * je Anlage ist wörtlich das der Zeile ({@link siteStatus}) — zwei Wahrheiten
 * über denselben Zustand darf es nicht geben. Eine Anlage, die Aufmerksamkeit
 * braucht, wird BEIM NAMEN genannt und trägt ihr Alter.
 */
export function flottenAussage(
  sites: readonly OverviewSite[],
  now: Date = new Date(),
): FleetSentence {
  if (sites.length === 0) return { tone: 'off', text: 'Noch keine Anlage angelegt.' };
  const gesamt = sites.length;
  const online = sites.filter((s) => siteStatus(s).tone === 'ok').length;
  const stumm = sites.filter((s) => siteStatus(s).label === 'Meldet sich nicht');
  const wartet = sites.filter((s) => siteStatus(s).label === 'Wartet auf Daten');

  if (online === gesamt) {
    return { tone: 'ok', text: gesamt === 1 ? '1 Anlage online' : `Alle ${gesamt} Anlagen online` };
  }

  const teile = [`${online} von ${gesamt} Anlagen online`];
  const hinweis = flottenHinweis(sites, now);
  if (hinweis) teile.push(hinweis);
  return { tone: stumm.length > 0 || wartet.length > 0 ? 'warn' : 'off', text: teile.join(' · ') };
}

/**
 * Der zweite Teil der Flotten-Aussage: WELCHE Anlage Aufmerksamkeit braucht,
 * beim Namen und mit ihrem Alter; `null`, wenn alle online sind. Die Kopfzeile
 * der Unternehmens- und Standort-Übersicht hängt ihn an ihre Datenlage.
 */
export function flottenHinweis(sites: readonly OverviewSite[], now: Date = new Date()): string | null {
  const stumm = sites.filter((s) => siteStatus(s).label === 'Meldet sich nicht');
  if (stumm.length > 0) return stummSatz(stumm, now);
  const wartet = sites.filter((s) => siteStatus(s).label === 'Wartet auf Daten');
  if (wartet.length > 0) return wartetSatz(wartet);
  const ohne = sites.filter((s) => siteStatus(s).label === 'Kein Gerät');
  if (ohne.length > 0) return ohneGeraetSatz(ohne);
  return null;
}

function stummSatz(stumm: readonly OverviewSite[], now: Date): string {
  if (stumm.length === 1) {
    const alter = seitDauer(stumm[0].lastSeenAt, now);
    return `${stumm[0].name} meldet sich ${alter ? `${alter} ` : ''}nicht`;
  }
  return `${stumm.length} Anlagen melden sich nicht (${namenListe(stumm.map((s) => s.name))})`;
}

function wartetSatz(wartet: readonly OverviewSite[]): string {
  return wartet.length === 1
    ? `${wartet[0].name} wartet auf die ersten Daten`
    : `${wartet.length} Anlagen warten auf die ersten Daten`;
}

function ohneGeraetSatz(ohne: readonly OverviewSite[]): string {
  return ohne.length === 1
    ? `${ohne[0].name} hat noch kein Gerät`
    : `${ohne.length} Anlagen haben noch kein Gerät`;
}

function namenListe(namen: readonly string[]): string {
  if (namen.length <= 1) return namen[0] ?? '';
  return `${namen.slice(0, -1).join(', ')} und ${namen[namen.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Die KENNZAHLEN-LEISTE
// ---------------------------------------------------------------------------

/**
 * Das Wort für das Steuerungs-Delta — der Befund P7 des Scouts: „Erlös heute"
 * ist kein Erlös, sondern der VORTEIL, und im Cockpit derselben Anlage heißt
 * dieselbe Zahl „durch Steuerung". Beide Flächen tragen deshalb seit
 * Revision 2 dieselbe Unterzeile.
 *
 * ⚠ **DIE MESSLATTE IST DERSELBE SPEICHER OHNE SMARTE STEUERUNG** (Captain
 * 04.09.2026). Die Zahl ist `savedSteuerungEur` je Tag ({@link tagesSteuerung}),
 * nicht mehr `savedEur` gegenüber einer Anlage OHNE Speicher — und die
 * Unterzeile sagt das.
 *
 * ⚠ Das Wort folgt der TONALITÄT (`fleetTonalitaet` aus `site.profil` bzw.
 * `plantKind`), nicht der Betriebsart: die Tonalität ist im Haus seit Stufe 2
 * die eine Quelle der Geld-Sprache („privat spart, gewerbe verdient"), und
 * eine zweite Regel daneben wäre genau die Doppeldeutigkeit, gegen die diese
 * Runde gebaut ist.
 */
export function vorteilLabel(kind: FleetKind): string {
  return kind === 'direktvermarktung' ? 'Mehrerlös heute' : 'Vorteil heute';
}

/** Die Unterzeile des Vorteils — sie sagt den BEZUG, in beiden Flächen gleich. */
export const VORTEIL_BEZUG = 'gegenüber Speicher ohne Steuerung';

/** „+33,13" / „-0,80" / „0,00" — eine echte Null trägt kein Vorzeichen. */
export function signiertesGeld(v: number): string {
  const wert = Math.abs(v) < 0.005 ? 0 : v;
  return wert > 0 ? `+${eur(wert)}` : eur(wert);
}

/**
 * Die Unterzeile des Vorteils. Zählt die Zelle wegen der Geld-Regel nur einen
 * Teil der Anlagen, sagt sie, welchen (A13: „nur Werk Ahrenberg – Halle 1").
 */
export function vorteilUnterzeile(k: PortfolioKennzahlen, anlagen: number): string {
  const geld = k.geldNamen;
  const deckung = anlagenText(k.erloesHeuteAnlagen, anlagen);
  if (geld != null && geld.length > 0 && geld.length < anlagen) {
    return geld.length <= 2
      ? `${VORTEIL_BEZUG} · ${deckung} · nur ${namenListe(geld)}`
      : `${VORTEIL_BEZUG} · ${deckung}`;
  }
  return `${VORTEIL_BEZUG} · ${deckung}`;
}

/** Die Fussnote des Netzbezugs — die Summe nennt, über wie viele Anlagen sie geht. */
export function netzbezugFussnote(k: PortfolioKennzahlen, anlagen: number): string | null {
  if (k.netzbezugJetztKw == null) return null;
  return meldenGerade(k.netzbezugJetztAnlagen, anlagen);
}

/** Die Fussnote der PV-Zelle — „jetzt" gilt nur für Anlagen, die gerade melden. */
export function pvJetztFussnote(k: PortfolioKennzahlen, anlagen: number): string | null {
  if (k.pvJetztKw == null) return null;
  return meldenGerade(k.pvJetztAnlagen, anlagen);
}

function anlagenText(zaehler: number, nenner: number): string {
  return `${zaehler} von ${nenner} ${nenner === 1 ? 'Anlage' : 'Anlagen'}`;
}

function meldenGerade(zaehler: number, nenner: number): string {
  return `${anlagenText(zaehler, nenner)} ${nenner === 1 ? 'meldet' : 'melden'} gerade`;
}

function mitUntergrenze(wert: string, zaehler: number, nenner: number): string {
  return zaehler < nenner ? `mindestens ${wert}` : wert;
}

/**
 * Die Zellen der Kennzahlen-Leiste, in der WIRKSAMEN Anordnung.
 *
 * Eingabe ist die aufgelöste `order` (Katalog → Preset → Vorgabe → Eigen), aus
 * der nur die Bausteine mit einem Leisten-Ort eine Zelle werden. Die Leiste
 * hat damit nie eine Waise: sie ist ein Gitter über N gleich hohe Zellen, und
 * N ist genau die Zahl der Zellen, die etwas zu sagen haben.
 */
export function leistenZellen(input: {
  order: readonly string[];
  kennzahlen: PortfolioKennzahlen;
  anlagen: number;
  tonalitaet: FleetKind;
}): KennzahlZelle[] {
  const { kennzahlen: k, anlagen } = input;
  const out: KennzahlZelle[] = [];
  for (const id of input.order) {
    if (!bausteinOrt(id).leiste) continue;
    switch (id) {
      case 'erloese':
        if (k.erloesHeuteEur == null) break;
        out.push({
          id,
          label: vorteilLabel(input.tonalitaet),
          wert: signiertesGeld(k.erloesHeuteEur),
          einheit: '€',
          unterzeile: vorteilUnterzeile(k, anlagen),
          lead: true,
        });
        break;
      case 'netzbezug-gesamt':
        if (k.netzbezugJetztKw == null) break;
        out.push({
          id,
          label: 'Netzbezug jetzt',
          wert: mitUntergrenze(fmtNum(k.netzbezugJetztKw, ''), k.netzbezugJetztAnlagen, anlagen),
          einheit: 'kW',
          unterzeile: netzbezugFussnote(k, anlagen),
          ton: k.netzbezugJetztAnlagen < anlagen ? 'warn' : 'ruhig',
        });
        break;
      case 'pv-jetzt':
        if (k.pvJetztKw == null) break;
        out.push({
          id,
          label: 'PV jetzt',
          wert: mitUntergrenze(fmtNum(k.pvJetztKw, ''), k.pvJetztAnlagen, k.pvAnlagen ?? anlagen),
          einheit: 'kW',
          // Der Nenner sind die Anlagen MIT PV (Befund UEMS AP-01 IP-6): Halle 2
          // ohne Erzeuger macht aus „PV jetzt" keinen Vorbehalt.
          unterzeile: pvJetztFussnote(k, k.pvAnlagen ?? anlagen),
          ton: k.pvJetztAnlagen < (k.pvAnlagen ?? anlagen) ? 'warn' : 'ruhig',
        });
        break;
      case 'erzeugung-heute':
        if (k.erzeugungHeuteKwh == null) break;
        out.push({
          id,
          label: 'Erzeugung heute',
          wert: mitUntergrenze(fmtNum(k.erzeugungHeuteKwh, '', 0), k.erzeugungHeuteAnlagen, anlagen),
          einheit: 'kWh',
          unterzeile: anlagenText(k.erzeugungHeuteAnlagen, anlagen),
        });
        break;
      case 'verbrauch-heute':
        if (k.verbrauchHeuteKwh == null) break;
        out.push({
          id,
          label: 'Verbrauch heute',
          wert: mitUntergrenze(fmtNum(k.verbrauchHeuteKwh, '', 0), k.verbrauchHeuteAnlagen, anlagen),
          einheit: 'kWh',
          unterzeile: anlagenText(k.verbrauchHeuteAnlagen, anlagen),
        });
        break;
      case 'netz-heute': {
        // Bezug und Einspeisung stehen in EINER Zelle und werden nie saldiert
        // (die Katalog-Regel); eine fehlende Richtung wird ausgelassen, nie 0.
        const teile: string[] = [];
        if (k.bezugHeuteKwh != null) teile.push(`↓ ${mitUntergrenze(fmtNum(k.bezugHeuteKwh, '', 0), k.bezugHeuteAnlagen, anlagen)}`);
        if (k.einspeisungHeuteKwh != null) teile.push(`↑ ${mitUntergrenze(fmtNum(k.einspeisungHeuteKwh, '', 0), k.einspeisungHeuteAnlagen, anlagen)}`);
        if (teile.length === 0) break;
        out.push({
          id,
          label: 'Netz heute',
          wert: teile.join(' · '),
          einheit: 'kWh',
          unterzeile: [
            k.bezugHeuteKwh != null ? `Bezug: ${anlagenText(k.bezugHeuteAnlagen, anlagen)}` : null,
            k.einspeisungHeuteKwh != null ? `Einspeisung: ${anlagenText(k.einspeisungHeuteAnlagen, anlagen)}` : null,
          ].filter(Boolean).join(' · '),
        });
        break;
      }
      case 'lastspitzen':
        if (k.vermiedeneSpitzeEur == null) break;
        out.push({
          id,
          label: 'Vermiedene Spitze',
          wert: eur(k.vermiedeneSpitzeEur),
          einheit: '€',
          unterzeile:
            [k.vermiedeneSpitzeKw != null ? `${fmtNum(k.vermiedeneSpitzeKw, 'kW', 0)} gekappt` : null,
              anlagenText(k.vermiedeneSpitzeAnlagen, anlagen)].filter(Boolean).join(' · '),
        });
        break;
      case 'ladepunkte':
        if (k.ladepunkte == null) break;
        out.push({
          id,
          label: 'Ladepunkte',
          wert: mitUntergrenze(String(k.ladepunkte), k.ladepunkteAnlagen, anlagen),
          einheit: null,
          unterzeile: anlagenText(k.ladepunkteAnlagen, anlagen),
        });
        break;
      default:
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Die ANLAGEN-TABELLE
// ---------------------------------------------------------------------------

/** Eine optionale Spalte der Anlagen-Tabelle. */
export type SpaltenId =
  | 'pv-jetzt'
  | 'erzeugung-heute'
  | 'verbrauch-heute'
  | 'speicher'
  | 'netz-heute'
  | 'erloese';

/** Die optionalen Spalten in ihrer festen Lese-Reihenfolge (Jetzt → Heute). */
const SPALTEN_ORDNUNG: SpaltenId[] = [
  'pv-jetzt',
  'erzeugung-heute',
  'verbrauch-heute',
  'speicher',
  'netz-heute',
  'erloese',
];

/** Der Kopf einer Spalte: Name plus die leise Einheit darunter. */
export const SPALTEN_KOPF: Record<SpaltenId, { titel: string; einheit: string | null }> = {
  'pv-jetzt': { titel: 'PV jetzt', einheit: 'kW' },
  'erzeugung-heute': { titel: 'Erzeugung heute', einheit: 'kWh' },
  'verbrauch-heute': { titel: 'Verbrauch heute', einheit: 'kWh' },
  speicher: { titel: 'Speicher', einheit: null },
  // ⚠ Die Zelle der Leiste zeigt die ENERGIE des Tages, die Zeile die
  // LEISTUNG jetzt — dieselbe Grösse „Netz", zwei Zeitbezüge, ein Baustein.
  'netz-heute': { titel: 'Netz jetzt', einheit: 'kW' },
  erloese: { titel: 'Heute', einheit: '€' },
};

/**
 * Welche der OPTIONALEN Spalten die Tabelle trägt.
 *
 * Zwei Bedingungen, und beide sind eine Ehrlichkeitsregel: der Baustein muss
 * SICHTBAR sein (die Anordnung des Kunden — ein ausgeblendeter Baustein hat
 * auch keine Spalte) UND mindestens EINE Anlage muss sie füllen können. Eine
 * Spalte aus lauter „—" ist genau das Bild, gegen das diese Fläche gebaut ist;
 * ein EINZELNES „—" bleibt dagegen stehen — in einer gemischten Flotte ist es
 * die wahre Aussage über genau diese Anlage.
 *
 * Die Pflicht-Spalten (Anlage, Zustand) stehen immer — sie beantworten sich
 * aus der Existenz der Anlage selbst.
 */
export function tabellenSpalten(zeilen: readonly AnlagenZeile[], sichtbar: readonly string[]): SpaltenId[] {
  const an = new Set(sichtbar);
  // UEMS AP-01 IP-6: der Netzbezug gesamt ist je Anlage die Spalte „Netz jetzt".
  if (an.has('netzbezug-gesamt')) an.add('netz-heute');
  const gefuellt: Record<SpaltenId, (z: AnlagenZeile) => boolean> = {
    'pv-jetzt': (z) => z.pvJetztKw != null,
    'erzeugung-heute': (z) => z.erzeugungKwh != null,
    'verbrauch-heute': (z) => z.verbrauchKwh != null,
    speicher: (z) => z.ladestandPct != null,
    'netz-heute': (z) => z.netz != null,
    erloese: (z) => z.heuteEur != null,
  };
  return SPALTEN_ORDNUNG.filter((s) => an.has(s) && zeilen.some(gefuellt[s]));
}

/** Der Zustand einer Anlage in der Zeile: Punkt + Wort + Alter. */
export interface ZeilenZustand {
  wort: string;
  /** „seit 3 Std." — nur, wo ein Alter etwas erklärt; sonst null. */
  alter: string | null;
  ton: 'ok' | 'warn' | 'off';
}

/** Eine Zeile der Anlagen-Tabelle (am Telefon: eine Karte). */
export interface AnlagenZeile {
  id: string;
  name: string;
  /** Die Unterzeile — Stammdaten (kompakt) bzw. ein Satz (komfortabel). */
  unterzeile: string | null;
  /** „Speicher ohne Gerät" — der Fahrplan erreicht die Anlage nicht. */
  speicherOhneGeraet: boolean;
  pvJetztKw: number | null;
  erzeugungKwh: number | null;
  verbrauchKwh: number | null;
  ladestandPct: number | null;
  /** „lädt" · „entlädt" · „voll" · „zuletzt" — das Wort neben dem Balken. */
  ladestandWort: string | null;
  /** Netz JETZT: Richtung + Betrag; null = kein frischer Messwert. */
  netz: { richtung: 'bezug' | 'einspeisung' | 'ausgeglichen'; kw: number } | null;
  heuteEur: number | null;
  zustand: ZeilenZustand;
}

/** Reihenfolge des Zustands: was Aufmerksamkeit braucht, steht oben. */
const ZUSTAND_RANG: Record<string, number> = {
  'Meldet sich nicht': 0,
  'Wartet auf Daten': 1,
  'Kein Gerät': 2,
  Online: 3,
};

/**
 * Die Zeilen der Anlagen-Tabelle — **Zustand zuerst, dann Name** (§5.2).
 *
 * Die Sortierung ist die eigentliche Betriebs-Eigenschaft dieser Fläche: die
 * Anlage, die Aufmerksamkeit braucht, steht oben, ohne dass jemand sortieren
 * muss. Innerhalb eines Zustands entscheidet der Name (deutsche Kollation), so
 * dass die Reihenfolge zwischen zwei Aufrufen stabil ist.
 */
export function anlagenZeilen(input: {
  overview: Overview | null;
  earnings: Earnings | null;
  configById?: Map<string, Pick<Site, 'tarifArt' | 'leistungspreisEurKw'>> | null;
  dichte: Dichte;
  now: Date;
  /** Geld-Regel (UEMS AP-01 IP-6): nur diese Anlagen tragen „Heute €"; `null` = alle. */
  geld?: ReadonlySet<string> | null;
}): AnlagenZeile[] {
  const { now, dichte } = input;
  const geld = input.geld ?? null;
  const erloesBySite = new Map((input.earnings?.sites ?? []).map((s) => [s.id, s]));
  const heute = berlinDay(now);
  const zeilen = (input.overview?.sites ?? []).map((s) => zeileVon(s, {
    earnings: geld != null && !geld.has(s.id) ? null : (erloesBySite.get(s.id) ?? null),
    config: input.configById?.get(s.id) ?? null,
    heute,
    dichte,
    now,
  }));
  return zeilen.sort((a, b) => {
    const ra = ZUSTAND_RANG[a.zustand.wort] ?? 9;
    const rb = ZUSTAND_RANG[b.zustand.wort] ?? 9;
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name, 'de');
  });
}

function zeileVon(
  site: OverviewSite,
  ctx: {
    earnings: EarningsSite | null;
    config: Pick<Site, 'tarifArt' | 'leistungspreisEurKw'> | null;
    heute: string;
    dichte: Dichte;
    now: Date;
  },
): AnlagenZeile {
  const status = siteStatus(site);
  const frisch = siteLiveFresh(site, ctx.now);
  const live = site.live;
  const soc = siteSoc(site);
  const battKw = live ? deriveBatteryKw(live.pvKw, live.loadKw, live.gridKw) : null;
  const batt = batteryState(soc, frisch ? battKw : null);
  const netzWort = live && frisch ? gridState(live.gridKw) : 'unbekannt';

  return {
    id: site.id,
    name: site.name,
    unterzeile:
      ctx.dichte === 'kompakt'
        ? stammdatenZeile(site, ctx.config)
        : lebensZeile(site, status, frisch, batt, netzWort, ctx.now),
    speicherOhneGeraet: site.batteryWithoutDevice === true,
    // „jetzt" nur mit FRISCHEM Messwert - eine nachspielende Box ist online,
    // ihre Werte sind es nicht.
    pvJetztKw: frisch ? (live?.pvKw ?? null) : null,
    erzeugungKwh: site.energyToday?.pvKwh ?? null,
    verbrauchKwh: site.energyToday?.loadKwh ?? null,
    ladestandPct: soc,
    ladestandWort: soc == null ? null : ladestandWort(batt, frisch),
    netz:
      netzWort === 'unbekannt' || live?.gridKw == null
        ? null
        : { richtung: netzWort, kw: Math.abs(live.gridKw) },
    heuteEur: ctx.earnings ? savedOnDay(ctx.earnings.dailySaved, ctx.heute) : null,
    zustand: {
      wort: status.label,
      alter: status.tone === 'ok' ? null : seitDauer(site.lastSeenAt, ctx.now),
      ton: status.tone,
    },
  };
}

/** „lädt" · „entlädt" · „voll" · „zuletzt" — ohne frischen Messwert das Alter-Wort. */
function ladestandWort(batt: ReturnType<typeof batteryState>, frisch: boolean): string | null {
  if (!frisch) return 'zuletzt';
  switch (batt) {
    case 'laedt':
      return 'lädt';
    case 'entlaedt':
      return 'entlädt';
    case 'voll':
      return 'voll';
    default:
      return null;
  }
}

/**
 * Die KOMPAKTE Unterzeile: Stammdaten und Betriebsmodelle — **nie
 * Basis-Anwendungen** (die Chips „Anlage beobachten · Speicher-Fahrplan"
 * standen in JEDER Zeile und waren damit keine Information, Befund P6) und nie
 * Komponenten-Zähler (die Spalten PV/Speicher/Netz SIND die Komponenten).
 *
 * ⚠ Sie geht durch {@link anwendungenVonAnlage}, nicht direkt an
 * `site.anwendungen`: nur so behält eine Anlage an einem ÄLTEREN Backend ihre
 * abgeleiteten Geschäfts-Anwendungen (die M6-Zusage „mehrere, nie EIN
 * Gesicht"). Der Rückfall kann zu wenig sagen, nie zu viel.
 */
export function stammdatenZeile(
  site: OverviewSite,
  config?: Pick<Site, 'tarifArt' | 'leistungspreisEurKw'> | null,
): string | null {
  const teile: string[] = [
    site.plantKind === 'direktvermarktung' ? 'Direktvermarktung' : 'Eigenverbrauch',
  ];
  for (const id of anwendungenVonAnlage(site, config ?? null)) {
    if (anwendung(id)?.klasse === 'geschaeft') teile.push(anwendungLabel(id));
  }
  return teile.join(' · ');
}

/**
 * Die KOMFORTABLE Unterzeile: ein Satz über das, was die Anlage GERADE tut —
 * und wo sie nichts tut, der Grund. Sie behauptet nur, was der Messwert
 * hergibt; ohne frische Werte steht dort die Lage, nie eine Tätigkeit.
 */
export function lebensZeile(
  site: OverviewSite,
  status: { label: string },
  frisch: boolean,
  batt: ReturnType<typeof batteryState>,
  netz: ReturnType<typeof gridState>,
  now: Date,
): string | null {
  if (status.label === 'Kein Gerät') return 'Noch kein Gerät verbunden';
  if (status.label === 'Wartet auf Daten') return 'Wartet auf die ersten Daten';
  if (status.label === 'Meldet sich nicht') {
    const alter = seitDauer(site.lastSeenAt, now);
    return `meldet sich ${alter ? `${alter} ` : ''}nicht`;
  }
  const art = site.plantKind === 'direktvermarktung' ? 'Direktvermarktung' : 'Eigenverbrauch';
  if (!frisch) return `keine aktuellen Daten · ${art}`;
  if (batt === 'laedt') return `lädt gerade den Speicher · ${art}`;
  if (batt === 'entlaedt') return `versorgt sich aus dem Speicher · ${art}`;
  if (netz === 'einspeisung') return `gibt gerade ins Netz ab · ${art}`;
  if (netz === 'bezug') return `bezieht gerade Strom · ${art}`;
  return art;
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/**
 * Der eine Satz über der Fläche, wenn ein Baustein FEHLT, weil seine Anwendung
 * nicht läuft — er wird bewusst NICHT gesagt. Eine Flotte, die keinen Speicher
 * hat, braucht keine Erklärung dafür, dass keine Speicher-Spalte dasteht; die
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
