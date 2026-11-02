import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api';
import type { LaufStand, WerkstattAnsicht, WerkstattDienst, WerkstattFreigabe } from '../../werkstattBank';

const werkstattBoxen = vi.fn();
const werkstattDienst = vi.fn();
const werkstattFreigaben = vi.fn();
const werkstattFreigeben = vi.fn();
const werkstattFreigabeBeenden = vi.fn();

vi.mock('../../admin/adminApi', () => ({
  adminApi: {
    werkstattBoxen: () => werkstattBoxen(),
    werkstattDienst: () => werkstattDienst(),
    werkstattFreigaben: () => werkstattFreigaben(),
    werkstattFreigeben: (i: unknown) => werkstattFreigeben(i),
    werkstattFreigabeBeenden: (k: string) => werkstattFreigabeBeenden(k),
  },
}));

const { WerkstattPage } = await import('./WerkstattPage');

/** Die Ansicht, wie Go sie schreibt (Vertrag werkstatt-ansicht-v1). */
const vektor: WerkstattAnsicht = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../../docs/contracts/werkstatt-ansicht-v1.example.json'), 'utf8'),
);
const SHA = '0123456789abcdef'.repeat(4);

function freigabe(over: Partial<WerkstattFreigabe> = {}): WerkstattFreigabe {
  return {
    id: 'f1', kennung: '2026-11-mango-1', boxArt: 'mango', gueltigAb: '2026-11-02T08:00:00Z', gueltigBis: '2026-11-30T08:00:00Z',
    obergrenze: 20, openwrt: { fassung: '25.12.5', datei: 'openwrt-25.12.5-x-sysupgrade.bin', sha256: SHA, quelle: 'https://o.example/' },
    edgeLight: { fassung: 'edge-light-2026.11.1', quelle: 'https://e.example/', programmSha256: SHA, skripteSha256: SHA },
    notiz: null, erteiltAm: '2026-11-02T08:00:00Z', erteiltVon: 'Admin', beendetAm: null, beendetVon: null, zustand: 'laufend', grund: null,
    ...over,
  };
}

function dienst(lauf: Partial<LaufStand> | null, over: Partial<WerkstattDienst> = {}): WerkstattDienst {
  const ansicht: WerkstattAnsicht = { ...vektor, lauf: lauf === null ? null : { ...(vektor.lauf as LaufStand), ...lauf } };
  return { ansicht, gemeldetAm: new Date().toISOString(), dienstZeit: ansicht.zeit, alterSekunden: 4, aktuell: true, laeufe: [], ...over };
}

