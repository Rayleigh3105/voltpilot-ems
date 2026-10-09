import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api';

const fernwartung = vi.fn();
const fernwartungBoxen = vi.fn();
const fernwartungTechniker = vi.fn();
const fernwartungProtokoll = vi.fn();
const fernwartungFensterOeffnen = vi.fn();
const fernwartungFensterSchliessen = vi.fn();
const fernwartungSchluessel = vi.fn();
const fernwartungBoxSperren = vi.fn();
const fernwartungTechnikerLoeschen = vi.fn();
const fernwartungTechnikerEntsperren = vi.fn();
const fernwartungTechnikerAnlegen = vi.fn();
const fernwartungTechnikerSshSetzen = vi.fn();
const fernwartungTechnikerSshEntfernen = vi.fn();

vi.mock('../../admin/adminApi', () => ({
  adminApi: {
    fernwartung: () => fernwartung(),
    fernwartungBoxen: () => fernwartungBoxen(),
    fernwartungTechniker: () => fernwartungTechniker(),
    fernwartungProtokoll: (f: unknown) => fernwartungProtokoll(f),
    fernwartungFensterOeffnen: (i: unknown) => fernwartungFensterOeffnen(i),
    fernwartungFensterSchliessen: (id: string) => fernwartungFensterSchliessen(id),
    fernwartungSchluessel: (ref: string, i: unknown) => fernwartungSchluessel(ref, i),
    fernwartungBoxSperren: (ref: string) => fernwartungBoxSperren(ref),
    fernwartungTechnikerLoeschen: (id: string) => fernwartungTechnikerLoeschen(id),
    fernwartungTechnikerEntsperren: (id: string) => fernwartungTechnikerEntsperren(id),
    fernwartungTechnikerAnlegen: (i: unknown) => fernwartungTechnikerAnlegen(i),
    fernwartungTechnikerSshSetzen: (id: string, k: string) => fernwartungTechnikerSshSetzen(id, k),
    fernwartungTechnikerSshEntfernen: (id: string) => fernwartungTechnikerSshEntfernen(id),
  },
}));

const { FernwartungPage } = await import('./FernwartungPage');

const server = {
  endpunkt: 'wartung.voltpilot.de',
  port: 51820,
  publicKey: 'LnLMuBG+dDEeaEKlQrdTlPifX2fk0hOaB/NFc/BudjE=',
  eingerichtet: true,
  boxNetz: '10.10.16.0/20',
  technikerNetz: '10.10.32.0/24',
  boxServerAdresse: '10.10.16.1',
  technikerServerAdresse: '10.10.32.1',
};

function uebersicht(over: Record<string, unknown> = {}) {
  return {
    server,
    maxFensterMinuten: 1440,
    abrufe: [{ dienst: 'voltpilot-tunnel-dienst', zuletztAm: new Date().toISOString(), peers: 3, fenster: 0 }],
    boxenAktiv: 2,
    boxenGesperrt: 0,
    technikerAktiv: 1,
    technikerGesperrt: 0,
    fensterOffen: 0,
    fensterGeplant: 0,
    stand: new Date().toISOString(),
    ...over,
  };
}

function box(over: Record<string, unknown> = {}) {
  return {
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
    laufendeFenster: [],
    ...over,
  };
}

const max = {
  id: 't1',
  name: 'Max (Laptop)',
  publicKey: 'FY4LLXFaOvh8LPZu/gA4AeS2WJjXkuOUPB4hlxBI8/Y=',
  publicKeyKurz: 'FY4LLXFa…BI8/Y=',
  adresse: '10.10.32.2',
  status: 'aktiv',
  notiz: null,
  angelegtAm: '2026-10-07T10:00:00Z',
  geaendertAm: '2026-10-07T10:00:00Z',
  sshPublicKey: null as string | null,
  sshFingerabdruck: null as string | null,
  sshBits: null as number | null,
};

/** Ein öffentlicher RSA-Schlüssel mit 2048 Bit aus Zahlen statt aus einem Schlüsselpaar. */
function rsaZeile(): string {
  const feld = (b: Buffer) => {
    const l = Buffer.alloc(4);
    l.writeUInt32BE(b.length);
    return Buffer.concat([l, b]);
  };
  const n = Buffer.alloc(257);
  n[1] = 0x80;
  n[256] = 1;
  return `ssh-rsa ${Buffer.concat([feld(Buffer.from('ssh-rsa')), feld(Buffer.from([1, 0, 1])), feld(n)]).toString('base64')}`;
}

