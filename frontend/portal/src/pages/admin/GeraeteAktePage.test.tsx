import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EdgeUpdates } from '../../adminEdgeUpdates';

const edgeUpdates = vi.fn();
const listDevices = vi.fn();
const listPendingEnrollments = vi.fn();
const werkstattBoxen = vi.fn();
const werkstattDienst = vi.fn();
const werkstattFreigaben = vi.fn();
const fernwartungProtokoll = vi.fn();
const boxVerlauf = vi.fn();
const fernwartungBox = vi.fn();
const fernwartung = vi.fn();
const fernwartungTechniker = vi.fn();
const controlCandidates = vi.fn();
const componentFleet = vi.fn();
const activateControl = vi.fn();
const deactivateControl = vi.fn();
const fleet = vi.fn();

vi.mock('../../admin/adminApi', () => ({
  adminApi: {
    edgeUpdates: (...a: unknown[]) => edgeUpdates(...a),
    listDevices: (...a: unknown[]) => listDevices(...a),
    listPendingEnrollments: (...a: unknown[]) => listPendingEnrollments(...a),
    werkstattBoxen: (...a: unknown[]) => werkstattBoxen(...a),
    werkstattDienst: (...a: unknown[]) => werkstattDienst(...a),
    werkstattFreigaben: (...a: unknown[]) => werkstattFreigaben(...a),
    fernwartungProtokoll: (...a: unknown[]) => fernwartungProtokoll(...a),
    boxVerlauf: (...a: unknown[]) => boxVerlauf(...a),
    fernwartungBox: (...a: unknown[]) => fernwartungBox(...a),
    fernwartung: (...a: unknown[]) => fernwartung(...a),
    fernwartungTechniker: (...a: unknown[]) => fernwartungTechniker(...a),
    controlCandidates: (...a: unknown[]) => controlCandidates(...a),
    componentFleet: (...a: unknown[]) => componentFleet(...a),
    activateControl: (...a: unknown[]) => activateControl(...a),
    deactivateControl: (...a: unknown[]) => deactivateControl(...a),
  },
}));

vi.mock('../../admin/fleetApi', () => ({
  fleetApi: { fleet: (...a: unknown[]) => fleet(...a) },
}));

const { GeraeteAktePage } = await import('./GeraeteAktePage');
const { ApiError } = await import('../../api');

const emptyEdgeUpdates = (): EdgeUpdates => ({
  releases: [], journal: [], rollouts: [], fleet: [], kpi: null,
} as unknown as EdgeUpdates);

const connectedRow = {
  deviceId: 'd1', label: 'edge-a1', externalRef: 'edge-a1', siteId: 's1', siteName: 'Pilsting',
  tenantId: 't1', tenantName: 'Kunde A', ist: 'edge-2026.08.0', soll: 'edge-2026.08.0', sollSeq: 12,
  state: 'bestaetigt', reason: null, since: null, reportedAt: null, rolloutId: null,
  lastSeenAt: new Date().toISOString(), boxArt: 'docker', linie: 'docker',
};

const fleetSite = (overrides: Partial<Record<string, unknown>> = {}) => ({
  siteId: 's1', siteName: 'Pilsting', tenantId: 't1', tenantName: 'Kunde A', plantKind: 'pv_storage',
  netzladenErlaubt: true, tarifArt: null, boxes: [{ deviceId: 'd1', externalRef: 'edge-a1', name: 'edge-a1', fuehrtAnlage: true, lastSeenAt: null, edge: null, update: null }],
  deviceCount: 1, onlineCount: 1, waitingCount: 0, worstStatus: 'online', lastSeenAt: null,
  lastPlanGeneratedAt: new Date().toISOString(), hasStorage: true, batteryWithoutDevice: false,
  sources: null, edge: null, update: null, control: null, curtailment: null,
  kwp: { configuredKwp: null, observedPeakKw: null, buckets: 0, verdict: 'unbekannt', reason: '' },
  forecast: [], pflege: [],
  ...overrides,
});

