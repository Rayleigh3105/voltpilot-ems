import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EdgeUpdates, FleetRow, UpdateFakten } from '../../adminEdgeUpdates';

const edgeUpdates = vi.fn();
const edgeRelease = vi.fn();
const createRollout = vi.fn();
const setUpdateTarget = vi.fn();
const revertUpdateTarget = vi.fn();
const listDevices = vi.fn();

vi.mock('../../admin/adminApi', () => ({
  adminApi: {
    edgeUpdates: (...a: unknown[]) => edgeUpdates(...a),
    edgeRelease: (...a: unknown[]) => edgeRelease(...a),
    createRollout: (...a: unknown[]) => createRollout(...a),
    setUpdateTarget: (...a: unknown[]) => setUpdateTarget(...a),
    revertUpdateTarget: (...a: unknown[]) => revertUpdateTarget(...a),
    listDevices: (...a: unknown[]) => listDevices(...a),
  },
}));

const { EdgeUpdatesPage } = await import('./EdgeUpdatesPage');

/**
 * Das geschützte Leerzeichen vor Einheiten („vor 30 Sek.“), wie `format.fmtRelative` es setzt.
 * `toHaveTextContent` fasst Leerraum samt NBSP zusammen; nur direkte `textContent`-Vergleiche brauchen es.
 */
const NB = String.fromCharCode(160);

const data = (over: Partial<EdgeUpdates> = {}): EdgeUpdates => ({
  releases: [
    {
      releaseSeq: 12, version: 'edge-2026.08.0', targetCommit: '3bf8c038', notes: null,
      signed: true, signingKeyId: 'rel-2026-a', createdAt: '2026-08-05T08:00:00Z',
      runningOnDevices: 1,
    },
    {
      releaseSeq: 11, version: 'edge-2026.07.2', targetCommit: '665d59b8', notes: null,
      signed: false, signingKeyId: null, createdAt: '2026-07-20T08:00:00Z',
      runningOnDevices: 2,
    },
  ],
  rollouts: [{
    id: 'r1', releaseVersion: 'edge-2026.08.0', releaseSeq: 12,
    state: 'active', createdBy: 'admin', createdAt: '2026-08-05T08:00:00Z',
    total: 2, confirmed: 1, failed: 0,
    devices: [
      {
        deviceId: 'd1', label: 'edge-a1', siteName: 'Pilsting', tenantName: 'Kunde A',
        state: 'bestaetigt', reason: null, since: '2026-08-05T08:00:00Z',
      },
      {
        deviceId: 'd2', label: 'edge-b2', siteName: 'Auernheim', tenantName: 'Kunde A',
        state: 'unbekannt',
        reason: 'Dieses Gerät hat noch keinen Software-Stand gemeldet.', since: null,
      },
    ],
  }],
  fleet: [
    {
      deviceId: 'd1', label: 'edge-a1', externalRef: 'edge-a1', siteId: 's1',
      siteName: 'Pilsting', tenantId: 't1',
      tenantName: 'Kunde A', ist: 'edge-2026.08.0', soll: 'edge-2026.08.0', sollSeq: 12,
      state: 'bestaetigt', reason: null,
      since: '2026-08-05T08:00:00Z', reportedAt: '2026-08-05T09:00:00Z', rolloutId: 'r1',
    },
    {
      deviceId: 'd2', label: 'edge-b2', externalRef: 'edge-b2', siteId: 's2',
      siteName: 'Auernheim', tenantId: 't1',
      tenantName: 'Kunde A', ist: null, soll: 'edge-2026.08.0', sollSeq: 12,
      state: 'unbekannt',
      reason: 'Dieses Gerät hat noch keinen Software-Stand gemeldet.',
      since: null, reportedAt: null, rolloutId: 'r1',
    },
  ],
  journal: [
    {
      id: 2, at: '2026-08-05T08:01:00Z', actor: 'system', event: 'device_state',
      rolloutId: 'r1', deviceId: 'd1', detail: 'bestaetigt',
    },
    {
      id: 1, at: '2026-08-05T08:00:00Z', actor: 'admin', event: 'rollout_created',
      rolloutId: 'r1', deviceId: null, detail: 'edge-2026.08.0',
    },
  ],
  kpi: {
    known: 1, upToDate: 1, unknown: 1, inRollout: 1, failed: 0,
    newestRelease: 'edge-2026.08.0',
  },
  ...over,
});

/**
 * Was die API seit Geräte & Updates G1/G2 je Box mitliefert: Linie,
 * Linien-Stand, die EINE Uhr und die drei Fakten. Ohne diese Felder (älterer
 * Server) zeigt die Seite „unbekannt", nie eine geratene Null.
 */
