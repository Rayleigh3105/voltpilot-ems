import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { Switch } from '../../designsystem/components/forms/Switch';
import { Drawer } from '../../designsystem/components/shell/Drawer';
import {
  api,
  downloadMeasurementExport,
  type MeasurementBudgetEstimate,
  type MeasurementCatalogPoint,
  type MeasurementCatalogResult,
  type MeasurementHistory,
  type MeasurementRange,
  type MeasurementSelectionState,
} from '../api';
import { useEChart } from '../useEChart';
import { ConfirmDialog } from './ConfirmDialog';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';
import { VpTimePicker } from './VpTimePicker';
import './MeasurementLibrary.css';

const ranges: Array<[MeasurementRange, string]> = [
  ['24h', '24 h'], ['7d', '7 Tage'], ['30d', '30 Tage'], ['90d', '90 Tage'],
  ['year', 'Jahr'], ['free', 'Frei'],
];

function uuid() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-0000-4000-8000-${Math.random()}`;
}

function isoOrUndefined(value: string) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function pointLabel(point: MeasurementCatalogPoint) {
  return point.labelDe || point.labelSource || point.pointKey;
}

function bytes(value: number) {
  if (value < 1_000_000) return `${Math.round(value / 1000)} kB/Jahr`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)} MB/Jahr`;
  return `${(value / 1_000_000_000).toFixed(2)} GB/Jahr`;
}

function cadence(value: number | null) {
  if (!value) return 'ereignisgesteuert';
  if (value < 60) return `alle ${value} s`;
  if (value % 3600 === 0) return `alle ${value / 3600} h`;
  return `alle ${value / 60} min`;
}

function scaleText(point: MeasurementCatalogPoint) {
  if (point.scale.kind === 'none') return 'keine';
  return `${point.scale.kind}${point.scale.value == null ? '' : ` ${JSON.stringify(point.scale.value)}`}`;
}

function addressText(point: MeasurementCatalogPoint) {
  if (!point.address) return point.selector;
  if (point.address.registers?.length) return point.address.registers.map((r) => `0x${r.toString(16).padStart(4, '0')}`).join(', ');
  return `SunSpec M${point.address.modelId}, Offset ${point.address.offsetWords}`;
}

function statusLabel(point: MeasurementCatalogPoint) {
  if (point.availabilityStatus === 'read') return 'Vom Gerät gelesen';
  if (point.availabilityStatus === 'family_configured') return 'Für diese Anbindung vorgesehen';
  return 'Nicht als verfügbar bestätigt';
}

function applySteps(status: string) {
  const applied = ['applied', 'first_sample'].includes(status);
  const sampled = status === 'first_sample';
  return [
    ['Angefordert', true], ['Angewendet', applied], ['Erster Wert', sampled],
  ] as Array<[string, boolean]>;
}

function HistoryChart({ history }: { history: MeasurementHistory }) {
  const ref = useEChart((chart, width) => {
    const numeric = history.data.some((d) => d.value != null);
    const markerLines = history.markers.map((m) => ({
      xAxis: m.time,
      label: { formatter: width < 620 ? '' : m.label, color: '#52606d' },
      lineStyle: { color: '#8a94a3', type: 'dashed' as const },
    }));
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
        markPoint: { data: gaps },
      }],
    }, true);
  }, [history]);
  return <div ref={ref} className="vp-measure-chart" role="img" aria-label={`Verlauf ${history.meta.label}`} />;
}

