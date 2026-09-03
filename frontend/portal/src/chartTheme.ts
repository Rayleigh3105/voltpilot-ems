/**
 * One shared chart palette + type token set for every ECharts surface in the
 * portal (TelemetryChart, ScheduleChart, HistoryChart, WeatherChart,
 * PriceHistoryChart, ForecastQualityChart). ECharts renders to canvas and can't
 * resolve CSS var() at paint time, so we read the design-system `--vp-chart-*`
 * tokens (tokens/colors.css) from :root once, memoise them, and fall back to the
 * token defaults when running headless. Charts import THIS instead of scattering
 * their own hard-coded hex, so the data surfaces read the same brand palette as
 * the rest of the UI and re-theming is a single edit in the tokens.
 */
export interface ChartTheme {
  /** Body/label font, matches the portal type tokens. */
  font: string;
  /** Axis + muted legend text. */
  axis: string;
  /** Legend labels (strong ink). */
  ink: string;
  /** Split (grid) lines. */
  grid: string;
  /** Axis lines. */
  axisLine: string;
  /**
   * Der Kartengrund unter dem Canvas. Canvas kann `var()` nicht auflösen, eine
   * Beschriftung MITTEN im Diagramm (z. B. die Tagesgrenze der Marktpreise)
   * braucht aber einen deckenden Grund, um über den Balken lesbar zu bleiben.
   */
  surface: string;
  /** PV / irradiance as a BAR or AREA. */
  pv: string;
  /**
   * Die LINIEN-Stufe von {@link pv} (`--vp-chart-pv-line` #E65100). Das helle
   * Grundorange misst nur 2,2:1 auf Weiss - als 1,4-2,2-px-Linie verschwindet
   * es. Regel wie bei {@link flowGridLine}: **PV als LINIE nimmt `pvLine`, PV
   * als BALKEN/FLAECHE behaelt `pv`** (F2, „duenn heisst dunkler").
   */
  pvLine: string;
  /** Temperature. */
  temp: string;
  /** Consumption / load as a BAR or AREA. */
  load: string;
  /**
   * Die LINIEN-Stufe von {@link load} (`--vp-chart-load-line` #1D6FD8, 4,9:1).
   * Sie hebt das Haus-Blau zugleich vom Preis-Blau ab (der gemessene
   * Blau-Kollaps im Live-Chart, F10).
   */
  loadLine: string;
  /** Price + net-power reference line (action ink). */
  price: string;
  /** Battery state of charge. */
  soc: string;
  /** Charge / feed-in (positive). */
  charge: string;
  /** Battery charge FROM THE GRID (Netzladen slots in the Fahrplan). */
  gridCharge: string;
  /** Battery discharge / energy leaving storage (filled berry). */
  battDischarge: string;
  /** Grid draw / cost (Netzbezug, warning-coloured red). */
  discharge: string;
  /** Plan overlay. */
  plan: string;
  /** Cloud cover. */
  cloud: string;
  /**
   * Der RUHENDE Slot (warten / Reserve halten) - bewusst KEIN Serienton,
   * damit „hier passiert nichts" nie wie eine Handlung aussieht.
   */
  idle: string;
  /**
   * Benanntes Neutral-Grau für Kontext-/Admin-Reihen (F10: „Neutral-Grau als
   * *benanntes* Token"). Es ist der Wert, der als `rgba(96,125,139,…)` im
   * Admin-PlanChart stand - gleicher Ton, jetzt mit Namen.
   */
  neutral: string;
  /**
   * Der Ton des GÜNSTIGEN (und des negativen) Preisfensters — Chart-Redesign
   * Stufe 4. Bewusst NICHT das helle Laden-Grün {@link charge}: die zwei
   * benannten Fenster werden immer zusammen gezeichnet, und `#2E9E5B` gegen das
   * Kosten-Rot misst ΔE 5,4 (harter CVD-FAIL), diese Stufe 6,0 — das Band, das
   * der dataviz-Validator mit Zweitkodierung durchlässt, und jedes Fenster
   * trägt sein WORT im Bild. Derselbe „die FORM entscheidet die Stufe"-Fall wie
   * bei {@link pvLine}/{@link flowGridLine}. Das teure Fenster nimmt das
   * bestehende Kosten-Rot {@link discharge}.
   */
  guenstig: string;
  /**
   * The GRID role hue (teal) - the same `--vp-flow-grid` the energy-flow diagram
   * uses, so a "Netz" series reads as the grid everywhere. Deliberately NOT
   * `gridCharge` (that is the Netzladen slot colour) and not the red
   * `discharge` (that is cost/warning ink).
   */
  flowGrid: string;
  /**
   * Die LINIEN-Stufe von {@link flowGrid}. Als Linie steht „Netz" direkt neben
   * dem Batterie-Laden-Grün und war davon nicht zu trennen (ΔE 9,8, harter
   * FAIL); diese Stufe trennt mit ΔE 19,3. Regel: **Netz als LINIE nimmt
   * `flowGridLine`, Netz als BALKEN/FLÄCHE behält `flowGrid`** - der helle
   * Grundton bleibt die Rollenfarbe (Energiefluss, Kacheln, kWh-Balken).
   */
  flowGridLine: string;
  /**
   * The CONSUMER role hue (purple) - the same `--vp-flow-load` the energy-flow
   * diagram uses for Haus/Verbraucher, so the Fahrplan's stacked consumer
   * layers read as loads everywhere (Verbrauchssteuerung §14.11). Several
   * consumers get deterministic shades of THIS one hue.
   */
  consumer: string;
  /** Variante C · Reihe 1 der Geld-Charts (Einspeise-Erlös) — Primary. */
  cReihe1: string;
  /** Variante C · Reihe 2 (Wert des Eigenverbrauchs) — Secondary. */
  cReihe2: string;
  /** Variante C · die Kosten-Reihe — Destructive, mit Vorzeichen im Text. */
  cKosten: string;
  /** Variante C · die FÜHRENDE Linie (kumuliert) — Foreground. */
  cLead: string;
}

