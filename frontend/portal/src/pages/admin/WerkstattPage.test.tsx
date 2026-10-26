import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api';

const werkstattBoxen = vi.fn();
const werkstattGrundlagen = vi.fn();
const werkstattBoxAnlegen = vi.fn();
const werkstattSchritt = vi.fn();
const werkstattLanNetz = vi.fn();
const werkstattAbnahme = vi.fn();
const fernwartung = vi.fn();
const fernwartungBoxen = vi.fn();
const fernwartungTechniker = vi.fn();
const fernwartungFenster = vi.fn();
const fernwartungFensterOeffnen = vi.fn();
const fernwartungFensterSchliessen = vi.fn();
const fernwartungSchluessel = vi.fn();

vi.mock('../../admin/adminApi', () => ({
  adminApi: {
    werkstattBoxen: () => werkstattBoxen(),
    werkstattGrundlagen: () => werkstattGrundlagen(),
    werkstattBoxAnlegen: (i: unknown) => werkstattBoxAnlegen(i),
    werkstattSchritt: (r: string, s: string, e: boolean) => werkstattSchritt(r, s, e),
    werkstattLanNetz: (r: string, l: string) => werkstattLanNetz(r, l),
    werkstattAbnahme: (r: string, i: unknown) => werkstattAbnahme(r, i),
    fernwartung: () => fernwartung(),
    fernwartungBoxen: () => fernwartungBoxen(),
    fernwartungTechniker: () => fernwartungTechniker(),
    fernwartungFenster: (b: string) => fernwartungFenster(b),
    fernwartungFensterOeffnen: (i: unknown) => fernwartungFensterOeffnen(i),
    fernwartungFensterSchliessen: (id: string) => fernwartungFensterSchliessen(id),
    fernwartungSchluessel: (r: string, i: unknown) => fernwartungSchluessel(r, i),
  },
}));

const { WerkstattPage } = await import('./WerkstattPage');

const REF = 'edge-wrk7abg';
const HOST = 'SHA256:' + 'Q'.repeat(42) + 'c';
const jetzt = new Date().toISOString();

const server = {
  endpunkt: 'wartung.example.test',
  port: 51820,
  publicKey: 'LnLMuBG+dDEeaEKlQrdTlPifX2fk0hOaB/NFc/BudjE=',
  eingerichtet: true,
  boxNetz: '10.10.16.0/20',
  technikerNetz: '10.10.32.0/24',
  boxServerAdresse: '10.10.16.1',
  technikerServerAdresse: '10.10.32.1',
};

function uebersicht() {
  return {
    server,
    maxFensterMinuten: 1440,
    abrufe: [{ dienst: 'voltpilot-tunnel-dienst', zuletztAm: jetzt, peers: 3, fenster: 0 }],
    rueckmeldungen: [],
    boxenAktiv: 1,
    boxenGesperrt: 0,
    technikerAktiv: 1,
    technikerGesperrt: 0,
    fensterOffen: 0,
    fensterGeplant: 0,
    stand: jetzt,
  };
}

function wsBox(over: Record<string, unknown> = {}) {
  return {
    id: 'w1',
    edgeRef: REF,
    boxArt: 'edge-light',
    lanNetz: null,
    schritte: { openwrt: { am: jetzt, von: 'admin' } },
    notiz: null,
    angelegtAm: jetzt,
    angelegtVon: 'admin',
    geaendertAm: jetzt,
    abnahmen: [],
    ...over,
  };
}

const tunnel = {
  id: 'b1',
  edgeRef: REF,
  publicKey: 'jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEM=',
  publicKeyKurz: 'jUg9DePF…5HiEM=',
  adresse: '10.10.16.7',
  status: 'aktiv',
  notiz: 'Werkstatt',
  angelegtAm: jetzt,
  geaendertAm: jetzt,
  siteId: null,
  siteName: null,
  tenantId: null,
  tenantName: null,
  laufendeFenster: [],
  rueckmeldung: null,
};

