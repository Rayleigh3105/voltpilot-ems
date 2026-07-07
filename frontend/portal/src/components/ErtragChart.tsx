import type { EarningsRange, EarningsSeriesPoint } from '../api';
import { bestBucket, bucketAxisLabel, bucketTooltipLabel, ertragTitle } from '../anlage';
import { eurAmount } from '../format';
import { chartTheme } from '../chartTheme';
import { useEChart } from '../useEChart';
import { ChartSubtitle } from './ChartExplain';

/**
 * The money-centric "Ertrag" bar chart: Gesamtertrag per bucket over the
 * selected range (per Berlin hour for the day, per day for the month, per month
 * for the year/all). The best bucket is highlighted green - the same "bester
 * Tag" the line beneath the chart names. Bars only, no axis clutter; reads the
 * shared chart palette so re-theming is a token edit.
 */
export function ErtragChart({
  series,
  range,
}: {
  series: EarningsSeriesPoint[];
  range: EarningsRange;
}) {
  const best = bestBucket(series);
  const bestStart = best && best.gesamtertragEur > 0 ? best.start : null;

  const ref = useEChart(
    (chart, width) => {
      const t = chartTheme();
      const narrow = width < 480;
      // Canvas can't resolve var(): a real gradient for normal bars, the solid
      // green token for the best one.
      const barGradient = {
        type: 'linear' as const,
        x: 0,
        y: 0,
        x2: 0,
        y2: 1,
        colorStops: [
          { offset: 0, color: t.price },
          { offset: 1, color: t.plan },
        ],
      };

      chart.setOption(
        {
          textStyle: { fontFamily: t.font },
          grid: { left: 6, right: 6, top: 10, bottom: 4, containLabel: true },
          tooltip: {
            trigger: 'axis',
            confine: true,
            axisPointer: { type: 'shadow' },
            formatter: (params: { dataIndex: number }[]) => {
              const p = series[params[0].dataIndex];
              return `${bucketTooltipLabel(p.start, range)}<br/><b>${eurAmount(p.gesamtertragEur)}</b>`;
            },
          },
          xAxis: {
            type: 'category',
            data: series.map((p) => bucketAxisLabel(p.start, range)),
            axisLine: { lineStyle: { color: t.axisLine } },
            axisTick: { show: false },
            axisLabel: { color: t.axis, hideOverlap: true, fontSize: narrow ? 10 : 11 },
          },
          yAxis: {
            type: 'value',
            axisLabel: {
              color: t.axis,
              fontSize: narrow ? 10 : 11,
              formatter: (v: number) => `${v.toLocaleString('de-DE')} €`,
            },
            splitLine: { lineStyle: { color: t.grid } },
          },
          series: [
            {
              type: 'bar',
              barMaxWidth: 26,
              itemStyle: { borderRadius: [3, 3, 0, 0] },
              data: series.map((p) => ({
                value: p.gesamtertragEur,
                itemStyle: { color: p.start === bestStart ? t.charge : barGradient },
              })),
            },
          ],
        },
        true,
      );
    },
    [series, range, bestStart],
  );

  return (
    <>
      <ChartSubtitle>{ertragTitle(range)} · grün = bester Wert</ChartSubtitle>
      <div className="vp-chart compact" ref={ref} role="img" aria-label={ertragTitle(range)} />
    </>
  );
}
