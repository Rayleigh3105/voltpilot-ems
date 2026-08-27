import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
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
import {
  HINZU,
  LEER,
  MAX_SPARK,
  TITEL,
  adresse as adresseVon,
  eigenePunkte,
  katalogTitel,
  kurzfassung,
  sparkPunkte,
  wortwahl,
  zeilen,
  type BeobachteteZeile,
  type BrueckeVorschlag,
} from '../beobachteteRegister';
import { BEOBACHTEN_HINWEIS } from '../registerFamilie';
import { NO_DATA } from '../nodata';
import type { MiniPoint } from '../miniChart';
import { useEChart } from '../useEChart';
import { ConfirmDialog } from './ConfirmDialog';
import { MiniLineSpark } from './MiniChart';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';
import { VpTimePicker } from './VpTimePicker';
import './Messwerte.css';

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

function statusLabel(point: MeasurementCatalogPoint) {
  if (point.availabilityStatus === 'read') return 'Vom Gerät gelesen';
  if (point.availabilityStatus === 'family_configured') return 'Für diese Anbindung vorgesehen';
  return 'Nicht als verfügbar bestätigt';
}

function resultLabel(count: number) {
  return `${count.toLocaleString('de-DE')} ${count === 1 ? 'Punkt' : 'Punkte'} gefunden`;
}

/** Was ein Umschalten betrifft - der Katalog-Punkt wird dafür nicht gebraucht. */
interface Umschaltung {
  pointKey: string;
  label: string;
  enabled: boolean;
  cadence: number;
  minCadence: number | null;
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

/** Eine Zeile des Katalog-Einschubs (der technische Blick auf einen Punkt). */
function PointRow({ point, onToggle, onHistory }: {
  point: MeasurementCatalogPoint;
  onToggle: (u: Umschaltung) => void;
  onHistory: (pointKey: string, label: string) => void;
}) {
  return (
    <article className="vp-measure-row" data-semantic={point.semanticStatus}>
      <div className="vp-measure-row__main">
        <Switch
          checked={point.selected}
          onChange={() => onToggle({
            pointKey: point.pointKey,
            label: pointLabel(point),
            enabled: !point.selected,
            cadence: point.selectedCadenceS ?? point.defaultCadenceS ?? 30,
            minCadence: point.minCadenceS,
          })}
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
        <div><dt>Adresse / Schlüssel</dt><dd className="vp-mono">{adresseVon(point) ?? NO_DATA}</dd></div>
        <div><dt>Typ</dt><dd>{point.valueType} · {point.widthBits ?? 'variabel'} Bit · {point.signed == null ? 'Vorzeichen n/a' : point.signed ? 'signed' : 'unsigned'}</dd></div>
        <div><dt>Reihenfolge / Skala</dt><dd>{point.endian || 'Protokoll'} · {scaleText(point)}</dd></div>
        <div><dt>Einheit</dt><dd>{point.unit || 'nicht belegt'}</dd></div>
        <div><dt>Roh / dekodiert</dt><dd>{point.rawValue ?? NO_DATA} / {point.decodedValue ?? NO_DATA}</dd></div>
        <div><dt>Zuletzt gelesen</dt><dd>{point.lastReadAt ? new Date(point.lastReadAt).toLocaleString('de-DE') : 'Noch nie'}</dd></div>
        <div><dt>Kadenz</dt><dd>{cadence(point.selectedCadenceS ?? point.defaultCadenceS)}</dd></div>
        <div><dt>Datenmenge</dt><dd>{bytes(point.estimatedDataPerYearBytes)}</dd></div>
      </dl>
      <div className="vp-measure-row__actions">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onHistory(point.pointKey, pointLabel(point))}
          disabled={!point.recorded && !point.lastReadAt}
        >
          Verlauf ansehen
        </Button>
        <span title={point.availabilityReason}>{point.availabilityReason}</span>
      </div>
    </article>
  );
}

