import { useState } from 'react';
import type { History, HistoryBucket } from './api';
import { chartTheme } from './chartTheme';
import { useEChart } from './useEChart';
import { ChartLegend, ChartInsight, type LegendItem } from './components/ChartExplain';

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
function nowBucketIdx(buckets: HistoryBucket[]): number {
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

/**
 * The energy series of a period: PV-Erzeugung / Hausverbrauch / Netzbezug /
 * Einspeisung. Day view shows average power (kW lines), week/month/year show
 * energy per bucket (kWh bars). The HTML legend below is also a series toggle -
 * tap a series to hide it and read the others cleanly.
 */
export function HistoryEnergyChart({ history }: { history: History }) {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const t = chartTheme();
  const day = history.range === 'day';
  const unit = day ? 'kW' : 'kWh';

  const legendDefs: { label: string; field: keyof HistoryBucket; color: string }[] = [
    { label: 'PV-Erzeugung', field: 'pvKwh', color: t.pv },
    { label: 'Hausverbrauch', field: 'loadKwh', color: t.load },
    { label: 'Netzbezug', field: 'gridImportKwh', color: t.discharge },
    { label: 'Einspeisung', field: 'gridExportKwh', color: t.charge },
  ];

  const ref = useEChart((chart, width) => {
    const narrow = width < 480;
    const weekNarrow = narrow && history.range === 'week';
    const { buckets, bucketMinutes } = history;
    const times = buckets.map((b) => b.start);

    const val = (b: HistoryBucket, field: keyof HistoryBucket) =>
      day ? kw(b[field] as number | null, bucketMinutes) : (b[field] as number | null);
    const series = (name: string, field: keyof HistoryBucket, color: string) =>
      day
        ? {
            name,
            type: 'line' as const,
            smooth: true,
            showSymbol: false,
            lineStyle: { width: 2.5, color },
            itemStyle: { color },
            areaStyle: { opacity: 0.06, color },
            data: buckets.map((b) => val(b, field)),
          }
        : {
            name,
            type: 'bar' as const,
            barMaxWidth: 18,
            itemStyle: { color, borderRadius: 2 },
            data: buckets.map((b) => val(b, field)),
          };

    const nowIdx = day ? nowBucketIdx(buckets) : -1;

    chart.setOption(
      {
        textStyle: { fontFamily: t.font, color: t.axis },
        grid: { top: 22, right: 12, bottom: 8, left: 8, containLabel: true },
        tooltip: {
          trigger: 'axis',
          confine: true,
          formatter: (params: any[]) => {
            const lines = [`<b>${timeLabel(params[0]?.axisValue, history.range)}${day ? ' Uhr' : ''}</b>`];
            for (const p of params) {
              if (p.value == null) continue;
              lines.push(
                `${p.marker} ${p.seriesName}: ${Number(p.value).toLocaleString('de-DE', { maximumFractionDigits: 2 })} ${unit}`,
              );
            }
            return lines.join('<br/>');
          },
        },
        xAxis: {
          type: 'category',
          data: times,
          boundaryGap: !day,
          axisLabel: {
            // Narrow week view: one weekday label per day (at its first
            // bucket) - the auto interval over hourly buckets would repeat
            // weekdays ("Mo Mo Di ...").
            formatter:
              weekNarrow
                ? (v: string) =>
                    new Date(v).getHours() === 0 ? timeLabel(v, 'week', true) : ''
                : (v: string) => timeLabel(v, history.range, narrow),
            interval: weekNarrow ? 0 : 'auto',
            color: t.axis,
            hideOverlap: true,
          },
          axisTick: { show: !weekNarrow },
          axisLine: { lineStyle: { color: t.axisLine } },
        },
        yAxis: {
          type: 'value',
          name: narrow ? unit : day ? 'Leistung (kW)' : 'Energie (kWh)',
          nameTextStyle: { color: t.axis, align: 'left' },
          nameGap: 12,
          splitLine: { lineStyle: { color: t.grid } },
          axisLabel: { color: t.axis },
        },
        series: legendDefs
          .filter((d) => !hidden.has(d.label))
          .map((d) => {
            const s: any = series(d.label, d.field, d.color);
            if (d.label === 'PV-Erzeugung' && nowIdx >= 0 && nowIdx < buckets.length - 1) {
              s.markLine = {
                silent: true,
                symbol: 'none',
                lineStyle: { color: t.price, type: 'solid', width: 2 },
                label: { formatter: 'Jetzt', color: t.price, position: 'insideStartTop' },
                data: [{ xAxis: nowIdx }],
              };
            }
            return s;
          }),
      },
      true,
    );
  }, [history, hidden, t]);

  const toggle = (label: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      // Never let the user hide every series at once.
      if (next.has(label)) next.delete(label);
      else if (next.size < legendDefs.length - 1) next.add(label);
      return next;
    });

  return (
    <div>
      <ChartLegend
        items={legendDefs.map<LegendItem>((d) => ({
          color: d.color,
          label: d.label,
          unit,
          shape: day ? 'area' : 'bar',
        }))}
        hidden={hidden}
        onToggle={toggle}
      />
      <div ref={ref} className="vp-chart" />
      <ChartInsight icon="activity">
        <strong>PV-Erzeugung</strong> (gelb) und <strong>Hausverbrauch</strong> (blau) im
        Vergleich: Was die PV nicht deckt, kommt als <strong>Netzbezug</strong> (rot) dazu;
        Überschuss geht als <strong>Einspeisung</strong> (grün) ins Netz. Tippen Sie auf eine
        Kachel, um eine Kurve aus- oder einzublenden.
      </ChartInsight>
    </div>
  );
}

