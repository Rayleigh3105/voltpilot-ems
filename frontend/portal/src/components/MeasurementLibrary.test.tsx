import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api, type MeasurementCatalogPoint, type MeasurementHistory } from '../api';
import { MeasurementLibrary } from './MeasurementLibrary';

const estimate = {
  enabledPointCount: 1, samplesPerMinute: 2, requestsPerMinute: 2, dutyCyclePercent: 1.3,
  softWarning: false, hardRejected: false, reasons: [], rawGbPerYear: 0.11,
  longTermGbPerYear: 0.03, totalGbPerYear: 0.14, retentionSummary: '90 Tage roh',
};
const state = {
  deviceId: 'd', siteId: 's', desiredRevision: 0, catalogVersion: '2026.08.26.1',
  status: 'idle' as const, statusReason: 'Keine Auswahl', activationNotice: 'Start jetzt',
  disableNotice: 'Historie bleibt', selections: [], volumeEstimate: estimate,
};
const point: MeasurementCatalogPoint = {
  family: 'hybrid_3p', pointKey: 'deye.hybrid_3p.pv.pv2-current',
  sourceKind: 'modbus_holding', address: { kind: 'modbus_holding', registers: [678], widthWords: 1 },
  selector: 'holding:0x02a6', widthBits: 16, valueType: 'uint16', signed: false,
  endian: 'word_little_byte_big', scale: { kind: 'factor', value: 0.1 }, unit: 'A',
  group: 'PV', labelDe: 'PV2 Strom', labelSource: 'PV2 Current', semanticStatus: 'vendor_label_only',
  aggregationKind: 'gauge', defaultCadenceS: 30, minCadenceS: 30, longTermCadenceS: 300,
  pollGroup: 'deye:hybrid_3p:pv:30', sourceUrl: 'https://example.invalid/map',
  sourceCommit: 'abc', sourceRevision: null, dynamic: false, recommended: true,
  available: true, availabilityStatus: 'family_configured',
  availabilityReason: 'Für die konfigurierte Anbindungsfamilie vorgesehen; noch nicht gelesen.',
  recorded: false, selected: false, selectedCadenceS: null, lastReadAt: null,
  rawValue: null, decodedValue: null, quality: null, gap: false, droppedSamples: 0,
  estimatedDataPerYearBytes: 67_000_000,
};