function PointRow({ point, applyStatus, onToggle, onHistory }: {
  point: MeasurementCatalogPoint;
  applyStatus?: string;
  onToggle: (point: MeasurementCatalogPoint) => void;
  onHistory: (point: MeasurementCatalogPoint) => void;
}) {
  return (
    <article className="vp-measure-row" data-semantic={point.semanticStatus}>
      <div className="vp-measure-row__main">
        <Switch
          checked={point.selected}
          onChange={() => onToggle(point)}
          label={<span className="vp-measure-row__title">{pointLabel(point)}</span>}
          aria-label={`${pointLabel(point)} ${point.selected ? 'abwählen' : 'aufzeichnen'}`}
        />
        <div className="vp-measure-badges">
          <span className={`vp-measure-badge vp-measure-badge--${point.availabilityStatus}`}>{statusLabel(point)}</span>
          {point.recommended && <span className="vp-measure-badge">Empfohlen</span>}
          {point.recorded && <span className="vp-measure-badge">Historie vorhanden</span>}
          {point.semanticStatus !== 'known' && (
            <span className="vp-measure-badge vp-measure-badge--warn">
              {point.semanticStatus === 'unknown' ? 'Semantik unbekannt' : 'Nur Herstellerbezeichnung'}
            </span>
          )}
        </div>
        <p className="vp-measure-row__source">{point.labelSource || 'Keine Herstellerbezeichnung'} · {point.group}</p>
      </div>
      <dl className="vp-measure-tech">
        <div><dt>Adresse / Schlüssel</dt><dd className="vp-mono">{addressText(point)}</dd></div>
        <div><dt>Typ</dt><dd>{point.valueType} · {point.widthBits ?? 'variabel'} Bit · {point.signed == null ? 'Vorzeichen n/a' : point.signed ? 'signed' : 'unsigned'}</dd></div>
        <div><dt>Reihenfolge / Skala</dt><dd>{point.endian || 'Protokoll'} · {scaleText(point)}</dd></div>
        <div><dt>Einheit</dt><dd>{point.unit || 'nicht belegt'}</dd></div>
        <div><dt>Roh / dekodiert</dt><dd>{point.rawValue ?? '—'} / {point.decodedValue ?? '—'}</dd></div>
        <div><dt>Zuletzt gelesen</dt><dd>{point.lastReadAt ? new Date(point.lastReadAt).toLocaleString('de-DE') : 'Noch nie'}</dd></div>
        <div><dt>Kadenz</dt><dd>{cadence(point.selectedCadenceS ?? point.defaultCadenceS)}</dd></div>
        <div><dt>Datenmenge</dt><dd>{bytes(point.estimatedDataPerYearBytes)}</dd></div>
      </dl>
      {point.selected && (
        <div className="vp-measure-steps" aria-label="Aktivierungsstatus">
          {applySteps(applyStatus ?? (point.lastReadAt ? 'first_sample' : 'pending_edge')).map(([label, done]) => (
            <span key={label} className={done ? 'is-done' : ''}>{done ? '✓' : '○'} {label}</span>
          ))}
        </div>
      )}
      <div className="vp-measure-row__actions">
        <Button variant="ghost" size="sm" onClick={() => onHistory(point)} disabled={!point.recorded && !point.lastReadAt}>
          Verlauf ansehen
        </Button>
        <span title={point.availabilityReason}>{point.availabilityReason}</span>
      </div>
    </article>
  );
}