function box(edgeRef: string) {
  return {
    id: edgeRef, edgeRef, boxArt: 'edge-light', lanNetz: '10.213.0.1/24', schritte: {}, notiz: null,
    angelegtAm: '2026-11-02T09:00:00Z', angelegtVon: 'Dienst', geaendertAm: '2026-11-02T09:00:00Z',
    abnahmen: [{
      id: 'a1', edgeRef, hostSchluessel: 'SHA256:' + 'Q'.repeat(43), fassung: 'edge-light-2026.11.1', tunnelAdresse: '10.10.16.5',
      lanNetz: '10.213.0.1/24', pruefungen: [], notiz: null, erfasstAm: '2026-11-02T10:42:00Z', erfasstVon: 'werkstatt-dienst',
      probe: { fensterId: 'p1', technikerName: 'Werkstatt-Dienst', grund: 'Werkstatt-Probe', beginn: '2026-11-02T10:30:00Z', ende: '2026-11-02T11:00:00Z',
        geschlossenAm: '2026-11-02T10:35:00Z', geschlossenVon: 'werkstatt-dienst', schluesselAbgeholtUm: null, gemeldetAm: null },
      quelle: 'dienst', belege: { anmeldeprobe: 'Schritt probe: Anmeldung über den Tunnel', neustart: 'Schritt neustart: frischer Handshake' },
      freigabeId: 'f1', einloesungId: 'e1', passwortAge: '-----BEGIN AGE ENCRYPTED FILE-----\nYWdl\n-----END AGE ENCRYPTED FILE-----',
    }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = '#/werkstatt';
  werkstattBoxen.mockResolvedValue([box('edge-5t2dcy6')]);
  werkstattFreigaben.mockResolvedValue([freigabe()]);
  werkstattDienst.mockResolvedValue(dienst({}));
});

describe('Werkstatt: Übersicht am Rechner', () => {
  it('zeigt Freigabe, Brücke, Boxen und nennt „Nicht versenden“', async () => {
    render(<WerkstattPage />);
    expect(await screen.findByTestId('ws-freigabe')).toHaveTextContent('Werkstatt freigegeben · Mango');
    expect(screen.getByTestId('ws-freigabe')).toHaveTextContent('Edge Light 2026.11.1 · OpenWrt 25.12.5 · bis 30.11.');
    expect(screen.getByTestId('ws-bruecke')).toHaveTextContent('bereit · Kabel am Werkstatt-Anschluss');
    expect(screen.getByTestId('ws-versand-oben')).toHaveTextContent('Nicht versenden: Stufe 1');
    expect(within(screen.getByTestId('ws-boxen')).getByText('edge-5t2dcy6')).toBeInTheDocument();
    // Keine Handschritte mehr: kein Passwort-Generator, keine Probe-Knöpfe.
    expect(screen.queryByText(/Passwort erzeugen/)).toBeNull();
    expect(screen.queryByText(/Fenster öffnen/)).toBeNull();
  });

  it('meldet sich der Dienst nicht, sagt die Seite das statt einen alten Stand zu zeigen', async () => {
    werkstattDienst.mockResolvedValue(dienst({}, { aktuell: false, alterSekunden: 600 }));
    render(<WerkstattPage />);
    expect(await screen.findByTestId('ws-dienst-veraltet')).toHaveTextContent('vor 10 Minuten');
    expect(screen.getByTestId('ws-bruecke')).toHaveTextContent('kein aktueller Stand');
  });

  it('eine gewählte Box zeigt ihre Belege (?box= ist auch das Ziel des Direktlinks)', async () => {
    window.location.hash = '#/werkstatt?box=edge-5t2dcy6';
    render(<WerkstattPage />);
    const detail = await screen.findByTestId('ws-detail');
    expect(detail).toHaveTextContent('edge-5t2dcy6');
    expect(within(detail).getByTestId('ws-belege')).toHaveTextContent('Schritt probe: Anmeldung über den Tunnel');
    expect(within(detail).getByTestId('ws-abnahme-protokoll')).toHaveTextContent('vom Werkstatt-Dienst');
    expect(within(detail).getByTestId('ws-abnahme-protokoll')).toHaveTextContent('nur mit dem age-Schlüssel');
  });

  it('Freigabe beenden fragt nach und ruft die API', async () => {
    werkstattFreigabeBeenden.mockResolvedValue(freigabe({ zustand: 'beendet' }));
    render(<WerkstattPage />);
    fireEvent.click(await screen.findByTestId('ws-freigabe-beenden'));
    fireEvent.click(await screen.findByTestId('ws-beenden-bestaetigen'));
    await waitFor(() => expect(werkstattFreigabeBeenden).toHaveBeenCalledWith('2026-11-mango-1'));
  });

  it('Werkstatt freigeben: Block aus freigabe-edge-light.json, Fehler der API stehen im Dialog', async () => {
    werkstattFreigaben.mockResolvedValue([]);
    werkstattFreigeben.mockRejectedValue(new ApiError(422, 'Freigabe ungültig: openwrt.sha256: 64 Zeichen 0-9a-f'));
    render(<WerkstattPage />);
    fireEvent.click(await screen.findByTestId('ws-freigeben'));
    fireEvent.click(screen.getByTestId('ws-freigabe-absenden'));
    expect(await screen.findByTestId('ws-freigabe-fehler')).toHaveTextContent('edge_light');
    expect(werkstattFreigeben).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('ws-freigabe-block'), {
      target: { value: JSON.stringify({ edge_light: { fassung: 'edge-light-2026.11.1', quelle: 'https://e.example/', programm_sha256: SHA, skripte_sha256: SHA } }) },
    });
    fireEvent.click(screen.getByTestId('ws-freigabe-absenden'));
    await waitFor(() => expect(werkstattFreigeben).toHaveBeenCalledTimes(1));
    expect(werkstattFreigeben.mock.calls[0][0]).toMatchObject({ boxArt: 'mango', tage: 30, obergrenze: 20,
      edgeLight: { fassung: 'edge-light-2026.11.1', programmSha256: SHA } });
    expect(await screen.findByTestId('ws-freigabe-fehler')).toHaveTextContent('openwrt.sha256');
  });
});