/** Eine Zeile der Beobachtungs-Liste (Teil 1). */
function BeobZeile({ zeile, spark, onHistory, onStop }: {
  zeile: BeobachteteZeile;
  spark: MiniPoint[] | undefined;
  onHistory: (pointKey: string, label: string) => void;
  onStop: (zeile: BeobachteteZeile) => void;
}) {
  return (
    <li className="vp-beob-row" data-testid={`beob-${zeile.pointKey}`}>
      <div className="vp-beob-kopf">
        <span className="vp-beob-name">{zeile.name}</span>
        {zeile.adresse && <span className="vp-mono vp-beob-adr">{zeile.adresse}</span>}
        {/* Der Zustand trägt sein WORT, nie nur eine Farbe. */}
        <span className={`vp-beob-zustand is-${zeile.ton}`}>{zeile.zustandWort}</span>
      </div>
      <div className="vp-beob-wertzeile">
        {/* Ohne Wert steht ein Strich - nie eine erfundene 0. */}
        <span className="vp-beob-wert">{zeile.wert ?? NO_DATA}</span>
        {zeile.frische && <span className="vp-beob-frische">{zeile.frische}</span>}
        {spark && spark.length > 0 && (
          <MiniLineSpark
            className="vp-beob-spark"
            points={spark}
            width={96}
            ariaLabel={`Verlauf der letzten 24 Stunden · ${zeile.name}`}
          />
        )}
      </div>
      {zeile.grund && <p className="vp-beob-grund">{zeile.grund}</p>}
      <div className="vp-beob-akt">
        <Button
          variant="ghost"
          size="sm"
          disabled={!zeile.verlaufMoeglich}
          onClick={() => onHistory(zeile.pointKey, zeile.name)}
        >
          Verlauf
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onStop(zeile)}>
          Nicht mehr beobachten
        </Button>
      </div>
    </li>
  );
}

/**
 * „Beobachtete Register" bzw. „Beobachtete Messwerte" - Teil 1 und 2 der
 * Register-Sektion einer Geräteseite (Geräteseiten Stufe 3a, Konzept
 * `data/vp-geraeteseite-rahmen-r2` §7.2).
 *
 * <p>Sie löst die frühere `MeasurementLibrary` ab: die zeigte eine ruhige
 * VORAUSWAHL des Katalogs („was könnte dieses Gerät liefern?"), gefragt ist auf
 * einer Geräteseite aber die Beobachtungs-LISTE („was beobachte ich hier, und
 * was sagt es jetzt?"). Die Einschübe - Katalog, Verlauf, eigenes Register,
 * Rückfrage - sind WIEDERVERWENDET, nicht neu gebaut.
 *
 * ⚠ **`deviceId` ist die BOX** - dort hängt der Transport, und dort veröffentlicht
 * der Server den EINEN Plan. `entityId` schneidet Auswahl und Papier-Spur auf die
 * Komponente DIESER Seite (Stufe 3b); ohne es antwortet der Server wie vorher
 * über das ganze Gerät, also bleibt die Box-Seite Zeichen für Zeichen dieselbe.
 *
 * ⚠ **`familien` fehlt** → die alte Box-Semantik (der Aufrufer kennt kein Gerät).
 * **`familien` ist leer** → für dieses Gerät kennt VoltPilot keine Registerliste;
 * es entsteht GAR KEINE Fläche, nie ein leerer Kasten (die Ausblende-Regel §7.3).
 */