const vor = (ms: number) => new Date(Date.now() - ms).toISOString();
function mitStand(d: EdgeUpdates, extra: Record<string, Partial<FleetRow>> = {}): EdgeUpdates {
  d.fleet = d.fleet.map((r) => ({
    ...r,
    boxArt: r.boxArt ?? 'docker',
    linie: (r.boxArt ?? 'docker') as 'docker' | 'light',
    lastSeenAt: vor(30_000),
    stufe1: false,
    stand: r.ist ? 'aktuell' : 'unbekannt',
    istRelease: r.ist ? 'edge-2026.08.0' : null,
    releasesDahinter: r.ist ? 0 : null,
    istSeit: null,
    fakten: null,
    ...extra[r.deviceId],
  }));
  return d;
}
const fakten = (o: Partial<{ angenommen: string; bestaetigt: string; schritt: string; grund: string }> = {}): UpdateFakten => ({
  angefragt: { release: 'edge-2026.08.0', releaseSeq: 12, am: vor(10 * 60_000), von: 'admin' },
  angenommen: { stand: o.angenommen ?? 'ja', am: vor(9 * 60_000), grund: null },
  bestaetigt: { stand: o.bestaetigt ?? 'offen', am: null, schritt: o.schritt ?? null, grund: o.grund ?? null },
});
const zeile = (name: string) =>
  within(screen.getByTestId('box-versions')).getAllByTestId('box-zeile').find((r) => r.textContent?.includes(name))!;

