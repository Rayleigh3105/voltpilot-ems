import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EdgeUpdates } from '../../adminEdgeUpdates';
import type { WerkstattAbnahme, WerkstattBox } from '../../werkstatt';

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
const geraeteFernlauf = vi.fn();
const geraeteFernlaufAufspielen = vi.fn();
const activateControl = vi.fn();
const deactivateControl = vi.fn();
const fleet = vi.fn();
const geraeteAkte = vi.fn(() => Promise.resolve({
  externalRef: '', lebensabschnitt: 'kunde', lebensabschnittSeit: null,
  kopf: null, software: null, verbindung: null, einrichtung: null,
}));

vi.mock('../../admin/adminApi', () => ({
  adminApi: {
    edgeUpdates: (...a: unknown[]) => edgeUpdates(...a),
    listDevices: (...a: unknown[]) => listDevices(...a),
    listPendingEnrollments: (...a: unknown[]) => listPendingEnrollments(...a),
    werkstattBoxen: (...a: unknown[]) => werkstattBoxen(...a),
    werkstattErstesVerbinden: () => Promise.resolve(undefined),
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
    geraeteAkte: (...a: unknown[]) => geraeteAkte(...a),
    geraeteFernlauf: (...a: unknown[]) => geraeteFernlauf(...a),
    geraeteFernlaufAufspielen: (...a: unknown[]) => geraeteFernlaufAufspielen(...a),
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
    // Fernlauf (S1): ohne Stand (eine Kundenbox, eine Kennung ohne Prüfzeichen) bleibt alles wie vorher.
    geraeteFernlauf.mockRejectedValue(new Error('kein Fernlauf'));
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

  it('Überblick: „Wie der Kunde es sieht" ist ein Knopf zur Anlage der Box (das Kopf-Menü ⋯ trägt ihn nicht)', async () => {
    edgeUpdates.mockResolvedValue({ ...emptyEdgeUpdates(), fleet: [connectedRow] });
    const jump = vi.fn();
    render(<GeraeteAktePage boxRef="edge-a1" reiter={null} onJumpToTenant={jump} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Wie der Kunde es sieht' }));
    expect(jump).toHaveBeenCalledWith('t1', expect.objectContaining({ page: 'anlagen', siteId: 's1' }));
    expect(screen.queryByText(/im Menü „⋯“ des Kopfes/)).toBeNull();
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
    // Admin-Durchgang F15: der Überblick sagt, WO die Box einem Kunden zugeordnet wird -
    // vorher schickte er nur in den Reiter „Einrichtung", der nichts dazu sagt.
    expect(await screen.findByText(/Verbunden wird die Box beim Kunden/)).toHaveTextContent('„VoltPilot-Box hinzufügen“');
  });

  it('Reiter Einrichtung einer noch nicht verbundenen Box sagt ehrlich, dass nichts verzeichnet ist', async () => {
    render(<GeraeteAktePage boxRef="edge-neu" reiter="einrichtung" />);
    expect(await screen.findByText(/nichts in der Einrichtung verzeichnet/)).toBeInTheDocument();
  });

  describe('N2 (Nebenfund vp-erstverbindung-update-konzept): eine wartende Werkstatt-Box widerspricht sich nicht mehr', () => {
    const abnahme: WerkstattAbnahme = {
      id: 'a1', edgeRef: 'edge-cyhchfr', hostSchluessel: 'SHA256:x', fassung: 'edge-light-2026.11.10',
      tunnelAdresse: '10.10.16.5', lanNetz: '10.213.0.1/24', pruefungen: [], probe: {} as never, notiz: null,
      erfasstAm: new Date().toISOString(), erfasstVon: 'Dienst', quelle: 'dienst',
    };
    const werkstattBox: WerkstattBox = {
      id: 'edge-cyhchfr', edgeRef: 'edge-cyhchfr', boxArt: 'edge-light', lanNetz: null, schritte: {}, notiz: null,
      angelegtAm: new Date().toISOString(), angelegtVon: 'Dienst', geaendertAm: new Date().toISOString(), abnahmen: [abnahme],
    };

    it('Kopf: Bauart aus der Werkstatt statt „Box-Art unbekannt", solange die Box selbst noch nichts meldet', async () => {
      werkstattBoxen.mockResolvedValue([werkstattBox]);
      render(<GeraeteAktePage boxRef="edge-cyhchfr" reiter={null} />);
      expect(await screen.findByTestId('akte-zustand')).toHaveTextContent('Noch nicht verbunden');
      expect(await screen.findByTestId('box-art')).toHaveTextContent('Edge Light');
      expect(screen.getByTestId('box-art')).toHaveAttribute('data-box-art', 'light');
    });

    it('Reiter Software: nennt Bauart und bestätigten Stand aus der Werkstatt, bleibt ehrlich bei „Noch nicht verbunden"', async () => {
      werkstattBoxen.mockResolvedValue([werkstattBox]);
      render(<GeraeteAktePage boxRef="edge-cyhchfr" reiter="software" />);
      expect(await screen.findByRole('heading', { name: 'Noch nicht verbunden' })).toBeInTheDocument();
      expect(await screen.findByText(/Aus der Werkstatt bekannt: Edge Light/)).toHaveTextContent('Edge Light 2026.11.10');
    });
  });

  describe('Fernlauf durch den Tunnel (vp-update-vor-zuordnung S1)', () => {
    const stand = {
      edgeRef: 'edge-k7m2xq3', laeuft: 'edge-light-2026.11.5', laeuftGemeldetAm: new Date(Date.now() - 3_600_000).toISOString(),
      fragtZuletztAm: new Date(Date.now() - 20_000).toISOString(), neueste: 'edge-light-2026.11.15',
      werkstattFassung: 'edge-light-2026.11.5', werkstattAm: new Date(Date.now() - 9 * 86_400_000).toISOString(),
      moeglich: true, gruende: [], haken: { tunnelVerbunden: true, fragtNachSchluesseln: true, keinKundenkonto: true },
      verlauf: [], nachtlauf: null as { dran: boolean; grund: string | null } | null, stand: new Date().toISOString(),
    };

    it('Reiter Software einer wartenden Box: Linie und Stand (N2) statt „Noch nicht verbunden", Knopf mit Bestätigung', async () => {
      geraeteFernlauf.mockResolvedValue(stand);
      geraeteFernlaufAufspielen.mockResolvedValue({});
      render(<GeraeteAktePage boxRef="edge-k7m2xq3" reiter="software" />);
      const karte = await screen.findByTestId('akte-fernlauf-stand');
      expect(karte).toHaveTextContent('Läuft2026.11.5');
      expect(karte).toHaveTextContent('gerade nach ihrem Zertifikat');
      expect(screen.queryByRole('heading', { name: 'Noch nicht verbunden' })).toBeNull();
      // Kopf: „Aktualisieren" führt auch für die wartende Box hierher (§4.5).
      expect(screen.getByRole('button', { name: 'Aktualisieren' })).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('akte-fernlauf-knopf'));
      const dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveTextContent('edge-k7m2xq3 von 2026.11.5 auf 2026.11.15 bringen?');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Aufspielen' }));
      await waitFor(() => expect(geraeteFernlaufAufspielen).toHaveBeenCalledWith('edge-k7m2xq3', 'edge-light-2026.11.15'));
    });

    it('ein wartender PFC200 (Edge Industrie): eigene Linie, und Karte wie Dialog sagen, dass die SPS weiterläuft', async () => {
      geraeteFernlauf.mockResolvedValue({ ...stand, edgeRef: 'edge-zz9988g', laeuft: 'edge-industrie-2026.11.5',
        neueste: 'edge-industrie-2026.11.15', werkstattFassung: 'edge-industrie-2026.11.5' });
      geraeteFernlaufAufspielen.mockResolvedValue({});
      render(<GeraeteAktePage boxRef="edge-zz9988g" reiter="software" />);
      const karte = await screen.findByTestId('akte-fernlauf-stand');
      expect(karte).toHaveTextContent('Edge Industrie');
      expect(karte).toHaveTextContent('Läuft2026.11.5');
      expect(screen.getByTestId('akte-fernlauf-satz')).toHaveTextContent(
        'Neu startet nur das Programm von VoltPilot; das Gerät und die SPS laufen weiter.');
      expect(screen.getByTestId('akte-fernlauf-satz')).not.toHaveTextContent('5 Min');
      fireEvent.click(screen.getByTestId('akte-fernlauf-knopf'));
      const dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveTextContent('edge-zz9988g von 2026.11.5 auf 2026.11.15 bringen?');
      expect(dialog).toHaveTextContent('das Gerät und die SPS laufen weiter');
      expect(dialog).toHaveTextContent('Tunnel, Identität, Firmware und SPS-Programm bleiben, wie sie sind.');
      expect(dialog).not.toHaveTextContent('Die Box startet einmal neu');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Aufspielen' }));
      await waitFor(() => expect(geraeteFernlaufAufspielen)
        .toHaveBeenCalledWith('edge-zz9988g', 'edge-industrie-2026.11.15'));
    });

    it('gesperrt: der Knopf bleibt aus und nennt den ersten Grund; kein „Aktualisieren" ohne Auftrag', async () => {
      geraeteFernlauf.mockResolvedValue({ ...stand, moeglich: false,
        gruende: [{ code: 'dienst_stumm', text: 'Der Werkstatt-Dienst meldet sich nicht.' }] });
      render(<GeraeteAktePage boxRef="edge-k7m2xq3" reiter="software" />);
      expect(await screen.findByTestId('akte-fernlauf-grund')).toHaveTextContent('Der Werkstatt-Dienst meldet sich nicht.');
      expect(screen.getByTestId('akte-fernlauf-knopf')).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'Aktualisieren' })).toBeNull();
    });

    it('S4: unter dem Knopf „Sonst heute Nacht von selbst", nur wenn die Automatik die Box nimmt', async () => {
      geraeteFernlauf.mockResolvedValue({ ...stand, nachtlauf: { dran: true, grund: null } });
      const { unmount } = render(<GeraeteAktePage boxRef="edge-k7m2xq3" reiter="software" />);
      expect(await screen.findByTestId('akte-fernlauf-heute-nacht')).toHaveTextContent('Sonst heute Nacht von selbst');
      unmount();

      // Angehalten (oder nicht dran): kein Satz, der Knopf bleibt.
      geraeteFernlauf.mockResolvedValue({ ...stand,
        nachtlauf: { dran: false, grund: 'Nachts von selbst ist angehalten; es bleibt der Knopf.' } });
      render(<GeraeteAktePage boxRef="edge-k7m2xq3" reiter="software" />);
      expect(await screen.findByTestId('akte-fernlauf-knopf')).toBeEnabled();
      expect(screen.queryByTestId('akte-fernlauf-heute-nacht')).toBeNull();
    });

    it('S4: im Verlauf „über den Tunnel auf 2026.11.15 · Automatik · nachts"', async () => {
      const iso = new Date(Date.now() - 6 * 3_600_000).toISOString();
      geraeteFernlauf.mockResolvedValue({ ...stand, laeuft: 'edge-light-2026.11.15', moeglich: false,
        gruende: [{ code: 'schon_neueste', text: 'Die Box läuft schon edge-light-2026.11.15; neuer ist nichts.' }],
        verlauf: [{
          id: 'n', art: 'aufspielen', zustand: 'fertig', fassungVorher: 'edge-light-2026.11.5',
          fassungZiel: 'edge-light-2026.11.15', akteurName: 'Automatik · nachts', nachts: true, erteiltAm: iso,
          begonnenAm: iso, schritt: 'tunnel', schrittSeit: null, schritte: [], fensterEnde: null,
          ergebnis: { ergebnis: 'fertig', grund: null, schritt: 'tunnel', fassungNachher: 'edge-light-2026.11.15',
            belege: {}, quelle: 'dienst', erfasstAm: iso },
        }] });
      render(<GeraeteAktePage boxRef="edge-k7m2xq3" reiter="verlauf" />);
      expect(await screen.findByTestId('akte-verlauf-fernlauf'))
        .toHaveTextContent('Über den Tunnel auf 2026.11.15 · fertig · Automatik · nachts');
    });

    it('S3 §4.7: eine wartende Docker-Box sagt einen ehrlichen Satz statt des Fernlauf-Knopfs (kein Wartungstunnel)', async () => {
      geraeteFernlauf.mockResolvedValue({ ...stand, laeuft: 'edge-2026.10.7', neueste: null,
        moeglich: false, gruende: [{ code: 'keine_edge_light', text: 'Nur eine Edge-Light-Box hat den Wartungstunnel.' }] });
      render(<GeraeteAktePage boxRef="edge-k7m2xq3" reiter="software" />);
      expect(await screen.findByRole('heading', { name: 'Docker-Box' })).toBeInTheDocument();
      expect(screen.getByText(/Läuft edge-2026.10.7/)).toHaveTextContent(
        'Läuft edge-2026.10.7 · Holt beim Verbinden die neueste Fassung. Docker-Boxen haben keinen Wartungstunnel.');
      expect(screen.queryByTestId('akte-fernlauf-knopf')).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Noch nicht verbunden' })).toBeNull();
      // Review zu PR #1948: der Kopf nennt die Bauart (wie bei Edge Light „Edge Light" vor der
      // Kennung), und ohne Knopf bleibt das Menü „⋯" neben Stand/Zustand statt auf einer eigenen Zeile.
      expect(screen.getByTestId('box-art')).toHaveTextContent('Docker-Box');
      expect(screen.getByTestId('box-art')).toHaveAttribute('data-box-art', 'docker');
      expect(document.querySelector('.vp-akte-aktionen--nur-menu')).not.toBeNull();
    });
  });

  it('N5: Reiter Einrichtung nennt, ob die Box gerade fragt, und den letzten Start - nicht „meldet sich seit"', async () => {
    listPendingEnrollments.mockResolvedValue([{
      externalRef: 'edge-cyhchfr', deviceInfo: 'vp-edge-core edge-light-2026.11.5', csrUpdatedAt: new Date(Date.now() - 3_600_000).toISOString(),
      everIssued: false, issuedAt: null, werkstattAbnahmeAm: null, zuletztAbgefragtAm: new Date(Date.now() - 10_000).toISOString(),
    }]);
    render(<GeraeteAktePage boxRef="edge-cyhchfr" reiter="einrichtung" />);
    const satz = await screen.findByTestId('akte-wartet-fragt');
    expect(satz).toHaveTextContent(/^Fragt gerade nach ihrem Zertifikat \(vor 10.Sek\.\) · zuletzt gestartet .* · vp-edge-core edge-light-2026\.11\.5\.$/);
    expect(satz).not.toHaveTextContent('Meldet sich seit');
  });

  it('Reiter Einrichtung „Meldet sich": dieselbe Sprache wie die Geräte-Liste - Erreichbarkeit grün, kein Kunde eingerichtet (Firstmate vp-werkstatt-laeuft-anzeige)', async () => {
    listPendingEnrollments.mockResolvedValue([{
      externalRef: 'edge-cyhchfr', deviceInfo: null, csrUpdatedAt: new Date().toISOString(), everIssued: false, issuedAt: null,
    }]);
    render(<GeraeteAktePage boxRef="edge-cyhchfr" reiter="einrichtung" />);
    const erreichbar = await screen.findByTestId('akte-wartet-erreichbar');
    expect(erreichbar).toHaveTextContent('Online');
    expect(erreichbar).toHaveClass('online');
    expect(screen.getByText('Noch bei keinem Kunden eingerichtet.')).toBeInTheDocument();
    expect(screen.getByText('Frisch — normal während der Einrichtung')).toBeInTheDocument();
  });

  // Firstmate vp-wartend-online-aktuell: die Kopfzeile sagte vorher IMMER denselben neutralen
  // Satz, egal ob die Box noch fragte oder längst verstummt war - dieselbe Rechnung wie die
  // Karte im Reiter „Einrichtung" muss auch hier gelten, nie eine zweite, abweichende Aussage.
  it('Kopfzeile einer wartenden Box: „Meldet sich nicht" sobald ihr eigenes Fenster abgelaufen ist, nicht pauschal 11 Minuten', async () => {
    listPendingEnrollments.mockResolvedValue([{
      externalRef: 'edge-cyhchfr', deviceInfo: null,
      csrUpdatedAt: new Date(Date.now() - 8 * 60_000).toISOString(), everIssued: false, issuedAt: null,
    }]);
    render(<GeraeteAktePage boxRef="edge-cyhchfr" reiter="einrichtung" />);
    const kopf = await screen.findByTestId('akte-zustand');
    expect(kopf).toHaveTextContent('Meldet sich nicht, wartet auf Zuordnung');
  });

  it('Kopfzeile einer wartenden Box: „Meldet sich" so lange sie innerhalb ihres eigenen Fensters fragt', async () => {
    listPendingEnrollments.mockResolvedValue([{
      externalRef: 'edge-cyhchfr', deviceInfo: null, csrUpdatedAt: new Date().toISOString(), everIssued: false, issuedAt: null,
    }]);
    render(<GeraeteAktePage boxRef="edge-cyhchfr" reiter="einrichtung" />);
    const kopf = await screen.findByTestId('akte-zustand');
    expect(kopf).toHaveTextContent('Meldet sich, wartet auf Zuordnung');
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

    it('Admin-Durchgang F1: eine Anlage ohne Speicher hat keinen Plan - kein Warnton, ein Satz warum', async () => {
      fleet.mockResolvedValue({ sites: [fleetSite({ hasStorage: false, lastPlanGeneratedAt: null })], releases: [] });
      render(<GeraeteAktePage boxRef="edge-a1" reiter="anlage" />);
      expect(await screen.findByText('Der Optimierer plant nur Anlagen mit Speicher.')).toBeInTheDocument();
      expect(screen.queryByText('kein aktueller Plan')).toBeNull();
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

  describe('S7: Live-Feinschliff (§5 des Konzepts)', () => {
    const vorher = (ms: number) => new Date(Date.now() - ms).toISOString();

    it('zeigt oben die Bezugszeit mit Takt (§5.2)', async () => {
      edgeUpdates.mockResolvedValue({ ...emptyEdgeUpdates(), fleet: [connectedRow] });
      render(<GeraeteAktePage boxRef="edge-a1" reiter={null} />);
      expect(await screen.findByTestId('akte-stand')).toHaveTextContent('Stand');
      expect(screen.getByTestId('akte-stand')).toHaveTextContent('alle 10 s');
    });

    it('E6: Verzögert zwischen 45 Sekunden und 5 Minuten - reine Anzeige', async () => {
      edgeUpdates.mockResolvedValue({
        ...emptyEdgeUpdates(), fleet: [{ ...connectedRow, lastSeenAt: vorher(2 * 60_000) }],
      });
      render(<GeraeteAktePage boxRef="edge-a1" reiter={null} />);
      expect(await screen.findByTestId('akte-zustand')).toHaveTextContent('Verzögert');
    });

    it('Meldet sich nicht nach 5 Minuten - ein anderer Ton als Verzögert', async () => {
      edgeUpdates.mockResolvedValue({
        ...emptyEdgeUpdates(), fleet: [{ ...connectedRow, lastSeenAt: vorher(10 * 60_000) }],
      });
      render(<GeraeteAktePage boxRef="edge-a1" reiter={null} />);
      expect(await screen.findByTestId('akte-zustand')).toHaveTextContent('Meldet sich nicht');
    });

    it('Unbekannt bei fehlendem Feld - keine Zahl, nie eine Null', async () => {
      edgeUpdates.mockResolvedValue({
        ...emptyEdgeUpdates(), fleet: [{ ...connectedRow, lastSeenAt: undefined }],
      });
      render(<GeraeteAktePage boxRef="edge-a1" reiter={null} />);
      expect(await screen.findByTestId('akte-zustand')).toHaveTextContent('Stand unbekannt');
    });

    it('L2-Sonderfall: Herzschlag in Ordnung, Messwerte alt - Kopf bleibt Verbunden', async () => {
      edgeUpdates.mockResolvedValue({ ...emptyEdgeUpdates(), fleet: [connectedRow] });
      geraeteAkte.mockResolvedValue({
        externalRef: 'edge-a1', lebensabschnitt: 'kunde', lebensabschnittSeit: null,
        kopf: {
          deviceId: 'd1', name: 'edge-a1', siteId: 's1', siteName: 'Pilsting', tenantId: 't1', tenantName: 'Kunde A',
          herzschlagAm: new Date().toISOString(), messwertAm: vorher(8 * 60_000), lastSeenAt: new Date().toISOString(), ausgebautAm: null,
        },
        software: null, verbindung: null, einrichtung: null,
      });
      render(<GeraeteAktePage boxRef="edge-a1" reiter={null} />);
      expect(await screen.findByTestId('akte-zustand')).toHaveTextContent('Verbunden');
      expect(await screen.findByTestId('akte-messwert-luecke')).toHaveTextContent('Messwerte seit');
      expect(screen.getByTestId('akte-messwert-luecke')).toHaveTextContent('Datenannahme');
    });

    it('Fehlerzeile bei gescheiterter Abfrage - die Werte bleiben mit ihrem alten Alter stehen (§5.2)', async () => {
      vi.useFakeTimers();
      try {
        edgeUpdates.mockResolvedValue({ ...emptyEdgeUpdates(), fleet: [connectedRow] });
        render(<GeraeteAktePage boxRef="edge-a1" reiter={null} />);
        await act(async () => { await Promise.resolve(); });
        expect(screen.getByTestId('akte-zustand')).toHaveTextContent('Verbunden');

        edgeUpdates.mockRejectedValue(new Error('netz weg'));
        listDevices.mockRejectedValue(new Error('netz weg'));
        geraeteAkte.mockRejectedValue(new Error('netz weg'));
        await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

        expect(screen.getByTestId('akte-stand')).toHaveTextContent('Aktualisierung schlägt fehl');
        // Die Seite blendet sich nicht auf eine leere Fehlerseite um - die alte Box steht weiter.
        expect(screen.getByTestId('akte-zustand')).toHaveTextContent('Verbunden');
        expect(screen.queryByTestId('geraete-akte')).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
