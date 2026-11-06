import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  },
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

describe('GeraeteAktePage (§4.4, Scheibe S2): EIN Ort je Box, inline statt im Fenster', () => {
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
  });

  it('zeigt den Kopf-Zustand einer verbundenen Box und die vier Reiter', async () => {
    edgeUpdates.mockResolvedValue({ ...emptyEdgeUpdates(), fleet: [connectedRow] });
    render(<GeraeteAktePage boxRef="edge-a1" reiter={null} />);
    expect(await screen.findByTestId('akte-zustand')).toHaveTextContent('Verbunden');
    const tabs = screen.getByTestId('akte-reiter');
    expect(tabs).toHaveTextContent('Überblick');
    expect(tabs).toHaveTextContent('Software');
    expect(tabs).toHaveTextContent('Verbindung');
    expect(tabs).toHaveTextContent('Einrichtung');
    expect(tabs).toHaveTextContent('Verlauf');
    // Der Reiter „Anlage" kommt erst mit S3 - er steht hier noch nicht.
    expect(tabs).not.toHaveTextContent('Anlage');
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
});