describe('EdgeUpdatesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    edgeUpdates.mockResolvedValue(data());
    edgeRelease.mockRejectedValue(new Error('keine Release-Seite'));
    listDevices.mockResolvedValue([]);
  });

  it('zeigt Lage, Linien, Boxen, die laufende Aktualisierung und den Verlauf', async () => {
    render(<EdgeUpdatesPage />);
    expect(await screen.findByTestId('lage')).toBeInTheDocument();
    expect(screen.getByTestId('linie-docker')).toHaveTextContent('edge-2026.08.0');
    expect(screen.getByTestId('box-versions')).toBeInTheDocument();
    expect(await screen.findByTestId('rollout-card')).toBeInTheDocument();
    expect(screen.getByTestId('journal')).toBeInTheDocument();
    expect(screen.getByText('Verlauf').closest('details')).not.toHaveAttribute('open');
    // Die Online-Uhr kommt mit der Flotte (G2) - kein zweiter Abruf des Inventars.
    expect(listDevices).not.toHaveBeenCalled();
  });

  it('zeigt je Box die laufende Version, ihre Anfrage und die drei Schritte - getrennt', async () => {
    edgeUpdates.mockResolvedValue(mitStand(data({ rollouts: [] }), {
      d1: { ist: 'edge-2026.07.2-665d59b8c0de', istRelease: 'edge-2026.07.2', releasesDahinter: 1, stand: 'laeuft',
        state: 'laedt', fakten: fakten({ bestaetigt: 'laeuft', schritt: 'laedt' }) },
    }));
    render(<EdgeUpdatesPage />);
    await screen.findByTestId('box-versions');
    const pilsting = zeile('Pilsting');
    expect(within(pilsting).getByTestId('box-laeuft')).toHaveTextContent('edge-2026.07.2');
    expect(within(pilsting).getByTestId('box-ziel')).toHaveTextContent('Anfrage edge-2026.08.0');
    expect(pilsting).toHaveTextContent('Update läuft');
    const schritte = within(pilsting).getAllByRole('listitem');
    expect(schritte.map((s) => [s.textContent, s.getAttribute('data-zustand')])).toEqual([
      ['angefragt', 'fertig'], ['angenommen', 'fertig'], ['bestätigt', 'aktiv'],
    ]);
    expect(pilsting).toHaveTextContent(/angenommen \d\d:\d\d · lädt/);
    expect(zeile('Auernheim')).toHaveTextContent('Keine Versionsmeldung');
    expect(zeile('Auernheim')).not.toHaveTextContent('veraltet');
  });

  it('sucht über Box, Anlage, Kunde und Version und setzt den Filter zurück', async () => {
    edgeUpdates.mockResolvedValue(mitStand(data()));
    render(<EdgeUpdatesPage />);
    await screen.findByTestId('box-versions');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Boxen durchsuchen' }), { target: { value: 'edge-a1' } });
    expect(screen.getByTestId('box-versions')).toHaveTextContent('Pilsting');
    expect(screen.getByTestId('box-versions')).not.toHaveTextContent('Auernheim');
    const zustand = screen.getByRole('group', { name: 'Boxen nach Zustand filtern' });
    fireEvent.click(within(zustand).getByRole('button', { name: 'Offline 0' }));
    expect(within(zustand).getByRole('button', { name: 'Offline 0' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Keine Box passt zu diesem Filter.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Filter zurücksetzen' }));
    expect(screen.getByTestId('box-versions')).toHaveTextContent('Auernheim');
    expect(screen.getByRole('searchbox', { name: 'Boxen durchsuchen' })).toHaveValue('');
  });

  // Geräte & Updates S0: der Stand vom 05.11. - das jüngste Release ist Edge Light.
  const stand0511 = (): EdgeUpdates => {
    const d = data({ rollouts: [] });
    d.releases = [
      { releaseSeq: 60, version: 'edge-light-2026.11.4', targetCommit: 'e4a3b957', notes: null,
        signed: true, signingKeyId: 'rel-2026-a', createdAt: '2026-11-05T15:43:00Z',
        runningOnDevices: 1, boxArt: 'light' },
      { releaseSeq: 58, version: 'edge-2026.10.7', targetCommit: 'c39b18d9', notes: null,
        signed: true, signingKeyId: 'rel-2026-a', createdAt: '2026-10-28T11:00:00Z',
        runningOnDevices: 1, boxArt: 'docker' },
    ];
    d.fleet = [
      { ...d.fleet[0], ist: 'edge-2026.10.7-c39b18d9c2a4', soll: null, sollSeq: null, state: 'aktuell',
        rolloutId: null, boxArt: 'docker', linie: 'docker', stand: 'aktuell', istRelease: 'edge-2026.10.7',
        releasesDahinter: 0, lastSeenAt: vor(8_000), fakten: null },
      { deviceId: 'gate', label: 'VoltPilotGATE', externalRef: 'edge-h5atkys', siteId: 's4',
        siteName: 'Heizstab-Pilot', tenantId: 't2', tenantName: 'Kunde C', ist: 'edge-light-2026.11.4',
        soll: null, sollSeq: null, state: 'aktuell', reason: null, since: null,
        reportedAt: '2026-11-05T16:02:00Z', rolloutId: null, boxArt: 'light', linie: 'light', stand: 'aktuell',
        istRelease: 'edge-light-2026.11.4', releasesDahinter: 0, lastSeenAt: vor(8_000), fakten: null,
        trust: { rootKeyIds: ['root-2026-a'], trustSetKeyIds: ['rel-2026-a'],
          trustSetGeneratedAt: '2026-11-04T10:00:00Z', trustSetError: null } },
      { deviceId: 'zuhause', label: 'Zuhause', externalRef: 'edge-tgjn9gd', siteId: 's5',
        siteName: 'Zuhause', tenantId: 't3', tenantName: 'Werner Schramm', ist: 'edge-light-2026.11.0',
        soll: null, sollSeq: null, state: 'aktuell', reason: null, since: null,
        reportedAt: '2026-11-05T16:40:00Z', rolloutId: null, boxArt: 'light', linie: 'light', stand: 'hand',
        stufe1: true, istRelease: 'edge-light-2026.11.0', releasesDahinter: 1, lastSeenAt: vor(10_000), fakten: null,
        trust: { rootKeyIds: ['root-2026-a'], trustSetKeyIds: [], trustSetGeneratedAt: null,
          trustSetError: 'Auf diesem Geraet liegt kein root-signiertes Vertrauens-Set.' } },
    ];
    d.kpi = { known: 3, upToDate: 1, unknown: 0, inRollout: 0, failed: 0, newestRelease: 'edge-light-2026.11.4' };
    d.lines = [
      { boxArt: 'docker', newestRelease: 'edge-2026.10.7', newestReleaseSeq: 58, devices: 1, known: 1, upToDate: 1, releases: 1,
        versions: [{ version: 'edge-2026.10.7', releaseSeq: 58, devices: ['d1'] }] },
      { boxArt: 'light', newestRelease: 'edge-light-2026.11.4', newestReleaseSeq: 60, devices: 2, known: 2, upToDate: 1, releases: 1,
        versions: [
          { version: 'edge-light-2026.11.4', releaseSeq: 60, devices: ['gate'] },
          { version: 'edge-light-2026.11.0', releaseSeq: null, devices: ['zuhause'] },
        ] },
    ];
    return d;
  };

  it('zeigt je Linie eine Karte - das Docker-Release verschwindet nicht hinter Edge Light (S0)', async () => {
    edgeUpdates.mockResolvedValue(stand0511());
    edgeRelease.mockResolvedValue({ releaseSeq: 60, programme: [
      { arch: 'linux/mipsle', groesse: 9, empfangen: 9, fertig: true },
      { arch: 'linux/arm64', groesse: 9, empfangen: 3, fertig: false },
    ] });
    render(<EdgeUpdatesPage />);
    const docker = await screen.findByTestId('linie-docker');
    expect(within(docker).getByTestId('linie-neuestes')).toHaveTextContent('edge-2026.10.7');
    expect(within(docker).getByTestId('linie-plattformen')).toHaveTextContent('PC · amd64');
    expect(within(docker).getByRole('button', { name: 'Alle aktuell' })).toBeDisabled();
    const light = screen.getByTestId('linie-light');
    expect(within(light).getByTestId('linie-neuestes')).toHaveTextContent('edge-light-2026.11.4');
    expect(light).toHaveTextContent('1 neuestes');
    expect(light).toHaveTextContent('1 nur von Hand (Stufe 1)');
    expect(within(light).getByTestId('linie-leiter')).toHaveTextContent('Zuhause · Stufe 1');
    // Die Release-Seite sagt, welche Programme fertig im Portal liegen.
    await waitFor(() => expect(within(light).getByTestId('linie-plattformen')).toHaveTextContent('Mango · mipsle ✓'));
    expect(within(light).getByTestId('linie-plattformen')).toHaveTextContent('Raspberry Pi · arm64 · noch nicht im Portal');
    expect(edgeRelease).toHaveBeenCalledWith(60);
    expect(screen.getByTestId('lage')).toHaveTextContent('1 Edge-Light-Box nimmt keine Updates aus dem Portal an (Stufe 1).');

    // Stufe 1: der Knopf führt zur Box, nicht in einen Verteil-Dialog.
    fireEvent.click(within(light).getByRole('button', { name: 'Nachrüsten: so geht’s' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('Zuhause');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Die Releases der Linie: das Edge-Light-Release verteilen, Zuhause ist ausgegraut.
    fireEvent.click(within(light).getByRole('button', { name: 'Releases (1)' }));
    const releases = await screen.findByRole('dialog', { name: 'Releases · Edge Light' });
    fireEvent.click(within(releases).getByRole('button', { name: /Aktualisieren/ }));
    const drawer = await screen.findByRole('dialog', { name: 'Aktualisieren auf edge-light-2026.11.4' });
    const zuhause = within(drawer).getAllByTestId('candidate-gesperrt').find((c) => c.textContent?.includes('Zuhause'))!;
    expect(zuhause).toHaveTextContent('diese Box hat Stufe 1');
    expect(zuhause.querySelector('input')).toBeDisabled();
    expect(within(drawer).getByTestId('choose-all')).toHaveTextContent('Alle passenden Geräte (1)');
  });

  it('zeigt das gemeldete Gerät in der Tabelle und im Drawer, mit dem Loader-Stand (G8)', async () => {
    const d = stand0511();
    d.fleet[0] = { ...d.fleet[0], geraetModell: 'Raspberry Pi 4 Model B Rev 1.4', geraetArch: 'arm64' };
    d.fleet[2] = { ...d.fleet[2], geraetModell: 'GL.iNet GL-MT300N-V2', geraetArch: 'mipsle', loader: 'flash' };
    edgeUpdates.mockResolvedValue(d);
    render(<EdgeUpdatesPage />);
    await screen.findByTestId('box-versions');
    expect(within(zeile('Pilsting')).getByTestId('box-geraet')).toHaveTextContent('Raspberry Pi 4 Model B Rev 1.4 · arm64');
    expect(within(zeile('Heizstab-Pilot')).getByTestId('box-geraet')).toHaveTextContent('Gerät nicht gemeldet');
    fireEvent.click(screen.getByRole('button', { name: 'Update verwalten für Zuhause · edge-tgjn9gd' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByTestId('drawer-geraet')).toHaveTextContent('GL.iNet GL-MT300N-V2 · mipsle');
    expect(within(drawer).getByTestId('drawer-loader'))
      .toHaveTextContent('startet nur die Fassung aus dem Flash (Stufe 1)');
  });

  it('bietet ein unsigniertes neuestes Release nicht zum Verteilen an und sagt es', async () => {
    const d = mitStand(data(), { d1: { stand: 'aelter', releasesDahinter: 1 } });
    d.releases[1].releaseSeq = 20;
    edgeUpdates.mockResolvedValue(d);
    render(<EdgeUpdatesPage />);
    const docker = await screen.findByTestId('linie-docker');
    expect(within(docker).getByTestId('linie-neuestes')).toHaveTextContent('edge-2026.07.2');
    expect(docker).toHaveTextContent('nicht signiert – nicht verteilbar');
    expect(within(docker).getByRole('button', { name: 'Verteilen …' })).toBeDisabled();
    expect(within(docker).getByTestId('linie-sperre')).toHaveTextContent('Nicht signiert – nicht verteilbar.');
  });

  it('zeigt eine Ablehnung direkt im Box-Dialog und erhält die Auswahl', async () => {
    const { ApiError } = await import('../../api');
    setUpdateTarget.mockRejectedValue(new ApiError(409, 'Dieses Release ist nicht mehr verfügbar.'));
    render(<EdgeUpdatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Update verwalten für Pilsting · edge-a1' }));
    const drawer = await screen.findByRole('dialog');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Aktualisieren' }));
    expect(await within(drawer).findByRole('alert')).toHaveTextContent('Dieses Release ist nicht mehr verfügbar.');
    expect(drawer).toBeInTheDocument();
  });

  it('erhält bei einem fehlgeschlagenen Refresh die Versionen mit sichtbarem Hinweis', async () => {
    render(<EdgeUpdatesPage />);
    await screen.findByTestId('box-versions');
    edgeUpdates.mockRejectedValue(new Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Neu laden' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('zuletzt geladenen Versionsstände bleiben sichtbar');
    expect(screen.getByTestId('box-versions')).toHaveTextContent('edge-2026.08.0');
  });

  it('bietet ein Update NUR für ein signiertes Release an', async () => {
    render(<EdgeUpdatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Releases (2)' }));
    const table = within(await screen.findByRole('dialog', { name: 'Releases · Docker-Box' })).getByTestId('releases');
    const rows = within(table).getAllByRole('row');
    // Das signierte Release trägt den Knopf, das unsignierte den Grund.
    expect(within(rows[1]).getByRole('button', { name: /Aktualisieren/ })).toBeEnabled();
    expect(within(rows[2]).queryByRole('button')).toBeNull();
    expect(rows[2]).toHaveTextContent('Nicht signiert');
  });

  it('ist EIN Schritt: Release wählen, Geräte ankreuzen, aktualisieren', async () => {
    // Das ist der Kern des Umbaus. Es gibt keine Welle, keinen Canary, keinen
    // Kanal und keinen zweiten Knopf „Auf Gerät anwenden".
    createRollout.mockResolvedValue({ rolloutId: 'r2' });
    render(<EdgeUpdatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Releases (2)' }));
    const releases = await screen.findByRole('dialog', { name: 'Releases · Docker-Box' });
    fireEvent.click(within(releases).getAllByRole('button', { name: /Aktualisieren/ })[0]);

    const drawer = await screen.findByRole('dialog', { name: 'Aktualisieren auf edge-2026.08.0' });
    fireEvent.click(within(drawer).getByTestId('choose-all').querySelector('input')!);
    // Die Zusammenfassung sagt VOR dem Klick, was passiert.
    expect(within(drawer).getByTestId('start-summary')).toHaveTextContent('niemand muss an ein Gerät');

    fireEvent.click(within(drawer).getByRole('button', { name: 'Aktualisieren' }));
    await waitFor(() =>
      // Die Reihenfolge ist die der Liste (Aufmerksamkeit zuerst), nicht die
      // der Flotten-Antwort.
      expect(createRollout).toHaveBeenCalledWith({ releaseSeq: 12, devices: ['d2', 'd1'] }),
    );
  });

  it('verteilt aus der Linien-Karte das neueste Release dieser Linie', async () => {
    edgeUpdates.mockResolvedValue(mitStand(data({ rollouts: [] }), {
      d1: { ist: 'edge-2026.07.2-665d59b8c0de', istRelease: 'edge-2026.07.2', releasesDahinter: 1, stand: 'aelter' },
    }));
    render(<EdgeUpdatesPage />);
    const docker = await screen.findByTestId('linie-docker');
    fireEvent.click(within(docker).getByRole('button', { name: 'Verteilen …' }));
    expect(await screen.findByRole('dialog', { name: 'Aktualisieren auf edge-2026.08.0' })).toBeInTheDocument();
  });

  it('nennt in „Braucht dich" Box, Grund und nächsten Schritt - ohne irgendetwas anzuhalten', async () => {
    const nav = vi.fn();
    edgeUpdates.mockResolvedValue(mitStand(data(), {
      d1: { state: 'fehlgeschlagen', stand: 'fehler', reason: 'Selbsttest fehlgeschlagen.',
        fakten: fakten({ bestaetigt: 'fehlgeschlagen', grund: 'Selbsttest fehlgeschlagen.' }) },
      d2: { ist: 'edge-2026.07.2-665d59b8c0de', istRelease: 'edge-2026.07.2', releasesDahinter: 1, stand: 'offline',
        lastSeenAt: vor(3 * 3600_000), fakten: fakten({ angenommen: 'wartet' }) },
    }));
    render(<EdgeUpdatesPage onNavigate={nav} />);
    expect(await screen.findByTestId('lage')).toHaveTextContent('1 Box braucht dich: Pilsting meldet ein fehlgeschlagenes Update.');
    const aufgaben = within(screen.getByTestId('braucht-dich')).getAllByTestId('aufgabe');
    expect(aufgaben.map((a) => a.querySelector('h3')?.textContent)).toEqual([
      'Pilsting: Update fehlgeschlagen', `Auernheim ist seit 3${NB}Std. offline`,
    ]);
    expect(aufgaben[0]).toHaveTextContent('Die Anfrage edge-2026.08.0 ist fehlgeschlagen: Selbsttest fehlgeschlagen.');
    expect(aufgaben[1]).toHaveTextContent('die Box holt es, sobald sie sich wieder meldet');
    // Der nächste Schritt: Fernwartung für die stumme Box, die Box selbst für den Fehler.
    fireEvent.click(within(aufgaben[1]).getByRole('button', { name: 'Fernwartung' }));
    expect(nav).toHaveBeenCalledWith(expect.objectContaining({ page: 'fernwartung' }));
    fireEvent.click(within(aufgaben[0]).getByRole('button', { name: 'Box ansehen' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('Pilsting');
    // Ein Fehlschlag ist INFORMATION: die Verteilung läuft weiter.
    expect(screen.getByTestId('rollout-card')).toHaveTextContent('läuft');
  });

  it('„Fortschritt" zeigt die Boxen mit laufendem Update', async () => {
    edgeUpdates.mockResolvedValue(mitStand(data({ rollouts: [] }), {
      d1: { ist: 'edge-2026.07.2-665d59b8c0de', istRelease: 'edge-2026.07.2', releasesDahinter: 1, stand: 'laeuft',
        state: 'laedt', fakten: fakten({ bestaetigt: 'laeuft', schritt: 'laedt' }) },
    }));
    render(<EdgeUpdatesPage />);
    expect(await screen.findByTestId('lage')).toHaveTextContent('Ein Update läuft: edge-2026.08.0 an 1 Docker-Box · 0 bestätigt.');
    fireEvent.click(within(screen.getByTestId('linie-docker')).getByRole('button', { name: 'Fortschritt' }));
    const zustand = screen.getByRole('group', { name: 'Boxen nach Zustand filtern' });
    expect(within(zustand).getByRole('button', { name: 'Update läuft 1' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(screen.getByTestId('box-versions')).getAllByTestId('box-zeile')).toHaveLength(1);
  });

  it('sagt im Ruhezustand in EINEM Satz, wie die Flotte steht', async () => {
    const d = mitStand(data({ rollouts: [] }), {
      d2: { ist: 'edge-2026.08.0-3bf8c038e1d2', istRelease: 'edge-2026.08.0', releasesDahinter: 0, stand: 'aktuell' },
    });
    edgeUpdates.mockResolvedValue(d);
    render(<EdgeUpdatesPage />);
    expect(await screen.findByTestId('lage')).toHaveTextContent('Alle 2 Boxen laufen auf dem neuesten Release ihrer Linie.');
    expect(within(screen.getByTestId('linie-docker')).getByRole('button', { name: 'Alle aktuell' })).toBeDisabled();
    expect(screen.queryByTestId('braucht-dich')).toBeNull();
    expect(screen.queryByTestId('rollout-card')).toBeNull();
  });

  it('zeigt eine Ablehnung des Servers WÖRTLICH', async () => {
    const { ApiError } = await import('../../api');
    createRollout.mockRejectedValue(
      new ApiError(409, 'Das Release ist nicht signiert und kann nicht verteilt werden.'),
    );
    render(<EdgeUpdatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Releases (2)' }));
    const releases = await screen.findByRole('dialog', { name: 'Releases · Docker-Box' });
    fireEvent.click(within(releases).getAllByRole('button', { name: /Aktualisieren/ })[0]);
    const drawer = await screen.findByRole('dialog', { name: 'Aktualisieren auf edge-2026.08.0' });
    fireEvent.click(within(drawer).getByTestId('choose-all').querySelector('input')!);
    fireEvent.click(within(drawer).getByRole('button', { name: 'Aktualisieren' }));
    expect(await screen.findByText(/nicht signiert/)).toBeInTheDocument();
    // Die Auswahl bleibt stehen: der Betreiber soll den Grund lesen und es
    // erneut versuchen können, statt von vorn anzufangen.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByTestId('choose-all')
      .querySelector('input')!).toBeChecked();
  });

  describe('Box-Art (Edge Light, Stufe 1)', () => {
    /** Die Pilot-Box: meldet sich am Stempel als Edge Light, ohne Vertrauens-Set. */
    const mitEdgeLight = () => {
      const d = mitStand(data({ rollouts: [] }), {
        d1: { ist: 'edge-2026.07.2-665d59b8c0de', istRelease: 'edge-2026.07.2', releasesDahinter: 1, stand: 'aelter' },
        d2: { boxArt: null, linie: null },
      });
      d.fleet.push({
        deviceId: 'd3', label: 'Mango Hof', externalRef: 'edge-m4ng0q1', siteId: 's3',
        siteName: 'Hof Linde', tenantId: 't1', tenantName: 'Kunde B',
        ist: 'edge-light-g2d2bca1b6', soll: null, sollSeq: null, state: 'aktuell', reason: null,
        since: null, reportedAt: '2026-08-05T09:00:00Z', rolloutId: null, boxArt: 'light',
        linie: 'light', stand: 'hand', stufe1: true, istRelease: null, releasesDahinter: null,
        lastSeenAt: vor(20_000), fakten: null,
        trust: { rootKeyIds: ['root-2026-a'], trustSetKeyIds: [], trustSetGeneratedAt: null,
          trustSetError: 'Das Vertrauens-Set oder seine Signatur fehlt.' },
      });
      return d;
    };

    it('zeigt die Linie als Chip, Stufe 1 ruhig als „nur von Hand", und filtert nach Linie', async () => {
      edgeUpdates.mockResolvedValue(mitEdgeLight());
      render(<EdgeUpdatesPage />);
      await screen.findByTestId('box-versions');
      expect(within(zeile('Hof Linde')).getByTestId('box-art')).toHaveTextContent('Edge Light');
      expect(within(zeile('Pilsting')).getByTestId('box-art')).toHaveTextContent('Docker-Box');
      expect(within(zeile('Auernheim')).getByTestId('box-art')).toHaveTextContent('Box-Art unbekannt');
      // Ruhig benannt statt „ohne Vertrauens-Set" als Warnung.
      expect(zeile('Hof Linde')).toHaveTextContent('nur von Hand · Stufe 1');
      expect(zeile('Hof Linde')).not.toHaveTextContent('ohne Vertrauens-Set');
      expect(within(screen.getByTestId('braucht-dich')).getByTestId('aufgabe'))
        .toHaveTextContent('Hof Linde: nur von Hand (Stufe 1)');

      const linie = screen.getByRole('group', { name: 'Boxen nach Linie filtern' });
      fireEvent.click(within(linie).getByRole('button', { name: 'Edge Light 1' }));
      expect(within(screen.getByTestId('box-versions')).getAllByTestId('box-zeile')).toHaveLength(1);
      expect(screen.getByTestId('box-versions')).toHaveTextContent('Hof Linde');
      expect(screen.getByTestId('box-versions')).not.toHaveTextContent('Pilsting');
    });

    it('graut im Verteil-Dialog die Edge-Light-Box aus und nennt den Grund', async () => {
      createRollout.mockResolvedValue({ rolloutId: 'r2' });
      edgeUpdates.mockResolvedValue(mitEdgeLight());
      render(<EdgeUpdatesPage />);
      fireEvent.click(within(await screen.findByTestId('linie-docker')).getByRole('button', { name: 'Verteilen …' }));
      const drawer = await screen.findByRole('dialog');
      expect(within(drawer).getByTestId('release-box-art')).toHaveTextContent('Docker-Box');
      expect(within(drawer).getByTestId('release-box-art'))
        .toHaveTextContent('1 Gerät passt nicht dazu');
      const gesperrt = within(drawer).getByTestId('candidate-gesperrt');
      expect(gesperrt).toHaveTextContent('Hof Linde');
      expect(gesperrt).toHaveTextContent('diese Box ist eine Edge Light');
      expect(gesperrt.querySelector('input')).toBeDisabled();

      const all = within(drawer).getByTestId('choose-all');
      expect(all).toHaveTextContent('Alle passenden Geräte (2)');
      fireEvent.click(all.querySelector('input')!);
      fireEvent.click(within(drawer).getByRole('button', { name: 'Aktualisieren' }));
      await waitFor(() =>
        expect(createRollout).toHaveBeenCalledWith({ releaseSeq: 12, devices: ['d2', 'd1'] }),
      );
    });

    it('bietet einer Edge-Light-Box kein Docker-Release an und sagt warum', async () => {
      const d = mitEdgeLight();
      // Eine Zuweisung aus der Zeit vor der Sperre bleibt zurücknehmbar.
      d.fleet[2].soll = 'edge-2026.08.0';
      d.fleet[2].sollSeq = 12;
      edgeUpdates.mockResolvedValue(d);
      render(<EdgeUpdatesPage />);
      fireEvent.click(await screen.findByRole('button', { name: 'Update verwalten für Hof Linde · edge-m4ng0q1' }));
      const drawer = await screen.findByRole('dialog');
      expect(within(drawer).getByTestId('box-art')).toHaveTextContent('Edge Light');
      expect(within(drawer).getByTestId('drawer-keine-passenden'))
        .toHaveTextContent('diese Box ist eine Edge Light');
      expect(within(drawer).queryByRole('combobox', { name: 'Release' })).toBeNull();
      expect(within(drawer).queryByRole('button', { name: 'Aktualisieren' })).toBeNull();
      expect(drawer).toHaveTextContent('Diese Box prüft Updates noch nicht gegen die Signaturkette');
      expect(within(drawer).getByRole('button', { name: 'Zuweisung zurücknehmen' })).toBeEnabled();
    });

    it('zeigt in den Releases einer Linie nur ihre Releases', async () => {
      const d = mitEdgeLight();
      d.releases[0].boxArt = 'docker';
      d.releases[1].boxArt = 'light';
      edgeUpdates.mockResolvedValue(d);
      render(<EdgeUpdatesPage />);
      fireEvent.click(within(await screen.findByTestId('linie-docker')).getByRole('button', { name: 'Releases (1)' }));
      const docker = await screen.findByRole('dialog', { name: 'Releases · Docker-Box' });
      expect(docker).toHaveTextContent('edge-2026.08.0');
      expect(docker).not.toHaveTextContent('edge-2026.07.2');
    });
  });

  describe('Verbindung je Box aus der EINEN Uhr (G2)', () => {
    it('zeigt je Box die Verbindung nach derselben Regel wie die Registrierung', async () => {
      const d = mitStand(data(), {
        d1: { lastSeenAt: vor(30_000) },
        d2: { lastSeenAt: vor(2 * 3600_000), stand: 'offline' },
      });
      d.fleet.push({ ...d.fleet[1], deviceId: 'd3', label: 'edge-c3', externalRef: 'edge-c3', siteName: 'Kirchdorf',
        lastSeenAt: null, stand: 'unbekannt' });
      d.fleet.push({ ...d.fleet[1], deviceId: 'd4', label: 'edge-d4', externalRef: 'edge-d4', siteName: 'Alter Server',
        lastSeenAt: undefined, stand: 'unbekannt' });
      edgeUpdates.mockResolvedValue(d);
      render(<EdgeUpdatesPage />);
      await screen.findByTestId('box-versions');
      expect(within(zeile('Pilsting')).getByTestId('box-verbindung')).toHaveTextContent('Verbundenvor 30 Sek.');
      expect(within(zeile('Auernheim')).getByTestId('box-verbindung')).toHaveTextContent('Meldet sich nichtseit 2 Std.');
      expect(within(zeile('Kirchdorf')).getByTestId('box-verbindung')).toHaveTextContent('Wartet auf erste Meldung');
      // Ohne Uhr vom Server (älterer Stand) ist die Verbindung unbekannt - nie „noch nie gemeldet".
      expect(within(zeile('Alter Server')).getByTestId('box-verbindung')).toHaveTextContent('Verbindung unbekannt');

      const zustand = screen.getByRole('group', { name: 'Boxen nach Zustand filtern' });
      fireEvent.click(within(zustand).getByRole('button', { name: 'Offline 1' }));
      expect(within(screen.getByTestId('box-versions')).getAllByTestId('box-zeile')).toHaveLength(1);
      expect(screen.getByTestId('box-versions')).toHaveTextContent('Auernheim');
    });
  });


  it('bietet NIRGENDS einen zweiten Schritt am Gerät an', async () => {
    render(<EdgeUpdatesPage />);
    await screen.findByTestId('rollout-card');
    for (const gone of [/Nächste Welle/, /Jetzt anwenden/, /Auf dem Gerät anwenden/,
      /Not-Aus/, /Rollout einfrieren/, /Pausieren/]) {
      expect(screen.queryByRole('button', { name: gone })).toBeNull();
    }
  });

  it('zeigt ein Gerät ohne Meldung als „unbekannt" MIT Grund - nie als veraltet', async () => {
    render(<EdgeUpdatesPage />);
    const devices = await screen.findByTestId('rollout-devices');
    const row = within(devices).getByText('Auernheim').closest('tr')!;
    expect(row).toHaveTextContent('unbekannt');
    expect(row).toHaveTextContent('noch keinen Software-Stand gemeldet');
    expect(row).not.toHaveTextContent('veraltet');
  });

  it('zeigt einen Live-Status nur unter dem aktuell zugewiesenen Release', async () => {
    // Regression 28.08.2026: der `.26`-Live-Status darf NICHT auch in der
    // historischen `.25`-Karte als „lädt" auftauchen. Nur die Karte der
    // aktuellen Zuweisung bleibt; der alte Auftrag lebt im Verlauf weiter.
    const d = data();
    d.rollouts.push({
      ...d.rollouts[0],
      id: 'r-old',
      releaseVersion: 'edge-2026.07.2',
      releaseSeq: 11,
      createdAt: '2026-07-20T08:00:00Z',
      devices: d.rollouts[0].devices.map((device) => ({ ...device, state: 'laedt' })),
    });
    edgeUpdates.mockResolvedValue(d);
    render(<EdgeUpdatesPage />);
    const cards = await screen.findAllByTestId('rollout-card');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent('edge-2026.08.0');
    expect(cards[0]).not.toHaveTextContent('edge-2026.07.2');
  });

  it('nennt den HEBEL einer stehenden Sperre, statt nur ihren Satz', async () => {
    const d = data();
    d.fleet[1].state = 'blockiert';
    d.fleet[1].blocker = 'platte';
    d.fleet[1].reason = 'Autonomie blockiert: zu wenig Platz.';
    edgeUpdates.mockResolvedValue(d);
    render(<EdgeUpdatesPage />);
    const devices = await screen.findByTestId('rollout-devices');
    const row = within(devices).getByText('Auernheim').closest('tr')!;
    expect(row).toHaveTextContent('Hebel:');
  });

  it('rendert eine historische Mitgliedschaft nicht als heutigen Geräte-Status', async () => {
    const d = data();
    d.rollouts[0].devices[1] = {
      deviceId: '7a1f0c2e-1111-2222-3333-444455556666', label: null, siteName: null,
      tenantName: null, state: 'unbekannt', reason: null, since: null, removed: true,
    };
    d.fleet = [d.fleet[0]];
    edgeUpdates.mockResolvedValue(d);
    render(<EdgeUpdatesPage />);
    const devices = await screen.findByTestId('rollout-devices');
    expect(devices).not.toHaveTextContent('7a1f0c2e-1111');
    expect(devices).not.toHaveTextContent('Entferntes Gerät');
  });

  it('blendet das Zustands-Protokoll aus dem Verlauf aus', async () => {
    render(<EdgeUpdatesPage />);
    const journal = await screen.findByTestId('journal');
    fireEvent.click(screen.getByText('Verlauf'));
    expect(journal).toHaveTextContent('Aktualisierung gestartet');
    expect(within(journal).queryByText(/bestaetigt/)).toBeNull();
  });

  it('weist ein Einzelgerät über die Geräte-Zeile zu - ohne Kanal und ohne Pin', async () => {
    setUpdateTarget.mockResolvedValue(undefined);
    render(<EdgeUpdatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Auernheim' }));

    const drawer = await screen.findByRole('dialog');
    expect(drawer).toHaveTextContent('edge-2026.08.0');
    expect(drawer).not.toHaveTextContent('Kanal');
    expect(within(drawer).queryByText(/Festnageln/)).toBeNull();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Aktualisieren' }));
    await waitFor(() =>
      expect(setUpdateTarget).toHaveBeenCalledWith('d2', { releaseSeq: 12 }),
    );
  });

  it('führt aus dem Drawer auf die EINE Geräteseite - mit gesetztem Mandanten', async () => {
    const jump = vi.fn();
    render(<EdgeUpdatesPage onJumpToTenant={jump} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pilsting' }));
    fireEvent.click(await screen.findByRole('button', { name: /Geräteseite öffnen/ }));
    expect(jump).toHaveBeenCalledWith('t1', {
      page: 'anlagen',
      siteId: 's1',
      sub: 'geraet',
      // Die REFERENZ ist der Schlüssel, nie die Geräte-UUID.
      geraet: { ref: 'edge-a1', geraetId: null },
    });
  });

  it('zeigt die Bezugszeit der gezeigten Daten', async () => {
    render(<EdgeUpdatesPage />);
    expect(await screen.findByTestId('freshness')).toHaveTextContent('Stand:');
  });

  it('pollt sich SELBST, statt auf einen Knopfdruck zu warten', async () => {
    vi.useFakeTimers();
    try {
      render(<EdgeUpdatesPage />);
      await act(async () => { await Promise.resolve(); });
      expect(edgeUpdates).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(edgeUpdates.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('behandelt reine Rollout-Historie als Ruhezustand', async () => {
    const d = data();
    d.fleet = d.fleet.map((device) => ({
      ...device,
      soll: null,
      sollSeq: null,
      rolloutId: null,
    }));
    edgeUpdates.mockResolvedValue(d);
    render(<EdgeUpdatesPage />);

    // Ohne heutige Zuweisung läuft nichts: keine Lauf-Karte, kein „läuft" im Lage-Satz.
    expect(await screen.findByTestId('lage')).not.toHaveTextContent('läuft');
    expect(screen.queryByTestId('rollout-card')).toBeNull();
  });

  it('trägt den ruhigen Crossover-Hinweis im Verweis auf die Geräte-Seite', async () => {
    const d = data();
    d.fleet[0].trust = {
      rootKeyIds: [], trustSetKeyIds: [], trustSetGeneratedAt: null, trustSetError: null,
    };
    edgeUpdates.mockResolvedValue(d);
    render(<EdgeUpdatesPage />);
    expect(await screen.findByTestId('fleet-pointer')).toHaveTextContent('Crossover offen');
  });
});
