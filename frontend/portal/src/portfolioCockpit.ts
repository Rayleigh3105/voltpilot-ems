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
 * Umsortierung je Bildschirmbreite.
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
  erloese: { leiste: true, spalte: true },
  // ⚠ NUR die Spalte: der kumulierte Ladestand ist raus (Captain 25.08.2026).
  speicher: { leiste: false, spalte: true },
  lastspitzen: { leiste: true, spalte: false },
  ladepunkte: { leiste: true, spalte: false },
  'pv-jetzt': { leiste: true, spalte: true },
  'erzeugung-heute': { leiste: true, spalte: true },
  'verbrauch-heute': { leiste: true, spalte: true },
  'netz-heute': { leiste: true, spalte: true },
  // Die Tabelle SELBST — sie steht immer, und immer zuletzt.
  anlagen: { leiste: false, spalte: false },
};

/** Wo dieser Baustein rendert; ein unbekannter (neuerer Server) nirgends. */
export function bausteinOrt(id: string): BausteinOrt {
  return ORT[id as PortfolioBausteinId] ?? { leiste: false, spalte: false };
}

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
    ladestandAnlagen: sites.filter((s) => siteSoc(s) != null).length,
    erloesHeuteEur: erloesHeute,
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
  const ohne = sites.filter((s) => siteStatus(s).label === 'Kein Gerät');

  if (online === gesamt) {
    return { tone: 'ok', text: gesamt === 1 ? '1 Anlage online' : `Alle ${gesamt} Anlagen online` };
  }

  const teile = [`${online} von ${gesamt} Anlagen online`];
  if (stumm.length > 0) teile.push(stummSatz(stumm, now));
  else if (wartet.length > 0) teile.push(wartetSatz(wartet));
  else if (ohne.length > 0) teile.push(ohneGeraetSatz(ohne));
  return { tone: stumm.length > 0 || wartet.length > 0 ? 'warn' : 'off', text: teile.join(' · ') };
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
 * Das Wort für das Steuerungs-Delta (`savedEur`) — der Befund P7 des Scouts:
 * „Erlös heute" ist kein Erlös, sondern der VORTEIL gegenüber der ungeregelten
 * Anlage, und im Cockpit derselben Anlage heißt dieselbe Zahl „durch
 * Steuerung". Beide Flächen tragen deshalb seit Revision 2 dieselbe
 * Unterzeile.
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
export const VORTEIL_BEZUG = 'gegenüber ungeregelt';

/** „+33,13" / „-0,80" / „0,00" — eine echte Null trägt kein Vorzeichen. */
export function signiertesGeld(v: number): string {
  const wert = Math.abs(v) < 0.005 ? 0 : v;
  return wert > 0 ? `+${eur(wert)}` : eur(wert);
}

/** Die Fussnote der PV-Zelle — „jetzt" gilt nur für Anlagen, die gerade melden. */
export function pvJetztFussnote(k: PortfolioKennzahlen, anlagen: number): string | null {
  if (k.pvJetztKw == null) return null;
  if (k.pvJetztAnlagen >= anlagen) return null;
  return `${k.pvJetztAnlagen} von ${anlagen} Anlagen melden gerade`;
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
          unterzeile:
            anlagen > 1
              ? `${VORTEIL_BEZUG} · ${anlagen} Anlagen`
              : VORTEIL_BEZUG,
          lead: true,
        });
        break;
      case 'pv-jetzt':
        if (k.pvJetztKw == null) break;
        out.push({
          id,
          label: 'PV jetzt',
          wert: fmtNum(k.pvJetztKw, ''),
          einheit: 'kW',
          unterzeile: pvJetztFussnote(k, anlagen),
          ton: pvJetztFussnote(k, anlagen) ? 'warn' : 'ruhig',
        });
        break;
      case 'erzeugung-heute':
        if (k.erzeugungHeuteKwh == null) break;
        out.push({
          id,
          label: 'Erzeugung heute',
          wert: fmtNum(k.erzeugungHeuteKwh, '', 0),
          einheit: 'kWh',
          unterzeile: null,
        });
        break;
      case 'verbrauch-heute':
        if (k.verbrauchHeuteKwh == null) break;
        out.push({
          id,
          label: 'Verbrauch heute',
          wert: fmtNum(k.verbrauchHeuteKwh, '', 0),
          einheit: 'kWh',
          unterzeile: null,
        });
        break;
      case 'netz-heute': {
        // Bezug und Einspeisung stehen in EINER Zelle und werden nie saldiert
        // (die Katalog-Regel); eine fehlende Richtung wird ausgelassen, nie 0.
        const teile: string[] = [];
        if (k.bezugHeuteKwh != null) teile.push(`↓ ${fmtNum(k.bezugHeuteKwh, '', 0)}`);
        if (k.einspeisungHeuteKwh != null) teile.push(`↑ ${fmtNum(k.einspeisungHeuteKwh, '', 0)}`);
        if (teile.length === 0) break;
        out.push({
          id,
          label: 'Netz heute',
          wert: teile.join(' · '),
          einheit: 'kWh',
          unterzeile:
            teile.length === 2 ? 'Bezug · Einspeisung' : k.bezugHeuteKwh != null ? 'Bezug' : 'Einspeisung',
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
            k.vermiedeneSpitzeKw != null ? `${fmtNum(k.vermiedeneSpitzeKw, 'kW', 0)} gekappt` : null,
        });
        break;
      case 'ladepunkte':
        if (k.ladepunkte == null) break;
        out.push({
          id,
          label: 'Ladepunkte',
          wert: String(k.ladepunkte),
          einheit: null,
          unterzeile: null,
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
}): AnlagenZeile[] {
  const { now, dichte } = input;
  const erloesBySite = new Map((input.earnings?.sites ?? []).map((s) => [s.id, s]));
  const heute = berlinDay(now);
  const zeilen = (input.overview?.sites ?? []).map((s) => zeileVon(s, {
    earnings: erloesBySite.get(s.id) ?? null,
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
