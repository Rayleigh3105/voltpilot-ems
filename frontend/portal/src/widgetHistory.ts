/**
 * Portal v3.2 · **M2 — der Verlauf im Widget-Detail-Modal.**
 *
 * Das Widget-Modal zeigt seit v3.2-M2 die Werte einer Kachel UND ihren
 * **Verlauf** in EINER Ansicht (kein „Jetzt | Verlauf"-Umschalter mehr). Dieses
 * Modul ist die **reine Ableitung** dieses Verlaufs (der `cockpitWidgets.ts`/
 * `live.ts`-Präzedenzfall): kein React, kein Netzwerk, kein neuer Rechenkern —
 * es KONSUMIERT die bereits vorhandenen `History`-Buckets (`api.history`, die
 * dieselbe Quelle wie die Historie-Seite sind) und ordnet jeder Fluss-/Energie-
 * Kachel ihre eine bzw. zwei Messreihen zu.
 *
 * Zwei Regeln sind auch hier Gesetz:
 *
 * 1. **Nicht jede Kachel hat einen Verlauf.** `widgetHistoryMetric(id)` liefert
 *    `null` für Kacheln, die aus den Historie-Buckets keine sinnvolle Kurve
 *    ziehen (Handel/Erlöse/Lastspitze tragen eigene reiche Körper, Automatik/
 *    Wetter haben hier keine Reihe). Für die Fluss-Kacheln (Erzeugung, Speicher,
 *    Netz, Haus) und Eigenverbrauch gibt es eine.
 * 2. **Die „—"-Disziplin.** Liegt für den gewählten Zeitraum kein Verlauf vor
 *    (Gesamt hat keinen Historie-Endpunkt, ein frischer Zeitraum noch keine
 *    Buckets), zeigt das Modal einen EHRLICHEN Satz statt eines erfundenen
 *    Diagramms — `metricHasData` entscheidet das, `noVerlaufNote` formuliert es.
 *
 * Die Messreihe **folgt dem gewählten Zeitraum**: `day` → mittlere Leistung in
 * kW (Kurve), Woche/Monat/Jahr → Energie in kWh (Balken), Ladestand → Prozent
 * (Kurve). `widgetSeries` baut genau das render-fertig, ohne ECharts zu kennen.
 */

import type { EarningsRange, History, HistoryBucket } from './api';
import type { WidgetId } from './cockpitWidgets';

/** Die Farbe einer Messreihe — ein `chartTheme()`-Token. */
export type SeriesColor = 'pv' | 'load' | 'discharge' | 'charge' | 'soc';

/** Die Achse des Verlaufs: Energie (kW/kWh) oder Ladestand (%). */
export type MetricAxis = 'energy' | 'percent';

/** Eine Messreihe einer Kachel — Feld im Bucket + Etikett + Farbe. */
export interface WidgetSeriesSpec {
  label: string;
  field: keyof HistoryBucket;
  color: SeriesColor;
}

/** Der Verlauf einer Kachel: eine oder zwei Reihen auf einer Achse. */
export interface WidgetMetric {
  axis: MetricAxis;
  series: WidgetSeriesSpec[];
  /** Der eine deutsche Aussage-Satz unter dem Diagramm. */
  insight: string;
}

/**
 * Welche Kachel welchen Verlauf zeigt. Nur die Fluss-/Energie-Kacheln haben
 * eine belastbare Kurve aus den Historie-Buckets; die Geld-Kacheln (Handel,
 * Erlöse, Lastspitze) tragen ihre eigenen reichen Modal-Körper und bekommen
 * hier bewusst `null`, Automatik/Wetter ebenso.
 */
