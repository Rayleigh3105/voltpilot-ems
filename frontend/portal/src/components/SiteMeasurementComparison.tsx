import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { api, type MeasurementComparisonOption, type MeasurementHistory, type MeasurementRange } from '../api';
import { useEChart } from '../useEChart';
import { VpPicker } from './VpPicker';
import './Messwerte.css';

function ComparisonChart({ rows }: { rows: Array<{ option: MeasurementComparisonOption; history: MeasurementHistory }> }) {
  const units = Array.from(new Set(rows.map((r) => r.option.unit)));
  const ref = useEChart((chart) => {
    chart.setOption({
      animation: false,
      aria: { enabled: true, description: 'Vergleich ausgewählter Anlagen-Messwerte' },
      tooltip: { trigger: 'axis' },
      legend: { type: 'scroll', bottom: 0 },
      grid: { left: 54, right: 54 + Math.max(0, units.length - 1) * 34, top: 28, bottom: 64, containLabel: true },
      xAxis: { type: 'time' },
      yAxis: units.map((unit, index) => ({
        type: 'value', name: unit, position: index === 0 ? 'left' : 'right',
        offset: index <= 1 ? 0 : (index - 1) * 48,
      })),
      series: rows.map(({ option, history }) => ({
        type: 'line', name: `${option.deviceLabel} · ${option.label}`,
        yAxisIndex: units.indexOf(option.unit), showSymbol: false, connectNulls: false,
        data: history.data.map((d) => [d.time, d.value]),
        lineStyle: { width: 2 },
      })),
    }, true);
  }, [rows]);
  return <div ref={ref} className="vp-measure-chart" role="img" aria-label="Vergleich ausgewählter Messwerte" />;
}

export function SiteMeasurementComparison({ siteId }: { siteId: string }) {
  const [options, setOptions] = useState<MeasurementComparisonOption[] | null>(null);
  const [selected, setSelected] = useState<MeasurementComparisonOption[]>([]);
  const [series, setSeries] = useState<Array<{ option: MeasurementComparisonOption; history: MeasurementHistory }>>([]);
  const [range, setRange] = useState<MeasurementRange>('7d');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.measurementComparisonOptions(siteId).then(setOptions, () => setError('Zusätzliche Messwerte sind gerade nicht erreichbar.')); }, [siteId]);
  useEffect(() => {
    let active = true;
    Promise.all(selected.map(async (option) => ({ option, history: await api.measurementHistory(option.deviceId, option.pointKey, range, 'decoded', undefined, undefined, siteId) })))
      .then((result) => active && setSeries(result), () => active && setError('Der Vergleich konnte nicht geladen werden.'));
    return () => { active = false; };
  }, [selected, range, siteId]);
  const compatibility = selected[0]?.compatibilityKey;
  const visible = useMemo(() => (options ?? []).filter((o) => !compatibility || o.compatibilityKey === compatibility), [options, compatibility]);
  const toggle = (option: MeasurementComparisonOption) => {
    setError(null);
    setSelected((current) => current.some((p) => p.deviceId === option.deviceId && p.pointKey === option.pointKey)
      ? current.filter((p) => !(p.deviceId === option.deviceId && p.pointKey === option.pointKey))
      : current.length < 3 ? [...current, option] : current);
  };
  return (
    <section className="vp-site-measure-compare" aria-labelledby="vp-site-measure-title">
      <div className="vp-site-measure-head"><div><h3 id="vp-site-measure-title">Zusätzliche Messwerte</h3><p>Bis zu drei semantisch gleiche Punkte. Einheiten erhalten getrennte Achsen.</p></div><VpPicker label="Zeitraum" value={range} options={[['24h', '24 Stunden'], ['7d', '7 Tage'], ['30d', '30 Tage'], ['90d', '90 Tage'], ['year', 'Jahr']].map(([value, label]) => ({ value, label }))} onChange={(value) => setRange(value as MeasurementRange)} /></div>
      {error && <p role="alert" className="vp-assist-error">{error}</p>}
      {!options ? <p role="status">Vergleichspunkte werden geladen …</p> : options.length === 0 ? <p className="vp-measure-empty">Noch keine aufgezeichneten, semantisch bekannten Zusatzmesswerte. Die Bibliothek auf einer Geräteseite startet deren Aufzeichnung.</p> : <>
        <div className="vp-site-measure-options" aria-label="Vergleichspunkte">{visible.map((option) => {
          const checked = selected.some((p) => p.deviceId === option.deviceId && p.pointKey === option.pointKey);
          return <Button key={`${option.deviceId}-${option.pointKey}`} variant={checked ? 'primary' : 'outline'} size="sm" aria-pressed={checked} disabled={!checked && selected.length >= 3} onClick={() => toggle(option)}>{option.deviceLabel} · {option.label} ({option.unit})</Button>;
        })}</div>
        {selected.length === 0 ? <p className="vp-measure-hint">Wählen Sie einen Punkt; danach werden nur noch wirklich vergleichbare Punkte angeboten.</p> : series.length ? <ComparisonChart rows={series} /> : <p role="status">Reihen werden geladen …</p>}
      </>}
    </section>
  );
}
