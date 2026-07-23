import type { SchedulePlan } from './api';
import { chartTheme } from './chartTheme';
import {
  chargeKind,
  hasGridCharge,
  planInsightParts,
  slotBarColor,
  socRangeLine,
} from './schedule';
import { useEChart } from './useEChart';
import { ChartLegend, ChartInsight, type LegendItem } from './components/ChartExplain';

/**
 * The optimizer plan for the day, made obvious at a glance: planned battery
 * power as signed bars (grün = Laden aus Solarstrom, türkis = Laden aus dem
 * Netz, blau = Entladen; left axis, kW) directly over the day-ahead price
 * (stepped line, right axis, ct/kWh) so WHY the plan charges/discharges is
 * visible, plus the planned Ladestand (SoC) as a dashed line on its OWN
 * labelled right axis (0-100 %), so it can be read without hovering and never
 * looks like a negative power value. Grid-charge
 * slots are DERIVED per slot (charging while net-importing, see schedule.ts);
 * on an EEG site ("Nur Solarladen") the türkis color can never appear - the
 * chart itself is the proof that only solar is stored. A "Jetzt"-marker and a shaded past region separate what already
 * happened from what is still planned; a dashed line splits today from morgen.
 * The colour swatches + one-line takeaway below the canvas explain the diagram
 * in plain German (captain: the diagrams should be understandable instantly).
 */

function ct(v: number | null): string {
  return v == null
    ? '-'
    : `${v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ct/kWh`;
}

