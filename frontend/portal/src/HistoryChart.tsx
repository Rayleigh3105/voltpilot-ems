import { useState } from 'react';
import type { History } from './api';
import { chartTheme, type ChartTheme } from './chartTheme';
import {
  anzeigeWert,
  energieDiagramm,
  toggleSerie,
  vorzeichenLabel,
  type EnergieFarbe,
  type EnergieSerie,
} from './energieBilanz';
import { useEChart } from './useEChart';
import { ChartLegend, ChartInsight, type LegendItem } from './components/ChartExplain';

import './components/Historie.css';

/** Bucket label: day -> "12:15", week -> "Mi 06:00", month/year -> "15.06.". */
function timeLabel(iso: string, range: History['range'], narrow = false): string {
  const d = new Date(iso);
  if (range === 'day') {
    return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }
  if (range === 'week') {
    // A phone-width canvas has no room for "Mi 06:00" pairs - the weekday
    // alone keeps several ticks readable instead of one lonely label.
    if (narrow) return d.toLocaleDateString('de-DE', { weekday: 'short' });
    return `${d.toLocaleDateString('de-DE', { weekday: 'short' })} ${d.toLocaleTimeString('de-DE', {
      hour: '2-digit',
      minute: '2-digit',
    })}`;
  }
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}

/** kWh -> avg kW over one bucket. */
function kw(kwh: number | null, bucketMinutes: number): number | null {
  return kwh == null ? null : (kwh * 60) / bucketMinutes;
}

/** Index of the last bucket whose start is at/before now, else -1. */
function nowBucketIdx(buckets: History['buckets']): number {
  const nowMs = Date.now();
  let idx = -1;
  for (let i = 0; i < buckets.length; i++) {
    if (new Date(buckets[i].start).getTime() <= nowMs) idx = i;
    else break;
  }
  return idx;
}

function ct(v: number | null): string {
  return v == null
    ? '-'
    : `${v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ct/kWh`;
}

/** A pure `EnergieFarbe` key -> the resolved chart hex. */
function farbe(t: ChartTheme, key: EnergieFarbe): string {
  switch (key) {
    case 'pv':
      return t.pv;
    case 'load':
      return t.load;
    case 'grid':
      return t.flowGrid;
    case 'gridImport':
      return t.discharge;
    case 'gridExport':
      return t.charge;
    case 'charge':
      return t.charge;
    case 'battDischarge':
      return t.battDischarge;
    case 'soc':
    default:
      return t.soc;
  }
}

function num(v: number, digits = 2): string {
  return v.toLocaleString('de-DE', { maximumFractionDigits: digits });
}

/**
 * **Die Standardansicht „Energie"** — EIN Diagramm mit der ganzen
 * Energiegeschichte des Zeitraums: PV-Erzeugung, Hausverbrauch, Netz
 * (+Bezug/−Einspeisung), Batterie (+laden/−entladen) und der Ladestand auf einer
 * zweiten Achse. Das ist der gemeinsame Nenner der sechs recherchierten
 * Referenzprodukte (Fronius Solar.web, SolarEdge, Home Assistant Energy, Victron
 * VRM, OpenEMS, evcc) — und der Ersatz für die frühere Vier-Reihen-Fassung, die
 * weder Batterie noch Ladestand zeigte und unter dem GELD-Tab lag.
 *
 * Fünf Regeln aus dem Entwurf, alle hier umgesetzt:
 *
 *  1. Tag = kW-Linien, Woche/Monat/Jahr = kWh-Balken (der SolarEdge/Fronius-Wechsel).
 *  2. **Die Legende ist die Bedienung** — Klick blendet eine Reihe aus.
 *  3. Der Tooltip nennt **alle** Reihen zu einem Zeitpunkt, in Klartext
 *     („Einspeisung 55,0 kW", nicht „Netz −55").
 *  4. Eine **betonte Nulllinie** trägt „↑ Bezug · Laden / ↓ Einspeisung · Entladen".
 *  5. Zoom per Streifen (unter 480 px entfällt er, wie im Entwurf vermerkt).
 *
 * Ehrlichkeit: eine Reihe ohne einen einzigen Wert wird NICHT als 0-Linie
 * gezeichnet — sie fehlt, und die Legende nennt den Grund.
 */
