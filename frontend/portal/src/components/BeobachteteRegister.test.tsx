import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api, type MeasurementCatalogPoint, type MeasurementSelectionState } from '../api';
import { BeobachteteRegister } from './BeobachteteRegister';

const estimate = {
  enabledPointCount: 1, samplesPerMinute: 2, requestsPerMinute: 2, dutyCyclePercent: 1.3,
  softWarning: false, hardRejected: false, reasons: [], rawGbPerYear: 0.11,
  longTermGbPerYear: 0.03, totalGbPerYear: 0.14, retentionSummary: '90 Tage roh',
};
const state: MeasurementSelectionState = {
  deviceId: 'd', siteId: 's', desiredRevision: 0, catalogVersion: '2026.08.26.1',
  status: 'idle', statusReason: 'Keine Auswahl', activationNotice: 'Start jetzt',
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

/** Eine EINGESCHALTETE Auswahl - erst sie ist eine Beobachtung. */
const beobachtet = {
  pointKey: point.pointKey, enabled: true, cadenceS: 30, applyStatus: 'applied',
  applyReason: null, enabledAt: '2026-08-26T00:00:00Z', disabledAt: null,
  label: 'PV2 Strom', family: 'hybrid_3p', group: 'PV', semanticStatus: 'vendor_label_only',
  customDefinition: null,
};

const katalog = (points: MeasurementCatalogPoint[], total = points.length) => ({
  catalogVersion: '2026.08.26.1', edgeMinVersion: 'unreleased',
  customPointActionLabel: 'Eigenen Messwert hinzufügen' as const,
  total, offset: 0, limit: 100,
  groups: [{ value: 'PV', count: points.length }], semanticStatuses: [],
  points,
});

describe('BeobachteteRegister · die Liste (Teil 1)', () => {
  beforeEach(() => {
    vi.spyOn(api, 'measurementSelection').mockResolvedValue(state);
    vi.spyOn(api, 'measurementCatalog').mockResolvedValue(katalog([point]));
    vi.spyOn(api, 'measurementEstimate').mockResolvedValue(estimate);
    vi.spyOn(api, 'changeMeasurementSelection').mockResolvedValue({ ...state, desiredRevision: 1, status: 'pending_edge' });
  });
  afterEach(() => vi.restoreAllMocks());

  it('führt mit den BEOBACHTUNGEN, nicht mit einer Katalog-Vorauswahl', async () => {
    const gelesen = { ...point, decodedValue: '4,2', lastReadAt: new Date().toISOString(), recorded: true };
    vi.mocked(api.measurementSelection).mockResolvedValue({ ...state, selections: [beobachtet] } as never);
    vi.mocked(api.measurementCatalog).mockResolvedValue(katalog([gelesen]));

    render(<BeobachteteRegister deviceId="d" familien={['hybrid_3p']} geraetName="Deye SUN-30K" />);
    expect(await screen.findByRole('heading', { name: 'Beobachtete Register' })).toBeVisible();
    const zeile = await screen.findByTestId(`beob-${point.pointKey}`);
    expect(within(zeile).getByText('PV2 Strom')).toBeVisible();
    expect(within(zeile).getByText('0x02a6')).toBeVisible();
    expect(within(zeile).getByText('4,2 A')).toBeVisible();
    expect(within(zeile).getByText('beobachtet')).toBeVisible();
    // Die Frische steht an der Zeile - ein soeben gelesener Wert sagt „gerade eben".
    expect(within(zeile).getByText(/^(vor |gerade eben$)/)).toBeVisible();
    // Die frühere „Wichtige zusätzliche Messwerte"-Vorauswahl gibt es nicht mehr:
    // sie beantwortete die umgekehrte Frage.
    expect(screen.queryByText('Wichtige zusätzliche Messwerte')).toBeNull();
  });

  it('sagt im leeren Zustand, wie man ihn füllt - und behauptet nichts', async () => {
    render(<BeobachteteRegister deviceId="d" familien={['hybrid_3p']} />);
    expect(await screen.findByText(/Noch kein Register beobachtet/)).toBeVisible();
    expect(document.body).not.toHaveTextContent('beobachtet ·');
  });

  it('spricht auf einem HTTP-Gerät von MESSWERTEN, nie von Registern', async () => {
    render(<BeobachteteRegister deviceId="d" familien={['goe.api_v2']} registerFaehig={false} geraetName="go-e Charger" />);
    expect(await screen.findByRole('heading', { name: 'Beobachtete Messwerte' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Messwert beobachten/ }));
    expect(await screen.findByRole('dialog', { name: 'Messwerte des go-e Charger' })).toBeVisible();
    // Ohne Modbus gibt es kein eigenes Register - das Formular könnte es nicht lesen.
    expect(screen.queryByRole('button', { name: 'Eigenes Register' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Eigenen Messwert hinzufügen' })).toBeNull();
  });

  it('meldet die Kurzfassung nach oben, statt sie zweimal abzuleiten', async () => {
    const gelesen = { ...point, decodedValue: '4,2', lastReadAt: new Date().toISOString(), recorded: true };
    vi.mocked(api.measurementSelection).mockResolvedValue({ ...state, selections: [beobachtet] } as never);
    vi.mocked(api.measurementCatalog).mockResolvedValue(katalog([gelesen]));
    const gemeldet: (string | null)[] = [];
    render(<BeobachteteRegister deviceId="d" familien={['hybrid_3p']} onKurzfassung={(t) => gemeldet.push(t)} />);
    await waitFor(() => expect(gemeldet.at(-1)).toMatch(/1 beobachtet/));
    expect(gemeldet.at(-1)).toContain('PV2 Strom 4,2 A');
  });

  it('„Nicht mehr beobachten" fragt VORHER und nennt die Folgen', async () => {
    vi.mocked(api.measurementSelection).mockResolvedValue({ ...state, selections: [beobachtet] } as never);
    render(<BeobachteteRegister deviceId="d" familien={['hybrid_3p']} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Nicht mehr beobachten' }));
    expect(await screen.findByText('Die vorhandene Historie und ihre Export-Metadaten bleiben erhalten.')).toBeVisible();
    expect(api.changeMeasurementSelection).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Aufzeichnung beenden' }));
    await waitFor(() => expect(api.changeMeasurementSelection).toHaveBeenCalledWith(
      'd', point.pointKey, expect.objectContaining({ enabled: false }), undefined,
    ));
  });

  it('bietet „Verlauf" nur an, wo es einen gibt', async () => {
    vi.mocked(api.measurementSelection).mockResolvedValue({ ...state, selections: [beobachtet] } as never);
    render(<BeobachteteRegister deviceId="d" familien={['hybrid_3p']} />);
    expect(await screen.findByRole('button', { name: 'Verlauf' })).toBeDisabled();
  });
});

describe('BeobachteteRegister · der Katalog-Einschub (Teil 2)', () => {
  beforeEach(() => {
    vi.spyOn(api, 'measurementSelection').mockResolvedValue(state);
    vi.spyOn(api, 'measurementCatalog').mockResolvedValue(katalog([point]));
    vi.spyOn(api, 'measurementEstimate').mockResolvedValue(estimate);
    vi.spyOn(api, 'changeMeasurementSelection').mockResolvedValue({ ...state, desiredRevision: 1, status: 'pending_edge' });
  });
  afterEach(() => vi.restoreAllMocks());

  it('nennt das GERÄT im Titel und bleibt technisch durchsuchbar', async () => {
    render(<BeobachteteRegister deviceId="d" familien={['hybrid_3p']} geraetName="Deye SUN-30K" />);
    fireEvent.click(await screen.findByRole('button', { name: /Register beobachten/ }));
    expect(await screen.findByRole('dialog', { name: 'Register des Deye SUN-30K' })).toBeVisible();
    expect(await screen.findByLabelText('Messwert suchen')).toHaveAttribute('placeholder', expect.stringContaining('P_Grid'));
    expect(await screen.findByText('1 Punkt gefunden')).toBeVisible();
    expect(screen.getAllByText('Adresse / Schlüssel').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/0x02a6/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Roh / dekodiert').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Nur Herstellerbezeichnung').length).toBeGreaterThan(0);
    expect(document.body).not.toHaveTextContent('Expertenmodus');
  });

  it('behält beim Tippen den Fokus und gibt den Seiten-Scroll nach einer Rückfrage frei', async () => {
    render(<BeobachteteRegister deviceId="d" familien={['hybrid_3p']} />);
    fireEvent.click(await screen.findByRole('button', { name: /Register beobachten/ }));

    const suche = await screen.findByLabelText('Messwert suchen');
    act(() => suche.focus());
    fireEvent.change(suche, { target: { value: 'P' } });
    expect(suche).toHaveFocus();
    fireEvent.change(suche, { target: { value: 'PV' } });
    expect(suche).toHaveFocus();
    expect(suche).toHaveValue('PV');

    fireEvent.click(await screen.findByRole('checkbox', { name: 'PV2 Strom aufzeichnen' }));
    const confirm = await screen.findByRole('dialog', { name: 'Messwert aufzeichnen' });
    await within(confirm).findByText(/2 Samples\/min/);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(confirm).not.toBeInTheDocument();

    const library = screen.getByRole('dialog', { name: 'Register beobachten' });
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.click(within(library).getByRole('button', { name: 'Schließen' }));
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('uses plural result copy for every count except one', async () => {
    vi.mocked(api.measurementCatalog).mockResolvedValue(
      katalog([point, { ...point, pointKey: 'point.two', labelDe: 'PV3 Strom' }], 2),
    );
    const { unmount } = render(<BeobachteteRegister deviceId="d" familien={['hybrid_3p']} />);
    fireEvent.click(await screen.findByRole('button', { name: /Register beobachten/ }));
    expect(await screen.findByText('2 Punkte gefunden')).toBeVisible();
    expect(screen.queryByText('2 Punkt gefunden')).not.toBeInTheDocument();

    unmount();
    vi.mocked(api.measurementCatalog).mockResolvedValue(katalog([], 0));
    render(<BeobachteteRegister deviceId="d" familien={['hybrid_3p']} />);
    fireEvent.click(await screen.findByRole('button', { name: /Register beobachten/ }));
    expect(await screen.findByText('0 Punkte gefunden')).toBeVisible();
  });

  it('tauscht den Einschub gegen den Verlauf und Escape bringt genau EINEN zurück', async () => {
    const recorded = { ...point, recorded: true, lastReadAt: '2026-08-26T00:00:00Z' };
    vi.mocked(api.measurementCatalog).mockResolvedValue(katalog([recorded]));
    vi.spyOn(api, 'measurementHistory').mockResolvedValue({
      meta: { pointKey: recorded.pointKey, label: 'PV2 Strom', sourceLabel: 'PV2 Current',
        unit: 'A', aggregationKind: 'gauge', semanticStatus: 'known',
        catalogVersion: '2026.08.26.3', representation: 'decoded', rawAvailable: true,
        from: '2026-08-25T00:00:00Z', to: '2026-08-26T00:00:00Z', bucketSeconds: 300,
        aggregationExplanation: 'Mittelwert', siteId: 's' }, data: [], markers: [],
    });

    render(<BeobachteteRegister deviceId="d" familien={['hybrid_3p']} geraetName="Deye SUN-30K" />);
    fireEvent.click(await screen.findByRole('button', { name: /Register beobachten/ }));
    const library = await screen.findByRole('dialog', { name: 'Register des Deye SUN-30K' });
    fireEvent.click(await within(library).findByRole('button', { name: 'Verlauf ansehen' }));
    const history = await screen.findByRole('dialog', { name: 'Verlauf · PV2 Strom' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).toHaveLength(1);
    expect(screen.queryByLabelText('Messwert suchen')).not.toBeInTheDocument();
    expect(history).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(await screen.findByRole('dialog', { name: 'Register des Deye SUN-30K' })).toBeVisible();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.queryByRole('dialog', { name: 'Verlauf · PV2 Strom' })).not.toBeInTheDocument();
  });

  it('zeigt Kadenz, Last, Volumen und „kein Backfill" VOR dem Einschalten', async () => {
    render(<BeobachteteRegister deviceId="d" familien={['hybrid_3p']} />);
    fireEvent.click(await screen.findByRole('button', { name: /Register beobachten/ }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'PV2 Strom aufzeichnen' }));
    expect(await screen.findByText('Die Aufzeichnung startet jetzt. Frühere Werte werden nicht rückwirkend nachgeladen.')).toBeVisible();
    await waitFor(() => expect(screen.getByText(/2 Samples\/min/)).toBeVisible());
    expect(screen.getByText(/0.140 GB\/Jahr/)).toBeVisible();
    expect(screen.getByText('Statusfolge: angefordert → auf der Box angewendet → erster Wert.')).toBeVisible();
  });

  it('hält ein eigenes Register sichtbar und verwaltbar', async () => {
    vi.mocked(api.measurementSelection).mockResolvedValue({
      ...state,
      selections: [{
        pointKey: 'custom.1', enabled: true, cadenceS: 30, applyStatus: 'applied',
        applyReason: null, enabledAt: '2026-08-26T00:00:00Z', disabledAt: null,
        label: 'Kessel Vorlauf', family: null as unknown as string, group: 'Eigene Messwerte',
        semanticStatus: 'unknown',
        customDefinition: {
          label: 'Kessel Vorlauf', sourceKind: 'modbus_holding', address: 42,
          selector: 'holding:0x002a', valueType: 'uint16', widthBits: 16, signed: false,
          endian: 'big', scale: 1, unit: 'C', cadenceS: 30, retentionClass: 'gauge',
          readOnly: true, requestCostMs: 2000,
        },
      }],
    } as never);
    render(<BeobachteteRegister deviceId="d" familien={['hybrid_3p']} eigeneErlaubt />);
    expect(await screen.findByText('Kessel Vorlauf')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Register beobachten/ }));
    // Die Adresse steht in BEIDEN Lesehöhen gleich - Zeile und Einschub
    // gehen durch dieselbe `adresse()`.
    expect((await screen.findAllByText('0x002a')).length).toBeGreaterThan(1);
    expect(screen.getAllByText('Eigenes Register').length).toBeGreaterThan(0);
  });

  it('setzt die Rohdarstellung je Punkt zurück und bietet immer den Rückweg', async () => {
    const first = { ...point, recorded: true, lastReadAt: '2026-08-26T00:00:00Z' };
    const second = { ...first, pointKey: 'point.two', labelDe: 'PV3 Strom' };
    vi.mocked(api.measurementCatalog).mockResolvedValue(katalog([first, second], 2));
    const meta = (label: string) => ({
      pointKey: 'x', label, sourceLabel: null, unit: 'A', aggregationKind: 'gauge',
      semanticStatus: 'known', catalogVersion: '1', representation: 'decoded' as const,
      rawAvailable: true, from: 'a', to: 'b', bucketSeconds: 60,
      aggregationExplanation: 'Mittel', siteId: 's',
    });
    vi.spyOn(api, 'measurementHistory').mockImplementation((_d, _p, _r, representation) =>
      Promise.resolve({
        meta: { ...meta('PV'), representation },
        // Leere Reihe: der Umschalter steht VOR dem Datenzweig, und ein
        // gerendertes Diagramm stürzt in jsdom ab (zrender ohne Canvas).
        data: [], markers: [],
      }));

    render(<BeobachteteRegister deviceId="d" familien={['hybrid_3p']} />);
    fireEvent.click(await screen.findByRole('button', { name: /Register beobachten/ }));
    const [ersterVerlauf] = await screen.findAllByRole('button', { name: 'Verlauf ansehen' });
    fireEvent.click(ersterVerlauf);
    fireEvent.click(await screen.findByRole('button', { name: 'Rohwert' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rohwert' })).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.keyDown(document, { key: 'Escape' });

    const [, zweiterVerlauf] = await screen.findAllByRole('button', { name: 'Verlauf ansehen' });
    fireEvent.click(zweiterVerlauf);
    // Der nächste Punkt beginnt DEKODIERT - eine geerbte Rohdarstellung wäre
    // eine Aussage über einen Punkt, den niemand danach gefragt hat.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Dekodiert' })).toHaveAttribute('aria-pressed', 'true'));
  });

  it('bietet nach einem abgelehnten Roh-Fenster die dekodierte Rückkehr an', async () => {
    const recorded = { ...point, recorded: true, lastReadAt: '2026-08-26T00:00:00Z' };
    vi.mocked(api.measurementCatalog).mockResolvedValue(katalog([recorded]));
    vi.spyOn(api, 'measurementHistory').mockImplementation((_d, _p, _r, representation) =>
      representation === 'raw'
        ? Promise.reject(new Error('Rohwerte liegen für diesen Zeitraum nicht vor.'))
        : Promise.resolve({
          meta: { pointKey: 'x', label: 'PV2 Strom', sourceLabel: null, unit: 'A',
            aggregationKind: 'gauge', semanticStatus: 'known', catalogVersion: '1',
            representation: 'decoded', rawAvailable: true, from: 'a', to: 'b',
            bucketSeconds: 60, aggregationExplanation: 'Mittel', siteId: 's' },
          data: [], markers: [],
        }));

    render(<BeobachteteRegister deviceId="d" familien={['hybrid_3p']} />);
    fireEvent.click(await screen.findByRole('button', { name: /Register beobachten/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Verlauf ansehen' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Rohwert' }));
    expect(await screen.findByText('Rohwerte liegen für diesen Zeitraum nicht vor.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Dekodierte Werte laden' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Dekodiert' })).toHaveAttribute('aria-pressed', 'true'));
  });
});

/**
 * Geraeteseiten Stufe 0/3a: `familien` schneidet den Katalog auf das Geraet,
 * `entityId` die AUSWAHL auf die Komponente dieser Seite (Stufe 3b). Fehlt das
 * eine, bleibt es bei der Box-Semantik - Zeichen fuer Zeichen.
 */
describe('BeobachteteRegister · der Geraete- und Komponenten-Schnitt', () => {
  beforeEach(() => {
    vi.spyOn(api, 'measurementSelection').mockResolvedValue(state);
    vi.spyOn(api, 'measurementCatalog').mockResolvedValue(katalog([point]));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sendet die Familien und fragt die Box nicht mehr nach ihrer Vereinigung', async () => {
    render(<BeobachteteRegister deviceId="d" familien={['goe.api_v2']} />);
    await waitFor(() => expect(api.measurementCatalog).toHaveBeenCalled());
    const statusParams = vi.mocked(api.measurementCatalog).mock.calls[0][1];
    expect(statusParams.get('selectedOnly')).toBe('true');
    expect(statusParams.getAll('family')).toEqual([]);
    fireEvent.click(await screen.findByRole('button', { name: /beobachten/ }));
    await waitFor(() => expect(vi.mocked(api.measurementCatalog).mock.calls.length)
      .toBeGreaterThan(1));
    const bibliothekParams = vi.mocked(api.measurementCatalog).mock.calls
      .map((call) => call[1])
      .find((params) => params.get('selectedOnly') == null)!;
    expect(bibliothekParams.getAll('family')).toEqual(['goe.api_v2']);
    expect(bibliothekParams.get('availableOnly')).toBeNull();
    expect(screen.queryByText('Verfügbarkeit')).toBeNull();
  });

  it('traegt die KOMPONENTE in jeden Aufruf - Auswahl, Katalog, Vorschau, Verlauf', async () => {
    vi.mocked(api.measurementSelection).mockResolvedValue({ ...state, selections: [beobachtet] } as never);
    vi.mocked(api.measurementCatalog).mockResolvedValue(
      katalog([{ ...point, recorded: true, lastReadAt: '2026-08-26T00:00:00Z' }]),
    );
    vi.spyOn(api, 'measurementEstimate').mockResolvedValue(estimate);
    vi.spyOn(api, 'measurementHistory').mockResolvedValue({
      meta: { pointKey: 'x', label: 'PV2 Strom', sourceLabel: null, unit: 'A',
        aggregationKind: 'gauge', semanticStatus: 'known', catalogVersion: '1',
        representation: 'decoded', rawAvailable: false, from: 'a', to: 'b',
        bucketSeconds: 60, aggregationExplanation: 'Mittel', siteId: 's' },
      data: [], markers: [],
    });

    render(<BeobachteteRegister deviceId="d" siteId="s" entityId="ent-1" familien={['hybrid_3p']} />);
    await waitFor(() => expect(api.measurementSelection).toHaveBeenCalledWith('d', 'ent-1'));
    expect(vi.mocked(api.measurementCatalog).mock.calls[0][1].get('entityId')).toBe('ent-1');
    // Der Mini-Verlauf haengt an derselben Komponente.
    await waitFor(() => expect(api.measurementHistory).toHaveBeenCalledWith(
      'd', point.pointKey, '24h', 'decoded', undefined, undefined, 's', 'ent-1',
    ));
    fireEvent.click(await screen.findByRole('button', { name: 'Nicht mehr beobachten' }));
    await waitFor(() => expect(api.measurementEstimate).toHaveBeenCalledWith(
      'd', point.pointKey, expect.any(Number), false, 'ent-1',
    ));
  });

  it('fragt ohne Komponente kompakt nach den ausgewaehlten Punkten der Box', async () => {
    render(<BeobachteteRegister deviceId="d" />);
    await waitFor(() => expect(api.measurementCatalog).toHaveBeenCalled());
    expect(api.measurementSelection).toHaveBeenCalledWith('d', undefined);
    const params = vi.mocked(api.measurementCatalog).mock.calls[0][1];
    expect(params.getAll('family')).toEqual([]);
    expect(params.get('entityId')).toBeNull();
    expect(params.get('selectedOnly')).toBe('true');
  });

  it('holt den ersten Wert nach, ohne dass die Seite neu geladen werden muss', async () => {
    vi.useFakeTimers();
    const gelesen = { ...point, decodedValue: '4,2', lastReadAt: new Date().toISOString(), recorded: true };
    vi.mocked(api.measurementSelection).mockResolvedValue({ ...state, selections: [beobachtet] } as never);
    vi.mocked(api.measurementCatalog)
      .mockResolvedValueOnce(katalog([point]))
      .mockResolvedValue(katalog([gelesen]));

    const { unmount } = render(
      <BeobachteteRegister deviceId="d" familien={['hybrid_3p']} />,
    );
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId(`beob-${point.pointKey}`)).toHaveTextContent('—');

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.getByTestId(`beob-${point.pointKey}`)).toHaveTextContent('4,2 A');
    expect(api.measurementSelection).toHaveBeenCalledTimes(2);
    expect(api.measurementCatalog).toHaveBeenCalledTimes(2);
    unmount();
    vi.useRealTimers();
  });

  it('entsteht ohne Katalog-Familie gar nicht und fragt dann auch nichts ab', async () => {
    const { container } = render(<BeobachteteRegister deviceId="d" familien={[]} />);
    await waitFor(() => expect(container.innerHTML).toBe(''));
    expect(api.measurementCatalog).not.toHaveBeenCalled();
    expect(api.measurementSelection).not.toHaveBeenCalled();
  });

  it('spricht im Fehlerfall ueber das GERAET, nicht ueber die Box', async () => {
    vi.mocked(api.measurementSelection).mockRejectedValue(new Error('down'));
    render(<BeobachteteRegister deviceId="d" familien={['hybrid_3p']} />);
    expect(await screen.findByText(/Für dieses Gerät konnte die Messwert-Bibliothek nicht geladen werden/))
      .toBeVisible();
    expect(document.body).not.toHaveTextContent('Diese VoltPilot-Box');
  });

  it('nennt die Stufe-3c-Grenze und behauptet dann keine Beobachtung', async () => {
    vi.mocked(api.measurementSelection).mockResolvedValue({ ...state, selections: [beobachtet] } as never);
    const { unmount } = render(<BeobachteteRegister deviceId="d" familien={['hybrid_3p']} lesbar={false} />);
    expect(await screen.findByTestId('measure-beobachten-hinweis')).toHaveTextContent(
      /primären Wechselrichter/);
    expect(await screen.findByText('wartet auf die Box')).toBeVisible();
    unmount();

    render(<BeobachteteRegister deviceId="d" familien={['hybrid_3p']} />);
    await screen.findByRole('heading', { name: 'Beobachtete Register' });
    expect(screen.queryByTestId('measure-beobachten-hinweis')).toBeNull();
  });
});

describe('BeobachteteRegister · die Bruecke aus einer Lesung', () => {
  beforeEach(() => {
    vi.spyOn(api, 'measurementSelection').mockResolvedValue(state);
    vi.spyOn(api, 'measurementCatalog').mockResolvedValue(katalog([point]));
    vi.spyOn(api, 'customMeasurementEstimate').mockResolvedValue(estimate);
  });
  afterEach(() => vi.restoreAllMocks());

  it('oeffnet das Formular VORBEFUELLT und speichert erst mit dem Klick', async () => {
    const verbraucht = vi.fn();
    render(
      <BeobachteteRegister
        deviceId="d"
        familien={['hybrid_3p']}
        bruecke={{ label: 'Einspeisegrenze', address: '231', sourceKind: 'modbus_holding', unit: 'kW', scale: '0.01' }}
        onBrueckeVerbraucht={verbraucht}
      />,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Eigenen Messwert hinzufügen' });
    expect(within(dialog).getByLabelText('Bezeichnung')).toHaveValue('Einspeisegrenze');
    expect(within(dialog).getByLabelText('Registeradresse (dezimal)')).toHaveValue(231);
    expect(within(dialog).getByLabelText('Einheit')).toHaveValue('kW');
    expect(within(dialog).getByLabelText('Skala')).toHaveValue(0.01);
    expect(verbraucht).toHaveBeenCalled();
    // Bis hierher ist NICHTS angelegt - erst „Jetzt aufzeichnen" schreibt.
    expect(api.customMeasurementEstimate).not.toHaveBeenCalled();
  });
});
