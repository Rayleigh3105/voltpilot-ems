import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api';
import { FEHLER_IM_BEREICH, Fehlergrenze } from '../../components/Fehlergrenze';
import { SCHRITTE, type LaufStand, type WerkstattAnsicht, type WerkstattDienst, type WerkstattFreigabe } from '../../werkstattBank';

const werkstattBoxen = vi.fn();
const werkstattDienst = vi.fn();
const werkstattFreigaben = vi.fn();
const werkstattFreigeben = vi.fn();
const werkstattFreigabeBeenden = vi.fn();
const fernwartungBox = vi.fn();
const fernwartung = vi.fn();
const werkstattBoxEntfernen = vi.fn();

vi.mock('../../admin/adminApi', () => ({
  adminApi: {
    werkstattBoxen: () => werkstattBoxen(),
    werkstattDienst: () => werkstattDienst(),
    werkstattFreigaben: () => werkstattFreigaben(),
    werkstattFreigeben: (i: unknown) => werkstattFreigeben(i),
    werkstattFreigabeBeenden: (k: string) => werkstattFreigabeBeenden(k),
    fernwartungBox: (r: string) => fernwartungBox(r),
    fernwartung: () => fernwartung(),
    werkstattBoxEntfernen: (r: string) => werkstattBoxEntfernen(r),
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
  fernwartungBox.mockRejectedValue(new ApiError(404, 'keine Box'));
  fernwartung.mockResolvedValue({ rueckmeldungen: [] });
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

describe('Werkstatt: Einrichtungs-Detailseite einer Box', () => {
  const fwBox = {
    id: 'b1', edgeRef: 'edge-5t2dcy6', publicKey: 'k', publicKeyKurz: 'AbCd…xyz=', adresse: '10.10.16.5', status: 'aktiv', notiz: null,
    angelegtAm: '2026-11-02T10:00:00Z', geaendertAm: '2026-11-02T10:00:00Z', siteId: null, siteName: null, tenantId: null, tenantName: null,
    laufendeFenster: [], rueckmeldung: null,
  };

  it('ersetzt die Liste durch die Seite der Box, „Alle Boxen“ führt zurück', async () => {
    window.location.hash = '#/werkstatt?box=edge-5t2dcy6';
    render(<WerkstattPage />);
    const seite = await screen.findByTestId('ws-detail');
    expect(screen.queryByTestId('ws-boxen')).toBeNull();
    expect(within(seite).getByTestId('ws-stand')).toHaveTextContent('abgenommen');
    fireEvent.click(within(seite).getByTestId('ws-zurueck'));
    expect(await screen.findByTestId('ws-boxen')).toBeInTheDocument();
    expect(screen.queryByTestId('ws-detail')).toBeNull();
    expect(window.location.hash).toBe('#/werkstatt');
  });

  it('zeigt Hardware, Fassungen, Netz und Schlüssel aus Register, Abnahme und Freigabe', async () => {
    window.location.hash = '#/werkstatt?box=edge-5t2dcy6';
    render(<WerkstattPage />);
    const e = await screen.findByTestId('ws-einrichtung');
    expect(within(e).getByTestId('ws-zeile-hardware')).toHaveTextContent('GL.iNet GL-MT300N-V2');
    expect(within(e).getByTestId('ws-zeile-edge-light')).toHaveTextContent('edge-light-2026.11.1');
    expect(within(e).getByTestId('ws-zeile-openwrt')).toHaveTextContent('25.12.5');
    expect(within(e).getByTestId('ws-zeile-freigabe')).toHaveTextContent('2026-11-mango-1');
    expect(within(e).getByTestId('ws-zeile-lan')).toHaveTextContent('10.213.0.1/24');
    expect(within(e).getByTestId('ws-zeile-tunnel')).toHaveTextContent('10.10.16.5');
    expect(within(e).getByTestId('ws-zeile-host')).toHaveTextContent('SHA256:' + 'Q'.repeat(43));
    // Das Root-Passwort steht nur verschlüsselt da, nie als Klartext.
    expect(screen.getByTestId('ws-passwort-age')).toHaveTextContent('nur mit dem age-Schlüssel');
    expect(screen.getByTestId('ws-detail')).not.toHaveTextContent(/Passwort:/);
  });

  it('Bindung: ohne Tunnel-Schlüssel steht das ehrlich da, nicht „verbunden“', async () => {
    window.location.hash = '#/werkstatt?box=edge-5t2dcy6';
    render(<WerkstattPage />);
    const b = await screen.findByTestId('ws-bindung');
    await waitFor(() => expect(b).toHaveTextContent('noch kein Tunnel-Schlüssel hinterlegt'));
    expect(within(b).getByTestId('ws-zeile-tunnel-schluessel')).toHaveTextContent('nicht hinterlegt');
    expect(within(b).queryByTestId('ws-verbindung')).toBeNull();
    expect(within(b).getByRole('link', { name: 'Fernwartung dieser Box' })).toHaveAttribute('href', '#/fernwartung?box=edge-5t2dcy6');
  });

  it('Bindung: Kunde, Zugang und Verbindung kommen aus der Fernwartung; ohne Meldung des Tunnel-Dienstes „unbekannt“', async () => {
    fernwartungBox.mockResolvedValue({ ...fwBox, siteName: 'Halle 1', tenantName: 'Muster GmbH' });
    window.location.hash = '#/werkstatt?box=edge-5t2dcy6';
    render(<WerkstattPage />);
    const b = await screen.findByTestId('ws-bindung');
    await waitFor(() => expect(within(b).getByTestId('ws-zeile-ort')).toHaveTextContent('Halle 1 · Muster GmbH'));
    expect(within(b).getByTestId('ws-zeile-zugang')).toHaveTextContent('aktiv');
    expect(within(b).getByTestId('ws-zeile-tunnel-schluessel')).toHaveTextContent('AbCd…xyz=');
    expect(within(b).getByTestId('ws-verbindung')).toHaveTextContent('Verbindung unbekannt');
  });

  it('Bindung: ein Fehler der API steht da, ohne die Seite zu kippen', async () => {
    fernwartungBox.mockRejectedValue(new ApiError(500, 'Datenbank nicht erreichbar'));
    window.location.hash = '#/werkstatt?box=edge-5t2dcy6';
    render(<WerkstattPage />);
    expect(await within(await screen.findByTestId('ws-bindung')).findByText('Datenbank nicht erreichbar')).toBeInTheDocument();
    expect(screen.getByTestId('ws-einrichtung')).toBeInTheDocument();
  });

  it('3MF: drei Downloads mit Dateiname, als Datei ohne Kennung der Box beschriftet', async () => {
    window.location.hash = '#/werkstatt?box=edge-5t2dcy6';
    render(<WerkstattPage />);
    const g = await screen.findByTestId('ws-gehaeuse');
    expect(within(g).getByTestId('ws-gehaeuse-hinweis')).toHaveTextContent('ohne Referenz und QR-Code dieser Box');
    for (const name of ['gehaeuse-v04.3mf', 'unterteil.3mf', 'deckel.3mf']) {
      const a = within(within(g).getByTestId(`ws-gehaeuse-${name}`)).getByRole('link');
      expect(a).toHaveAttribute('download', name);
      expect(a).toHaveAttribute('href', expect.stringMatching(/\.3mf(\?.*)?$/));
    }
  });

  it('eine Box ohne Abnahme sagt, was fehlt, statt Werte zu erfinden', async () => {
    const b = box('edge-5t2dcy6');
    werkstattBoxen.mockResolvedValue([{ ...b, abnahmen: [] }]);
    window.location.hash = '#/werkstatt?box=edge-5t2dcy6';
    render(<WerkstattPage />);
    const e = await screen.findByTestId('ws-einrichtung');
    expect(within(e).getByTestId('ws-zeile-edge-light')).toHaveTextContent('–');
    expect(within(e).getByTestId('ws-zeile-host')).toHaveTextContent('–');
    expect(e).toHaveTextContent('Ohne Abnahme gibt es keinen geprüften Stand');
    expect(screen.getByTestId('ws-abnahme')).toHaveTextContent('Noch keine Abnahme.');
  });

  it('frühere Abnahmen stehen aufklappbar unter der neuesten', async () => {
    const b = box('edge-5t2dcy6');
    werkstattBoxen.mockResolvedValue([{ ...b, abnahmen: [b.abnahmen[0], { ...b.abnahmen[0], id: 'a0', fassung: 'edge-light-2026.10.6', quelle: 'hand' }] }]);
    window.location.hash = '#/werkstatt?box=edge-5t2dcy6';
    render(<WerkstattPage />);
    const f = await screen.findByTestId('ws-fruehere');
    expect(f).toHaveTextContent('Frühere Abnahmen (1)');
    expect(f).toHaveTextContent('edge-light-2026.10.6');
  });

  it('die Docker-Box hat keine Beschriftung und keine Druckdatei', async () => {
    const b = box('edge-5t2dcy6');
    werkstattBoxen.mockResolvedValue([{ ...b, boxArt: 'edge-app', abnahmen: [] }]);
    window.location.hash = '#/werkstatt?box=edge-5t2dcy6';
    render(<WerkstattPage />);
    expect(await screen.findByTestId('ws-einrichtung')).toHaveTextContent('Docker-Box');
    expect(screen.queryByTestId('ws-gehaeuse')).toBeNull();
    expect(screen.queryByTestId('ws-beschriftung')).toBeNull();
  });

  it('eine unbekannte Referenz führt zurück zur Liste', async () => {
    window.location.hash = '#/werkstatt?box=edge-unbekannt';
    render(<WerkstattPage />);
    expect(await screen.findByTestId('ws-box')).toHaveTextContent('edge-unbekannt steht nicht in der Werkstatt-Liste');
    fireEvent.click(screen.getByRole('button', { name: 'Alle Boxen' }));
    expect(await screen.findByTestId('ws-boxen')).toBeInTheDocument();
  });
});

describe('Werkstatt: einen unbenutzten Eintrag aus dem Register entfernen', () => {
  const REF = 'edge-pmzasg2';
  const nurRegister = () => ({ ...box(REF), lanNetz: null, abnahmen: [], inGebrauch: [] as string[] });

  it('nur im Register und unbenutzt: Rückfrage auf der Seite nennt die Referenz, danach die Liste ohne die Box', async () => {
    werkstattBoxen.mockResolvedValueOnce([box('edge-5t2dcy6'), nurRegister()]).mockResolvedValue([box('edge-5t2dcy6')]);
    werkstattBoxEntfernen.mockResolvedValue(undefined);
    window.location.hash = `#/werkstatt?box=${REF}`;
    render(<WerkstattPage />);
    const karte = await screen.findByTestId('ws-entfernen');
    expect(screen.getByTestId('ws-stand')).toHaveTextContent('im Register');
    expect(within(karte).queryByTestId('ws-entfernen-frage')).toBeNull();
    fireEvent.click(within(karte).getByTestId('ws-entfernen-start'));
    const frage = within(karte).getByTestId('ws-entfernen-frage');
    expect(frage).toHaveTextContent(`${REF} aus dem Register entfernen?`);
    expect(within(frage).getByTestId('ws-entfernen-ja')).toHaveTextContent(`${REF} entfernen`);
    expect(werkstattBoxEntfernen).not.toHaveBeenCalled();
    fireEvent.click(within(frage).getByTestId('ws-entfernen-ja'));
    await waitFor(() => expect(werkstattBoxEntfernen).toHaveBeenCalledWith(REF));
    const liste = await screen.findByTestId('ws-boxen');
    expect(screen.queryByTestId('ws-detail')).toBeNull();
    expect(window.location.hash).toBe('#/werkstatt');
    await waitFor(() => expect(within(liste).queryByText(REF)).toBeNull());
    expect(within(liste).getByText('edge-5t2dcy6')).toBeInTheDocument();
  });

  it('Abbrechen ruft nichts auf; ein 409 der API steht in der Rückfrage, die Seite bleibt', async () => {
    werkstattBoxen.mockResolvedValue([nurRegister()]);
    werkstattBoxEntfernen.mockRejectedValue(new ApiError(409, `${REF} lässt sich nicht aus dem Register entfernen: der Werkstatt-Dienst hat ihr einen Code ausgegeben.`));
    window.location.hash = `#/werkstatt?box=${REF}`;
    render(<WerkstattPage />);
    fireEvent.click(await screen.findByTestId('ws-entfernen-start'));
    fireEvent.click(screen.getByTestId('ws-entfernen-nein'));
    expect(screen.queryByTestId('ws-entfernen-frage')).toBeNull();
    expect(werkstattBoxEntfernen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('ws-entfernen-start'));
    fireEvent.click(screen.getByTestId('ws-entfernen-ja'));
    expect(await screen.findByTestId('ws-entfernen-fehler')).toHaveTextContent('Code ausgegeben');
    expect(screen.getByTestId('ws-detail')).toBeInTheDocument();
  });

  it('keine Aktion, sobald die Box in Gebrauch, abgenommen oder in einem Lauf ist oder die API nichts dazu sagt', async () => {
    const faelle = [
      { ...nurRegister(), inGebrauch: ['für sie ist ein Tunnel-Schlüssel hinterlegt'] },
      { ...nurRegister(), inGebrauch: undefined },
      { ...box(REF), inGebrauch: [] },
    ];
    for (const b of faelle) {
      werkstattBoxen.mockResolvedValue([b]);
      window.location.hash = `#/werkstatt?box=${REF}`;
      const { unmount } = render(<WerkstattPage />);
      await screen.findByTestId('ws-detail');
      expect(screen.queryByTestId('ws-entfernen')).toBeNull();
      unmount();
    }
    // Ein Lauf des Dienstes kennt die Box: Stand „läuft“, keine Aktion.
    werkstattBoxen.mockResolvedValue([nurRegister()]);
    const lauf = { kennung: 'l1', freigabe: '2026-11-mango-1', boxArt: 'mango', zustand: 'laeuft' as const, schritt: 'programm', titel: 'x', grund: null,
      beginn: '2026-11-04T16:00:00Z', ende: null, aktualisiertAm: '2026-11-04T16:01:00Z', stand: { ...(vektor.lauf as LaufStand), box: REF } };
    werkstattDienst.mockResolvedValue(dienst({}, { laeufe: [lauf] as unknown as WerkstattDienst['laeufe'] }));
    window.location.hash = `#/werkstatt?box=${REF}`;
    render(<WerkstattPage />);
    await screen.findByTestId('ws-detail');
    expect(screen.queryByTestId('ws-entfernen')).toBeNull();
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

/**
 * Die Ansicht, wie der Dienst sie am 04.11.2026 um 10:28–10:29Z meldete:
 * `TestAnsichtZustaende` (services/werkstatt-dienst/internal/dienst) erzeugt
 * sie aus dem Dienst selbst. Ein Lauf ohne erledigten Schritt kam dabei mit
 * `erledigt: null` an und brachte die Werkbank in die Fehlergrenze.
 */
const zustaende: Record<string, WerkstattAnsicht> = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../../docs/contracts/werkstatt-ansicht-v1.zustaende.json'), 'utf8'),
);

/**
 * Die API hält je Lauf seinen letzten Stand (`DienstAnsichtService`): `laeufe` nennt die Zustände, deren Lauf zu dem
 * Zeitpunkt in der Liste stand (neueste zuerst).
 */
function ausZustand(name: string, laeufeAus: readonly string[]): WerkstattDienst {
  const ansicht = zustaende[name];
  const laeufe = laeufeAus.map((n) => {
    const s = zustaende[n].lauf as LaufStand;
    return {
      kennung: s.kennung, freigabe: s.freigabe, boxArt: s.box_art, zustand: s.zustand, schritt: s.schritt ?? null, titel: s.titel ?? null,
      grund: s.grund ?? null, beginn: s.beginn, ende: s.ende ?? null, aktualisiertAm: ansicht.zeit, stand: s,
    };
  });
  return { ansicht, gemeldetAm: new Date().toISOString(), dienstZeit: ansicht.zeit, alterSekunden: 2, aktuell: true, laeufe };
}

/** Welcher Bildschirm an der Werkbank zu welchem Zustand gehört. */
function erwarteterBildschirm(name: string): string {
  if (name.startsWith('laeuft_')) return 'laeuft';
  if (name.startsWith('wartet_')) return 'du';
  if (name === 'angehalten_startlader') return 'startlader';
  if (name.startsWith('angehalten_')) return 'problem';
  if (name === 'fertig') return 'fertig';
  return 'anschliessen';
}

/** Die Läufe, die zu dem Zustand in der Liste der API stehen: sein eigener und der angehaltene von 10:28:08Z. */
function laeufeZu(name: string): string[] {
  if (!zustaende[name].lauf) return [];
  return name === 'angehalten_beim_erkennen' ? [name] : [name, 'angehalten_beim_erkennen'];
}

describe('Werkstatt: Ansichten des Dienstes vom 04.11.2026', () => {
  const ABLAUF = Object.keys(zustaende).sort().map((n): [string, string[], string] => [n, laeufeZu(n), erwarteterBildschirm(n)]);

  it('die Datei trägt jeden Zustand eines Laufs', () => {
    expect(ABLAUF.map(([n]) => n)).toEqual(expect.arrayContaining([
      'ohne_kabel', 'mit_kabel', 'angehalten_beim_erkennen', 'laeuft_erkennen', 'laeuft_wiedererkennen', 'wartet_tunnel_adresse',
      'wartet_probe', 'angehalten_beim_neustart', 'angehalten_startlader', 'fertig',
    ]));
    // jeder Schritt des echten Laufs ab Werk; ohne Portal-API kommt die Tunnel-Adresse aus dem Portal statt einloesen
    expect(ABLAUF.filter(([n]) => n.startsWith('laeuft_')).map(([n]) => n.slice('laeuft_'.length)).sort())
      .toEqual(SCHRITTE.filter((s) => s !== 'einloesen').slice().sort());
  });

  it.each(ABLAUF)('An der Werkbank: %s (Läufe %j) zeichnet den Bildschirm %s', async (name, laeufe, art) => {
    window.location.hash = '#/werkstatt?werkbank=1';
    werkstattDienst.mockResolvedValue(ausZustand(name, laeufe));
    const fehler = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Fehlergrenze><WerkstattPage /></Fehlergrenze>);
    fireEvent.click(await screen.findByTestId('wsb-mango'));
    expect(screen.queryByText(FEHLER_IM_BEREICH)).toBeNull();
    expect(screen.getByTestId('wsb')).toHaveAttribute('data-bildschirm', art);
    expect(fehler).not.toHaveBeenCalled();
    fehler.mockRestore();
  });

  /** So meldete der Dienst bis 724ebdde9 einen Lauf ohne erledigten Schritt; die API hält solche Stände je Lauf fest. */
  function mitNull(name: string, laeufe: string[]): WerkstattDienst {
    const d = ausZustand(name, laeufe);
    const ohne = (s: LaufStand): LaufStand => (s.erledigt.length === 0 ? ({ ...s, erledigt: null } as unknown as LaufStand) : s);
    return { ...d, ansicht: d.ansicht && { ...d.ansicht, lauf: d.ansicht.lauf && ohne(d.ansicht.lauf) }, laeufe: d.laeufe.map((l) => ({ ...l, stand: ohne(l.stand) })) };
  }

  it.each([
    ['angehalten_beim_erkennen', 'problem'],
    ['laeuft_erkennen', 'laeuft'],
  ])('ein gespeicherter Stand mit erledigt: null (Dienst bis 724ebdde9): %s zeichnet %s', async (name, art) => {
    window.location.hash = '#/werkstatt?werkbank=1';
    werkstattDienst.mockResolvedValue(mitNull(name, laeufeZu(name)));
    const fehler = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Fehlergrenze><WerkstattPage /></Fehlergrenze>);
    fireEvent.click(await screen.findByTestId('wsb-mango'));
    expect(screen.queryByText(FEHLER_IM_BEREICH)).toBeNull();
    expect(screen.getByTestId('wsb')).toHaveAttribute('data-bildschirm', art);
    expect(fehler).not.toHaveBeenCalled();
    fehler.mockRestore();
  });

  it.each(ABLAUF)('Übersicht am Rechner mit gewählter Box: %s (Läufe %j)', async (name, laeufe) => {
    window.location.hash = '#/werkstatt?box=edge-5t2dcy6';
    werkstattDienst.mockResolvedValue(ausZustand(name, laeufe));
    const fehler = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Fehlergrenze><WerkstattPage /></Fehlergrenze>);
    expect(await screen.findByTestId('ws-detail')).toBeInTheDocument();
    expect(screen.queryByText(FEHLER_IM_BEREICH)).toBeNull();
    expect(fehler).not.toHaveBeenCalled();
    fehler.mockRestore();
  });
});