const techniker = {
  id: 't1',
  name: 'Alex (Laptop)',
  publicKey: 'FY4LLXFaOvh8LPZu/gA4AeS2WJjXkuOUPB4hlxBI8/Y=',
  publicKeyKurz: 'FY4LLXFa…BI8/Y=',
  adresse: '10.10.32.3',
  status: 'aktiv',
  notiz: null,
  angelegtAm: jetzt,
  geaendertAm: jetzt,
  sshPublicKey: 'ssh-rsa AAAA',
  sshFingerabdruck: 'SHA256:TDOx3bpPNtPLIdd+juZoGcDMz3ZRCklaP5G6aBrp9Zc',
  sshBits: 3072,
};

const geschlossen = {
  id: 'f9',
  edgeRef: REF,
  technikerId: 't1',
  technikerName: 'Alex (Laptop)',
  grund: 'Werkstatt-Probe',
  beginn: '2026-10-26T10:00:00Z',
  ende: '2026-10-26T10:15:00Z',
  wirksamesEnde: '2026-10-26T10:08:00Z',
  zustand: 'geschlossen',
  geoeffnetAm: '2026-10-26T10:00:00Z',
  geoeffnetVon: 'admin',
  geschlossenAm: '2026-10-26T10:08:00Z',
  geschlossenVon: 'admin',
  rueckmeldung: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = '#/werkstatt';
  werkstattBoxen.mockResolvedValue([wsBox()]);
  werkstattGrundlagen.mockResolvedValue({ pruefungen: [], lanNetzVorschlag: '10.213.0.1/24' });
  fernwartung.mockResolvedValue(uebersicht());
  fernwartungBoxen.mockResolvedValue([]);
  fernwartungTechniker.mockResolvedValue([techniker]);
  fernwartungFenster.mockResolvedValue([]);
});