/**
 * The traceability centerpiece of the day view: ACTUAL battery behavior as
 * signed bars (grün = laden, rot = entladen) directly over the day-ahead price
 * curve (stepped line, right axis, ct/kWh) - charging-when-cheap is visible at
 * a glance. Where the optimizer persisted a plan, its trajectory is overlaid
 * dashed (Plan vs. Ist); the measured Ladestand (SoC) rides along on a hidden
 * axis. A "Jetzt"-marker + shaded past make now unmistakable. Same visual
 * language as the Fahrplan chart, deliberately.
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

    const markLineData: any[] = [];
    if (nowIdx >= 0 && nowIdx < buckets.length - 1)
      markLineData.push({
        xAxis: nowIdx,
        lineStyle: { color: t.price, type: 'solid', width: 2 },
        label: { formatter: 'Jetzt', color: t.price, position: 'insideStartTop' },
      });

    chart.setOption(
      {
        textStyle: { fontFamily: t.font, color: t.axis },
        grid: { top: 30, right: narrow ? 16 : 52, bottom: 8, left: 8, containLabel: true },
        tooltip: {
          trigger: 'axis',
          confine: true,
          formatter: (params: any[]) => {
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
                const amt =
                  Math.abs(v) < 0.05
                    ? ''
                    : ` ${Math.abs(v).toLocaleString('de-DE', { maximumFractionDigits: 2 })} kW`;
                lines.push(`${p.marker} Batterie${suffix} ${label}${amt}`);
              } else if (p.seriesName === 'Börsenpreis') {
                lines.push(`${p.marker} Strompreis: ${ct(v)}`);
              } else if (p.seriesName === 'Ladestand') {
                lines.push(`${p.marker} Ladestand: ${v.toLocaleString('de-DE', { maximumFractionDigits: 0 })} %`);
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
              color: (p: any) => (Number(p.value) >= 0 ? t.charge : t.discharge),
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
    { color: t.discharge, label: 'Batterie entlädt', unit: 'kW', shape: 'bar' },
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
        rote wann er <strong>entladen</strong> hat - gut sichtbar über dem Preisverlauf:
        Laden fällt in günstige, Entladen in teure Zeiten.
        {hasPlan
          ? ' Die gestrichelte Linie ist der ursprüngliche Plan - so sehen Sie Plan gegen Ist.'
          : ''}
      </ChartInsight>
    </div>
  );
}
