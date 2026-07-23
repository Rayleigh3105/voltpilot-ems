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
  };
  return cache;
}