export function ScheduleChart({
  plan,
  peakTargetKw,
  onSlotClick,
  selectedIndex,
}: {
  plan: SchedulePlan;
  /**
   * U4 Lastspitzen overlay: when set (schedule.peakTargetKw), a red dashed
   * horizontal line marks the planned grid-import Ziel on the power axis, and
   * the axis grows to keep it in view. Absent = the plain Fahrplan (default).
   */
  peakTargetKw?: number | null;
  /**
   * "Warum"-layer tap target (the OptimizerPlanChart bar-click pattern,
   * widened to the whole plot column so idle slots are tappable too): called
   * with the tapped slot's index. Absent = the chart behaves exactly as
   * before (no click handling).
   */
  onSlotClick?: (index: number) => void;
  /** The selected slot to highlight (a solid marker line); null/absent = none. */
  selectedIndex?: number | null;
}) {
  const t = chartTheme();

  const ref = useEChart((chart, width) => {
    const narrow = width < 480;
    const slots = plan.slots;
    const target = peakTargetKw != null && peakTargetKw > 0 ? peakTargetKw : null;
    const times = slots.map((s) => s.start);
    const battery = slots.map((s) => (s.batteryKw == null ? null : Number(s.batteryKw)));
    // Price shown in ct/kWh (the unit on the customer's bill), not EUR/MWh.
    const pricesCt = slots.map((s) => (s.priceEurMwh == null ? null : Number(s.priceEurMwh) / 10));
    const soc = slots.map((s) => (s.socPct == null ? null : Number(s.socPct)));

    // today/tomorrow divider: first slot on the local "tomorrow".
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const boundaryIdx = slots.findIndex(
      (s) => new Date(s.start).toDateString() === tomorrow.toDateString(),
    );

    // "Jetzt": the last slot whose start is at/before now (past is shaded).
    const nowMs = Date.now();
    let nowIdx = -1;
    for (let i = 0; i < slots.length; i++) {
      if (new Date(slots[i].start).getTime() <= nowMs) nowIdx = i;
      else break;
    }
    // The marker is only truthful while the plan actually covers "now": a
    // stale plan that ended hours ago must not draw a "Jetzt" line onto its
    // last bar (audit F2) - the page's staleness banner says so instead.
    const lastEndMs =
      slots.length > 0
        ? new Date(slots[slots.length - 1].start).getTime() + (plan.slotMinutes || 15) * 60_000
        : 0;
    const nowInPlan = nowIdx >= 0 && nowMs < lastEndMs;

    const kwAbs = battery.filter((v): v is number => v != null).map((v) => Math.abs(v));
    const kwMax = kwAbs.length ? Math.max(...kwAbs, 1) : 1;

    // The plan's DATE belongs on the axis (audit F2): a plan from yesterday
    // rendered a pure 10:15 … 23:45 time axis and read as today. The first
    // label of every calendar day carries its date on a second line.
    const dayStarts = new Set<number>();
    let seenDay = '';
    slots.forEach((s, i) => {
      const day = new Date(s.start).toDateString();
      if (day !== seenDay) {
        dayStarts.add(i);
        seenDay = day;
      }
    });

    // The SoC line only gets an axis when the plan actually carries SoC.
    const hasSoc = soc.some((v) => v != null);

    const markLineData: any[] = [];
    if (boundaryIdx > 0)
      markLineData.push({
        xAxis: boundaryIdx,
        lineStyle: { color: t.axis, type: 'dashed', width: 1.5 },
        label: { formatter: 'Morgen', color: t.axis, position: 'insideEndTop' },
      });
    if (nowInPlan)
      markLineData.push({
        xAxis: nowIdx,
        lineStyle: { color: t.price, type: 'solid', width: 2 },
        label: { formatter: 'Jetzt', color: t.price, position: 'insideStartTop' },
      });
    // U4: the peak-shaving Ziel as a horizontal red dashed line on the power axis.
    if (target != null)
      markLineData.push({
        yAxis: target,
        lineStyle: { color: t.discharge, type: 'dashed', width: 1.5 },
        label: {
          formatter: `Ziel Netzbezug ${Math.round(target)} kW`,
          color: t.discharge,
          position: 'insideEndTop',
        },
      });
    // "Warum"-layer selection highlight (the OptimizerPlanChart pattern).
    if (selectedIndex != null && selectedIndex >= 0 && selectedIndex < slots.length)
      markLineData.push({
        xAxis: selectedIndex,
        lineStyle: { color: t.plan, type: 'solid', width: 2 },
        // rotate 0: an inside label on a vertical markLine otherwise renders
        // rotated along the line (the documented edge-label gotcha).
        label: { formatter: 'Ausgewählt', color: t.plan, position: 'insideEndTop', rotate: 0 },
      });

    // Tap-to-explain: the whole plot column is a tap target (idle slots too),
    // via the zrender click + pixel→category conversion. Only wired when the
    // caller opts in - without onSlotClick the chart is byte-identical.
    const zr = chart.getZr();
    zr.off('click');
    if (onSlotClick) {
      zr.on('click', (e: { offsetX: number; offsetY: number }) => {
        const pt: [number, number] = [e.offsetX, e.offsetY];
        if (!chart.containPixel('grid', pt)) return;
        const idx = Math.round(Number(chart.convertFromPixel({ xAxisIndex: 0 }, pt[0])));
        if (Number.isFinite(idx) && idx >= 0 && idx < slots.length) onSlotClick(idx);
      });
    }

    chart.setOption(
      {
        textStyle: { fontFamily: t.font, color: t.axis },
        grid: { top: 30, right: narrow ? 16 : 52, bottom: 8, left: 8, containLabel: true },
        tooltip: {
          trigger: 'axis',
          confine: true,
          formatter: (params: any[]) => {
            const time = new Date(params[0]?.axisValue).toLocaleString('de-DE', {
              weekday: 'short',
              hour: '2-digit',
              minute: '2-digit',
            });
            const lines = [`<b>${time} Uhr</b>`];
            let batV: number | null = null;
            for (const p of params) {
              if (p.value == null) continue;
              const v = Number(p.value);
              if (p.seriesName === 'Batterie') {
                batV = v;
                const kind = chargeKind(
                  slots[p.dataIndex]?.batteryKw ?? null,
                  slots[p.dataIndex]?.gridKw ?? null,
                  slots[p.dataIndex]?.pvKw,
                  slots[p.dataIndex]?.curtailKw,
                );
                const label =
                  kind === 'netzladen'
                    ? 'lädt aus dem Netz'
                    : kind === 'solarladen'
                      ? 'lädt Solarstrom'
                      : kind === 'entladen'
                        ? 'entlädt'
                        : 'hält';
                const amt =
                  Math.abs(v) < 0.05
                    ? ''
                    : ` ${Math.abs(v).toLocaleString('de-DE', { maximumFractionDigits: 2 })} kW`;
                lines.push(`${p.marker} Batterie ${label}${amt}`);
              } else if (p.seriesName === 'Börsenpreis') {
                lines.push(`${p.marker} Strompreis: ${ct(v)}`);
              } else if (p.seriesName === 'Ladestand') {
                lines.push(`${p.marker} Ladestand: ${v.toLocaleString('de-DE', { maximumFractionDigits: 0 })} %`);
              }
            }
            if (batV != null && Math.abs(batV) > 0.05) {
              const kind = chargeKind(
                slots[params[0]?.dataIndex]?.batteryKw ?? null,
                slots[params[0]?.dataIndex]?.gridKw ?? null,
                slots[params[0]?.dataIndex]?.pvKw,
                slots[params[0]?.dataIndex]?.curtailKw,
              );
              lines.push(
                `<span style="color:${t.axis}">${
                  batV > 0
                    ? kind === 'netzladen'
                      ? 'Speichert günstigen Strom aus dem Netz'
                      : 'Speichert eigenen Solarstrom'
                    : 'Deckt den Verbrauch aus dem Speicher'
                }</span>`,
              );
            }
            return lines.join('<br/>');
          },
        },
        xAxis: {
          type: 'category',
          data: times,
          axisLabel: {
            formatter: (v: string, index: number) => {
              const d = new Date(v);
              const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
              if (!dayStarts.has(index)) return time;
              return `${d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}\n${time}`;
            },
            lineHeight: 15,
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
            // Discharge stays at battery scale; the top grows to keep the peak
            // Ziel visible when the Lastspitzen overlay is on.
            min: -Math.ceil(kwMax),
            max: Math.ceil(target != null ? Math.max(kwMax, target) : kwMax),
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
          // SoC axis (0-100 %) - VISIBLE on the right, offset behind the price
          // axis (audit F4: as a hidden axis over a signed kW scale the SoC
          // line sat below the 0-kW gridline and read as a negative value, and
          // touch users had no hover to decode it). Too narrow for a second
          // right axis => hidden again, and the SoC band is named in text
          // under the chart instead.
          {
            type: 'value',
            min: 0,
            max: 100,
            show: hasSoc && !narrow,
            position: 'right',
            offset: 44,
            splitLine: { show: false },
            axisLine: { show: true, lineStyle: { color: t.soc } },
            axisTick: { lineStyle: { color: t.soc } },
            axisLabel: { color: t.soc, formatter: '{value} %' },
          },
        ],
        series: [
          {
            name: 'Batterie',
            type: 'bar',
            yAxisIndex: 0,
            data: battery,
            barCategoryGap: '8%',
            z: 3,
            itemStyle: {
              borderRadius: 2,
              color: (p: any) => {
                const slot = slots[p.dataIndex];
                const kind = slot
                  ? chargeKind(slot.batteryKw, slot.gridKw, slot.pvKw, slot.curtailKw)
                  : Number(p.value) >= 0
                    ? 'solarladen'
                    : 'entladen';
                return slotBarColor(kind, t);
              },
            },
            // Shade the already-elapsed part of the day, and mark today|morgen + jetzt.
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
            lineStyle: { color: t.soc, width: 1.5, type: 'dashed' },
            itemStyle: { color: t.soc },
          },
        ],
      },
      true,
    );
  }, [plan, t, peakTargetKw, onSlotClick, selectedIndex]);

  // Insight: charge cheap, discharge expensive, and today's saving - composed
  // by the pure builder so the "flat curve" clause can never contradict a
  // visibly cycling plan (audit F3).
  const insight = planInsightParts(plan.slots, new Date());
  // The planned SoC band in words - the readable fallback wherever the SoC
  // axis has no room (phones) and the touch-friendly answer to "how full?".
  const socLine = socRangeLine(plan.slots);

  // The türkis entry appears only when the plan actually charges from the
  // grid: on an EEG site ("Nur Solarladen") the color never occurs, and the
  // legend must not advertise it - no türkis = provably no Netzstrom stored.
  const gridCharging = hasGridCharge(plan.slots);
  const legend: LegendItem[] = [
    { color: t.charge, label: 'Laden aus Solarstrom', unit: 'kW', shape: 'bar' },
    ...(gridCharging
      ? [{ color: t.gridCharge, label: 'Laden aus dem Netz (günstig)', unit: 'kW', shape: 'bar' } as LegendItem]
      : []),
    { color: t.battDischarge, label: 'Entladen (teurer Strom)', unit: 'kW', shape: 'bar' },
    { color: t.price, label: 'Börsen-Strompreis', unit: 'ct/kWh', shape: 'line' },
    { color: t.soc, label: 'Ladestand des Speichers', unit: '%', shape: 'dashed' },
    ...(peakTargetKw != null && peakTargetKw > 0
      ? [{ color: t.discharge, label: 'Ziel Netzbezug (Lastspitze)', unit: 'kW', shape: 'dashed' } as LegendItem]
      : []),
  ];

  return (
    <div>
      <ChartLegend items={legend} />
      <div ref={ref} className="vp-chart tall" />
      {socLine && (
        <p className="vp-note vp-plan-soc" style={{ margin: 'var(--vp-space-2) 0 0' }}>
          {socLine}
        </p>
      )}
      {insight && (
        <ChartInsight>
          {insight.map((part, i) =>
            part.strong ? <strong key={i}>{part.text}</strong> : <span key={i}>{part.text}</span>,
          )}
        </ChartInsight>
      )}
    </div>
  );
}