const METRICS: Partial<Record<WidgetId, WidgetMetric>> = {
  erzeugung: {
    axis: 'energy',
    series: [{ label: 'PV-Erzeugung', field: 'pvKwh', color: 'pv' }],
    insight:
      'Ihre Solar-Erzeugung über den Zeitraum. Die Höhe folgt Sonnenstand und Wetter.',
  },
  haus: {
    axis: 'energy',
    series: [{ label: 'Hausverbrauch', field: 'loadKwh', color: 'load' }],
    insight: 'So viel Strom hat Ihr Haus über den Zeitraum verbraucht.',
  },
  netz: {
    axis: 'energy',
    series: [
      { label: 'Netzbezug', field: 'gridImportKwh', color: 'discharge' },
      { label: 'Einspeisung', field: 'gridExportKwh', color: 'charge' },
    ],
    insight:
      'Was Sie aus dem Netz bezogen (rot) und was Sie eingespeist haben (grün) — je Zeitabschnitt.',
  },
  speicher: {
    axis: 'percent',
    series: [{ label: 'Ladestand', field: 'socLastPct', color: 'soc' }],
    insight:
      'Der Ladestand Ihres Speichers über den Zeitraum — gefüllt in günstigen, geleert in teuren Zeiten.',
  },
  eigenverbrauch: {
    axis: 'energy',
    series: [
      { label: 'PV-Erzeugung', field: 'pvKwh', color: 'pv' },
      { label: 'Hausverbrauch', field: 'loadKwh', color: 'load' },
    ],
    insight:
      'PV-Erzeugung (gelb) gegen Hausverbrauch (blau): Wo sich die Kurven decken, nutzen Sie Ihren Solarstrom selbst.',
  },
};

/** Der Verlauf einer Kachel, oder `null` wenn sie keinen aus der Historie hat. */
export function widgetHistoryMetric(id: WidgetId): WidgetMetric | null {
  return METRICS[id] ?? null;
}

/** Eine render-fertige Reihe (rohe Zahlen; das Diagramm formatiert). */
export interface RenderedSeries {
  label: string;
  color: SeriesColor;
  data: (number | null)[];
}

/** Die render-fertige Sicht auf den Verlauf einer Kachel. */
export interface WidgetSeriesView {
  /** Bucket-Startzeiten (ISO) — die x-Achse. */
  labels: string[];
  /** Die Einheit: `kW` (Tag), `kWh` (Woche/Monat/Jahr) oder `%` (Ladestand). */
  unit: string;
  axis: MetricAxis;
  /** true = Tages-Zeitraum → Kurve statt Balken. */
  day: boolean;
  series: RenderedSeries[];
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Baut die render-fertige Messreihe aus den Historie-Buckets — **folgt dem
 * gewählten Zeitraum**: Tag → mittlere Leistung in kW, sonst Energie in kWh;
 * Ladestand bleibt Prozent. Es rechnet die Buckets nur um, nie etwas dazu.
 */
export function widgetSeries(history: History, metric: WidgetMetric): WidgetSeriesView {
  const day = history.range === 'day';
  const percent = metric.axis === 'percent';
  const unit = percent ? '%' : day ? 'kW' : 'kWh';
  const labels = history.buckets.map((b) => b.start);
  const conv = (v: number | null): number | null => {
    if (v == null) return null;
    if (percent) return v;
    // kWh je Bucket → mittlere kW über den Bucket (nur im Tages-Zeitraum).
    return day ? (v * 60) / history.bucketMinutes : v;
  };
  const series = metric.series.map((s) => ({
    label: s.label,
    color: s.color,
    data: history.buckets.map((b) => conv(num(b[s.field]))),
  }));
  return { labels, unit, axis: metric.axis, day, series };
}

/**
 * Gibt es für diesen Zeitraum überhaupt einen Verlauf? False, wenn keine
 * Historie geladen ist (Gesamt / Ladefehler) ODER kein Bucket einen Wert der
 * Kachel-Reihen trägt — dann zeigt das Modal `noVerlaufNote` statt eines
 * erfundenen Diagramms.
 */
export function metricHasData(
  history: History | null | undefined,
  metric: WidgetMetric,
): boolean {
  if (!history || history.buckets.length === 0) return false;
  return metric.series.some((s) => history.buckets.some((b) => num(b[s.field]) != null));
}

/**
 * Der ehrliche Satz, wenn kein Verlauf vorliegt. „Gesamt" hat keinen
 * Historie-Endpunkt und wird eigens benannt (der Kunde soll wissen, dass ein
 * anderer Zeitraum einen Verlauf hat), sonst der neutrale „noch keine Daten".
 */
export function noVerlaufNote(range: EarningsRange): string {
  if (range === 'all') {
    return 'Für „Gesamt" gibt es keinen Verlauf. Wählen Sie Heute, Monat oder Jahr, um den zeitlichen Verlauf zu sehen.';
  }
  return 'Für diesen Zeitraum liegt noch kein Verlauf vor. Sobald Ihre Anlage misst, erscheint er hier.';
}