export function HistoryEnergieChart({ history }: { history: History }) {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const t = chartTheme();
  const diagramm = energieDiagramm(history);
  // Nur Reihen mit Werten sind überhaupt schaltbar/zeichenbar.
  const vorhanden = diagramm.serien.filter((s) => !s.leer);
  const fehlend = diagramm.serien.filter((s) => s.leer);
  const sichtbar = vorhanden.filter((s) => !hidden.has(s.label));

  const ref = useEChart(
    (chart, width) => {
      const narrow = width < 480;
      const weekNarrow = narrow && history.range === 'week';
      const { zeiten, einheit, jetztIndex } = diagramm;
      const brauchtSoc = sichtbar.some((s) => s.zweiteAchse);

      const serieOption = (s: EnergieSerie, isFirst: boolean) => {
        const color = farbe(t, s.farbe);
        const base = {
          name: s.label,
          yAxisIndex: s.zweiteAchse ? 1 : 0,
          data: s.werte,
          itemStyle: { color },
        };
        // Die betonte Nulllinie hängt an der ersten gezeichneten kW/kWh-Reihe.
        // Die RICHTUNGSWORTE stehen bewusst NICHT auf der Linie: im echten
        // Diagramm liegen dort die Kurven, die Beschriftung wurde unlesbar
        // durchkreuzt (und ECharts zeichnete von zwei Labels auf derselben Linie
        // nur eines). Sie stehen darum als lesbare Zeile unter der Legende -
        // gleicher Inhalt, umbruchfähig, auch am Telefon.
        const zeroLine =
          isFirst && !s.zweiteAchse
            ? {
                markLine: {
                  silent: true,
                  symbol: 'none',
                  data: [
                    {
                      yAxis: 0,
                      lineStyle: { color: t.axis, width: 1.6, type: 'solid' as const },
                      label: { show: false },
                    },
                    ...(jetztIndex > 0 && jetztIndex < zeiten.length - 1
                      ? [
                          {
                            xAxis: jetztIndex,
                            lineStyle: { color: t.price, width: 2, type: 'solid' as const },
                            label: {
                              formatter: 'Jetzt',
                              color: t.price,
                              position: 'insideEndTop' as const,
                              rotate: 0,
                            },
                          },
                        ]
                      : []),
                  ],
                },
              }
            : {};
        if (s.linie) {
          return {
            ...base,
            ...zeroLine,
            type: 'line' as const,
            smooth: true,
            showSymbol: false,
            connectNulls: false,
            lineStyle: s.zweiteAchse
              ? { width: 1.8, color, type: 'dotted' as const }
              : { width: 2.4, color },
            ...(s.zweiteAchse ? {} : { areaStyle: { opacity: 0.06, color } }),
            z: s.zweiteAchse ? 1 : 2,
          };
        }
        return {
          ...base,
          ...zeroLine,
          type: 'bar' as const,
          barMaxWidth: 16,
          itemStyle: { color, borderRadius: 2 },
        };
      };

      chart.setOption(
        {
          textStyle: { fontFamily: t.font, color: t.axis },
          grid: {
            top: 26,
            right: brauchtSoc ? (narrow ? 26 : 46) : 12,
            bottom: narrow ? 8 : 34,
            left: 8,
            containLabel: true,
          },
          tooltip: {
            trigger: 'axis',
            confine: true,
            formatter: (params: { axisValue: string; value: number | null; marker: string; seriesName: string }[]) => {
              const head = `<b>${timeLabel(params[0]?.axisValue, history.range)}${
                history.range === 'day' ? ' Uhr' : ''
              }</b>`;
              const lines = [head];
              for (const p of params) {
                if (p.value == null) continue;
                const s = sichtbar.find((x) => x.label === p.seriesName);
                if (!s) continue;
                const v = Number(p.value);
                const label = s.signed ? vorzeichenLabel(s.key, v) : s.label;
                lines.push(`${p.marker} ${label}: ${num(anzeigeWert(s, v))} ${s.unit}`);
              }
              return lines.join('<br/>');
            },
          },
          xAxis: {
            type: 'category',
            data: zeiten,
            boundaryGap: diagramm.balken,
            axisLabel: {
              // Narrow week view: one weekday label per day (at its first
              // bucket) - the auto interval over hourly buckets would repeat
              // weekdays ("Mo Mo Di ...").
              formatter: weekNarrow
                ? (v: string) => (new Date(v).getHours() === 0 ? timeLabel(v, 'week', true) : '')
                : (v: string) => timeLabel(v, history.range, narrow),
              interval: weekNarrow ? 0 : 'auto',
              color: t.axis,
              hideOverlap: true,
            },
            axisTick: { show: !weekNarrow },
            axisLine: { lineStyle: { color: t.axisLine } },
          },
          yAxis: [
            {
              type: 'value',
              name: narrow ? einheit : einheit === 'kW' ? 'Leistung (kW)' : 'Energie (kWh)',
              nameTextStyle: { color: t.axis, align: 'left' },
              nameGap: 12,
              splitLine: { lineStyle: { color: t.grid } },
              axisLabel: { color: t.axis },
            },
            {
              type: 'value',
              name: narrow ? '' : 'Ladestand (%)',
              nameTextStyle: { color: t.soc, align: 'right' },
              nameGap: 12,
              position: 'right',
              min: 0,
              max: 100,
              // Shown WHENEVER the Ladestand is drawn, phone included: its 0..100
              // scale does not share the kW zero, so without the labelled axis a
              // 30 % night reading sits visually BELOW the emphasised zero line
              // and reads as a negative power (measured in the browser at 375 px).
              show: brauchtSoc,
              splitLine: { show: false },
              axisLabel: {
                color: t.soc,
                formatter: narrow ? '{value}' : '{value} %',
                showMinLabel: false,
              },
            },
          ],
          // Zoom/Brush: am Telefon entfällt der Streifen (Entwurf), das
          // Pinch-/Wheel-Zoom bleibt.
          // `zoomOnMouseWheel: false` is load-bearing: the chart sits on a long
          // scrollable page, so a wheel over it must scroll the page (the same
          // reason LocationMap disables scrollWheelZoom). Zooming is the slider
          // brush on desktop and pinch on touch.
          dataZoom: narrow
            ? [{ type: 'inside', xAxisIndex: 0, zoomOnMouseWheel: false, moveOnMouseWheel: false }]
            : [
                { type: 'inside', xAxisIndex: 0, zoomOnMouseWheel: false, moveOnMouseWheel: false },
                {
                  type: 'slider',
                  xAxisIndex: 0,
                  height: 22,
                  bottom: 2,
                  borderColor: t.axisLine,
                  fillerColor: 'rgba(149,185,255,0.22)',
                  handleStyle: { color: t.price },
                  textStyle: { color: t.axis },
                },
              ],
          series: sichtbar.map((s, i) => serieOption(s, i === 0)),
        },
        true,
      );
    },
    [history, diagramm, sichtbar, t],
  );

  const legend: LegendItem[] = vorhanden.map((s) => ({
    color: farbe(t, s.farbe),
    label: s.label,
    unit: s.vorzeichen ?? s.unit,
    shape: s.zweiteAchse ? 'dotted' : s.linie ? 'area' : 'bar',
  }));

  return (
    <div>
      <ChartLegend
        items={legend}
        hidden={hidden}
        onToggle={(label) => setHidden((prev) => toggleSerie(prev, label, vorhanden.length))}
      />
      {sichtbar.some((s) => s.signed) && (
        <p className="vp-energie-nulllinie">
          <span>↑ über der Nulllinie: Bezug · Laden</span>
          <span>↓ darunter: Einspeisung · Entladen</span>
        </p>
      )}
      {fehlend.length > 0 && (
        <p className="vp-note vp-energie-fehlt">
          {fehlend.map((s) => s.fehlt).join(' ')}
        </p>
      )}
      <div ref={ref} className="vp-chart tall" />
      <ChartInsight icon="activity">
        <strong>PV-Erzeugung</strong> und <strong>Hausverbrauch</strong> stehen über der
        Nulllinie. Was darunter liegt, verlässt Ihr Haus: <strong>Einspeisung</strong> ins
        Netz und <strong>Entladen</strong> des Speichers. Der <strong>Ladestand</strong> läuft
        auf der rechten Achse mit. Tippen Sie eine Kachel der Legende an, um eine Reihe aus-
        oder einzublenden; im Diagramm können Sie einen Ausschnitt ziehen.
      </ChartInsight>
    </div>
  );
}

