import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EdgeUpdates } from '../../adminEdgeUpdates';

const edgeUpdates = vi.fn();
const listDevices = vi.fn();
const listPendingEnrollments = vi.fn();
const werkstattBoxen = vi.fn();
const provisionDevice = vi.fn();
const componentFleet = vi.fn();
const geraeteListe = vi.fn();

vi.mock('../../admin/adminApi', () => ({
  adminApi: {
    edgeUpdates: (...a: unknown[]) => edgeUpdates(...a),
    listDevices: (...a: unknown[]) => listDevices(...a),
    listPendingEnrollments: (...a: unknown[]) => listPendingEnrollments(...a),
    werkstattBoxen: (...a: unknown[]) => werkstattBoxen(...a),
    provisionDevice: (...a: unknown[]) => provisionDevice(...a),
    componentFleet: (...a: unknown[]) => componentFleet(...a),
    geraeteListe: (...a: unknown[]) => geraeteListe(...a),
  },
}));

const { GeraeteListePage } = await import('./GeraeteListePage');

const emptyEdgeUpdates = (): EdgeUpdates => ({
  releases: [], journal: [], rollouts: [], fleet: [], kpi: null,
} as unknown as EdgeUpdates);

describe('GeraeteListePage (§4.4, Scheibe S2): jede Box in jedem Lebensabschnitt, eine Zeile führt in die Akte', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    edgeUpdates.mockResolvedValue(emptyEdgeUpdates());
    listDevices.mockResolvedValue([]);
    listPendingEnrollments.mockResolvedValue([]);
    werkstattBoxen.mockResolvedValue([]);
    componentFleet.mockResolvedValue([]);
    geraeteListe.mockResolvedValue({ geraete: [] });
  });

  it('zeigt die leere Lage ehrlich, statt eine Tabelle ohne Zeilen zu zeigen', async () => {
    render(<GeraeteListePage onOpen={vi.fn()} />);
    expect(await screen.findByText('Noch kein Gerät')).toBeInTheDocument();
  });

  it('führt eine verbundene Zeile in die Geräteakte, nie in eine zweite Ansicht', async () => {
    edgeUpdates.mockResolvedValue({
      ...emptyEdgeUpdates(),
      fleet: [{
        deviceId: 'd1', label: 'edge-a1', externalRef: 'edge-a1', siteId: 's1', siteName: 'Pilsting',
        tenantId: 't1', tenantName: 'Kunde A', ist: 'edge-2026.08.0', soll: 'edge-2026.08.0', sollSeq: 12,
        state: 'bestaetigt', reason: null, since: null, reportedAt: null, rolloutId: null,
        lastSeenAt: new Date().toISOString(), boxArt: 'docker', linie: 'docker',
      }],
    });
    const onOpen = vi.fn();
    render(<GeraeteListePage onOpen={onOpen} />);
    const row = await screen.findByText('Pilsting');
    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledWith('edge-a1');
  });

  it('„Geräte-ID registrieren" öffnet eine Eingabezeile - kein Fenster (E1 = A)', async () => {
    render(<GeraeteListePage onOpen={vi.fn()} />);
    await screen.findByText('Noch kein Gerät');
    fireEvent.click(screen.getByRole('button', { name: 'Geräte-ID registrieren' }));
    expect(screen.getByTestId('geraete-registrier-zeile')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    provisionDevice.mockResolvedValue(undefined);
    fireEvent.change(screen.getByLabelText('Geräte-ID *'), { target: { value: 'VP-1234-ABCD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrieren' }));
    await waitFor(() => expect(provisionDevice).toHaveBeenCalledWith(expect.objectContaining({ externalRef: 'VP-1234-ABCD' })));
  });

  it('zeigt eine gedruckte, unverbundene ID als eigenen Lebensabschnitt', async () => {
    listDevices.mockResolvedValue([{
      deviceId: null, externalRef: 'VP-0001', label: null, siteId: null, siteName: null, tenantId: null,
      tenantName: null, kind: 'inverter', ist: null, soll: null, sollSeq: null, state: null, reason: null,
      blocker: null, lastSeenAt: null, reportedAt: null, provisioned: true, note: null,
      provisionedAt: new Date().toISOString(),
    }]);
    render(<GeraeteListePage onOpen={vi.fn()} />);
    expect(await screen.findByText('Gedruckt', { exact: false })).toBeInTheDocument();
    expect(screen.getByTestId('geraete-liste')).toHaveTextContent('VP-0001');
  });

  const boxRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
    deviceId: 'd1', label: 'edge-a1', externalRef: 'edge-a1', siteId: 's1', siteName: 'Pilsting',
    tenantId: 't1', tenantName: 'Kunde A', ist: 'edge-2026.08.0', soll: 'edge-2026.08.0', sollSeq: 12,
    state: 'bestaetigt', reason: null, since: null, reportedAt: null, rolloutId: null,
    lastSeenAt: new Date().toISOString(), boxArt: 'docker', linie: 'docker',
    ...overrides,
  });

  /** Scheibe S3: `#/optimizer`/`#/flows` landen hier mit einem Werkzeug - „Box wählen, dann Werkzeug". */
  it('trägt ein Werkzeug aus der Adresse mit und öffnet die Akte direkt im Werkzeug', async () => {
    window.location.hash = '#/plattform/geraete?werkzeug=plan';
    edgeUpdates.mockResolvedValue({ ...emptyEdgeUpdates(), fleet: [boxRow()] });
    const onOpen = vi.fn();
    render(<GeraeteListePage onOpen={onOpen} />);
    expect(await screen.findByTestId('geraete-liste-werkzeug')).toHaveTextContent('Plan erklären (Optimizer)');
    fireEvent.click(await screen.findByText('Pilsting'));
    expect(onOpen).toHaveBeenCalledWith('edge-a1', 'plan');
    window.location.hash = '';
  });

  /** Scheibe S3: `#/komponenten-flotte` landet hier mit `?filter=fassung` - nur Boxen mit abweichender Fassung. */
  it('Chip „Fassung weicht ab" filtert auf Boxen, deren Anlage eine Fassung nicht angewandt hat', async () => {
    window.location.hash = '#/plattform/geraete?filter=fassung';
    edgeUpdates.mockResolvedValue({
      ...emptyEdgeUpdates(),
      fleet: [boxRow(), boxRow({ deviceId: 'd2', externalRef: 'edge-a2', siteId: 's2', siteName: 'Ahrenberg' })],
    });
    componentFleet.mockResolvedValue([
      { siteId: 's1', siteName: 'Pilsting', tenantId: 't1', tenantName: 'Kunde A', componentAuthority: 'portal', componentCount: 2, syncStatus: 'pending', privateTemplates: 0 },
      { siteId: 's2', siteName: 'Ahrenberg', tenantId: 't1', tenantName: 'Kunde A', componentAuthority: 'portal', componentCount: 2, syncStatus: 'in_sync', privateTemplates: 0 },
    ]);
    render(<GeraeteListePage onOpen={vi.fn()} />);
    const liste = await screen.findByTestId('geraete-liste');
    await waitFor(() => expect(liste).toHaveTextContent('Pilsting'));
    expect(liste).not.toHaveTextContent('Ahrenberg');
    window.location.hash = '';
  });

  describe('S7: Live-Feinschliff (§5 des Konzepts)', () => {
    it('zeigt oben die Bezugszeit mit Takt (§5.2)', async () => {
      edgeUpdates.mockResolvedValue({ ...emptyEdgeUpdates(), fleet: [boxRow()] });
      render(<GeraeteListePage onOpen={vi.fn()} />);
      await screen.findByText('Pilsting');
      expect(screen.getByTestId('geraete-liste-stand')).toHaveTextContent('Stand');
      expect(screen.getByTestId('geraete-liste-stand')).toHaveTextContent('alle 30 s');
    });

    it('zeigt eine verzögerte Box als „Verzögert", nicht als „Meldet sich nicht" (E6)', async () => {
      edgeUpdates.mockResolvedValue({ ...emptyEdgeUpdates(), fleet: [boxRow({ lastSeenAt: new Date(Date.now() - 2 * 60_000).toISOString() })] });
      render(<GeraeteListePage onOpen={vi.fn()} />);
      const liste = await screen.findByTestId('geraete-liste');
      expect(liste).toHaveTextContent('Verzögert');
    });

    it('Fehlerzeile bei gescheiterter Abfrage - die Liste bleibt stehen statt sich zu leeren (§5.2)', async () => {
      vi.useFakeTimers();
      try {
        edgeUpdates.mockResolvedValue({ ...emptyEdgeUpdates(), fleet: [boxRow()] });
        render(<GeraeteListePage onOpen={vi.fn()} />);
        await act(async () => { await Promise.resolve(); });
        expect(screen.getByTestId('geraete-liste')).toHaveTextContent('Pilsting');

        edgeUpdates.mockRejectedValue(new Error('netz weg'));
        listDevices.mockRejectedValue(new Error('netz weg'));
        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

        expect(screen.getByTestId('geraete-liste-stand')).toHaveTextContent('Aktualisierung schlägt fehl');
        expect(screen.getByTestId('geraete-liste')).toHaveTextContent('Pilsting');
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