describe('GeraeteAktePage (§4.4, Scheiben S2/S3): EIN Ort je Box, inline statt im Fenster', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    edgeUpdates.mockResolvedValue(emptyEdgeUpdates());
    listDevices.mockResolvedValue([]);
    listPendingEnrollments.mockResolvedValue([]);
    werkstattBoxen.mockResolvedValue([]);
    werkstattDienst.mockResolvedValue({ ansicht: null, gemeldetAm: null, dienstZeit: null, alterSekunden: null, aktuell: true, laeufe: [] });
    werkstattFreigaben.mockResolvedValue([]);
    fernwartungProtokoll.mockResolvedValue([]);
    boxVerlauf.mockResolvedValue({ deviceId: 'd1', eintraege: [] });
    fernwartungBox.mockRejectedValue(new ApiError(404, 'Für edge-a1 ist kein Tunnel-Schlüssel hinterlegt.'));
    fernwartung.mockRejectedValue(new Error('nicht gebraucht'));
    fernwartungTechniker.mockResolvedValue([]);
    controlCandidates.mockResolvedValue([]);
    componentFleet.mockResolvedValue([]);
    fleet.mockResolvedValue({ sites: [fleetSite()], releases: [] });
  });

  it('zeigt den Kopf-Zustand einer verbundenen Box und die fünf Reiter (Scheibe S3: „Anlage" dazu)', async () => {
    edgeUpdates.mockResolvedValue({ ...emptyEdgeUpdates(), fleet: [connectedRow] });
    render(<GeraeteAktePage boxRef="edge-a1" reiter={null} />);
    expect(await screen.findByTestId('akte-zustand')).toHaveTextContent('Verbunden');
    const tabs = screen.getByTestId('akte-reiter');
    expect(tabs).toHaveTextContent('Überblick');
    expect(tabs).toHaveTextContent('Software');
    expect(tabs).toHaveTextContent('Verbindung');
    expect(tabs).toHaveTextContent('Anlage');
    expect(tabs).toHaveTextContent('Einrichtung');
    expect(tabs).toHaveTextContent('Verlauf');
  });

  it('wechselt per Reiter inline - kein Fenster, keine zweite Seite (E1 = A)', async () => {
    edgeUpdates.mockResolvedValue({ ...emptyEdgeUpdates(), fleet: [connectedRow] });
    const nav = vi.fn();
    render(<GeraeteAktePage boxRef="edge-a1" reiter={null} onNavigate={nav} />);
    await screen.findByTestId('akte-zustand');
    fireEvent.click(screen.getByRole('tab', { name: 'Software' }));
    expect(nav).toHaveBeenCalledWith(expect.objectContaining({
      page: 'geraete-registry', geraeteAkte: { ref: 'edge-a1', reiter: 'software' },
    }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Reiter Software: läuft, Vertrauen und Update-Verlauf aus vorhandenen Antworten - keine neue Schnittstelle', async () => {
    edgeUpdates.mockResolvedValue({ ...emptyEdgeUpdates(), fleet: [connectedRow] });
    render(<GeraeteAktePage boxRef="edge-a1" reiter="software" />);
    expect(await screen.findByText('Linie und Stand')).toBeInTheDocument();
    expect(screen.getByText('Vertrauen')).toBeInTheDocument();
    expect(boxVerlauf).toHaveBeenCalledWith('d1');
  });

  it('Reiter Verbindung: bettet die Fernwartungs-Karte EINER Box inline ein', async () => {
    edgeUpdates.mockResolvedValue({ ...emptyEdgeUpdates(), fleet: [connectedRow] });
    render(<GeraeteAktePage boxRef="edge-a1" reiter="verbindung" />);
    expect(await screen.findByTestId('fw-karte')).toBeInTheDocument();
    expect(await screen.findByText(/kein Tunnel-Schlüssel hinterlegt/)).toBeInTheDocument();
    expect(fernwartungBox).toHaveBeenCalledWith('edge-a1');
  });

  it('eine noch nicht verbundene Box zeigt das ehrlich, statt eine leere Seite', async () => {
    render(<GeraeteAktePage boxRef="edge-neu" reiter={null} />);
    expect(await screen.findByTestId('akte-zustand')).toHaveTextContent('Noch nicht verbunden');
  });

  it('Reiter Einrichtung einer noch nicht verbundenen Box sagt ehrlich, dass nichts verzeichnet ist', async () => {
    render(<GeraeteAktePage boxRef="edge-neu" reiter="einrichtung" />);
    expect(await screen.findByText(/nichts in der Einrichtung verzeichnet/)).toBeInTheDocument();
  });

  describe('Reiter Anlage (§4.4, Scheibe S3): Plan, Steuerung, Fassung, Werkzeuge aus vorhandenen Antworten', () => {
    beforeEach(() => {
      edgeUpdates.mockResolvedValue({ ...emptyEdgeUpdates(), fleet: [connectedRow] });
    });

    it('zeigt Plan, Steuerung & Abregelung mit Beleg und die Komponenten-Fassung', async () => {
      componentFleet.mockResolvedValue([
        { siteId: 's1', siteName: 'Pilsting', tenantId: 't1', tenantName: 'Kunde A', componentAuthority: 'portal', componentCount: 3, syncStatus: 'in_sync', sources: { builtin: 3, certified: 0, custom: 0, composed: 0, unknown: 0 }, privateTemplates: 0 },
      ]);
      render(<GeraeteAktePage boxRef="edge-a1" reiter="anlage" />);
      expect(await screen.findByText('Plan')).toBeInTheDocument();
      expect(screen.getByText('Steuerung und Abregelung')).toBeInTheDocument();
      expect(screen.getByText('Komponenten-Fassung')).toBeInTheDocument();
      expect(screen.getByText('Angewandt')).toBeInTheDocument();
      expect(fleet).toHaveBeenCalled();
      expect(componentFleet).toHaveBeenCalled();
    });

    it('Scharfschalten: aktiviert über denselben Aufruf wie die frühere Steuerungs-Freigabe', async () => {
      controlCandidates.mockResolvedValue([
        { deviceId: 'd1', tenantId: 't1', siteId: 's1', siteName: 'Pilsting', tenantName: 'Kunde A', externalRef: 'edge-a1', activated: false, platformCertVerdict: 'covered_not_activated', platformCertModel: 'SUN-30K', certSource: 'platform', activatedAt: null, activatedBy: null },
      ]);
      activateControl.mockResolvedValue(undefined);
      render(<GeraeteAktePage boxRef="edge-a1" reiter="anlage" />);
      const knopf = await screen.findByRole('button', { name: 'Steuerung aktivieren' });
      fireEvent.click(knopf);
      const dialog = await screen.findByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Steuerung aktivieren' }));
      await waitFor(() => expect(activateControl).toHaveBeenCalledWith('d1'));
    });

    it('E2 = A: eine weitere Box derselben Anlage zeigt nur einen Satz und den Weg zur führenden Box', async () => {
      fleet.mockResolvedValue({
        sites: [fleetSite({
          boxes: [
            { deviceId: 'd1', externalRef: 'edge-a1', name: 'Leitstand', fuehrtAnlage: true, lastSeenAt: null, edge: null, update: null },
            { deviceId: 'd2', externalRef: 'edge-a2', name: 'edge-a2', fuehrtAnlage: false, lastSeenAt: null, edge: null, update: null },
          ],
        })],
        releases: [],
      });
      const andereBoxRow = { ...connectedRow, deviceId: 'd2', externalRef: 'edge-a2', label: 'edge-a2' };
      edgeUpdates.mockResolvedValue({ ...emptyEdgeUpdates(), fleet: [andereBoxRow] });
      const nav = vi.fn();
      render(<GeraeteAktePage boxRef="edge-a2" reiter="anlage" onNavigate={nav} />);
      const satz = await screen.findByText(/Die Anlage führt Box/);
      expect(satz).toHaveTextContent('Leitstand');
      fireEvent.click(screen.getByText('Leitstand ›'));
      expect(nav).toHaveBeenCalledWith(expect.objectContaining({
        geraeteAkte: { ref: 'edge-a1', reiter: 'anlage', werkzeug: null },
      }));
    });

    it('Werkzeuge öffnen mit vorgewählter Anlage - ein Klick navigiert direkt dorthin, keine Mandant→Anlage-Auswahl', async () => {
      const nav = vi.fn();
      render(<GeraeteAktePage boxRef="edge-a1" reiter="anlage" onNavigate={nav} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Plan erklären (Optimizer)' }));
      expect(nav).toHaveBeenCalledWith(expect.objectContaining({
        geraeteAkte: { ref: 'edge-a1', reiter: 'anlage', werkzeug: 'plan' },
      }));
      fireEvent.click(screen.getByRole('button', { name: 'Flows' }));
      expect(nav).toHaveBeenCalledWith(expect.objectContaining({
        geraeteAkte: { ref: 'edge-a1', reiter: 'anlage', werkzeug: 'flows' },
      }));
    });

    it('Prognose/Gemeinsame Steuerung öffnen „Wie der Kunde es sieht" dieser Anlage', async () => {
      const jump = vi.fn();
      render(<GeraeteAktePage boxRef="edge-a1" reiter="anlage" onJumpToTenant={jump} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Prognose' }));
      expect(jump).toHaveBeenCalledWith('t1', expect.objectContaining({ sub: 'prognose' }));
      fireEvent.click(screen.getByRole('button', { name: 'Gemeinsame Steuerung' }));
      expect(jump).toHaveBeenCalledWith('t1', expect.objectContaining({ sub: 'technik' }));
    });
  });
});