describe('Werkstatt: Bildschirme an der Werkbank', () => {
  it('Start → Mango → Läuft mit sechs Phasen und Restzeit; kein „Weiter“-Knopf', async () => {
    window.location.hash = '#/werkstatt?werkbank=1';
    render(<WerkstattPage />);
    expect(await screen.findByTestId('wsb')).toHaveAttribute('data-bildschirm', 'start');
    fireEvent.click(screen.getByTestId('wsb-mango'));
    expect(screen.getByTestId('wsb')).toHaveAttribute('data-bildschirm', 'laeuft');
    expect(screen.getByTestId('wsb-restzeit')).toHaveTextContent(/Noch ca\. \d+ Minuten/);
    expect(within(screen.getByTestId('wsb-phasen')).getAllByRole('listitem')).toHaveLength(6);
    expect(screen.queryByRole('button', { name: /Weiter/ })).toBeNull();
  });

  it('Fertig zeigt Referenz und QR-Code; „Nächste Box“ führt zum Anschließen', async () => {
    window.location.hash = '#/werkstatt?werkbank=1';
    werkstattDienst.mockResolvedValue(dienst({ zustand: 'fertig' }));
    render(<WerkstattPage />);
    fireEvent.click(await screen.findByTestId('wsb-mango'));
    expect(screen.getByTestId('wsb-ref')).toHaveTextContent('EDGE-K7M2XQ3');
    expect(screen.getByTestId('wsb-qr')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('wsb-naechste'));
    expect(screen.getByTestId('wsb')).toHaveAttribute('data-bildschirm', 'anschliessen');
    expect(within(screen.getByTestId('wsb-warten')).getByText('Kabel steckt').closest('li')).toHaveAttribute('data-zustand', 'ok');
  });

  it('Problem sagt, was passiert ist und was zu tun ist; Technik nur eingeklappt', async () => {
    window.location.hash = '#/werkstatt?werkbank=1';
    werkstattDienst.mockResolvedValue(dienst({ zustand: 'angehalten', schritt: 'probe', grund: 'kein Handshake an wg_wartung' }));
    render(<WerkstattPage />);
    fireEvent.click(await screen.findByTestId('wsb-mango'));
    expect(screen.getByTestId('wsb-problem')).toHaveTextContent('Hier hat etwas nicht geklappt.');
    expect(screen.getByRole('heading', { name: 'Probe über den Wartungstunnel' })).toBeInTheDocument();
    const details = screen.getByTestId('wsb-details');
    expect(details.tagName).toBe('DETAILS');
    expect(details).not.toHaveAttribute('open');
    expect(details).toHaveTextContent('kein Handshake an wg_wartung');
  });

  it('der Startlader ist der eine Handgriff (M4)', async () => {
    window.location.hash = '#/werkstatt?werkbank=1';
    werkstattDienst.mockResolvedValue(dienst({ zustand: 'angehalten', schritt: 'openwrt', handgriff: 'Startlader (Handgriff M4): Mango vom Strom …' }));
    render(<WerkstattPage />);
    fireEvent.click(await screen.findByTestId('wsb-mango'));
    expect(screen.getByTestId('wsb')).toHaveAttribute('data-bildschirm', 'startlader');
    expect(screen.getByRole('heading', { name: 'Reset-Knopf drücken' })).toBeInTheDocument();
  });

  it('ohne Meldung des Dienstes: kein alter Stand, sondern was zu tun ist', async () => {
    window.location.hash = '#/werkstatt?werkbank=1';
    werkstattDienst.mockResolvedValue(dienst({}, { aktuell: false, alterSekunden: 300 }));
    render(<WerkstattPage />);
    expect(await screen.findByTestId('wsb-kein-dienst')).toBeInTheDocument();
    expect(screen.queryByTestId('wsb-mango')).toBeNull();
  });
});
