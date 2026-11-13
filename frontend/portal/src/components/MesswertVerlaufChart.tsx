import type { MeasurementHistory } from '../api';
import { useEChart } from '../useEChart';
import { nachlieferungMarker } from './MesswertHerkunftKarte';

/**
 * Das Verlaufsdiagramm eines beobachteten Messwerts (Dialog „Verlauf ·…“ in `BeobachteteRegister`).
 *
 * ⚠ EIGENES MODUL, NACHGELADEN: es trägt die Diagramm-Bibliothek (`useEChart`, ≈ 207 kB gz). Statisch in
 * `BeobachteteRegister` lag sie in jedem Aufruf der Geräteseite, obwohl der Dialog erst auf Klick aufgeht.
 * Wächter: `src/seitenBuendel.test.ts`.
 */
export function HistoryChart({ history, onWaehlen }: { history: MeasurementHistory; onWaehlen: (index: number) => void }) {
  const ref = useEChart((chart, width) => {
    const numeric = history.data.some((d) => d.value != null);
    const markerLines = history.markers.filter((m) => !m.until).map((m) => ({
      xAxis: m.time,
      label: { formatter: width < 620 ? '' : m.label, color: '#52606d' },
      lineStyle: { color: '#8a94a3', type: 'dashed' as const },
    }));
    const markerBands = history.markers.filter((m) => m.until).map((m) => ([
      { xAxis: m.time, name: nachlieferungMarker(history, m) },
      { xAxis: m.until },
    ]));
    const gaps = history.data.filter((d) => d.gap).map((d) => ({
      coord: [d.time, d.value], name: 'Datenlücke', value: 'Lücke',
      itemStyle: { color: '#c25b26' },
    }));
    chart.setOption({
      animation: false,
      aria: { enabled: true, description: `Verlauf ${history.meta.label}` },
      grid: { left: 48, right: 18, top: 28, bottom: 52, containLabel: true },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'time', axisLabel: { hideOverlap: true } },
      yAxis: { type: numeric ? 'value' : 'category', name: history.meta.unit ?? '' },
      series: [{
        name: history.meta.label,
        type: numeric ? 'line' : 'scatter',
        showSymbol: history.data.length < 60,
        connectNulls: false,
        data: history.data.map((d) => [d.time, d.value ?? d.text]),
        lineStyle: { width: 2, color: '#1665d8' },
        itemStyle: { color: '#1665d8' },
        markLine: { silent: true, symbol: ['none', 'none'], data: markerLines },
        markArea: {
          silent: true,
          label: { show: width >= 620, color: '#6b3a1e' },
          itemStyle: { color: 'rgba(194, 91, 38, .12)' },
          data: markerBands,
        },
        markPoint: { data: gaps },
      }],
    }, true);
    chart.off('click');
    chart.on('click', (p: { dataIndex?: number }) => {
      if (typeof p.dataIndex === 'number') onWaehlen(p.dataIndex);
    });
  }, [history, onWaehlen]);
  const waehleAusBild = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.min(Math.max(0, e.clientX - r.left - 48), Math.max(1, r.width - 66));
    const index = Math.min(history.data.length - 1, Math.floor((x / Math.max(1, r.width - 66)) * history.data.length));
    if (index >= 0) onWaehlen(index);
  };
  return <div className="vp-measure-chart-wrap" onClick={waehleAusBild}>
    <div ref={ref} className="vp-measure-chart" role="img" aria-label={`Verlauf ${history.meta.label}`} />
  </div>;
}