export function BeobachteteRegister({
  deviceId, siteId, entityId, familien, eigeneErlaubt = true, registerFaehig = true,
  geraetName = null, lesbar = true, bruecke = null, onBrueckeVerbraucht, onKurzfassung,
}: {
  deviceId: string | null | undefined;
  siteId?: string;
  /** Die Komponente DIESER Seite - ohne sie bleibt es bei der Box-Semantik. */
  entityId?: string;
  /** Die Katalog-Familien DIESES Geräts (`registerFamilie.geraetFamilien`). */
  familien?: readonly string[] | null;
  /**
   * Ob eigene (frei definierte) Modbus-Register hierher gehören. Sie werden
   * gegen den PRIMÄREN Wechselrichter gelesen, also stehen sie nur auf dessen
   * Seite - auf einer Wallbox wären sie eine Zusage gegen die falsche Adresse.
   */
  eigeneErlaubt?: boolean;
  /** Modbus? Sonst heißt die Sache „Messwert" statt „Register" (D3a). */
  registerFaehig?: boolean;
  /** Für den Titel des Katalog-Einschubs - er NENNT das Gerät. */
  geraetName?: string | null;
  /** Kann die Box einen Punkt dieses Geräts heute lesen (Stufe 3c)? */
  lesbar?: boolean;
  /** Die Brücke aus einer Lesung: „gut gefunden, behalten". */
  bruecke?: BrueckeVorschlag | null;
  onBrueckeVerbraucht?: () => void;
  /**
   * Die Kurzfassung für den geschlossenen Sektions-Kopf. Sie entsteht HIER,
   * weil nur diese Fläche die Beobachtungen kennt - und wird nach oben
   * GEMELDET, statt sie im Rahmen ein zweites Mal abzuleiten.
   *
   * ⚠ Der Rückruf muss STABIL sein (ein `useState`-Setter genügt): React bricht
   * bei gleicher Zeichenkette ab, also entsteht keine Schleife.
   */
  onKurzfassung?: (text: string | null) => void;
}) {
  const wahl = wortwahl(registerFaehig);
  // Die Familien-Adresse EINMAL gebaut: sie geht in beide Katalog-Abrufe und
  // darf zwischen ihnen nicht abweichen.
  const familienListe = familien == null ? null : [...familien];
  const geraeteSicht = familienListe != null;
  /**
   * Die AUSBLENDE-Regel (§7.3) - sie greift schon VOR dem ersten Abruf: für ein
   * Gerät ohne Katalog-Familie gibt es nichts zu fragen, also wird auch nichts
   * gefragt. Ein Abruf, dessen Antwort niemand rendert, ist Last ohne Aussage.
   */
  const stumm = familienListe != null && familienListe.length === 0;
  const familienParams = (params: URLSearchParams) => {
    for (const family of familienListe ?? []) params.append('family', family);
    if (entityId) params.set('entityId', entityId);
    return params;
  };
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
  const [pending, setPending] = useState<Umschaltung | null>(null);
  const [pendingCadence, setPendingCadence] = useState(30);
  const [estimate, setEstimate] = useState<MeasurementBudgetEstimate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [historyPoint, setHistoryPoint] = useState<{ pointKey: string; label: string } | null>(null);
  const [historyReturnToLibrary, setHistoryReturnToLibrary] = useState(false);
  const [history, setHistory] = useState<MeasurementHistory | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [range, setRange] = useState<MeasurementRange>('24h');
  const [freeFrom, setFreeFrom] = useState(() => new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 16));
  const [freeTo, setFreeTo] = useState(() => new Date().toISOString().slice(0, 16));
  const [representation, setRepresentation] = useState<'raw' | 'decoded'>('decoded');
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState({ label: '', address: '0', valueType: 'uint16', endian: 'big', scale: '1', unit: 'W', cadenceS: '30', sourceKind: 'modbus_holding' });
  const [customEstimate, setCustomEstimate] = useState<MeasurementBudgetEstimate | null>(null);
  const [sparks, setSparks] = useState<Record<string, MiniPoint[]>>({});

  const loadState = () => {
    if (!deviceId || stumm) return;
    api.measurementSelection(deviceId, entityId).then(setState, () => setUnsupported(true));
  };
  const loadQuiet = () => {
    if (!deviceId || stumm) return;
    // Auf einer Geräteseite fragt `availableOnly` die Box („was kann DIESE Box
    // lesen") - der Familien-Schnitt fragt das Gerät. Nie beides.
    const params = geraeteSicht
      ? familienParams(new URLSearchParams({ limit: '250' }))
      : new URLSearchParams({ availableOnly: 'true', limit: '250' });
    api.measurementCatalog(deviceId, params).then(setQuiet, () => setUnsupported(true));
  };
  useEffect(() => {
    setUnsupported(false);
    loadState();
    loadQuiet();
  }, [deviceId, entityId, familienListe?.join(',')]);

  useEffect(() => {
    if (!open || !deviceId || stumm) return;
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ q: query, offset: String(offset), limit: '100' });
      if (group) params.set('group', group);
      if (semantic) params.set('semanticStatus', semantic);
      if (!geraeteSicht && availability === 'available') params.set('availableOnly', 'true');
      if (recorded !== 'all') params.set('recorded', recorded);
      api.measurementCatalog(deviceId, familienParams(params)).then(setCatalog, () => setError('Die vollständige Liste konnte nicht geladen werden.'));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [open, deviceId, entityId, familienListe?.join(','), query, group, semantic, availability, recorded, offset, state]);

  useEffect(() => {
    if (!pending || !deviceId) return;
    setEstimate(null);
    api.measurementEstimate(deviceId, pending.pointKey, pendingCadence, pending.enabled, entityId)
      .then(setEstimate, (e) => setError(e instanceof Error ? e.message : 'Die Auswirkung konnte nicht berechnet werden.'));
  }, [pending, pendingCadence, deviceId, entityId]);

  useEffect(() => {
    if (!historyPoint || !deviceId) return;
    setHistory(null);
    setHistoryError(null);
    const from = range === 'free' ? isoOrUndefined(freeFrom) : undefined;
    const to = range === 'free' ? isoOrUndefined(freeTo) : undefined;
    api.measurementHistory(deviceId, historyPoint.pointKey, range, representation, from, to,
      siteId, entityId)
      .then(setHistory, (e) => setHistoryError(e instanceof Error ? e.message : 'Der Verlauf konnte nicht geladen werden.'));
  }, [historyPoint, range, representation, freeFrom, freeTo, deviceId, siteId, entityId]);

  // ⚠ Eigene Register tragen KEINE Katalog-Familie, lassen sich also nicht
  // schneiden. Sie werden gegen den primären Wechselrichter gelesen - deshalb
  // entscheidet der Wirt (`eigeneErlaubt`), ob sie hierher gehören.
  const customPoints = useMemo(
    () => eigenePunkte(state, eigeneErlaubt),
    [state, eigeneErlaubt],
  );

  const visibleCustomPoints = useMemo(() => customPoints.filter((point) => {
    const normalized = query.trim().toLocaleLowerCase('de-DE');
    const searchable = `${point.labelDe} ${point.labelSource} ${point.selector} ${point.address?.registers?.join(' ')} ${point.unit} ${point.sourceKind}`.toLocaleLowerCase('de-DE');
    return (!normalized || searchable.includes(normalized))
      && (!group || group === point.group)
      && (!semantic || semantic === point.semanticStatus)
      && (recorded === 'all' || (recorded === 'true') === point.recorded);
  }), [customPoints, group, query, recorded, semantic]);

  /** Teil 1: die Beobachtungen dieser Komponente - die reine Regel entscheidet. */
  const rows = useMemo(() => zeilen({
    selections: state?.selections,
    katalog: [...customPoints, ...(quiet?.points ?? [])],
    lesbar,
  }), [state, quiet, customPoints, lesbar]);

  const kurz = useMemo(() => kurzfassung(rows), [rows]);
  useEffect(() => { onKurzfassung?.(kurz); }, [kurz, onKurzfassung]);

  const sparkKeys = rows.filter((r) => r.verlaufMoeglich).slice(0, MAX_SPARK)
    .map((r) => r.pointKey).join('|');
  useEffect(() => {
    if (!deviceId || !sparkKeys) return;
    let abgebrochen = false;
    // Ein Mini-Verlauf je Zeile, gedeckelt und FAIL-SOFT: er ist Beiwerk, sein
    // Ausfall darf die Liste nie kippen.
    for (const key of sparkKeys.split('|')) {
      api.measurementHistory(deviceId, key, '24h', 'decoded', undefined, undefined, siteId, entityId)
        .then(
          (h) => {
            if (!abgebrochen) setSparks((alt) => ({ ...alt, [key]: sparkPunkte(h) }));
          },
          () => {},
        );
    }
    return () => { abgebrochen = true; };
  }, [deviceId, siteId, entityId, sparkKeys]);

  const toggle = (u: Umschaltung) => {
    setPending(u);
    setPendingCadence(u.cadence);
    setError(null);
  };

  const openHistory = (pointKey: string, label: string) => {
    setHistoryReturnToLibrary(open);
    setOpen(false);
    setRepresentation('decoded');
    setHistory(null);
    setHistoryError(null);
    setHistoryPoint({ pointKey, label });
  };

  const closeHistory = () => {
    setHistoryPoint(null);
    setHistory(null);
    setHistoryError(null);
    setRepresentation('decoded');
    if (historyReturnToLibrary) setOpen(true);
    setHistoryReturnToLibrary(false);
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
        enabled: pending.enabled,
        ...(pending.enabled ? { cadenceS: pendingCadence } : {}),
      }, entityId);
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
    try { setCustomEstimate(await api.customMeasurementEstimate(deviceId, customDefinition(), entityId)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Das Register ist nicht gültig.'); }
  };
  const addCustom = async () => {
    if (!deviceId || !state) return;
    setBusy(true);
    try {
      setState(await api.addCustomMeasurement(deviceId, {
        expectedRevision: state.desiredRevision, idempotencyKey: uuid(), definition: customDefinition(),
      }, entityId));
      setCustomOpen(false); setCustomEstimate(null); loadQuiet();
    } catch (e) { setError(e instanceof Error ? e.message : 'Das Register konnte nicht hinzugefügt werden.'); }
    finally { setBusy(false); }
  };

  /**
   * Die BRÜCKE: eine gelesene Zeile wird zur Beobachtung. Sie füllt das
   * Eigenbau-Formular vor und öffnet es - **gespeichert wird erst mit dem
   * Klick**, wie auf jedem anderen Weg auch.
   */
  const brueckeGesehen = useRef<BrueckeVorschlag | null>(null);
  useEffect(() => {
    if (!bruecke || brueckeGesehen.current === bruecke) return;
    brueckeGesehen.current = bruecke;
    setCustom((alt) => ({
      ...alt,
      label: bruecke.label,
      address: bruecke.address,
      sourceKind: bruecke.sourceKind,
      unit: bruecke.unit,
      scale: bruecke.scale,
    }));
    setCustomEstimate(null);
    setCustomOpen(true);
    onBrueckeVerbraucht?.();
  }, [bruecke, onBrueckeVerbraucht]);

  if (!deviceId) return null;
  // Die AUSBLENDE-Regel (§7.3): ohne Katalog-Familie gibt es für dieses Gerät
  // keine Registerliste - dann entsteht kein Kasten, der nur das erklärt.
  if (stumm) return null;
  if (unsupported) {
    return (
      /* Der Grund ist der Abruf, nicht der Softwarestand einer Box: die Auswahl
         kommt aus der Cloud, und ein Fehlschlag sagt nichts über die Box. */
      <p className="vp-alert vp-alert-warn">
        Für dieses Gerät konnte die Messwert-Bibliothek nicht geladen werden.
      </p>
    );
  }

  return (
    <section className="vp-beob" aria-labelledby="vp-beob-title">
      <h3 id="vp-beob-title" className="vp-beob-title">{TITEL[wahl]}</h3>
      {/* Die ehrliche Grenze der Stufe 3a - sie steht ÜBER der Liste, weil sie
          für jede Zeile gilt (§7.4 3a). */}
      {!lesbar && (
        <p className="vp-measure-hint" data-testid="measure-beobachten-hinweis">
          {BEOBACHTEN_HINWEIS}
        </p>
      )}
      {state && state.status !== 'idle' && (
        <p className="vp-measure-global-status" role="status">
          <strong>{state.statusReason}</strong> {state.volumeEstimate.totalGbPerYear.toFixed(3)} GB/Jahr geplant.
        </p>
      )}
      {!state || !quiet ? (
        <p role="status">Beobachtungen werden geladen …</p>
      ) : rows.length === 0 ? (
        <p className="vp-measure-empty">{LEER[wahl]}</p>
      ) : (
        <ul className="vp-beob-list">
          {rows.map((zeile) => (
            <BeobZeile
              key={zeile.key}
              zeile={zeile}
              spark={sparks[zeile.pointKey]}
              onHistory={openHistory}
              onStop={(z) => toggle({
                pointKey: z.pointKey, label: z.name, enabled: false, cadence: 30, minCadence: null,
              })}
            />
          ))}
        </ul>
      )}
      <div className="vp-beob-hinzu">
        <Button variant="outline" onClick={() => setOpen(true)} iconLeft={<Icon name="search" size={16} />}>
          {`＋ ${HINZU[wahl]}`}
        </Button>
        {/* „Eigenes Register" gibt es nur, wo die Box eines lesen KANN. */}
        {eigeneErlaubt && registerFaehig && (
          <Button variant="ghost" onClick={() => setCustomOpen(true)}>Eigenes Register</Button>
        )}
      </div>

      <Drawer open={open} onClose={() => setOpen(false)} title={katalogTitel(wahl, geraetName)} footer={
        eigeneErlaubt && registerFaehig
          ? <Button variant="outline" onClick={() => setCustomOpen(true)}>Eigenen Messwert hinzufügen</Button>
          : null
      }>
        <p className="vp-measure-drawer-intro">Alle bekannten Punkte dieses Geräts. Suche umfasst deutschen und originalen Namen, Registeradresse, API-Key oder OCPP-Measurand sowie Einheit.</p>
        <Input label="Messwert suchen" value={query} onChange={(e) => { setQuery(e.target.value); setOffset(0); }} placeholder="z. B. PV2 Strom, 0x00bf, P_Grid, Energy.Active.Import, V" />
        <div className="vp-measure-filters" aria-label="Messwertfilter">
          <VpPicker label="Gruppe" value={group} options={[{ value: '', label: 'Alle Gruppen' }, ...(catalog?.groups ?? []).map((f) => ({ value: f.value, label: `${f.value} (${f.count})` }))]} onChange={(value) => { setGroup(value); setOffset(0); }} />
          {/* ⚠ „Für Gerät verfügbar" fragt server-seitig die Familien-VEREINIGUNG
              der BOX ab - auf einer Geräteseite also die falsche Frage (der
              gemeldete Fehler). Dort schneidet schon `?family=`. */}
          {!geraeteSicht && (
            <VpPicker label="Verfügbarkeit" value={availability} options={[{ value: 'all', label: 'Alle bekannten' }, { value: 'available', label: 'Für Gerät verfügbar' }]} onChange={(value) => { setAvailability(value as typeof availability); setOffset(0); }} />
          )}
          <VpPicker label="Semantik" value={semantic} options={[{ value: '', label: 'Alle' }, { value: 'known', label: 'Bekannt' }, { value: 'vendor_label_only', label: 'Nur Herstellerbezeichnung' }, { value: 'unknown', label: 'Unbekannt' }]} onChange={(value) => { setSemantic(value); setOffset(0); }} />
          <VpPicker label="Aufzeichnung" value={recorded} options={[{ value: 'all', label: 'Alle' }, { value: 'true', label: 'Mit Historie' }, { value: 'false', label: 'Ohne Historie' }]} onChange={(value) => { setRecorded(value as typeof recorded); setOffset(0); }} />
        </div>
        {error && <p role="alert" className="vp-assist-error">{error}</p>}
        <p className="vp-measure-result" aria-live="polite">{catalog ? resultLabel(catalog.total + visibleCustomPoints.length) : 'Liste wird geladen …'}</p>
        <div className="vp-measure-list">{[...visibleCustomPoints, ...(catalog?.points ?? [])].map((point) => <PointRow key={point.pointKey} point={point} onToggle={toggle} onHistory={openHistory} />)}</div>
        {catalog && catalog.total > catalog.limit && <nav className="vp-measure-pages" aria-label="Ergebnisseiten"><Button variant="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - catalog.limit))}>Zurück</Button><span>{offset + 1}–{Math.min(offset + catalog.limit, catalog.total)} von {catalog.total}</span><Button variant="ghost" disabled={offset + catalog.limit >= catalog.total} onClick={() => setOffset(offset + catalog.limit)}>Weiter</Button></nav>}
      </Drawer>

      <ConfirmDialog
        open={pending != null}
        title={pending?.enabled ? 'Messwert aufzeichnen' : 'Aufzeichnung beenden'}
        intro={pending?.label ?? ''}
        consequences={pending?.enabled ? [
          `Kadenz: ${cadence(pendingCadence)}.`,
          estimate ? `Gerätelast: ${estimate.samplesPerMinute} Samples/min, ${estimate.dutyCyclePercent} % Buslast.` : 'Gerätelast wird berechnet …',
          estimate ? `Datenvolumen gesamt: ${estimate.totalGbPerYear.toFixed(3)} GB/Jahr.` : 'Datenvolumen wird berechnet …',
          'Die Aufzeichnung startet jetzt. Frühere Werte werden nicht rückwirkend nachgeladen.',
          'Statusfolge: angefordert → auf der Box angewendet → erster Wert.',
        ] : [
          'Es werden künftig keine neuen Werte gelesen.',
          'Die vorhandene Historie und ihre Export-Metadaten bleiben erhalten.',
        ]}
        confirmLabel={pending?.enabled ? 'Jetzt aufzeichnen' : 'Aufzeichnung beenden'}
        busy={busy || Boolean(pending?.enabled && (!estimate || estimate.hardRejected))}
        onConfirm={confirmToggle}
        onCancel={() => setPending(null)}
        extra={pending?.enabled ? <Input label="Kadenz in Sekunden" type="number" min={pending?.minCadence ?? 1} max={86400} value={pendingCadence} onChange={(e) => setPendingCadence(Number(e.target.value))} error={estimate?.hardRejected ? estimate.reasons.join(' ') : null} /> : null}
      />

      <Drawer open={historyPoint != null} onClose={closeHistory} title={historyPoint ? `Verlauf · ${historyPoint.label}` : 'Verlauf'} footer={history && historyPoint ? <Button variant="outline" onClick={() => void downloadMeasurementExport(deviceId, historyPoint.pointKey, range, representation, range === 'free' ? isoOrUndefined(freeFrom) : undefined, range === 'free' ? isoOrUndefined(freeTo) : undefined, siteId, entityId)}>CSV mit Metadaten exportieren</Button> : null}>
        <div className="vp-measure-range" aria-label="Zeitraum">{ranges.map(([key, label]) => <button type="button" key={key} aria-pressed={range === key} className={range === key ? 'is-active' : ''} onClick={() => setRange(key)}>{label}</button>)}</div>
        {range === 'free' && <div className="vp-measure-free"><div><VpDatePicker label="Von · Datum" value={freeFrom.split('T')[0]} onChange={(value) => setFreePart('from', 'date', value)} /><VpTimePicker label="Von · Uhrzeit" value={freeFrom.split('T')[1] ?? ''} onChange={(value) => setFreePart('from', 'time', value)} /></div><div><VpDatePicker label="Bis · Datum" value={freeTo.split('T')[0]} onChange={(value) => setFreePart('to', 'date', value)} /><VpTimePicker label="Bis · Uhrzeit" value={freeTo.split('T')[1] ?? ''} onChange={(value) => setFreePart('to', 'time', value)} /></div></div>}
        {(history?.meta.rawAvailable || representation === 'raw') && <div className="vp-measure-range" aria-label="Wertdarstellung"><button type="button" aria-pressed={representation === 'decoded'} className={representation === 'decoded' ? 'is-active' : ''} onClick={() => setRepresentation('decoded')}>Dekodiert</button><button type="button" aria-pressed={representation === 'raw'} className={representation === 'raw' ? 'is-active' : ''} onClick={() => setRepresentation('raw')}>Rohwert</button></div>}
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