describe('MeasurementLibrary', () => {
  beforeEach(() => {
    vi.spyOn(api, 'measurementSelection').mockResolvedValue(state);
    vi.spyOn(api, 'measurementCatalog').mockResolvedValue({
      catalogVersion: '2026.08.26.1', edgeMinVersion: 'unreleased',
      customPointActionLabel: 'Eigenen Messwert hinzufügen', total: 1, offset: 0, limit: 100,
      groups: [{ value: 'PV', count: 1 }], semanticStatuses: [{ value: 'vendor_label_only', count: 1 }],
      points: [point],
    });
    vi.spyOn(api, 'measurementEstimate').mockResolvedValue(estimate);
    vi.spyOn(api, 'changeMeasurementSelection').mockResolvedValue({ ...state, desiredRevision: 1, status: 'pending_edge' });
  });
  afterEach(() => vi.restoreAllMocks());

  it('starts quietly and opens the full technical searchable library without forbidden wording', async () => {
    render(<MeasurementLibrary deviceId="d" />);
    expect(await screen.findByRole('heading', { name: 'Wichtige zusätzliche Messwerte' })).toBeVisible();
    expect(screen.getByText('PV2 Strom')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Messwert-Bibliothek' }));
    expect(await screen.findByLabelText('Messwert suchen')).toHaveAttribute('placeholder', expect.stringContaining('P_Grid'));
    expect(await screen.findByText('1 Punkt gefunden')).toBeVisible();
    expect(screen.getAllByText('Adresse / Schlüssel').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/0x02a6/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Roh / dekodiert').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Nur Herstellerbezeichnung').length).toBeGreaterThan(0);
    expect(document.body).not.toHaveTextContent('Expertenmodus');
  });

  it('uses plural result copy for every count except one', async () => {
    vi.mocked(api.measurementCatalog).mockResolvedValue({
      catalogVersion: '2026.08.26.3', edgeMinVersion: 'unreleased',
      customPointActionLabel: 'Eigenen Messwert hinzufügen', total: 2, offset: 0, limit: 100,
      groups: [{ value: 'PV', count: 2 }], semanticStatuses: [],
      points: [point, { ...point, pointKey: 'point.two', labelDe: 'PV3 Strom' }],
    });
    const { unmount } = render(<MeasurementLibrary deviceId="d" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Messwert-Bibliothek' }));
    expect(await screen.findByText('2 Punkte gefunden')).toBeVisible();
    expect(screen.queryByText('2 Punkt gefunden')).not.toBeInTheDocument();

    unmount();
    vi.mocked(api.measurementCatalog).mockResolvedValue({
      catalogVersion: '2026.08.26.3', edgeMinVersion: 'unreleased',
      customPointActionLabel: 'Eigenen Messwert hinzufügen', total: 0, offset: 0, limit: 100,
      groups: [], semanticStatuses: [], points: [],
    });
    render(<MeasurementLibrary deviceId="d" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Messwert-Bibliothek' }));
    expect(await screen.findByText('0 Punkte gefunden')).toBeVisible();
  });

  it('swaps the library for history and Escape returns to exactly one modal', async () => {
    const recorded = { ...point, recorded: true, lastReadAt: '2026-08-26T00:00:00Z' };
    vi.mocked(api.measurementCatalog).mockResolvedValue({
      catalogVersion: '2026.08.26.3', edgeMinVersion: 'unreleased',
      customPointActionLabel: 'Eigenen Messwert hinzufügen', total: 1, offset: 0, limit: 100,
      groups: [], semanticStatuses: [], points: [recorded],
    });
    vi.spyOn(api, 'measurementHistory').mockResolvedValue({
      meta: { pointKey: recorded.pointKey, label: 'PV2 Strom', sourceLabel: 'PV2 Current',
        unit: 'A', aggregationKind: 'gauge', semanticStatus: 'known',
        catalogVersion: '2026.08.26.3', representation: 'decoded', rawAvailable: true,
        from: '2026-08-25T00:00:00Z', to: '2026-08-26T00:00:00Z', bucketSeconds: 300,
        aggregationExplanation: 'Mittelwert', siteId: 's' }, data: [], markers: [],
    });

    render(<MeasurementLibrary deviceId="d" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Messwert-Bibliothek' }));
    const library = await screen.findByRole('dialog', { name: 'Messwert-Bibliothek' });
    fireEvent.click(await within(library).findByRole('button', { name: 'Verlauf ansehen' }));
    const history = await screen.findByRole('dialog', { name: 'Verlauf · PV2 Strom' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).toHaveLength(1);
    expect(screen.queryByLabelText('Messwert suchen')).not.toBeInTheDocument();
    expect(history).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(await screen.findByRole('dialog', { name: 'Messwert-Bibliothek' })).toBeVisible();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.queryByRole('dialog', { name: 'Verlauf · PV2 Strom' })).not.toBeInTheDocument();
  });

  it('shows cadence, load, volume and no-backfill before activation', async () => {
    render(<MeasurementLibrary deviceId="d" />);
    const toggle = await screen.findByRole('checkbox', { name: 'PV2 Strom aufzeichnen' });
    fireEvent.click(toggle);
    expect(await screen.findByText('Die Aufzeichnung startet jetzt. Frühere Werte werden nicht rückwirkend nachgeladen.')).toBeVisible();
    await waitFor(() => expect(screen.getByText(/2 Samples\/min/)).toBeVisible());
    expect(screen.getByText(/0.140 GB\/Jahr/)).toBeVisible();
    expect(screen.getByText('Statusfolge: angefordert → auf der Box angewendet → erster Wert.')).toBeVisible();
  });

  it('keeps a free register visible and manageable with its technical definition', async () => {
    vi.mocked(api.measurementSelection).mockResolvedValue({
      ...state,
      selections: [{
        pointKey: 'custom.abc', enabled: false, cadenceS: 60, applyStatus: 'applied',
        applyReason: null, enabledAt: '2026-08-25T00:00:00Z', disabledAt: '2026-08-26T00:00:00Z',
        label: 'Schaltschranktemperatur', family: '', group: 'Eigene Messwerte',
        semanticStatus: 'unknown',
        customDefinition: {
          label: 'Schaltschranktemperatur', sourceKind: 'modbus_input', address: 512,
          selector: 'input:0x0200', valueType: 'int16', widthBits: 16, signed: true,
          endian: 'big', scale: 0.1, unit: '°C', cadenceS: 60, retentionClass: 'gauge',
          readOnly: true, requestCostMs: 35,
        },
      }],
    });
    render(<MeasurementLibrary deviceId="d" />);
    expect(await screen.findByText('Schaltschranktemperatur')).toBeVisible();
    expect(screen.getByText('Eigenes Register · Eigene Messwerte')).toBeVisible();
    expect(screen.getByText('0x0200')).toBeVisible();
    expect(screen.getByText('Historie vorhanden')).toBeVisible();
  });

  it('resets raw representation for the next point and always offers decoded recovery', async () => {
    const a = { ...point, pointKey: 'point.a', recorded: true, lastReadAt: '2026-08-26T00:00:00Z' };
    const b = { ...point, pointKey: 'point.b', labelDe: 'PV3 Strom', recorded: true,
      lastReadAt: '2026-08-26T00:00:00Z' };
    vi.mocked(api.measurementCatalog).mockResolvedValue({
      catalogVersion: '2026.08.26.1', edgeMinVersion: 'unreleased',
      customPointActionLabel: 'Eigenen Messwert hinzufügen', total: 2, offset: 0, limit: 100,
      groups: [{ value: 'PV', count: 2 }], semanticStatuses: [], points: [a, b],
    });
    const makeHistory = (pointKey: string, representation: 'raw' | 'decoded'): MeasurementHistory => ({
      meta: { pointKey, label: pointKey, sourceLabel: pointKey, unit: 'A', aggregationKind: 'gauge',
        semanticStatus: 'known', catalogVersion: '2026.08.26.1', representation,
        rawAvailable: pointKey === 'point.a', from: '2026-08-25T00:00:00Z',
        to: '2026-08-26T00:00:00Z', bucketSeconds: 300, aggregationExplanation: 'Mittelwert', siteId: 's' },
      data: [], markers: [],
    });
    vi.spyOn(api, 'measurementHistory').mockImplementation(async (_device, pointKey, _range, representation) => {
      if (pointKey === 'point.b' && representation === 'raw') throw new Error('Keine Rohdaten');
      return makeHistory(pointKey, representation);
    });

    render(<MeasurementLibrary deviceId="d" />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Verlauf ansehen' }))[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Rohwert' }));
    await waitFor(() => expect(api.measurementHistory).toHaveBeenCalledWith(
      'd', 'point.a', '24h', 'raw', undefined, undefined,
      undefined, undefined,
    ));
    fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Verlauf ansehen' })[1]);
    await waitFor(() => expect(api.measurementHistory).toHaveBeenCalledWith(
      'd', 'point.b', '24h', 'decoded', undefined, undefined,
      undefined, undefined,
    ));
    expect(screen.queryByText('Keine Rohdaten')).not.toBeInTheDocument();
  });

  it('offers a decoded recovery action when a raw window is rejected', async () => {
    const recorded = { ...point, recorded: true, lastReadAt: '2026-08-26T00:00:00Z' };
    vi.mocked(api.measurementCatalog).mockResolvedValue({
      catalogVersion: '2026.08.26.1', edgeMinVersion: 'unreleased',
      customPointActionLabel: 'Eigenen Messwert hinzufügen', total: 1, offset: 0, limit: 100,
      groups: [], semanticStatuses: [], points: [recorded],
    });
    vi.spyOn(api, 'measurementHistory').mockImplementation(async (_device, pointKey, _range, representation) => {
      if (representation === 'raw') throw new Error('Für diesen Zeitraum sind keine echten Rohdaten vorhanden.');
      return { meta: { pointKey, label: pointKey, sourceLabel: pointKey, unit: 'A', aggregationKind: 'gauge',
        semanticStatus: 'known', catalogVersion: '2026.08.26.1', representation: 'decoded',
        rawAvailable: true, from: '2026-08-25T00:00:00Z', to: '2026-08-26T00:00:00Z',
        bucketSeconds: 300, aggregationExplanation: 'Mittelwert', siteId: 's' }, data: [], markers: [] };
    });
    render(<MeasurementLibrary deviceId="d" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Verlauf ansehen' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Rohwert' }));
    expect(await screen.findByRole('button', { name: 'Dekodierte Werte laden' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Dekodierte Werte laden' }));
    await waitFor(() => expect(api.measurementHistory).toHaveBeenLastCalledWith(
      'd', recorded.pointKey, '24h', 'decoded', undefined, undefined,
      undefined, undefined,
    ));
  });

  it('announces the selected period and representation as pressed controls', async () => {
    const recorded = { ...point, recorded: true, lastReadAt: '2026-08-26T00:00:00Z' };
    vi.mocked(api.measurementCatalog).mockResolvedValue({
      catalogVersion: '2026.08.26.3', edgeMinVersion: 'unreleased',
      customPointActionLabel: 'Eigenen Messwert hinzufügen', total: 1, offset: 0, limit: 100,
      groups: [], semanticStatuses: [], points: [recorded],
    });
    vi.spyOn(api, 'measurementHistory').mockImplementation(async (_device, pointKey, range,
      representation) => ({
      meta: { pointKey, label: pointKey, sourceLabel: pointKey, unit: 'A',
        aggregationKind: 'gauge', semanticStatus: 'known', catalogVersion: '2026.08.26.3',
        representation, rawAvailable: true, from: '2026-08-25T00:00:00Z',
        to: '2026-08-26T00:00:00Z', bucketSeconds: range === '7d' ? 3600 : 300,
        aggregationExplanation: 'Mittelwert', siteId: 's' }, data: [], markers: [],
    }));

    render(<MeasurementLibrary deviceId="d" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Verlauf ansehen' }));
    const day = await screen.findByRole('button', { name: '24 h' });
    const week = screen.getByRole('button', { name: '7 Tage' });
    expect(day).toHaveAttribute('aria-pressed', 'true');
    expect(week).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(week);
    await waitFor(() => expect(week).toHaveAttribute('aria-pressed', 'true'));
    expect(day).toHaveAttribute('aria-pressed', 'false');
    const decoded = screen.getByRole('button', { name: 'Dekodiert' });
    const raw = screen.getByRole('button', { name: 'Rohwert' });
    expect(decoded).toHaveAttribute('aria-pressed', 'true');
    expect(raw).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(raw);
    await waitFor(() => expect(raw).toHaveAttribute('aria-pressed', 'true'));
    expect(decoded).toHaveAttribute('aria-pressed', 'false');
  });
});