let cache: ChartTheme | null = null;

function read(name: string, fallback: string): string {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** The resolved chart palette (memoised - tokens are static after first paint). */
export function chartTheme(): ChartTheme {
  if (cache) return cache;
  cache = {
    font: 'Inter, sans-serif',
    axis: read('--vp-chart-axis', '#6C757D'),
    ink: read('--vp-chart-ink', '#1A1A1A'),
    grid: read('--vp-chart-grid', '#F1F3F5'),
    surface: read('--vp-surface', '#FFFFFF'),
    axisLine: read('--vp-chart-axisline', '#E9ECEF'),
    pv: read('--vp-chart-pv', '#FF9800'),
    pvLine: read('--vp-chart-pv-line', '#E65100'),
    temp: read('--vp-chart-temp', '#4B5563'),
    load: read('--vp-chart-load', '#2196F3'),
    loadLine: read('--vp-chart-load-line', '#1D6FD8'),
    price: read('--vp-chart-price', '#2F6BD6'),
    soc: read('--vp-chart-soc', '#9C27B0'),
    charge: read('--vp-chart-charge', '#2E9E5B'),
    gridCharge: read('--vp-chart-gridcharge', '#00ACC1'),
    battDischarge: read('--vp-chart-battdischarge', '#8B1E3F'),
    discharge: read('--vp-chart-discharge', '#E53935'),
    plan: read('--vp-chart-plan', '#1E3A5F'),
    cloud: read('--vp-chart-cloud', '#90A4AE'),
    idle: read('--vp-chart-idle', '#EDEFF2'),
    neutral: read('--vp-chart-neutral', '#607D8B'),
    guenstig: read('--vp-chart-guenstig', '#15803D'),
    flowGrid: read('--vp-flow-grid', '#0ea5a3'),
    flowGridLine: read('--vp-chart-grid-line', '#036672'),
    consumer: read('--vp-flow-load', '#8b5cf6'),
    // --- Variante C: die vier Reihen-Farben der ERLÖSE-Welt ---------------
    // Sie kommen aus der Zuordnungstabelle in `index.css` (Konzept
    // `vp-erloese-lesbar-konzept-u3` §3.10 Punkt 6: „Chart-Farben aus der
    // Palette Primary/Secondary/Foreground/Destructive"). Bewusst EIGENE
    // Einträge statt einer Umdefinition von `price`/`charge`/`discharge`:
    // die tragen portalweit ihre Bedeutung (Preis, Laden, Entladen) und
    // dürfen nicht die Farbe einer Geld-Reihe annehmen.
    cReihe1: read('--vp-erl-chart-1', '#2563eb'),
    cReihe2: read('--vp-erl-chart-2', '#3b82f6'),
    cKosten: read('--vp-erl-chart-kosten', '#dc2626'),
    cLead: read('--vp-erl-chart-lead', '#1e293b'),
  };
  return cache;
}
