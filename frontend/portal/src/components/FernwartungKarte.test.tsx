import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';

const fernwartung = vi.fn();
const fernwartungBox = vi.fn();
const fernwartungTechniker = vi.fn();
const fernwartungFensterSchliessen = vi.fn();

vi.mock('../admin/adminApi', () => ({
  adminApi: {
    fernwartung: () => fernwartung(),
    fernwartungBox: (ref: string) => fernwartungBox(ref),
    fernwartungTechniker: () => fernwartungTechniker(),
    fernwartungFensterSchliessen: (id: string) => fernwartungFensterSchliessen(id),
  },
}));

const { FernwartungKarte } = await import('./FernwartungKarte');

const uebersicht = {
  server: {
    endpunkt: 'wartung.voltpilot.de',
    port: 51820,
    publicKey: null,
    eingerichtet: false,
    boxNetz: '10.10.16.0/20',
    technikerNetz: '10.10.32.0/24',
    boxServerAdresse: '10.10.16.1',
    technikerServerAdresse: '10.10.32.1',
  },
  maxFensterMinuten: 1440,
  abrufe: [],
  boxenAktiv: 1,
  boxenGesperrt: 0,
  technikerAktiv: 1,
  technikerGesperrt: 0,
  fensterOffen: 1,
  fensterGeplant: 0,
  stand: new Date().toISOString(),
};

const offenesFenster = {
  id: 'f1',
  edgeRef: 'edge-zay5sdd',
  technikerId: 't1',
  technikerName: 'Max (Laptop)',
  grund: 'Update auf Stufe 2',
  beginn: new Date(Date.now() - 60_000).toISOString(),
  ende: new Date(Date.now() + 3_600_000).toISOString(),
  wirksamesEnde: new Date(Date.now() + 3_600_000).toISOString(),
  zustand: 'offen',
  geoeffnetAm: new Date().toISOString(),
  geoeffnetVon: 'admin',
  geschlossenAm: null,
  geschlossenVon: null,
};

describe('FernwartungKarte (Box-Seite, nur Plattform-Schicht)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fernwartung.mockResolvedValue(uebersicht);
    fernwartungTechniker.mockResolvedValue([]);
  });

  it('ohne hinterlegten Schlüssel sagt sie das und bietet das Hinterlegen an', async () => {
    fernwartungBox.mockRejectedValue(new ApiError(404, 'Für edge-zay5sdd ist kein Tunnel-Schlüssel hinterlegt.'));
    render(<FernwartungKarte edgeRef="edge-zay5sdd" />);
    expect(await screen.findByText(/kein Tunnel-Schlüssel hinterlegt/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tunnel-Schlüssel hinterlegen' })).toBeEnabled();
    expect(screen.getByRole('link', { name: /Zugänge und Protokoll/ })).toHaveAttribute(
      'href',
      '#/fernwartung?box=edge-zay5sdd',
    );
  });

  it('zeigt das offene Fenster, schließt es und nennt, warum kein neues geht', async () => {
    fernwartungBox.mockResolvedValue({
      id: 'b1',
      edgeRef: 'edge-zay5sdd',
      publicKey: 'jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEM=',
      publicKeyKurz: 'jUg9DePF…5HiEM=',
      adresse: '10.10.16.2',
      status: 'aktiv',
      notiz: null,
      angelegtAm: '2026-10-07T10:00:00Z',
      geaendertAm: '2026-10-07T10:00:00Z',
      siteId: 's1',
      siteName: 'Dirolf',
      tenantId: 'k1',
      tenantName: 'Familie Dirolf',
      laufendeFenster: [offenesFenster],
    });
    fernwartungFensterSchliessen.mockResolvedValue({});
    render(<FernwartungKarte edgeRef="edge-zay5sdd" />);
    expect(await screen.findByText(/^bis .* · Max \(Laptop\)$/)).toBeInTheDocument();
    expect(screen.getByText('offen')).toBeInTheDocument();
    expect(screen.getByText('Tunnel 10.10.16.2')).toBeInTheDocument();
    // Kein aktiver Zugang: der Knopf bleibt sichtbar und nennt den Grund.
    expect(screen.getByRole('button', { name: 'Fenster öffnen' })).toBeDisabled();
    expect(screen.getByText(/keinen aktiven Techniker-Zugang/)).toBeInTheDocument();
    expect(screen.getByTestId('fw-karte-dienst')).toHaveTextContent('noch nie abgeholt');

    // Der Zugang steht nicht in der (leeren) Liste: die Karte behauptet nicht, er habe keinen Schlüssel.
    expect(screen.getByTestId('fw-anmeldung-unbekannt')).toHaveTextContent(/nicht bekannt/);
    expect(screen.getByText('ssh -i ~/.ssh/id_rsa_voltpilot -p 2222 root@10.10.16.2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
    await waitFor(() => expect(fernwartungFensterSchliessen).toHaveBeenCalledWith('f1'));
  });

  it('zeigt am offenen Fenster die fertigen Befehle und den Fingerabdruck des Zugangs', async () => {
    fernwartungTechniker.mockResolvedValue([
      {
        id: 't1',
        name: 'Max (Laptop)',
        publicKey: 'FY4LLXFaOvh8LPZu/gA4AeS2WJjXkuOUPB4hlxBI8/Y=',
        publicKeyKurz: 'FY4LLXFa…BI8/Y=',
        adresse: '10.10.32.2',
        status: 'aktiv',
        notiz: null,
        angelegtAm: '2026-10-07T10:00:00Z',
        geaendertAm: '2026-10-07T10:00:00Z',
        sshPublicKey: 'ssh-rsa AAAAB3NzaC1yc2EA',
        sshFingerabdruck: 'SHA256:TDOx3bpPNtPLIdd+juZoGcDMz3ZRCklaP5G6aBrp9Zc',
        sshBits: 3072,
      },
    ]);
    fernwartungBox.mockResolvedValue({
      id: 'b1',
      edgeRef: 'edge-zay5sdd',
      publicKey: 'jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEM=',
      publicKeyKurz: 'jUg9DePF…5HiEM=',
      adresse: '10.10.16.2',
      status: 'aktiv',
      notiz: null,
      angelegtAm: '2026-10-07T10:00:00Z',
      geaendertAm: '2026-10-07T10:00:00Z',
      siteId: null,
      siteName: null,
      tenantId: null,
      tenantName: null,
      laufendeFenster: [offenesFenster],
    });
    render(<FernwartungKarte edgeRef="edge-zay5sdd" />);
    const anmeldung = await screen.findByTestId('fw-anmeldung');
    expect(anmeldung).toHaveTextContent('ssh -i ~/.ssh/id_rsa_voltpilot -p 2222 -L 8484:127.0.0.1:8484 root@10.10.16.2');
    expect(screen.getByTestId('fw-anmeldung-vorhanden')).toHaveTextContent(
      '„Max (Laptop)“: Anmeldung mit dem SSH-Schlüssel SHA256:TDOx3bpPNtPLIdd+juZoGcDMz3ZRCklaP5G6aBrp9Zc',
    );
  });
});