/**
 * The traceability centerpiece of the day view: ACTUAL battery behavior as
 * signed bars (grün = laden, blau = entladen) directly over the day-ahead price
 * curve (stepped line, right axis, ct/kWh) - charging-when-cheap is visible at
 * a glance. Where the optimizer persisted a plan, its trajectory is overlaid
 * dashed (Plan vs. Ist); the measured Ladestand (SoC) rides along on a hidden
 * axis. A "Jetzt"-marker + shaded past make now unmistakable. Same visual
 * language as the Fahrplan chart, deliberately.
 *
 * This one stays on the money face ("Erlöse"): it is the proof that the
 * optimizer bought cheap and sold dear, not the energy story of the period.
 */
export function HistoryDayChart({ history }: { history: History }) {
  const t = chartTheme();
  const ref = useEChart((chart, width) => {
    const narrow = width < 480;
    const { buckets, plan, bucketMinutes } = history;
    const times = buckets.map((b) => b.start);
    const battery = buckets.map((b) =>
      b.batteryChargeKwh == null || b.batteryDischargeKwh == null
        ? null
        : kw(b.batteryChargeKwh - b.batteryDischargeKwh, bucketMinutes),
    );
    const pricesCt = buckets.map((b) => (b.priceEurMwh == null ? null : b.priceEurMwh / 10));
    const soc = buckets.map((b) => b.socLastPct);
    const planByTime = new Map(plan.map((p) => [new Date(p.time).getTime(), p.batteryKw]));
    const planned = buckets.map((b) => planByTime.get(new Date(b.start).getTime()) ?? null);
    const hasPlan = plan.length > 0;

    const kwAbs = [...battery, ...planned]
      .filter((v): v is number => v != null)
      .map((v) => Math.abs(v));
    const kwMax = kwAbs.length ? Math.max(...kwAbs, 1) : 1;
    const nowIdx = nowBucketIdx(buckets);

    const markLineData: Record<string, unknown>[] = [];
    if (nowIdx >= 0 && nowIdx < buckets.length - 1)
      markLineData.push({
        xAxis: nowIdx,
        lineStyle: { color: t.price, type: 'solid', width: 2 },
        // `rotate: 0` is load-bearing: on a category axis an inside-positioned
        // markLine label otherwise renders ROTATED along the line (the
        // documented edge-label gotcha) - measured in the browser.
        label: { formatter: 'Jetzt', color: t.price, position: 'insideStartTop', rotate: 0 },
      });

    chart.setOption(
      {
        textStyle: { fontFamily: t.font, color: t.axis },
        grid: { top: 30, right: narrow ? 16 : 52, bottom: 8, left: 8, containLabel: true },
        tooltip: {
          trigger: 'axis',
          confine: true,
          formatter: (params: { axisValue: string; value: number | null; marker: string; seriesName: string }[]) => {
            const time = new Date(params[0]?.axisValue).toLocaleTimeString('de-DE', {
              hour: '2-digit',
              minute: '2-digit',
            });
            const lines = [`<b>${time} Uhr</b>`];
            for (const p of params) {
              if (p.value == null) continue;
              const v = Number(p.value);
              if (p.seriesName === 'Batterie (ist)' || p.seriesName === 'Plan') {
                const label = v > 0.05 ? 'lädt' : v < -0.05 ? 'entlädt' : 'hält';
                const suffix = p.seriesName === 'Plan' ? ' (geplant)' : '';
                const amt = Math.abs(v) < 0.05 ? '' : ` ${num(Math.abs(v))} kW`;
                lines.push(`${p.marker} Batterie${suffix} ${label}${amt}`);
              } else if (p.seriesName === 'Börsenpreis') {
                lines.push(`${p.marker} Strompreis: ${ct(v)}`);
              } else if (p.seriesName === 'Ladestand') {
                lines.push(`${p.marker} Ladestand: ${num(v, 0)} %`);
              }
            }
            return lines.join('<br/>');
          },
        },
        xAxis: {
          type: 'category',
          data: times,
          axisLabel: {
            formatter: (v: string) => timeLabel(v, 'day'),
            color: t.axis,
            hideOverlap: true,
          },
          axisLine: { lineStyle: { color: t.axisLine } },
        },
        yAxis: [
          {
            type: 'value',
            name: narrow ? 'kW' : 'Leistung (kW)',
            nameTextStyle: { color: t.axis, align: 'left' },
            nameGap: 12,
            min: -Math.ceil(kwMax),
            max: Math.ceil(kwMax),
            splitLine: { lineStyle: { color: t.grid } },
            axisLabel: { color: t.axis },
          },
          {
            type: 'value',
            name: narrow ? 'ct/kWh' : 'Preis (ct/kWh)',
            nameTextStyle: { color: t.price, align: 'right' },
            nameGap: 12,
            position: 'right',
            splitLine: { show: false },
            axisLabel: { color: t.price },
          },
          // Hidden SoC axis (0-100%): the trajectory rides along, values in the tooltip.
          { type: 'value', min: 0, max: 100, show: false },
        ],
        series: [
          {
            name: 'Batterie (ist)',
            type: 'bar',
            yAxisIndex: 0,
            data: battery,
            barCategoryGap: '8%',
            z: 3,
            itemStyle: {
              borderRadius: 2,
              color: (p: { value: number }) => (Number(p.value) >= 0 ? t.charge : t.battDischarge),
            },
            markArea:
              nowIdx > 0
                ? {
                    silent: true,
                    itemStyle: { color: t.axis, opacity: 0.08 },
                    data: [[{ xAxis: 0 }, { xAxis: nowIdx }]],
                  }
                : undefined,
            markLine: markLineData.length
              ? { silent: true, symbol: 'none', data: markLineData }
              : undefined,
          },
          ...(hasPlan
            ? [
                {
                  name: 'Plan',
                  type: 'line' as const,
                  yAxisIndex: 0,
                  data: planned,
                  step: 'middle' as const,
                  symbol: 'none',
                  z: 2,
                  lineStyle: { color: t.plan, width: 1.5, type: 'dashed' as const },
                  itemStyle: { color: t.plan },
                },
              ]
            : []),
          {
            name: 'Börsenpreis',
            type: 'line',
            yAxisIndex: 1,
            data: pricesCt,
            step: 'end',
            symbol: 'none',
            z: 2,
            lineStyle: { color: t.price, width: 2 },
            itemStyle: { color: t.price },
          },
          {
            name: 'Ladestand',
            type: 'line',
            yAxisIndex: 2,
            data: soc,
            smooth: true,
            symbol: 'none',
            z: 1,
            lineStyle: { color: t.soc, width: 1.5, type: 'dotted' },
            itemStyle: { color: t.soc },
          },
        ],
      },
      true,
    );
  }, [history, t]);

  const hasPlan = history.plan.length > 0;
  const legend: LegendItem[] = [
    { color: t.charge, label: 'Batterie lädt', unit: 'kW', shape: 'bar' },
    { color: t.battDischarge, label: 'Batterie entlädt', unit: 'kW', shape: 'bar' },
    ...(hasPlan
      ? [{ color: t.plan, label: 'Geplant (Soll)', unit: 'kW', shape: 'dashed' as const }]
      : []),
    { color: t.price, label: 'Börsen-Strompreis', unit: 'ct/kWh', shape: 'line' },
    { color: t.soc, label: 'Ladestand', unit: '%', shape: 'dotted' },
  ];

  return (
    <div>
      <ChartLegend items={legend} />
      <div ref={ref} className="vp-chart tall" />
      <ChartInsight>
        Grüne Balken zeigen, wann Ihr Speicher <strong>tatsächlich geladen</strong> hat,
        blaue wann er <strong>entladen</strong> hat - gut sichtbar über dem Preisverlauf:
        Laden fällt in günstige, Entladen in teure Zeiten.
        {hasPlan
          ? ' Die gestrichelte Linie ist der ursprüngliche Plan - so sehen Sie Plan gegen Ist.'
          : ''}
      </ChartInsight>
    </div>
  );
}