describe('WerkstattPage', () => {
  it('listet die Boxen und sagt oben, dass keine Box mit Stufe 1 versendet wird', async () => {
    render(<WerkstattPage />);
    const tabelle = await screen.findByTestId('ws-boxen');
    const zeile = within(tabelle).getByText(REF).closest('tr')!;
    expect(zeile).toHaveTextContent('1 von 13 Schritten');
    expect(zeile).toHaveTextContent('keiner');
    expect(zeile).toHaveTextContent('offen');
    expect(screen.getByTestId('ws-versand-oben')).toHaveTextContent(/^Nicht versenden\./);
    expect(screen.queryByText(/versandbereit/i)).toBeNull();
  });

  it('führt eine neue Box bis zur Referenz und nimmt die Haken davor mit', async () => {
    const neu = wsBox({ edgeRef: 'edge-wrk8cdb', schritte: {} });
    werkstattBoxAnlegen.mockResolvedValue(neu);
    render(<WerkstattPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Neue Box einrichten/ }));
    expect(await screen.findByText('Neue Box · Edge Light')).toBeInTheDocument();

    fireEvent.click(within(screen.getByTestId('ws-haken-openwrt')).getByRole('checkbox'));
    fireEvent.click(within(screen.getByTestId('ws-haken-kabel')).getByRole('checkbox'));
    // Ab Schritt 5 gibt es noch nichts abzuhaken: die Box steht noch nicht im Register.
    expect(within(screen.getByTestId('ws-haken-status')).getByRole('checkbox')).toBeDisabled();
    expect(werkstattSchritt).not.toHaveBeenCalled();

    const schritt5 = screen.getByTestId('ws-schritt-programm');
    fireEvent.change(within(schritt5).getByLabelText('Referenz der Box'), { target: { value: 'EDGE-WRK8CDX' } });
    fireEvent.click(within(schritt5).getByRole('button', { name: /aufnehmen/ }));
    expect(await within(schritt5).findByText(/stimmt nicht/)).toBeInTheDocument();
    expect(werkstattBoxAnlegen).not.toHaveBeenCalled();

    fireEvent.change(within(schritt5).getByLabelText('Referenz der Box'), { target: { value: ' EDGE-WRK8CDB ' } });
    fireEvent.click(within(schritt5).getByRole('button', { name: /aufnehmen/ }));
    await waitFor(() =>
      expect(werkstattBoxAnlegen).toHaveBeenCalledWith({
        edgeRef: 'edge-wrk8cdb',
        boxArt: 'edge-light',
        schritte: ['openwrt', 'kabel', 'programm'],
      }),
    );
    await waitFor(() => expect(window.location.hash).toBe('#/werkstatt?box=edge-wrk8cdb'));
  });

  it('erzeugt das Root-Passwort im Browser, zeigt es einmal und schickt es nirgends hin', async () => {
    window.location.hash = `#/werkstatt?box=${REF}`;
    werkstattSchritt.mockResolvedValue(wsBox({ schritte: { openwrt: { am: jetzt, von: 'admin' }, passwort: { am: jetzt, von: 'admin' } } }));
    render(<WerkstattPage />);
    const schritt = await screen.findByTestId('ws-schritt-passwort');
    fireEvent.click(within(schritt).getByRole('button', { name: 'Passwort erzeugen' }));
    const feld = within(schritt).getByTestId('ws-passwort');
    const passwort = feld.querySelector('code')!.textContent!;
    expect(passwort).toMatch(/^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){4}$/);

    fireEvent.click(within(schritt).getByTestId('ws-passwort-abgelegt').querySelector('input')!);
    await waitFor(() => expect(werkstattSchritt).toHaveBeenCalledWith(REF, 'passwort', true));
    expect(screen.queryByText(passwort)).toBeNull();
    const alleAufrufe = [werkstattSchritt, werkstattBoxAnlegen, werkstattLanNetz, werkstattAbnahme, fernwartungSchluessel]
      .flatMap((m) => m.mock.calls)
      .map((c) => JSON.stringify(c));
    expect(alleAufrufe.join(' ')).not.toContain(passwort);
  });

  it('hinterlegt den Tunnel-Schlüssel und zeigt danach die Befehlszeile mit dem Namen der Box', async () => {
    window.location.hash = `#/werkstatt?box=${REF}`;
    fernwartungSchluessel.mockResolvedValue({ ergebnis: 'angelegt', box: tunnel, server });
    render(<WerkstattPage />);
    const schritt6 = await screen.findByTestId('ws-schritt-tunnel_schluessel');
    expect(screen.getByTestId('ws-schritt-tunnel')).toHaveTextContent('sobald der Tunnel-Schlüssel hinterlegt ist');

    fernwartungBoxen.mockResolvedValue([tunnel]);
    fireEvent.change(within(schritt6).getByLabelText('Öffentlicher Tunnel-Schlüssel'), { target: { value: tunnel.publicKey } });
    fireEvent.click(within(schritt6).getByRole('button', { name: 'Im Portal hinterlegen' }));
    await waitFor(() => expect(fernwartungSchluessel).toHaveBeenCalledWith(REF, { publicKey: tunnel.publicKey, notiz: 'Werkstatt' }));
    expect(await within(schritt6).findByTestId('ws-tunnel-hinterlegt')).toHaveTextContent('10.10.16.7');
    expect(screen.getByTestId('ws-schritt-tunnel')).toHaveTextContent(
      'edge-light/openwrt/service-tunnel.sh mango 10.10.16.7 51820',
    );
  });

  it('öffnet die Werkstatt-Probe für 30 Minuten mit dem Zugang, der einen SSH-Schlüssel hat', async () => {
    window.location.hash = `#/werkstatt?box=${REF}`;
    fernwartungBoxen.mockResolvedValue([tunnel]);
    fernwartungFensterOeffnen.mockResolvedValue({ ...geschlossen, zustand: 'offen' });
    render(<WerkstattPage />);
    const probe = await screen.findByTestId('ws-probe-start');
    fireEvent.click(within(probe).getByRole('button', { name: /Fenster für die Probe öffnen \(30 Minuten\)/ }));
    await waitFor(() =>
      expect(fernwartungFensterOeffnen).toHaveBeenCalledWith({
        edgeRef: REF,
        technikerId: 't1',
        grund: 'Werkstatt-Probe',
        dauerMinuten: 30,
      }),
    );
  });

  it('hält die Abnahme erst fest, wenn alles da ist, mit dem Fenster der Probe', async () => {
    window.location.hash = `#/werkstatt?box=${REF}`;
    const box = wsBox({ lanNetz: '10.213.0.1/24' });
    werkstattBoxen.mockResolvedValue([box]);
    fernwartungBoxen.mockResolvedValue([tunnel]);
    fernwartungFenster.mockResolvedValue([geschlossen]);
    werkstattAbnahme.mockResolvedValue({});
    render(<WerkstattPage />);
    const karte = await screen.findByTestId('ws-karte-abnahme');
    const knopf = within(karte).getByRole('button', { name: 'Abnahme festhalten' });
    expect(knopf).toBeDisabled();
    expect(within(karte).getByTestId('ws-abnahme-sperre')).toHaveTextContent('8 von 8');

    for (const haken of within(karte).getAllByRole('checkbox')) fireEvent.click(haken);
    fireEvent.change(within(karte).getByLabelText('Host-Schlüssel (aus Schritt 10)'), { target: { value: `3072 ${HOST} [10.10.16.7]:2222 (RSA)` } });
    fireEvent.change(within(karte).getByLabelText('Fassung des Programms (aus /health)'), { target: { value: 'edge-light-g9c3368e3a' } });
    expect(knopf).toBeEnabled();
    fireEvent.click(knopf);
    await waitFor(() =>
      expect(werkstattAbnahme).toHaveBeenCalledWith(REF, {
        hostSchluessel: HOST,
        fassung: 'edge-light-g9c3368e3a',
        pruefungen: [
          'root_passwort',
          'notfall_schluessel',
          'tunnel_status',
          'anmeldeprobe',
          'host_schluessel',
          'fenster_zu',
          'lan_netz',
          'neustart',
        ],
        probeFensterId: 'f9',
        notiz: null,
      }),
    );
  });

  it('zeigt eine Abnahme als Protokoll und am Ende wieder den Satz zum Versand', async () => {
    window.location.hash = `#/werkstatt?box=${REF}`;
    werkstattBoxen.mockResolvedValue([
      wsBox({
        lanNetz: '10.213.0.1/24',
        abnahmen: [
          {
            id: 'a1',
            edgeRef: REF,
            hostSchluessel: HOST,
            fassung: 'edge-light-g9c3368e3a',
            tunnelAdresse: '10.10.16.7',
            lanNetz: '10.213.0.1/24',
            pruefungen: ['root_passwort'],
            probe: { ...geschlossen, fensterId: 'f9', ende: geschlossen.wirksamesEnde, schluesselAbgeholtUm: null, gemeldetAm: null },
            notiz: null,
            erfasstAm: jetzt,
            erfasstVon: 'admin',
          },
        ],
      }),
    ]);
    fernwartungBoxen.mockResolvedValue([tunnel]);
    render(<WerkstattPage />);
    const protokoll = await screen.findByTestId('ws-abnahme-protokoll');
    expect(protokoll).toHaveTextContent(HOST);
    expect(protokoll).toHaveTextContent('nicht gemeldet');
    expect(screen.getByTestId('ws-versand')).toHaveTextContent('Keine Box mit Stufe 1 geht an einen Kunden');
    expect(screen.getByTestId('ws-beschriftung')).toHaveTextContent('EDGE-WRK7ABG');
    expect(screen.getByTestId('ws-beschriftung')).toHaveTextContent('https://portal.voltpilot.de/k/edge-wrk7abg');
  });

  it('nennt den Grund der API, wenn das LAN-Netz ein übliches Heimnetz ist', async () => {
    window.location.hash = `#/werkstatt?box=${REF}`;
    werkstattLanNetz.mockRejectedValue(new ApiError(422, '192.168.1.0/24 enthält 192.168.1.0/24, ein übliches Netz von Heimroutern.'));
    render(<WerkstattPage />);
    const schritt = await screen.findByTestId('ws-schritt-lan');
    const feld = within(schritt).getByLabelText(/LAN der Box/);
    expect(feld).toHaveValue('10.213.0.1/24');
    fireEvent.change(feld, { target: { value: '192.168.1.1/24' } });
    fireEvent.click(within(schritt).getByRole('button', { name: 'Netz festhalten' }));
    expect(await within(schritt).findByText(/übliches Netz von Heimroutern/)).toBeInTheDocument();
  });

  it('zeigt die Docker-Box im Register ohne Ablauf', async () => {
    window.location.hash = '#/werkstatt?box=edge-wrk8cdb';
    werkstattBoxen.mockResolvedValue([wsBox({ edgeRef: 'edge-wrk8cdb', boxArt: 'edge-app', schritte: {} })]);
    render(<WerkstattPage />);
    expect(await screen.findByTestId('ws-docker')).toHaveTextContent('Entscheid 9a');
    expect(screen.queryByTestId('ws-ablauf')).toBeNull();
  });
});
