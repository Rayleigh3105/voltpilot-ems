import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EdgeUpdates } from '../../adminEdgeUpdates';

const edgeUpdates = vi.fn();
const listDevices = vi.fn();
const listPendingEnrollments = vi.fn();
const werkstattBoxen = vi.fn();
const provisionDevice = vi.fn();
const componentFleet = vi.fn();
const geraeteListe = vi.fn();
const deleteProvisionedDevice = vi.fn();
const deletePendingEnrollment = vi.fn();
const werkstattBoxLoeschen = vi.fn();

vi.mock('../../admin/adminApi', () => ({
  adminApi: {
    edgeUpdates: (...a: unknown[]) => edgeUpdates(...a),
    listDevices: (...a: unknown[]) => listDevices(...a),
    listPendingEnrollments: (...a: unknown[]) => listPendingEnrollments(...a),
    werkstattBoxen: (...a: unknown[]) => werkstattBoxen(...a),
    provisionDevice: (...a: unknown[]) => provisionDevice(...a),
    componentFleet: (...a: unknown[]) => componentFleet(...a),
    geraeteListe: (...a: unknown[]) => geraeteListe(...a),
    deleteProvisionedDevice: (...a: unknown[]) => deleteProvisionedDevice(...a),
    deletePendingEnrollment: (...a: unknown[]) => deletePendingEnrollment(...a),
    werkstattBoxLoeschen: (...a: unknown[]) => werkstattBoxLoeschen(...a),
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

  it('bietet keinen Registrieren-Einstieg mehr an - die Werkstatt registriert Boxen selbst', async () => {
    render(<GeraeteListePage onOpen={vi.fn()} />);
    await screen.findByText('Noch kein Gerät');
    expect(screen.queryByRole('button', { name: 'Geräte-ID registrieren' })).toBeNull();
  });

  it('zeigt eine gedruckte, unverbundene ID als eigenen Lebensabschnitt', async () => {
    listDevices.mockResolvedValue([{
      deviceId: null, externalRef: 'VP-0001', label: null, siteId: null, siteName: null, tenantId: null,
      tenantName: null, kind: 'inverter', ist: null, soll: null, sollSeq: null, state: null, reason: null,
      blocker: null, lastSeenAt: null, reportedAt: null, provisioned: true, note: null,
      provisionedAt: new Date().toISOString(),
    }]);
    render(<GeraeteListePage onOpen={vi.fn()} />);
    // In der Zeile selbst (früher traf die Suche den Kopf-Satz „… gedruckt, meldet sich …“).
    const zeile = (await screen.findAllByText('VP-0001'))[0].closest('tr')!;
    expect(within(zeile).getAllByText('Gedruckt').length).toBeGreaterThan(0);
    expect(screen.getByTestId('geraete-liste')).toHaveTextContent('VP-0001');
  });

  it('zeigt bei „Meldet sich" Erreichbarkeit (grün, solange frisch) und „Noch bei keinem Kunden eingerichtet" (Firstmate vp-werkstatt-laeuft-anzeige)', async () => {
    listPendingEnrollments.mockResolvedValue([{
      externalRef: 'edge-cyhchfr', deviceInfo: null, csrUpdatedAt: new Date().toISOString(), everIssued: false, issuedAt: null,
    }]);
    render(<GeraeteListePage onOpen={vi.fn()} />);
    const zeile = (await screen.findAllByText('edge-cyhchfr'))[0].closest('tr')!;
    expect(within(zeile).getByText('Noch bei keinem Kunden eingerichtet')).toBeInTheDocument();
    const erreichbar = within(zeile).getByTestId('geraete-wartet-erreichbar');
    expect(erreichbar).toHaveTextContent('Online');
    expect(erreichbar).toHaveClass('online');
    // der bestehende Hinweis (gray/amber Badge) bleibt stehen.
    expect(within(zeile).getByText('Frisch — normal während der Einrichtung')).toBeInTheDocument();
  });

  it('eine alte Meldung („Meldet sich nicht") bleibt von der grünen Erreichbarkeit unterschieden', async () => {
    listPendingEnrollments.mockResolvedValue([{
      externalRef: 'edge-alt', deviceInfo: null, csrUpdatedAt: new Date(Date.now() - 10 * 60_000).toISOString(), everIssued: false, issuedAt: null,
    }]);
    render(<GeraeteListePage onOpen={vi.fn()} />);
    const zeile = (await screen.findAllByText('edge-alt'))[0].closest('tr')!;
    const erreichbar = within(zeile).getByTestId('geraete-wartet-erreichbar');
    expect(erreichbar).toHaveTextContent('Meldet sich nicht');
    expect(erreichbar).toHaveClass('offline');
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

  describe('Boxen löschen (nur ohne aktive Kunden-/Anlagen-Bindung)', () => {
    it('löscht eine gedruckte, unverbundene Aufkleber-ID nach Rückfrage, mit Grund im Fehlerfall', async () => {
      listDevices.mockResolvedValue([{
        deviceId: null, externalRef: 'VP-0001', label: null, siteId: null, siteName: null, tenantId: null,
        tenantName: null, kind: 'inverter', ist: null, soll: null, sollSeq: null, state: null, reason: null,
        blocker: null, lastSeenAt: null, reportedAt: null, provisioned: true, note: null,
        provisionedAt: new Date().toISOString(),
      }]);
      render(<GeraeteListePage onOpen={vi.fn()} />);
      await screen.findAllByText('VP-0001');

      fireEvent.click(screen.getByRole('button', { name: /Aktionen für VP-0001/ }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Box löschen' }));
      expect(await screen.findByRole('heading', { name: 'VP-0001 löschen?' })).toBeInTheDocument();

      deleteProvisionedDevice.mockRejectedValueOnce(new Error('netz weg'));
      fireEvent.click(screen.getByRole('button', { name: 'Box löschen' }));
      await waitFor(() => expect(deleteProvisionedDevice).toHaveBeenCalledWith('VP-0001'));
      expect(await screen.findByText(/ließ sich nicht löschen/)).toBeInTheDocument();

      deleteProvisionedDevice.mockResolvedValueOnce(undefined);
      listDevices.mockResolvedValue([]);
      fireEvent.click(screen.getByRole('button', { name: 'Box löschen' }));
      await waitFor(() => expect(screen.queryByRole('heading', { name: 'VP-0001 löschen?' })).toBeNull());
      expect(await screen.findByText('Noch kein Gerät')).toBeInTheDocument();
    });

    it('eine verbundene Box bekommt kein Aktionen-Menü (keine aktive Bindung lässt sich löschen)', async () => {
      edgeUpdates.mockResolvedValue({
        ...emptyEdgeUpdates(),
        fleet: [{
          deviceId: 'd1', label: 'edge-a1', externalRef: 'edge-a1', siteId: 's1', siteName: 'Pilsting',
          tenantId: 't1', tenantName: 'Kunde A', ist: 'edge-2026.08.0', soll: 'edge-2026.08.0', sollSeq: 12,
          state: 'bestaetigt', reason: null, since: null, reportedAt: null, rolloutId: null,
          lastSeenAt: new Date().toISOString(), boxArt: 'docker', linie: 'docker',
        }],
      });
      render(<GeraeteListePage onOpen={vi.fn()} />);
      await screen.findByText('Pilsting');
      expect(screen.queryByRole('button', { name: /^Aktionen für/ })).toBeNull();
    });

    it('eine abgenommene Werkstatt-Box bekommt kein Aktionen-Menü (per Werkstatt-Regel in Gebrauch)', async () => {
      werkstattBoxen.mockResolvedValue([{
        id: 'w1', edgeRef: 'edge-werkstatt', boxArt: 'edge-light', lanNetz: null, schritte: {},
        notiz: null, angelegtAm: new Date().toISOString(), angelegtVon: 'admin', geaendertAm: new Date().toISOString(),
        abnahmen: [], inGebrauch: ['Abgenommen'],
      }]);
      render(<GeraeteListePage onOpen={vi.fn()} />);
      await screen.findAllByText('edge-werkstatt');
      expect(screen.queryByRole('button', { name: /^Aktionen für/ })).toBeNull();
    });

    it('löscht eine wartende Anmeldung über den eigenen Lösch-Weg', async () => {
      listPendingEnrollments.mockResolvedValue([
        { externalRef: 'edge-typo-1', deviceInfo: null, csrUpdatedAt: new Date().toISOString(), everIssued: false, issuedAt: null },
      ]);
      deletePendingEnrollment.mockResolvedValue(undefined);
      render(<GeraeteListePage onOpen={vi.fn()} />);
      await screen.findAllByText('edge-typo-1');

      fireEvent.click(screen.getByRole('button', { name: /Aktionen für edge-typo-1/ }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Box löschen' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Box löschen' }));
      await waitFor(() => expect(deletePendingEnrollment).toHaveBeenCalledWith('edge-typo-1'));
    });

    it('löscht eine löschbare Werkstatt-Box über ihren eigenen Lösch-Weg', async () => {
      werkstattBoxen.mockResolvedValue([{
        id: 'w1', edgeRef: 'edge-werkstatt', boxArt: 'edge-light', lanNetz: null, schritte: {},
        notiz: null, angelegtAm: new Date().toISOString(), angelegtVon: 'admin', geaendertAm: new Date().toISOString(),
        abnahmen: [], inGebrauch: [], loeschtMit: ['Tunnel-Schlüssel'],
      }]);
      werkstattBoxLoeschen.mockResolvedValue(undefined);
      render(<GeraeteListePage onOpen={vi.fn()} />);
      await screen.findAllByText('edge-werkstatt');

      fireEvent.click(screen.getByRole('button', { name: /Aktionen für edge-werkstatt/ }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Box löschen' }));
      expect(await screen.findByTestId('confirm-consequences')).toHaveTextContent('Tunnel-Schlüssel');
      fireEvent.click(screen.getByRole('button', { name: 'Box löschen' }));
      await waitFor(() => expect(werkstattBoxLoeschen).toHaveBeenCalledWith('edge-werkstatt'));
    });
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
