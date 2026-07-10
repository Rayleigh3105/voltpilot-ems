import { chartTheme } from '../../chartTheme';
import { chargeKind } from '../../schedule';
import { useEChart } from '../../useEChart';
import { ChartLegend, type LegendItem } from '../../components/ChartExplain';
import type { OptimizerDiagnostics } from '../../optimizerApi';

/**
 * "Der Plan" - the admin diagnostic Fahrplan, richer than the calm customer
 * chart: planned battery power as signed bars coloured by chargeKind (grün =
 * Solarladen, türkis = Netzladen, rot = Entladen) with a thin grid-power
 * sub-track behind them, over TWO price references on the right axis - the bare
 * SPOT the solver optimises (solid) and the REAL per-slot value it now prices
 * against (Bezug/Einspeisung, dashed) - plus the planned SoC (dashed, hidden
 * axis). Where the real line diverges from spot is exactly where "why did it do
 * that" lives. A bar click selects that slot for the €-breakdown below.
 */
export function OptimizerPlanChart({
  diag,
  selectedIdx,
  onSelectSlot,
}: {
  diag: OptimizerDiagnostics;
  selectedIdx: number;
  onSelectSlot: (idx: number) => void;
}) {
  const t = chartTheme();

  const ref = useEChart(
    (chart, width) => {
      const narrow = width < 520;
      const slots = diag.slots;
      const times = slots.map((s) => s.time);
      const battery = slots.map((s) => (s.batteryKw == null ? null : Number(s.batteryKw)));
      const grid = slots.map((s) => (s.gridKw == null ? null : Number(s.gridKw)));
      const soc = slots.map((s) => (s.socPct == null ? null : Number(s.socPct)));
      const spot = slots.map((s) => (s.solverPriceCtKwh == null ? null : Number(s.solverPriceCtKwh)));
      const importCt = slots.map((s) => (s.importPriceCtKwh == null ? null : Number(s.importPriceCtKwh)));
      const exportCt = slots.map((s) => (s.exportValueCtKwh == null ? null : Number(s.exportValueCtKwh)));

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const boundaryIdx = slots.findIndex(
        (s) => new Date(s.time).toDateString() === tomorrow.toDateString(),
      );

      const markLineData: Record<string, unknown>[] = [];
      if (boundaryIdx > 0) {
        markLineData.push({
          xAxis: boundaryIdx,
          lineStyle: { color: t.axis, type: 'dashed', width: 1.5 },
          label: { formatter: 'Morgen', color: t.axis, position: 'insideEndTop' },
        });
      }
      if (selectedIdx >= 0 && selectedIdx < slots.length) {
        markLineData.push({
          xAxis: selectedIdx,
          lineStyle: { color: t.price, type: 'solid', width: 2 },
          label: { formatter: 'Slot', color: t.price, position: 'insideStartTop' },
        });
      }

      const kwAbs = [...battery, ...grid]
        .filter((v): v is number => v != null)
        .map((v) => Math.abs(v));
      const kwMax = kwAbs.length ? Math.max(...kwAbs, 1) : 1;

      chart.off('click');
      chart.on('click', (params: { dataIndex?: number }) => {
        if (typeof params.dataIndex === 'number') onSelectSlot(params.dataIndex);
      });

      chart.setOption(
        {
          textStyle: { fontFamily: t.font, color: t.axis },
          grid: { top: 30, right: narrow ? 16 : 56, bottom: 8, left: 8, containLabel: true },
          tooltip: {
            trigger: 'axis',
            confine: true,
            formatter: (params: { axisValue?: string; dataIndex?: number }[]) => {
              const idx = params[0]?.dataIndex ?? 0;
              const s = slots[idx];
              if (!s) return '';
              const time = new Date(s.time).toLocaleString('de-DE', {
                weekday: 'short',
                hour: '2-digit',
                minute: '2-digit',
              });
              const kind = chargeKind(s.batteryKw, s.gridKw);
              const label =
                kind === 'netzladen'
                  ? 'lädt aus dem Netz'
                  : kind === 'solarladen'
                    ? 'lädt Solarstrom'
                    : kind === 'entladen'
                      ? 'entlädt'
                      : 'hält';
              const lines = [`<b>${time} Uhr</b>`, `Batterie ${label}`];
              if (s.batteryKw != null)
                lines.push(`Leistung: ${fmtKw(Number(s.batteryKw))}`);
              if (s.gridKw != null) lines.push(`Netz: ${fmtKw(Number(s.gridKw))}`);
              if (s.solverPriceCtKwh != null) lines.push(`Spot: ${fmtCt(Number(s.solverPriceCtKwh))}`);
              if (s.importPriceCtKwh != null) lines.push(`Bezug real: ${fmtCt(Number(s.importPriceCtKwh))}`);
              if (s.exportValueCtKwh != null) lines.push(`Einspeisung real: ${fmtCt(Number(s.exportValueCtKwh))}`);
              if (s.socPct != null)
                lines.push(`Ladestand: ${Number(s.socPct).toLocaleString('de-DE', { maximumFractionDigits: 0 })} %`);
              lines.push('<span style="opacity:.7">Klick: €-Aufschlüsselung ↓</span>');
              return lines.join('<br/>');
            },
          },
          xAxis: {
            type: 'category',
            data: times,
            axisLabel: {
              formatter: (v: string) =>
                new Date(v).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
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
              axisLabel: { color: t.price, formatter: '{value}' },
            },
            { type: 'value', min: 0, max: 100, show: false },
          ],
          series: [
            {
              name: 'Netz',
              type: 'bar',
              yAxisIndex: 0,
              data: grid,
              barCategoryGap: '8%',
              barGap: '-100%',
              z: 1,
              silent: true,
              itemStyle: {
                borderRadius: 1,
                color: (p: { value: number | null }) =>
                  Number(p.value) >= 0 ? 'rgba(96,125,139,0.28)' : 'rgba(0,172,193,0.28)',
              },
            },
            {
              name: 'Batterie',
              type: 'bar',
              yAxisIndex: 0,
              data: battery,
              barCategoryGap: '8%',
              z: 3,
              itemStyle: {
                borderRadius: 2,
                color: (p: { dataIndex: number; value: number | null }) => {
                  const slot = slots[p.dataIndex];
                  if (slot && chargeKind(slot.batteryKw, slot.gridKw) === 'netzladen') {
                    return t.gridCharge;
                  }
                  return Number(p.value) >= 0 ? t.charge : t.discharge;
                },
              },
              markLine: markLineData.length
                ? { silent: true, symbol: 'none', data: markLineData }
                : undefined,
            },
            {
              name: 'Spot-Preis',
              type: 'line',
              yAxisIndex: 1,
              data: spot,
              step: 'end',
              symbol: 'none',
              z: 2,
              lineStyle: { color: t.price, width: 2 },
              itemStyle: { color: t.price },
            },
            {
              name: 'Bezugspreis (real)',
              type: 'line',
              yAxisIndex: 1,
              data: importCt,
              step: 'end',
              symbol: 'none',
              connectNulls: false,
              z: 2,
              lineStyle: { color: t.discharge, width: 1.6, type: 'dashed' },
              itemStyle: { color: t.discharge },
            },
            {
              name: 'Einspeisewert (real)',
              type: 'line',
              yAxisIndex: 1,
              data: exportCt,
              step: 'end',
              symbol: 'none',
              connectNulls: false,
              z: 2,
              lineStyle: { color: t.charge, width: 1.6, type: 'dashed' },
              itemStyle: { color: t.charge },
            },
            {
              name: 'Ladestand',
              type: 'line',
              yAxisIndex: 2,
              data: soc,
              smooth: true,
              symbol: 'none',
              z: 1,
              lineStyle: { color: t.soc, width: 1.5, type: 'dashed' },
              itemStyle: { color: t.soc },
            },
          ],
        },
        true,
      );
    },
    [diag, selectedIdx, t],
  );

  const legend: LegendItem[] = [
    { color: t.charge, label: 'Laden aus Solarstrom', unit: 'kW', shape: 'bar' },
    { color: t.gridCharge, label: 'Laden aus dem Netz', unit: 'kW', shape: 'bar' },
    { color: t.discharge, label: 'Entladen', unit: 'kW', shape: 'bar' },
    { color: t.price, label: 'Spot-Preis (Solver)', unit: 'ct/kWh', shape: 'line' },
    { color: t.discharge, label: 'Bezugspreis real', unit: 'ct/kWh', shape: 'dashed' },
    { color: t.charge, label: 'Einspeisewert real', unit: 'ct/kWh', shape: 'dashed' },
    { color: t.soc, label: 'Ladestand', unit: '%', shape: 'dashed' },
  ];

  return (
    <div>
      <ChartLegend items={legend} />
      <div ref={ref} className="vp-chart tall" />
    </div>
  );
}

function fmtKw(v: number): string {
  return `${v.toLocaleString('de-DE', { maximumFractionDigits: 2 })} kW`;
}

function fmtCt(v: number): string {
  return `${v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ct/kWh`;
}