const FINGERABDRUCK = 'SHA256:TDOx3bpPNtPLIdd+juZoGcDMz3ZRCklaP5G6aBrp9Zc';
const maxMitSsh = { ...max, sshPublicKey: rsaZeile(), sshFingerabdruck: FINGERABDRUCK, sshBits: 3072 };

function offenesFenster(over: Record<string, unknown> = {}) {
  return {
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
    ...over,
  };
}

describe('FernwartungPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '#/fernwartung';
    fernwartung.mockResolvedValue(uebersicht());
    fernwartungBoxen.mockResolvedValue([
      box(),
      box({ id: 'b2', edgeRef: 'edge-k7m2xq3', adresse: '10.10.16.3', status: 'gesperrt', siteName: null, tenantName: null }),
    ]);
    fernwartungTechniker.mockResolvedValue([max]);
    fernwartungProtokoll.mockResolvedValue([
      {
        id: 'p1',
        zeit: new Date().toISOString(),
        akteur: 'admin',
        aktion: 'fenster_geoeffnet',
        edgeRef: 'edge-zay5sdd',
        technikerId: 't1',
        technikerName: 'Max (Laptop)',
        fensterId: 'f1',
        details: { dauerMinuten: '60', grund: 'Update auf Stufe 2' },
      },
    ]);
    fernwartungFensterOeffnen.mockResolvedValue({});
  });

  it('trennt Soll, Abruf und Unbekanntes und nennt den Kunden-Bezug', async () => {
    render(<FernwartungPage />);
    await screen.findByTestId('fw-boxen');
    expect(screen.getByTestId('fw-server')).toHaveTextContent('wartung.voltpilot.de:51820');
    expect(screen.getByTestId('fw-dienst')).toHaveTextContent('Tunnel-Dienst holt ab');
    expect(screen.getByText(/meldet der Tunnel-Dienst nicht zurück/)).toBeInTheDocument();
    expect(screen.getByText(/sieht die einzelnen Fenster nicht/)).toBeInTheDocument();

    const boxen = screen.getByTestId('fw-boxen');
    expect(within(boxen).getByText('Dirolf · Familie Dirolf')).toBeInTheDocument();
    expect(within(boxen).getByText('noch nicht gekoppelt')).toBeInTheDocument();
    expect(within(screen.getByTestId('fw-protokoll')).getByText('1 Stunde · Grund: Update auf Stufe 2')).toBeInTheDocument();
  });

  it('eine gesperrte Box zeigt „Fenster öffnen" gesperrt MIT Grund (E10)', async () => {
    render(<FernwartungPage />);
    const boxen = await screen.findByTestId('fw-boxen');
    const zeile = within(boxen).getByText('edge-k7m2xq3').closest('tr') as HTMLElement;
    expect(within(zeile).getByRole('button', { name: 'Fenster öffnen' })).toBeDisabled();
    expect(within(zeile).getByText(/gesperrt - erst entsperren/)).toBeInTheDocument();
    expect(within(zeile).getByRole('button', { name: 'Entsperren' })).toBeEnabled();
  });

  it('ein Fenster braucht einen Grund und geht dann mit Box, Techniker und Dauer raus', async () => {
    render(<FernwartungPage />);
    const boxen = await screen.findByTestId('fw-boxen');
    const zeile = within(boxen).getByText('edge-zay5sdd').closest('tr') as HTMLElement;
    fireEvent.click(within(zeile).getByRole('button', { name: 'Fenster öffnen' }));

    const dialog = await screen.findByRole('dialog');
    // Der einzige freie Zugang ist vorgewählt - und der Picker hat seinen Namen
    // (eine doppelte id auf der Seite nahm ihm einmal die Beschriftung).
    expect(within(dialog).getByRole('combobox', { name: /Techniker-Zugang/ })).toHaveTextContent('Max (Laptop)');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fenster öffnen' }));
    expect(await within(dialog).findByText(/Ein Grund ist Pflicht/)).toBeInTheDocument();
    expect(fernwartungFensterOeffnen).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByPlaceholderText(/Update auf Stufe 2/), {
      target: { value: 'go-e prüfen' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fenster öffnen' }));
    await waitFor(() =>
      expect(fernwartungFensterOeffnen).toHaveBeenCalledWith({
        edgeRef: 'edge-zay5sdd',
        technikerId: 't1',
        grund: 'go-e prüfen',
        dauerMinuten: 60,
      }),
    );
  });

  it('ein anderer Schlüssel verlangt die ausdrückliche Tausch-Markierung', async () => {
    fernwartungSchluessel
      .mockRejectedValueOnce(
        new ApiError(409, 'Für edge-zay5sdd ist bereits ein anderer Schlüssel hinterlegt (jUg9DePF…5HiEM=). Ein Tausch muss ausdrücklich als Schlüsseltausch markiert werden.'),
      )
      .mockResolvedValueOnce({ ergebnis: 'getauscht', box: box(), server });
    render(<FernwartungPage />);
    await screen.findByTestId('fw-boxen');
    fireEvent.click(screen.getByRole('button', { name: 'Tunnel-Schlüssel hinterlegen' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Box-Referenz/), { target: { value: 'EDGE-ZAY5SDD' } });
    fireEvent.change(within(dialog).getByLabelText(/Öffentlicher WireGuard-Schlüssel/), {
      target: { value: 'SBsk0U9z6BgB/U8nb+L9PdK/46p7mBvWRQe8I0Vg3C0=' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Hinterlegen' }));
    expect(await within(dialog).findByTestId('fw-tausch')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Hinterlegen' })).toBeDisabled();

    fireEvent.click(within(dialog).getByLabelText(/Ja, Schlüssel tauschen/));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Hinterlegen' }));
    expect(await within(dialog).findByTestId('fw-schluessel-ergebnis')).toHaveTextContent('Schlüssel getauscht');
    expect(fernwartungSchluessel).toHaveBeenLastCalledWith('edge-zay5sdd', {
      publicKey: 'SBsk0U9z6BgB/U8nb+L9PdK/46p7mBvWRQe8I0Vg3C0=',
      schluesselTausch: true,
      notiz: null,
    });
    expect(within(dialog).getByText(/service-tunnel\.sh root@<box> 10\.10\.16\.2 51820/)).toBeInTheDocument();
  });

  describe('Techniker-Zugang löschen', () => {
    // Der Fall des Kapitäns: derselbe Name zweimal, der alte gesperrt.
    const alt = {
      ...max,
      id: 't0',
      publicKey: 'Pgf4aS+67rz4HdSHuy8KKgm5e/UP3xnrMWJskXaZB9c=',
      publicKeyKurz: 'Pgf4aS+6…ZB9c=',
      adresse: '10.10.32.3',
      status: 'gesperrt',
    };

    function zeile(tabelle: HTMLElement, adresse: string): HTMLElement {
      return within(tabelle).getByText(adresse).closest('tr') as HTMLElement;
    }

    beforeEach(() => {
      fernwartungTechniker.mockResolvedValue([max, alt]);
      fernwartungTechnikerLoeschen.mockResolvedValue(undefined);
    });

    it('bietet „Löschen" nur am gesperrten Zugang an', async () => {
      render(<FernwartungPage />);
      const tabelle = await screen.findByTestId('fw-techniker');
      expect(within(zeile(tabelle, '10.10.32.3')).getByRole('button', { name: 'Löschen' })).toBeEnabled();
      expect(within(zeile(tabelle, '10.10.32.3')).getByRole('button', { name: 'Entsperren' })).toBeEnabled();
      expect(within(zeile(tabelle, '10.10.32.2')).queryByRole('button', { name: 'Löschen' })).toBeNull();
      expect(within(zeile(tabelle, '10.10.32.2')).getByRole('button', { name: 'Sperren' })).toBeEnabled();
    });

    it('fragt mit einem Satz nach, löscht erst auf Bestätigung und lädt die Liste neu', async () => {
      render(<FernwartungPage />);
      const tabelle = await screen.findByTestId('fw-techniker');
      fireEvent.click(within(zeile(tabelle, '10.10.32.3')).getByRole('button', { name: 'Löschen' }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Zugang löschen?')).toBeInTheDocument();
      expect(
        within(dialog).getByText(
          'Der gesperrte Zugang „Max (Laptop)“ (10.10.32.3, Pgf4aS+6…ZB9c=) verschwindet endgültig aus allen Listen und lässt sich nicht wiederherstellen.',
        ),
      ).toBeInTheDocument();
      expect(within(dialog).getByTestId('confirm-consequences')).toHaveTextContent(/bleiben vergeben/);
      expect(fernwartungTechnikerLoeschen).not.toHaveBeenCalled();

      // Die API liefert den gelöschten Zugang danach nicht mehr.
      fernwartungTechniker.mockResolvedValue([max]);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Endgültig löschen' }));
      await waitFor(() => expect(fernwartungTechnikerLoeschen).toHaveBeenCalledWith('t0'));
      await waitFor(() => expect(within(screen.getByTestId('fw-techniker')).queryByText('10.10.32.3')).toBeNull());
      expect(within(screen.getByTestId('fw-techniker')).getByText('10.10.32.2')).toBeInTheDocument();
      expect(within(screen.getByTestId('fw-techniker')).getAllByText('Max (Laptop)')).toHaveLength(1);
    });

    it('Abbrechen löscht nichts', async () => {
      render(<FernwartungPage />);
      const tabelle = await screen.findByTestId('fw-techniker');
      fireEvent.click(within(zeile(tabelle, '10.10.32.3')).getByRole('button', { name: 'Löschen' }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(fernwartungTechnikerLoeschen).not.toHaveBeenCalled();
      expect(within(screen.getByTestId('fw-techniker')).getByText('10.10.32.3')).toBeInTheDocument();
    });

    it('zeigt die Ablehnung des Servers und lässt den Zugang stehen', async () => {
      fernwartungTechnikerLoeschen.mockRejectedValue(
        new ApiError(409, 'Der Zugang „Max (Laptop)" ist aktiv. Erst sperren, dann löschen.'),
      );
      render(<FernwartungPage />);
      const tabelle = await screen.findByTestId('fw-techniker');
      fireEvent.click(within(zeile(tabelle, '10.10.32.3')).getByRole('button', { name: 'Löschen' }));
      fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Endgültig löschen' }));
      expect(await screen.findByText(/Erst sperren, dann löschen/)).toBeInTheDocument();
      expect(within(screen.getByTestId('fw-techniker')).getByText('10.10.32.3')).toBeInTheDocument();
    });

    it('das Protokoll nennt den gelöschten Zugang weiter beim Namen', async () => {
      fernwartungTechniker.mockResolvedValue([max]);
      fernwartungProtokoll.mockResolvedValue([
        {
          id: 'p9',
          zeit: new Date().toISOString(),
          akteur: 'admin',
          aktion: 'techniker_geloescht',
          edgeRef: null,
          technikerId: 't0',
          technikerName: 'Max (Laptop)',
          fensterId: null,
          details: { name: 'Max (Laptop)', adresse: '10.10.32.3', publicKey: 'Pgf4aS+6…ZB9c=' },
        },
      ]);
      render(<FernwartungPage />);
      const protokoll = await screen.findByTestId('fw-protokoll');
      expect(within(protokoll).getByText('Techniker-Zugang gelöscht')).toBeInTheDocument();
      expect(within(protokoll).getByText('Max (Laptop)')).toBeInTheDocument();
      expect(within(protokoll).getByText('10.10.32.3 · Pgf4aS+6…ZB9c= · bleiben vergeben')).toBeInTheDocument();
    });
  });

  describe('SSH-Schlüssel am Techniker-Zugang', () => {
    function zeile(tabelle: HTMLElement, adresse: string): HTMLElement {
      return within(tabelle).getByText(adresse).closest('tr') as HTMLElement;
    }
    const tablet = { ...max, id: 't2', name: 'Werkstatt-Tablet', adresse: '10.10.32.3' };

    beforeEach(() => {
      fernwartungTechniker.mockResolvedValue([maxMitSsh, tablet]);
    });

    it('zeigt den Fingerabdruck - oder ehrlich, dass der Zugang nur den Netzweg öffnet', async () => {
      render(<FernwartungPage />);
      const tabelle = await screen.findByTestId('fw-techniker');
      expect(within(zeile(tabelle, '10.10.32.2')).getByText(FINGERABDRUCK)).toBeInTheDocument();
      expect(within(zeile(tabelle, '10.10.32.2')).getByText('RSA 3072')).toBeInTheDocument();
      expect(within(zeile(tabelle, '10.10.32.3')).getByText('keiner')).toBeInTheDocument();
      expect(within(zeile(tabelle, '10.10.32.3')).getByText('Fenster öffnen nur den Netzweg')).toBeInTheDocument();
      // Die Seite verspricht nicht, dass eine Box den Schlüssel schon holt.
      expect(screen.getByTestId('fw-ssh-stand')).toHaveTextContent(/Abholen können ihn die Boxen noch nicht/);
    });

    it('in der Zeile eines offenen Fensters stehen die fertigen Befehle für SSH und die Web-App', async () => {
      fernwartungBoxen.mockResolvedValue([box({ laufendeFenster: [offenesFenster()] })]);
      render(<FernwartungPage />);
      const boxen = await screen.findByTestId('fw-boxen');
      const anmeldung = within(boxen).getByTestId('fw-anmeldung');
      expect(within(anmeldung).getByText('ssh -i ~/.ssh/id_rsa_voltpilot -p 2222 root@10.10.16.2')).toBeInTheDocument();
      expect(
        within(anmeldung).getByText('ssh -i ~/.ssh/id_rsa_voltpilot -p 2222 -L 8484:127.0.0.1:8484 root@10.10.16.2'),
      ).toBeInTheDocument();
      expect(within(anmeldung).getByText('http://127.0.0.1:8484')).toBeInTheDocument();
      expect(within(anmeldung).getByRole('button', { name: 'SSH-Befehl kopieren' })).toBeEnabled();
      expect(within(anmeldung).getByRole('button', { name: 'Befehl für die Web-App kopieren' })).toBeEnabled();
      expect(within(anmeldung).getByTestId('fw-anmeldung-vorhanden')).toHaveTextContent(FINGERABDRUCK);
    });

    it('ein Fenster für einen Zugang ohne SSH-Schlüssel heißt „nur Netzweg", ein geplantes zeigt keine Befehle', async () => {
      fernwartungBoxen.mockResolvedValue([
        box({
          laufendeFenster: [
            offenesFenster({ technikerId: 't2', technikerName: 'Werkstatt-Tablet' }),
            offenesFenster({ id: 'f2', zustand: 'geplant', beginn: new Date(Date.now() + 3_600_000).toISOString() }),
          ],
        }),
      ]);
      render(<FernwartungPage />);
      const boxen = await screen.findByTestId('fw-boxen');
      expect(within(boxen).getAllByTestId('fw-anmeldung')).toHaveLength(1);
      expect(within(boxen).getByTestId('fw-anmeldung-fehlt')).toHaveTextContent(
        'Nur Netzweg: „Werkstatt-Tablet“ hat keinen SSH-Schlüssel.',
      );
    });

    it('sagt beim Öffnen eines Fensters, dass es ohne SSH-Schlüssel nur den Netzweg öffnet', async () => {
      render(<FernwartungPage />);
      const boxen = await screen.findByTestId('fw-boxen');
      fireEvent.click(
        within(within(boxen).getByText('edge-zay5sdd').closest('tr') as HTMLElement).getByRole('button', {
          name: 'Fenster öffnen',
        }),
      );
      const dialog = await screen.findByRole('dialog');
      // Zwei freie Zugänge: nichts ist vorgewählt, also auch kein Hinweis.
      expect(within(dialog).queryByTestId('fw-fenster-nur-netzweg')).toBeNull();
      fireEvent.click(within(dialog).getByRole('combobox', { name: /Techniker-Zugang/ }));
      fireEvent.click(await screen.findByRole('option', { name: /Werkstatt-Tablet/ }));
      expect(await within(dialog).findByTestId('fw-fenster-nur-netzweg')).toHaveTextContent(
        'Dieses Fenster öffnet nur den Netzweg. Der Zugang „Werkstatt-Tablet“ hat keinen SSH-Schlüssel',
      );
      fireEvent.click(within(dialog).getByRole('combobox', { name: /Techniker-Zugang/ }));
      fireEvent.click(await screen.findByRole('option', { name: /Max \(Laptop\)/ }));
      expect(await within(dialog).findByTestId('fw-fenster-ssh')).toHaveTextContent(`${FINGERABDRUCK} (RSA 3072)`);
      expect(within(dialog).queryByTestId('fw-fenster-nur-netzweg')).toBeNull();
    });

    it('hinterlegt einen Schlüssel am Zugang und zeigt den Fingerabdruck der API', async () => {
      fernwartungTechnikerSshSetzen.mockResolvedValue({ ...tablet, sshPublicKey: rsaZeile(), sshFingerabdruck: 'SHA256:neu', sshBits: 2048 });
      render(<FernwartungPage />);
      const tabelle = await screen.findByTestId('fw-techniker');
      fireEvent.click(within(zeile(tabelle, '10.10.32.3')).getByRole('button', { name: 'SSH-Schlüssel' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Zugang „Werkstatt-Tablet“ (10.10.32.3)')).toBeInTheDocument();
      expect(within(dialog).getByTestId('fw-ssh-aktuell')).toHaveTextContent('Kein SSH-Schlüssel hinterlegt');
      // Die Befehle zum Erzeugen stehen im Dialog, für Windows und Linux.
      const erzeugen = within(dialog).getByTestId('fw-ssh-erzeugen');
      expect(within(erzeugen).getByText('Windows (PowerShell)')).toBeInTheDocument();
      expect(within(erzeugen).getByText('ssh-keygen -t rsa -b 3072 -f ~/.ssh/id_rsa_voltpilot')).toBeInTheDocument();
      expect(
        within(erzeugen).getByText('ssh-keygen -t rsa -b 3072 -f $env:USERPROFILE\\.ssh\\id_rsa_voltpilot'),
      ).toBeInTheDocument();

      // Leer und Ed25519 gehen nicht raus; der Fehler nennt den Befehl.
      const feld = within(dialog).getByLabelText(/Öffentlicher SSH-Schlüssel/);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Schlüssel hinterlegen' }));
      expect(await within(dialog).findByText('Der SSH-Schlüssel fehlt.')).toBeInTheDocument();
      expect(feld).toHaveFocus();
      fireEvent.change(feld, { target: { value: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA== max@laptop' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Schlüssel hinterlegen' }));
      expect(await within(dialog).findByText(/Ed25519-Schlüssel.*nur RSA.*ssh-keygen -t rsa -b 3072/)).toBeInTheDocument();
      expect(fernwartungTechnikerSshSetzen).not.toHaveBeenCalled();

      fireEvent.change(feld, { target: { value: `${rsaZeile()} max@laptop\n` } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Schlüssel hinterlegen' }));
      await waitFor(() => expect(fernwartungTechnikerSshSetzen).toHaveBeenCalledWith('t2', `${rsaZeile()} max@laptop`));
      expect(await within(dialog).findByTestId('fw-ssh-fingerabdruck')).toHaveTextContent('SHA256:neu (RSA 2048)');
      expect(within(dialog).getByText('ssh-keygen -lf ~/.ssh/id_rsa_voltpilot.pub')).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Fertig' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('ein privater Schlüssel verlässt den Browser nicht', async () => {
      render(<FernwartungPage />);
      const tabelle = await screen.findByTestId('fw-techniker');
      fireEvent.click(within(zeile(tabelle, '10.10.32.3')).getByRole('button', { name: 'SSH-Schlüssel' }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText(/Öffentlicher SSH-Schlüssel/), {
        target: { value: '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\n-----END OPENSSH PRIVATE KEY-----' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Schlüssel hinterlegen' }));
      expect(await within(dialog).findByText(/Das ist ein privater Schlüssel/)).toBeInTheDocument();
      expect(fernwartungTechnikerSshSetzen).not.toHaveBeenCalled();
    });

    it('zeigt die Ablehnung der API und entfernt einen Schlüssel erst nach Rückfrage', async () => {
      fernwartungTechnikerSshSetzen.mockRejectedValue(new ApiError(400, 'Der SSH-Schlüssel ist beschädigt oder unvollständig.'));
      fernwartungTechnikerSshEntfernen.mockResolvedValue(max);
      render(<FernwartungPage />);
      const tabelle = await screen.findByTestId('fw-techniker');
      fireEvent.click(within(zeile(tabelle, '10.10.32.2')).getByRole('button', { name: 'SSH-Schlüssel' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByTestId('fw-ssh-aktuell')).toHaveTextContent(`${FINGERABDRUCK} (RSA 3072)`);
      fireEvent.change(within(dialog).getByLabelText(/Öffentlicher SSH-Schlüssel/), { target: { value: rsaZeile() } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Schlüssel ersetzen' }));
      expect(await within(dialog).findByText('Der SSH-Schlüssel ist beschädigt oder unvollständig.')).toBeInTheDocument();

      fireEvent.click(within(dialog).getByRole('button', { name: 'Entfernen' }));
      expect(within(dialog).getByTestId('fw-ssh-entfernen')).toHaveTextContent(/öffnen danach\s+nur noch den Netzweg/);
      expect(fernwartungTechnikerSshEntfernen).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Zurück' }));
      expect(within(dialog).queryByTestId('fw-ssh-entfernen')).toBeNull();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Entfernen' }));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Schlüssel entfernen' }));
      await waitFor(() => expect(fernwartungTechnikerSshEntfernen).toHaveBeenCalledWith('t1'));
      expect(await within(dialog).findByText(/SSH-Schlüssel entfernt/)).toBeInTheDocument();
    });

    it('beim Anlegen ist der SSH-Schlüssel freiwillig, ein falscher hält das Anlegen aber auf', async () => {
      fernwartungTechnikerAnlegen.mockResolvedValue({ techniker: { ...tablet, id: 't3' }, server });
      render(<FernwartungPage />);
      await screen.findByTestId('fw-techniker');
      fireEvent.click(screen.getByRole('button', { name: 'Zugang anlegen' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByTestId('fw-ssh-erzeugen')).toBeInTheDocument();
      fireEvent.change(within(dialog).getByLabelText(/Name/), { target: { value: 'Neu (Laptop)' } });
      fireEvent.change(within(dialog).getByLabelText(/Öffentlicher WireGuard-Schlüssel/), {
        target: { value: 'SBsk0U9z6BgB/U8nb+L9PdK/46p7mBvWRQe8I0Vg3C0=' },
      });
      const ssh = within(dialog).getByLabelText(/Öffentlicher SSH-Schlüssel/);
      fireEvent.change(ssh, { target: { value: 'kein schluessel' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Zugang anlegen' }));
      expect(await within(dialog).findByText(/kein öffentlicher SSH-Schlüssel/)).toBeInTheDocument();
      expect(ssh).toHaveFocus();
      expect(fernwartungTechnikerAnlegen).not.toHaveBeenCalled();

      fireEvent.change(ssh, { target: { value: '' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Zugang anlegen' }));
      await waitFor(() =>
        expect(fernwartungTechnikerAnlegen).toHaveBeenCalledWith({
          name: 'Neu (Laptop)',
          publicKey: 'SBsk0U9z6BgB/U8nb+L9PdK/46p7mBvWRQe8I0Vg3C0=',
          notiz: null,
          sshPublicKey: null,
        }),
      );
      expect(await within(dialog).findByTestId('fw-techniker-ohne-ssh')).toHaveTextContent('nur Netzweg');
    });

    it('das Protokoll nennt gesetzte und entfernte SSH-Schlüssel mit Fingerabdruck', async () => {
      fernwartungProtokoll.mockResolvedValue([
        {
          id: 'p8',
          zeit: new Date().toISOString(),
          akteur: 'admin',
          aktion: 'techniker_ssh_schluessel_gesetzt',
          edgeRef: null,
          technikerId: 't1',
          technikerName: 'Max (Laptop)',
          fensterId: null,
          details: { name: 'Max (Laptop)', fingerabdruck: FINGERABDRUCK, bits: '3072' },
        },
      ]);
      render(<FernwartungPage />);
      const protokoll = await screen.findByTestId('fw-protokoll');
      expect(within(protokoll).getByText('SSH-Schlüssel gesetzt')).toBeInTheDocument();
      expect(within(protokoll).getByText(`${FINGERABDRUCK} · RSA 3072`)).toBeInTheDocument();
    });
  });

  it('warnt, wenn der Tunnel-Dienst nicht abholt', async () => {
    fernwartung.mockResolvedValue(uebersicht({ abrufe: [] }));
    render(<FernwartungPage />);
    expect(await screen.findByTestId('fw-dienst')).toHaveTextContent('noch nie abgeholt');
  });

  it('ein Ladefehler zeigt den Grund und einen Weg zurück', async () => {
    fernwartung.mockRejectedValue(new ApiError(500, 'Server-Fehler'));
    render(<FernwartungPage />);
    expect(await screen.findByText('Server-Fehler')).toBeInTheDocument();
  });
});
