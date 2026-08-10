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
  /** PV / irradiance. */
  pv: string;
  /** Temperature. */
  temp: string;
  /** Consumption / load. */
  load: string;
  /** Price + net-power reference line (action ink). */
  price: string;
  /** Battery state of charge. */
  soc: string;
  /** Charge / feed-in (positive). */
  charge: string;
  /** Battery charge FROM THE GRID (Netzladen slots in the Fahrplan). */
  gridCharge: string;
  /** Grid draw / cost (Netzbezug, warning-coloured red). */
  discharge: string;
  /**
   * BATTERY discharge in the plan (blue). Deliberately NOT the red `discharge`
   * above: a discharging battery is the money-making action, and red reads as
   * a problem (audit F5). Red stays for genuine costs/warnings.
   */
  battDischarge: string;
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
   * The GRID role hue (teal) - the same `--vp-flow-grid` the energy-flow diagram
   * uses, so a "Netz" series reads as the grid everywhere. Deliberately NOT
   * `gridCharge` (that is the Netzladen slot colour) and not the red
   * `discharge` (that is cost/warning ink).
   */
  flowGrid: string;
  /**
   * The CONSUMER role hue (purple) - the same `--vp-flow-load` the energy-flow
   * diagram uses for Haus/Verbraucher, so the Fahrplan's stacked consumer
   * layers read as loads everywhere (Verbrauchssteuerung §14.11). Several
   * consumers get deterministic shades of THIS one hue.
   */
  consumer: string;
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
    temp: read('--vp-chart-temp', '#F57C00'),
    load: read('--vp-chart-load', '#2196F3'),
    price: read('--vp-chart-price', '#2F6BD6'),
    soc: read('--vp-chart-soc', '#9C27B0'),
    charge: read('--vp-chart-charge', '#2E9E5B'),
    gridCharge: read('--vp-chart-gridcharge', '#00ACC1'),
    discharge: read('--vp-chart-discharge', '#E53935'),
    battDischarge: read('--vp-chart-battdischarge', '#2C5282'),
    plan: read('--vp-chart-plan', '#1E3A5F'),
    cloud: read('--vp-chart-cloud', '#90A4AE'),
    idle: read('--vp-chart-idle', '#EDEFF2'),
    neutral: read('--vp-chart-neutral', '#607D8B'),
    flowGrid: read('--vp-flow-grid', '#0ea5a3'),
    consumer: read('--vp-flow-load', '#8b5cf6'),
  };
  return cache;
}