export function MeasurementLibrary({ deviceId }: { deviceId: string | null | undefined }) {
  const [state, setState] = useState<MeasurementSelectionState | null>(null);
  const [quiet, setQuiet] = useState<MeasurementCatalogResult | null>(null);
  const [catalog, setCatalog] = useState<MeasurementCatalogResult | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('');
  const [semantic, setSemantic] = useState('');
  const [availability, setAvailability] = useState<'all' | 'available'>('all');
  const [recorded, setRecorded] = useState<'all' | 'true' | 'false'>('all');
  const [offset, setOffset] = useState(0);
  const [pending, setPending] = useState<MeasurementCatalogPoint | null>(null);
  const [pendingEnabled, setPendingEnabled] = useState(false);
  const [pendingCadence, setPendingCadence] = useState(30);
  const [estimate, setEstimate] = useState<MeasurementBudgetEstimate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [historyPoint, setHistoryPoint] = useState<MeasurementCatalogPoint | null>(null);
  const [history, setHistory] = useState<MeasurementHistory | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [range, setRange] = useState<MeasurementRange>('24h');
  const [freeFrom, setFreeFrom] = useState(() => new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 16));
  const [freeTo, setFreeTo] = useState(() => new Date().toISOString().slice(0, 16));
  const [representation, setRepresentation] = useState<'raw' | 'decoded'>('decoded');
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState({ label: '', address: '0', valueType: 'uint16', endian: 'big', scale: '1', unit: 'W', cadenceS: '30', sourceKind: 'modbus_holding' });
  const [customEstimate, setCustomEstimate] = useState<MeasurementBudgetEstimate | null>(null);

  const loadState = () => {
    if (!deviceId) return;
    api.measurementSelection(deviceId).then(setState, () => setUnsupported(true));
  };
  const loadQuiet = () => {
    if (!deviceId) return;
    const params = new URLSearchParams({ availableOnly: 'true', limit: '250' });
    api.measurementCatalog(deviceId, params).then(setQuiet, () => setUnsupported(true));
  };
  useEffect(() => { setUnsupported(false); loadState(); loadQuiet(); }, [deviceId]);

  useEffect(() => {
    if (!open || !deviceId) return;
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ q: query, offset: String(offset), limit: '100' });
      if (group) params.set('group', group);
      if (semantic) params.set('semanticStatus', semantic);
      if (availability === 'available') params.set('availableOnly', 'true');
      if (recorded !== 'all') params.set('recorded', recorded);
      api.measurementCatalog(deviceId, params).then(setCatalog, () => setError('Die vollständige Liste konnte nicht geladen werden.'));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [open, deviceId, query, group, semantic, availability, recorded, offset, state]);

  useEffect(() => {
    if (!pending || !deviceId) return;
    setEstimate(null);
    api.measurementEstimate(deviceId, pending.pointKey, pendingCadence, pendingEnabled)
      .then(setEstimate, (e) => setError(e instanceof Error ? e.message : 'Die Auswirkung konnte nicht berechnet werden.'));
  }, [pending, pendingCadence, pendingEnabled, deviceId]);

  useEffect(() => {
    if (!historyPoint || !deviceId) return;
    setHistory(null);
    setHistoryError(null);
    const from = range === 'free' ? isoOrUndefined(freeFrom) : undefined;
    const to = range === 'free' ? isoOrUndefined(freeTo) : undefined;
    api.measurementHistory(deviceId, historyPoint.pointKey, range, representation, from, to)
      .then(setHistory, (e) => setHistoryError(e instanceof Error ? e.message : 'Der Verlauf konnte nicht geladen werden.'));
  }, [historyPoint, range, representation, freeFrom, freeTo, deviceId]);

  const customPoints = useMemo<MeasurementCatalogPoint[]>(() => (state?.selections ?? [])
    .filter((selection) => selection.customDefinition)
    .map((selection) => {
      const definition = selection.customDefinition!;
      const effectiveCadence = selection.cadenceS ?? definition.cadenceS;
      const recorded = selection.enabledAt != null;
      return {
        family: 'custom', pointKey: selection.pointKey, sourceKind: definition.sourceKind,
        address: { kind: definition.sourceKind, registers: [definition.address], widthWords: Math.max(1, definition.widthBits / 16) },
        selector: definition.selector, widthBits: definition.widthBits, valueType: definition.valueType,
        signed: definition.signed, endian: definition.endian, scale: { kind: 'factor', value: definition.scale },
        unit: definition.unit, group: 'Eigene Messwerte', labelDe: definition.label,
        labelSource: 'Eigenes Register', semanticStatus: 'unknown', aggregationKind: 'gauge',
        defaultCadenceS: definition.cadenceS, minCadenceS: 1, longTermCadenceS: null,
        pollGroup: `custom:${definition.sourceKind}:${definition.address}`, sourceUrl: '',
        sourceCommit: null, sourceRevision: null, dynamic: false, recommended: false,
        available: true, availabilityStatus: 'family_configured',
        availabilityReason: selection.enabled
          ? 'Eigenes Register; die Aufzeichnung ist für dieses Gerät angefordert.'
          : 'Eigenes Register; die Aufzeichnung ist beendet, die Historie bleibt erhalten.',
        recorded, selected: selection.enabled, selectedCadenceS: selection.cadenceS,
        lastReadAt: null, rawValue: null, decodedValue: null, quality: null, gap: false,
        droppedSamples: 0,
        estimatedDataPerYearBytes: Math.round(365.25 * 24 * 3600 / Math.max(1, effectiveCadence) * 96),
      };
    }), [state]);

  const visibleCustomPoints = useMemo(() => customPoints.filter((point) => {
    const normalized = query.trim().toLocaleLowerCase('de-DE');
    const searchable = `${point.labelDe} ${point.labelSource} ${point.selector} ${point.address?.registers?.join(' ')} ${point.unit} ${point.sourceKind}`.toLocaleLowerCase('de-DE');
    return (!normalized || searchable.includes(normalized))
      && (!group || group === point.group)
      && (!semantic || semantic === point.semanticStatus)
      && (recorded === 'all' || (recorded === 'true') === point.recorded);
  }), [customPoints, group, query, recorded, semantic]);

  const important = useMemo(() => {
    const all = [...customPoints, ...(quiet?.points ?? [])];
    const preferred = all.filter((p) => p.selected || p.recommended || p.recorded || p.lastReadAt);
    return (preferred.length ? preferred : all).slice(0, 8);
  }, [customPoints, quiet]);

  const toggle = (point: MeasurementCatalogPoint) => {
    setPending(point);
    setPendingEnabled(!point.selected);
    setPendingCadence(point.selectedCadenceS ?? point.defaultCadenceS ?? 30);
    setError(null);
  };

  const openHistory = (point: MeasurementCatalogPoint) => {
    setRepresentation('decoded');
    setHistory(null);
    setHistoryError(null);
    setHistoryPoint(point);
  };

  const setFreePart = (side: 'from' | 'to', part: 'date' | 'time', value: string) => {
    const current = side === 'from' ? freeFrom : freeTo;
    const [date = '', time = '00:00'] = current.split('T');
    const next = part === 'date' ? `${value}T${time}` : `${date}T${value}`;
    (side === 'from' ? setFreeFrom : setFreeTo)(next);
  };

  const confirmToggle = async () => {
    if (!deviceId || !state || !pending) return;
    setBusy(true);
    try {
      const next = await api.changeMeasurementSelection(deviceId, pending.pointKey, {
        expectedRevision: state.desiredRevision,
        idempotencyKey: uuid(),
        enabled: pendingEnabled,
        ...(pendingEnabled ? { cadenceS: pendingCadence } : {}),
      });
      setState(next);
      setPending(null);
      loadQuiet();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Die Auswahl konnte nicht gespeichert werden.');
    } finally { setBusy(false); }
  };

  const customDefinition = () => {
    const valueType = custom.valueType;
    const signed = valueType === 'int16' || valueType === 'int32' || valueType.startsWith('float');
    const widthBits = valueType.endsWith('16') ? 16 : valueType.endsWith('64') ? 64 : 32;
    const address = Number(custom.address);
    return {
      label: custom.label, sourceKind: custom.sourceKind, address,
      selector: `${custom.sourceKind === 'modbus_holding' ? 'holding' : 'input'}:0x${address.toString(16).padStart(4, '0')}`,
      valueType, widthBits, signed, endian: custom.endian, scale: Number(custom.scale),
      unit: custom.unit, cadenceS: Number(custom.cadenceS), retentionClass: 'gauge', readOnly: true,
    };
  };

  const checkCustom = async () => {
    if (!deviceId) return;
    try { setCustomEstimate(await api.customMeasurementEstimate(deviceId, customDefinition())); }
    catch (e) { setError(e instanceof Error ? e.message : 'Das Register ist nicht gültig.'); }
  };
  const addCustom = async () => {
    if (!deviceId || !state) return;
    setBusy(true);
    try {
      setState(await api.addCustomMeasurement(deviceId, {
        expectedRevision: state.desiredRevision, idempotencyKey: uuid(), definition: customDefinition(),
      }));
      setCustomOpen(false); setCustomEstimate(null); loadQuiet();
    } catch (e) { setError(e instanceof Error ? e.message : 'Das Register konnte nicht hinzugefügt werden.'); }
    finally { setBusy(false); }
  };

  if (!deviceId) return null;
  if (unsupported) return (
    <Card padding="lg" radius="lg" className="vp-measure-entry">
      <h2>Zusätzliche Messwerte</h2>
      <p>Diese VoltPilot-Box unterstützt die Messwert-Bibliothek mit ihrem aktuellen Softwarestand noch nicht.</p>
    </Card>
  );

  return (
    <section className="vp-measure-library" aria-labelledby="vp-measure-title">
      <Card padding="lg" radius="lg" className="vp-measure-entry">
        <div className="vp-measure-entry__head">
          <div>
            <p className="vp-measure-eyebrow">Messung</p>
            <h2 id="vp-measure-title">Wichtige zusätzliche Messwerte</h2>
            <p>Ruhige Vorauswahl für dieses Gerät. Weitere technische Punkte bleiben in der Bibliothek.</p>
          </div>
          <Button variant="outline" onClick={() => setOpen(true)} iconLeft={<Icon name="search" size={16} />}>
            Messwert-Bibliothek
          </Button>
        </div>
        {state && state.status !== 'idle' && (
          <p className="vp-measure-global-status" role="status"><strong>{state.statusReason}</strong> {state.volumeEstimate.totalGbPerYear.toFixed(3)} GB/Jahr geplant.</p>
        )}
        {!quiet ? <p role="status">Messwerte werden geladen …</p> : important.length === 0 ? (
          <p className="vp-measure-empty">Noch keine Punkte für die erkannte Anbindung bestätigt. Die vollständige Bibliothek zeigt bekannte und frei ergänzbare Punkte.</p>
        ) : <div className="vp-measure-list">{important.map((point) => <PointRow key={point.pointKey} point={point} applyStatus={state?.selections.find((selection) => selection.pointKey === point.pointKey)?.applyStatus} onToggle={toggle} onHistory={openHistory} />)}</div>}
      </Card>

      <Drawer open={open} onClose={() => setOpen(false)} title="Messwert-Bibliothek" footer={
        <Button variant="outline" onClick={() => setCustomOpen(true)}>Eigenen Messwert hinzufügen</Button>
      }>
        <p className="vp-measure-drawer-intro">Alle bekannten Punkte. Suche umfasst deutschen und originalen Namen, Registeradresse, API-Key oder OCPP-Measurand sowie Einheit.</p>
        <Input label="Messwert suchen" value={query} onChange={(e) => { setQuery(e.target.value); setOffset(0); }} placeholder="z. B. PV2 Strom, 0x00bf, P_Grid, Energy.Active.Import, V" />
        <div className="vp-measure-filters" aria-label="Messwertfilter">
          <VpPicker label="Gruppe" value={group} options={[{ value: '', label: 'Alle Gruppen' }, ...(catalog?.groups ?? []).map((f) => ({ value: f.value, label: `${f.value} (${f.count})` }))]} onChange={(value) => { setGroup(value); setOffset(0); }} />
          <VpPicker label="Verfügbarkeit" value={availability} options={[{ value: 'all', label: 'Alle bekannten' }, { value: 'available', label: 'Für Gerät verfügbar' }]} onChange={(value) => { setAvailability(value as typeof availability); setOffset(0); }} />
          <VpPicker label="Semantik" value={semantic} options={[{ value: '', label: 'Alle' }, { value: 'known', label: 'Bekannt' }, { value: 'vendor_label_only', label: 'Nur Herstellerbezeichnung' }, { value: 'unknown', label: 'Unbekannt' }]} onChange={(value) => { setSemantic(value); setOffset(0); }} />
          <VpPicker label="Aufzeichnung" value={recorded} options={[{ value: 'all', label: 'Alle' }, { value: 'true', label: 'Mit Historie' }, { value: 'false', label: 'Ohne Historie' }]} onChange={(value) => { setRecorded(value as typeof recorded); setOffset(0); }} />
        </div>
        {error && <p role="alert" className="vp-assist-error">{error}</p>}
        <p className="vp-measure-result" aria-live="polite">{catalog ? `${(catalog.total + visibleCustomPoints.length).toLocaleString('de-DE')} Punkte gefunden` : 'Liste wird geladen …'}</p>
        <div className="vp-measure-list">{[...visibleCustomPoints, ...(catalog?.points ?? [])].map((point) => <PointRow key={point.pointKey} point={point} applyStatus={state?.selections.find((selection) => selection.pointKey === point.pointKey)?.applyStatus} onToggle={toggle} onHistory={openHistory} />)}</div>
        {catalog && catalog.total > catalog.limit && <nav className="vp-measure-pages" aria-label="Ergebnisseiten"><Button variant="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - catalog.limit))}>Zurück</Button><span>{offset + 1}–{Math.min(offset + catalog.limit, catalog.total)} von {catalog.total}</span><Button variant="ghost" disabled={offset + catalog.limit >= catalog.total} onClick={() => setOffset(offset + catalog.limit)}>Weiter</Button></nav>}
      </Drawer>

      <ConfirmDialog
        open={pending != null}
        title={pendingEnabled ? 'Messwert aufzeichnen' : 'Aufzeichnung beenden'}
        intro={pending ? pointLabel(pending) : ''}
        consequences={pendingEnabled ? [
          `Kadenz: ${cadence(pendingCadence)}.`,
          estimate ? `Gerätelast: ${estimate.samplesPerMinute} Samples/min, ${estimate.dutyCyclePercent} % Buslast.` : 'Gerätelast wird berechnet …',
          estimate ? `Datenvolumen gesamt: ${estimate.totalGbPerYear.toFixed(3)} GB/Jahr.` : 'Datenvolumen wird berechnet …',
          'Die Aufzeichnung startet jetzt. Frühere Werte werden nicht rückwirkend nachgeladen.',
          'Statusfolge: angefordert → auf der Box angewendet → erster Wert.',
        ] : [
          'Es werden künftig keine neuen Werte gelesen.',
          'Die vorhandene Historie und ihre Export-Metadaten bleiben erhalten.',
        ]}
        confirmLabel={pendingEnabled ? 'Jetzt aufzeichnen' : 'Aufzeichnung beenden'}
        busy={busy || (pendingEnabled && (!estimate || estimate.hardRejected))}
        onConfirm={confirmToggle}
        onCancel={() => setPending(null)}
        extra={pendingEnabled ? <Input label="Kadenz in Sekunden" type="number" min={pending?.minCadenceS ?? 1} max={86400} value={pendingCadence} onChange={(e) => setPendingCadence(Number(e.target.value))} error={estimate?.hardRejected ? estimate.reasons.join(' ') : null} /> : null}
      />

      <Drawer open={historyPoint != null} onClose={() => { setHistoryPoint(null); setHistory(null); setHistoryError(null); setRepresentation('decoded'); }} title={historyPoint ? `Verlauf · ${pointLabel(historyPoint)}` : 'Verlauf'} footer={history && historyPoint ? <Button variant="outline" onClick={() => void downloadMeasurementExport(deviceId, historyPoint.pointKey, range, representation, range === 'free' ? isoOrUndefined(freeFrom) : undefined, range === 'free' ? isoOrUndefined(freeTo) : undefined)}>CSV mit Metadaten exportieren</Button> : null}>
        <div className="vp-measure-range" aria-label="Zeitraum">{ranges.map(([key, label]) => <button type="button" key={key} className={range === key ? 'is-active' : ''} onClick={() => setRange(key)}>{label}</button>)}</div>
        {range === 'free' && <div className="vp-measure-free"><div><VpDatePicker label="Von · Datum" value={freeFrom.split('T')[0]} onChange={(value) => setFreePart('from', 'date', value)} /><VpTimePicker label="Von · Uhrzeit" value={freeFrom.split('T')[1] ?? ''} onChange={(value) => setFreePart('from', 'time', value)} /></div><div><VpDatePicker label="Bis · Datum" value={freeTo.split('T')[0]} onChange={(value) => setFreePart('to', 'date', value)} /><VpTimePicker label="Bis · Uhrzeit" value={freeTo.split('T')[1] ?? ''} onChange={(value) => setFreePart('to', 'time', value)} /></div></div>}
        {(history?.meta.rawAvailable || representation === 'raw') && <div className="vp-measure-range" aria-label="Wertdarstellung"><button type="button" className={representation === 'decoded' ? 'is-active' : ''} onClick={() => setRepresentation('decoded')}>Dekodiert</button><button type="button" className={representation === 'raw' ? 'is-active' : ''} onClick={() => setRepresentation('raw')}>Rohwert</button></div>}
        {historyError ? <div className="vp-assist-error" role="alert"><p>{historyError}</p>{representation === 'raw' && <Button size="sm" variant="outline" onClick={() => setRepresentation('decoded')}>Dekodierte Werte laden</Button>}</div> : !history ? <p role="status">Verlauf wird geladen …</p> : history.data.length === 0 ? <p className="vp-measure-empty">Für diesen Zeitraum sind keine Werte gespeichert. Eine frühere Abwahl löscht die Historie nicht.</p> : <><HistoryChart history={history} /><p className="vp-measure-hint">{history.meta.aggregationExplanation}</p><ul className="vp-measure-marker-list">{history.markers.map((m) => <li key={`${m.time}-${m.kind}`}><time>{new Date(m.time).toLocaleString('de-DE')}</time> · {m.label}</li>)}</ul></>}
      </Drawer>

      <Drawer open={customOpen} onClose={() => setCustomOpen(false)} title="Eigenen Messwert hinzufügen" footer={<><Button variant="ghost" onClick={checkCustom}>Last und Volumen prüfen</Button><Button onClick={addCustom} disabled={!customEstimate || customEstimate.hardRejected || busy}>Jetzt aufzeichnen</Button></>}>
        <p>Nur lesbare Modbus-Register. VoltPilot erfindet keine Semantik: Name, Einheit, Datentyp und Skala stammen aus Ihrer Gerätedokumentation.</p>
        <div className="vp-measure-custom">
          <Input label="Bezeichnung" value={custom.label} onChange={(e) => { setCustom({ ...custom, label: e.target.value }); setCustomEstimate(null); }} />
          <Input label="Registeradresse (dezimal)" type="number" min="0" max="65535" value={custom.address} onChange={(e) => { setCustom({ ...custom, address: e.target.value }); setCustomEstimate(null); }} />
          <VpPicker label="Registerart" value={custom.sourceKind} options={[{ value: 'modbus_holding', label: 'Holding Register' }, { value: 'modbus_input', label: 'Input Register' }]} onChange={(value) => { setCustom({ ...custom, sourceKind: value }); setCustomEstimate(null); }} />
          <VpPicker label="Datentyp" value={custom.valueType} options={['uint16', 'int16', 'uint32', 'int32', 'float32', 'float64'].map((value) => ({ value, label: value }))} onChange={(value) => { setCustom({ ...custom, valueType: value }); setCustomEstimate(null); }} />
          <VpPicker label="Byte-/Wortreihenfolge" value={custom.endian} options={[{ value: 'big', label: 'Big Endian' }, { value: 'word_little_byte_big', label: 'Wörter vertauscht, Bytes big endian' }]} onChange={(value) => { setCustom({ ...custom, endian: value }); setCustomEstimate(null); }} />
          <Input label="Skala" type="number" step="any" value={custom.scale} onChange={(e) => { setCustom({ ...custom, scale: e.target.value }); setCustomEstimate(null); }} />
          <Input label="Einheit" value={custom.unit} onChange={(e) => { setCustom({ ...custom, unit: e.target.value }); setCustomEstimate(null); }} />
          <Input label="Kadenz in Sekunden" type="number" min="1" max="86400" value={custom.cadenceS} onChange={(e) => { setCustom({ ...custom, cadenceS: e.target.value }); setCustomEstimate(null); }} />
        </div>
        <p className="vp-measure-readonly"><Icon name="lock" size={15} /> Ausschließlich lesbar. Keine Schreibparameter.</p>
        {customEstimate && <p role="status" className="vp-measure-global-status">{customEstimate.samplesPerMinute} Samples/min · {customEstimate.dutyCyclePercent} % Buslast · {customEstimate.totalGbPerYear.toFixed(3)} GB/Jahr. Start jetzt, kein Backfill.</p>}
      </Drawer>
    </section>
  );
}
