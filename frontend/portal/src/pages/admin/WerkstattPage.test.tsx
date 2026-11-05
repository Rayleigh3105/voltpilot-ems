import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
const werkstattNochmal = vi.fn();
const werkstattZurSeite = vi.fn();
const edgeUpdates = vi.fn();

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
    werkstattNochmal: (l: string) => werkstattNochmal(l),
    werkstattZurSeite: (l: string) => werkstattZurSeite(l),
    edgeUpdates: () => edgeUpdates(),
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
  edgeUpdates.mockRejectedValue(new ApiError(503, 'nicht da'));
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

  it('3MF: nur das komplette Gehäuse als Download mit Dateiname, als Datei ohne Kennung der Box beschriftet', async () => {
    window.location.hash = '#/werkstatt?box=edge-5t2dcy6';
    render(<WerkstattPage />);
    const g = await screen.findByTestId('ws-gehaeuse');
    expect(within(g).getByTestId('ws-gehaeuse-hinweis')).toHaveTextContent('ohne Referenz und QR-Code dieser Box');
    expect(within(g).queryByText(/Bambu Studio/)).toBeNull();
    expect(within(g).queryByText(/sitzt perfekt/)).toBeNull();
    const a = within(within(g).getByTestId('ws-gehaeuse-gehaeuse-v04.3mf')).getByRole('link');
    expect(a).toHaveAttribute('download', 'gehaeuse-v04.3mf');
    expect(a).toHaveAttribute('href', expect.stringMatching(/\.3mf(\?.*)?$/));
    expect(within(g).getAllByRole('link')).toHaveLength(1);
    expect(within(g).queryByTestId('ws-gehaeuse-unterteil.3mf')).toBeNull();
    expect(within(g).queryByTestId('ws-gehaeuse-deckel.3mf')).toBeNull();
    // Oben: die Druckdatei ist die erste Karte der Seite, vor der Einrichtung.
    expect(g.compareDocumentPosition(screen.getByTestId('ws-einrichtung')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('Kunde: noch nicht eingerichtet zeigt den Link des QR-Codes zum Kopieren und den QR-Code', async () => {
    werkstattBoxen.mockResolvedValue([{ ...box('edge-5t2dcy6'), kunde: null }]);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    window.location.hash = '#/werkstatt?box=edge-5t2dcy6';
    render(<WerkstattPage />);
    const k = await screen.findByTestId('ws-kunde');
    expect(k).toHaveTextContent('Noch nicht vom Kunden eingerichtet');
    expect(k).toHaveTextContent('privaten Fenster');
    expect(within(k).getByTestId('ws-kunde-link')).toHaveTextContent('https://portal.voltpilot.de/k/edge-5t2dcy6');
    expect(within(k).getByTestId('ws-kunde-qr')).toHaveAttribute('aria-label', 'QR-Code: https://portal.voltpilot.de/k/edge-5t2dcy6');
    expect(within(k).queryByRole('link')).toBeNull();
    fireEvent.click(within(k).getByRole('button', { name: 'Link kopieren' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://portal.voltpilot.de/k/edge-5t2dcy6'));
    expect(await within(k).findByText('Kopiert')).toBeInTheDocument();
  });

  it('Kunde: eingerichtet nennt Mandant und Anlage, ohne Knopf', async () => {
    werkstattBoxen.mockResolvedValue([{ ...box('edge-5t2dcy6'), kunde: { mandant: 'Familie Probe', anlage: 'Dach Süd', seit: '2026-11-03T08:00:00Z' } }]);
    window.location.hash = '#/werkstatt?box=edge-5t2dcy6';
    render(<WerkstattPage />);
    const k = await screen.findByTestId('ws-kunde');
    expect(k).toHaveTextContent('Vom Kunden eingerichtet: Familie Probe, Anlage Dach Süd');
    expect(screen.queryByTestId('ws-kunde-link')).toBeNull();
  });

  it('Kunde: ohne Angabe der API unbekannt, nie „nicht eingerichtet“', async () => {
    window.location.hash = '#/werkstatt?box=edge-5t2dcy6';
    render(<WerkstattPage />);
    const k = await screen.findByTestId('ws-kunde');
    expect(k).toHaveTextContent('nicht bekannt');
    expect(screen.queryByTestId('ws-kunde-link')).toBeNull();
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
  it('Start → Mango → Läuft: Jetzt-Karte, sechs Phasen mit Belegen, Software; kein „Weiter“-Knopf', async () => {
    window.location.hash = '#/werkstatt?werkbank=1';
    render(<WerkstattPage />);
    expect(await screen.findByTestId('wsb')).toHaveAttribute('data-bildschirm', 'start');
    fireEvent.click(screen.getByTestId('wsb-mango'));
    expect(screen.getByTestId('wsb')).toHaveAttribute('data-bildschirm', 'laeuft');
    expect(screen.getByTestId('wsb-restzeit')).toHaveTextContent(/Noch ca\. \d+ Minuten/);
    const schritte = screen.getByTestId('wsb-schritte');
    expect(schritte.querySelectorAll('[data-phase]')).toHaveLength(6);
    // E3: jeder erledigte Schritt mit einer Zeile Beleg und seiner Dauer
    const erkennen = schritte.querySelector('[data-schritt="erkennen"]')!;
    expect(erkennen).toHaveAttribute('data-zustand', 'ok');
    expect(erkennen).toHaveTextContent('GL.iNet GL-MT300N-V2 · OpenWrt 25.12.5 ramips/mt76x8 · root-Passwort: leer');
    expect(erkennen).toHaveTextContent('0:12');
    expect(schritte.querySelector('[data-schritt="programm"]')).toHaveAttribute('data-zustand', 'lauf');
    const jetzt = screen.getByTestId('wsb-jetzt');
    expect(jetzt).toHaveTextContent('Edge Light einspielen');
    expect(jetzt).toHaveTextContent(/Schritt \d+ von 16/);
    expect(jetzt).toHaveTextContent('Frist 10 Min');
    expect(jetzt).toHaveTextContent('Danach: Tunnel-Schlüssel erzeugen');
    // Software: Freigabe, OpenWrt mit Prüfsumme, Edge Light, vorher
    const sw = screen.getByTestId('wsb-software');
    expect(sw).toHaveTextContent('Freigabe 2026-11-mango-1');
    expect(within(sw).getByTestId('wsb-soft-openwrt')).toHaveTextContent('OpenWrt 25.12.5');
    expect(within(sw).getByTestId('wsb-soft-openwrt')).toHaveTextContent('sha256 0123…cdef');
    expect(within(sw).getByTestId('wsb-soft-openwrt')).toHaveTextContent('vorher: OpenWrt 25.12.5');
    expect(within(sw).getByTestId('wsb-soft-edge-light')).toHaveTextContent('Edge Light 2026.11.1');
    expect(within(sw).getByTestId('wsb-soft-edge-light')).toHaveTextContent('wird eingespielt');
    expect(within(sw).getByTestId('wsb-soft-edge-light')).toHaveTextContent('vorher: kein VoltPilot');
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
    // Ein älterer Dienst ohne fall: die Seite bleibt bei „Hier hat etwas nicht geklappt“ und bietet kein „Nochmal“.
    expect(screen.getByTestId('wsb')).toHaveAttribute('data-fall', 'schritt_gescheitert');
    expect(screen.getByTestId('wsb-fall-titel')).toHaveTextContent('Hier hat etwas nicht geklappt.');
    expect(screen.queryByTestId('wsb-knopf-nochmal')).toBeNull();
    expect(screen.getByTestId('wsb-knopf-zur-seite')).toBeInTheDocument();
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
    expect(screen.getByTestId('wsb')).toHaveAttribute('data-bildschirm', 'fall');
    expect(screen.getByTestId('wsb-bild')).toHaveAttribute('data-bild', 'startlader');
    expect(screen.getByTestId('wsb-knopf-abbild')).toHaveAttribute('href', 'https://downloads.openwrt.org/releases/25.12.5/targets/ramips/mt76x8/openwrt-25.12.5-ramips-mt76x8-glinet_gl-mt300n-v2-squashfs-sysupgrade.bin');
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
  if (name.startsWith('angehalten_') || name === 'startet' || name === 'unterspannung') return 'fall';
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
      'startet', 'unterspannung', 'angehalten_gl_passwort', 'angehalten_halb_eigene', 'angehalten_passwort_fremd',
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

  it.each([
    ['angehalten_gl_passwort', 'Diese Mango hat schon jemand eingerichtet.', 'Reset-Knopf der Mango'],
    ['angehalten_halb_eigene', 'Diese Mango ist nur halb eingerichtet.', 'Reset-Knopf der Mango'],
    ['angehalten_passwort_fremd', 'Diese Mango gehört nicht zur Werkstatt.', 'Nicht zurücksetzen.'],
    ['angehalten_beim_erkennen', 'Die Brücke war während des Laufs weg.', 'Raspberry Pi'],
  ])('Lösung aus dem Dienst: %s zeigt „%s“', async (name, titel, schritt) => {
    window.location.hash = '#/werkstatt?werkbank=1';
    werkstattDienst.mockResolvedValue(ausZustand(name, laeufeZu(name)));
    render(<Fehlergrenze><WerkstattPage /></Fehlergrenze>);
    fireEvent.click(await screen.findByTestId('wsb-mango'));
    expect(screen.getByText(titel)).toBeInTheDocument();
    expect(screen.getAllByText(new RegExp(schritt)).length).toBeGreaterThan(0);
  });

  it.each([
    ['startet', 'Die Mango startet noch.'],
    ['unterspannung', 'Die Brücke hat zu wenig Strom.'],
  ])('Fall am Anschluss: %s zeigt „%s“', async (name, titel) => {
    window.location.hash = '#/werkstatt?werkbank=1';
    werkstattDienst.mockResolvedValue(ausZustand(name, laeufeZu(name)));
    render(<Fehlergrenze><WerkstattPage /></Fehlergrenze>);
    fireEvent.click(await screen.findByTestId('wsb-mango'));
    expect(screen.getByTestId('wsb-fall-titel')).toHaveTextContent(titel);
  });

  /** So meldete der Dienst bis 724ebdde9 einen Lauf ohne erledigten Schritt; die API hält solche Stände je Lauf fest. */
  function mitNull(name: string, laeufe: string[]): WerkstattDienst {
    const d = ausZustand(name, laeufe);
    const ohne = (s: LaufStand): LaufStand => (s.erledigt.length === 0 ? ({ ...s, erledigt: null } as unknown as LaufStand) : s);
    return { ...d, ansicht: d.ansicht && { ...d.ansicht, lauf: d.ansicht.lauf && ohne(d.ansicht.lauf) }, laeufe: d.laeufe.map((l) => ({ ...l, stand: ohne(l.stand) })) };
  }

  it.each([
    ['angehalten_beim_erkennen', 'fall'],
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

/**
 * Die Fälle aus dem Vertrag (docs/contracts/werkstatt-ansicht-v1.md, „Fälle“): je Code eine Seite mit Titel und
 * Schritten aus `loesung`, der Art (warten / einmal kurz du / zur Seite) und genau den Knöpfen des Konzepts. Kein
 * Knopf löscht etwas an einer Box; den Reset nennt die Seite nur bei gl_passwort und halb_eigene.
 */
const vertrag = readFileSync(resolve(__dirname, '../../../../../docs/contracts/werkstatt-ansicht-v1.md'), 'utf8');
function vertragsFaelle(ueberschrift: string): { code: string; selbst: boolean; zurSeite: boolean }[] {
  const teil = vertrag.slice(vertrag.indexOf(ueberschrift));
  const tabelle = teil.slice(teil.indexOf('| Code'), teil.indexOf('\n\n', teil.indexOf('| Code')));
  return tabelle.split('\n').filter((z) => z.startsWith('| `')).map((z) => {
    const sp = z.split('|').map((x) => x.trim());
    const code = sp[1].replace(/`/g, '');
    return ueberschrift.startsWith('**Fälle am')
      ? { code, selbst: sp[3] === 'ja', zurSeite: false }
      : { code, selbst: sp[4] === 'ja', zurSeite: sp[5] === 'ja' };
  });
}
const AM_ANSCHLUSS = vertragsFaelle('**Fälle am Anschluss**');
const IM_LAUF = vertragsFaelle('**Fälle eines Laufs**');
/** Die Fälle, für die der Dienst „Nochmal“ anbietet (services/werkstatt-dienst/internal/faelle, Nochmal). */
const NOCHMAL = new Set(['kein_internet', 'uebertragung', 'bruecke_weg', 'box_weg', 'zwei_geraete', 'dienst_neu_gestartet', 'schritt_gescheitert', 'nicht_nachweisbar']);
const LAUF_KNOEPFE: Record<string, string[]> = {
  gl_passwort: ['zur-seite'], halb_eigene: ['zur-seite'],
  ssh_zu: ['abbild', 'zur-seite'], abbild_abgelehnt: ['abbild', 'zur-seite'], openwrt_fassung: ['abbild', 'zur-seite'],
  passwort_fremd: ['zur-seite'], falsches_geraet: ['zur-seite'], schon_edge_light: ['zur-seite'], nicht_update_bereit: ['zur-seite'],
  box_in_gebrauch: ['zur-seite', 'box-oeffnen'], fassung_nicht_bereit: ['freigabe-ansehen', 'zur-seite'],
  einloesen_abgewiesen: ['freigabe-ansehen', 'zur-seite'], nicht_nachweisbar: ['nochmal', 'zur-seite'],
};
const ANSCHLUSS_KNOEPFE: Record<string, string[]> = { nicht_freigegeben: ['freigeben'], eingerichtet: ['register'] };

function knoepfeAufDerSeite(): string[] {
  const k = screen.queryByTestId('wsb-knoepfe');
  return k ? [...k.querySelectorAll('[data-testid^="wsb-knopf-"]')].map((e) => e.getAttribute('data-testid')!.replace('wsb-knopf-', '')) : [];
}

describe('Werkstatt: eine Seite je Fall-Code', () => {
  it('der Vertrag nennt 29 Fälle (zwei_geraete an beiden Stellen)', () => {
    expect(AM_ANSCHLUSS.length + IM_LAUF.length).toBe(29);
  });

  it.each(IM_LAUF)('Lauf hält mit $code: Titel, Schritte, Art und Knöpfe', async ({ code, selbst, zurSeite }) => {
    window.location.hash = '#/werkstatt?werkbank=1';
    const loesung = { titel: `Titel ${code}.`, schritte: [`Erster Handgriff ${code}.`, `Zweiter Handgriff ${code}.`], selbst, zur_seite: zurSeite };
    werkstattDienst.mockResolvedValue(dienst({ zustand: 'angehalten', schritt: 'erkennen', erledigt: [], fall: code, loesung,
      grund: `Grund ${code}`, nochmal_moeglich: NOCHMAL.has(code) }));
    render(<WerkstattPage />);
    fireEvent.click(await screen.findByTestId('wsb-mango'));
    expect(screen.getByTestId('wsb')).toHaveAttribute('data-fall', code);
    expect(screen.getByTestId('wsb-fall-titel')).toHaveTextContent(`Titel ${code}.`);
    expect(screen.getByTestId('wsb-fall-was').textContent!.length).toBeGreaterThan(20);
    expect(screen.getByTestId('wsb-loesung')).toHaveTextContent(`Erster Handgriff ${code}.`);
    expect(screen.getByTestId('wsb-loesung')).toHaveTextContent(`Zweiter Handgriff ${code}.`);
    expect(screen.getByTestId('wsb-fall-banner')).toHaveAttribute('data-art', zurSeite ? 'seite' : 'hand');
    expect(screen.getByTestId('wsb-selbst')).toHaveAttribute('data-selbst', selbst ? 'ja' : 'nein');
    expect(screen.getByTestId('wsb-fall-code')).toHaveTextContent(code);
    expect(knoepfeAufDerSeite()).toEqual(LAUF_KNOEPFE[code] ?? ['nochmal', 'zur-seite']);
    const bild = screen.queryByTestId('wsb-bild')?.getAttribute('data-bild') ?? null;
    expect(bild === 'reset').toBe(code === 'gl_passwort' || code === 'halb_eigene');
    expect(screen.getByTestId('wsb-knoepfe')).not.toHaveTextContent(/lösch|zurücksetz|Reset/i);
  });

  it.each(AM_ANSCHLUSS)('am Anschluss $code: Titel, Schritte, Art und Knöpfe', async ({ code, selbst }) => {
    window.location.hash = '#/werkstatt?werkbank=1';
    const loesung = { titel: `Titel ${code}.`, schritte: [`Handgriff ${code}.`], selbst, zur_seite: false };
    werkstattDienst.mockResolvedValue({ ...dienst(null), ansicht: { ...vektor, lauf: null, anschluss_fall: code, anschluss_loesung: loesung } });
    render(<WerkstattPage />);
    fireEvent.click(await screen.findByTestId('wsb-mango'));
    if (code === 'kein_kabel' || code === 'keine_box') {
      // Diese beiden zeigt „Mango anschließen“ mit seiner Liste und dem Bild.
      expect(screen.getByTestId('wsb')).toHaveAttribute('data-bildschirm', 'anschliessen');
      return;
    }
    expect(screen.getByTestId('wsb')).toHaveAttribute('data-fall', code);
    expect(screen.getByTestId('wsb-fall-titel')).toHaveTextContent(`Titel ${code}.`);
    expect(screen.getByTestId('wsb-loesung')).toHaveTextContent(`Handgriff ${code}.`);
    expect(screen.getByTestId('wsb-fall-banner')).toHaveAttribute('data-art', code === 'startet' ? 'warten' : code === 'eingerichtet' ? 'seite' : 'hand');
    expect(knoepfeAufDerSeite()).toEqual(ANSCHLUSS_KNOEPFE[code] ?? []);
    expect(screen.queryByTestId('wsb-bild')?.getAttribute('data-bild') ?? null).not.toBe('reset');
  });
});

describe('Werkstatt: Nochmal versuchen und zur Seite legen', () => {
  const angehalten = () => dienst({ zustand: 'angehalten', schritt: 'openwrt', erledigt: ['erkennen', 'fassungen'], fall: 'box_weg',
    loesung: { titel: 'Die Mango war während des Laufs weg.', schritte: ['Strom und Kabel der Mango prüfen.'], selbst: true, zur_seite: false },
    nochmal_moeglich: true, grund: 'dial tcp 192.168.1.1:22: i/o timeout' });

  it('„Nochmal versuchen“ sendet den Auftrag für genau diesen Lauf und sagt, wann der Dienst ihn abholt', async () => {
    window.location.hash = '#/werkstatt?werkbank=1';
    werkstattDienst.mockResolvedValue(angehalten());
    werkstattNochmal.mockResolvedValue({ id: 'a1', art: 'nochmal', lauf: vektor.lauf!.kennung, erteiltAm: vektor.zeit });
    render(<WerkstattPage />);
    fireEvent.click(await screen.findByTestId('wsb-mango'));
    fireEvent.click(screen.getByTestId('wsb-knopf-nochmal'));
    expect(await screen.findByTestId('wsb-nochmal-gesendet')).toHaveTextContent('nächsten Meldung');
    expect(werkstattNochmal).toHaveBeenCalledWith(vektor.lauf!.kennung);
  });

  it('nimmt der Dienst den Auftrag an (nochmal_seit), steht das da statt des Knopfs; ein 409 steht an den Knöpfen', async () => {
    window.location.hash = '#/werkstatt?werkbank=1';
    werkstattDienst.mockResolvedValue(angehalten());
    werkstattNochmal.mockRejectedValue(new ApiError(409, 'Dieser Lauf ist nicht mehr der letzte des Dienstes.'));
    render(<WerkstattPage />);
    fireEvent.click(await screen.findByTestId('wsb-mango'));
    fireEvent.click(screen.getByTestId('wsb-knopf-nochmal'));
    expect(await screen.findByTestId('wsb-knopf-fehler')).toHaveTextContent('nicht mehr der letzte');
    const d = angehalten();
    werkstattDienst.mockResolvedValue({ ...d, ansicht: { ...d.ansicht!, lauf: { ...d.ansicht!.lauf!, nochmal_seit: vektor.zeit } } });
    cleanup();
    render(<WerkstattPage />);
    fireEvent.click(await screen.findByTestId('wsb-mango'));
    expect(screen.getByTestId('wsb-nochmal-laeuft')).toHaveTextContent('Der Dienst versucht es noch einmal.');
    expect(screen.queryByTestId('wsb-knopf-nochmal')).toBeNull();
  });

  it('„Box zur Seite legen“ speichert in der API; die Übersicht listet die Box mit Fall, Lösung und Grund', async () => {
    window.location.hash = '#/werkstatt?werkbank=1';
    werkstattDienst.mockResolvedValue({ ...angehalten(), zurSeite: [] });
    werkstattZurSeite.mockResolvedValue({});
    render(<WerkstattPage />);
    fireEvent.click(await screen.findByTestId('wsb-mango'));
    fireEvent.click(screen.getByTestId('wsb-knopf-zur-seite'));
    await waitFor(() => expect(screen.getByTestId('wsb')).toHaveAttribute('data-bildschirm', 'anschliessen'));
    expect(werkstattZurSeite).toHaveBeenCalledWith(vektor.lauf!.kennung);

    cleanup();
    window.location.hash = '#/werkstatt';
    werkstattDienst.mockResolvedValue({ ...dienst({}), zurSeite: [{ id: 'z1', lauf: 'l1', box: 'edge-k7m2xq3', fall: 'box_weg',
      loesungTitel: 'Die Mango war während des Laufs weg.', schritt: 'openwrt', grund: 'i/o timeout', gelegtAm: vektor.zeit, gelegtVon: 'alex' }] });
    render(<WerkstattPage />);
    const liste = await screen.findByTestId('ws-zur-seite');
    expect(liste).toHaveTextContent('edge-k7m2xq3');
    expect(liste).toHaveTextContent('Die Mango war während des Laufs weg.');
    expect(liste).toHaveTextContent('box_weg');
    expect(liste).toHaveTextContent('i/o timeout');
  });

  it('eine API vor der Lauf-Seite (kein zurSeite): keine Liste; scheitert das Speichern, liegt die Box trotzdem weg', async () => {
    window.location.hash = '#/werkstatt?werkbank=1';
    werkstattDienst.mockResolvedValue(angehalten());
    werkstattZurSeite.mockRejectedValue(new ApiError(404, 'Not Found'));
    render(<WerkstattPage />);
    fireEvent.click(await screen.findByTestId('wsb-mango'));
    fireEvent.click(screen.getByTestId('wsb-knopf-zur-seite'));
    expect(await screen.findByTestId('wsb-hinweis')).toHaveTextContent('nicht gespeichert');
    expect(screen.getByTestId('wsb')).toHaveAttribute('data-bildschirm', 'anschliessen');
    cleanup();
    window.location.hash = '#/werkstatt';
    render(<WerkstattPage />);
    await screen.findByTestId('ws-bruecke');
    expect(screen.queryByTestId('ws-zur-seite')).toBeNull();
  });

  it('Fertig nennt neun Prüfungen und zeigt, was jetzt auf der Box ist; ein neueres Release nur als Hinweis', async () => {
    window.location.hash = '#/werkstatt?werkbank=1';
    werkstattDienst.mockResolvedValue(dienst({ zustand: 'fertig', ende: '2026-11-02T10:22:00Z' }));
    edgeUpdates.mockResolvedValue({ releases: [{ releaseSeq: 9, version: '2026.11.3', signed: true, boxArt: 'edge-light' },
      { releaseSeq: 10, version: '2026.12.0', signed: false, boxArt: 'edge-light' }] });
    render(<WerkstattPage />);
    fireEvent.click(await screen.findByTestId('wsb-mango'));
    expect(screen.getByTestId('wsb-fertig')).toHaveTextContent('Alle neun Prüfungen bestanden · 17 Min');
    const sw = screen.getByTestId('wsb-software');
    expect(sw).toHaveTextContent('Auf dieser Box');
    expect(within(sw).getByTestId('wsb-soft-edge-light')).toHaveTextContent('✓ update-bereit');
    expect(await within(sw).findByTestId('wsb-soft-neuer')).toHaveTextContent('Neuer erschienen: Edge Light 2026.11.3');
  });
});
