import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EdgeUpdates, FleetRow, UpdateFakten } from '../../adminEdgeUpdates';

const edgeUpdates = vi.fn();
const edgeRelease = vi.fn();
const edgeEignung = vi.fn();
const boxVerlauf = vi.fn();
const createRollout = vi.fn();
const setUpdateTarget = vi.fn();
const revertUpdateTarget = vi.fn();
const listDevices = vi.fn();

vi.mock('../../admin/adminApi', () => ({
  adminApi: {
    edgeUpdates: (...a: unknown[]) => edgeUpdates(...a),
    edgeRelease: (...a: unknown[]) => edgeRelease(...a),
    edgeEignung: (...a: unknown[]) => edgeEignung(...a),
    boxVerlauf: (...a: unknown[]) => boxVerlauf(...a),
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
const fakten = (o: Partial<{ angenommen: string; bestaetigt: string; schritt: string; grund: string;
  bestaetigtAm: string }> = {}): UpdateFakten => ({
  angefragt: { release: 'edge-2026.08.0', releaseSeq: 12, am: vor(10 * 60_000), von: 'admin' },
  angenommen: { stand: o.angenommen ?? 'ja', am: vor(9 * 60_000), grund: null },
  bestaetigt: { stand: o.bestaetigt ?? 'offen', am: o.bestaetigtAm ?? null, schritt: o.schritt ?? null, grund: o.grund ?? null },
});
/** Pilsting auf dem älteren Release - damit es etwas zu verteilen gibt. */
const aelter07 = { ist: 'edge-2026.07.2-665d59b8c0de', istRelease: 'edge-2026.07.2', releasesDahinter: 1, stand: 'aelter' };
/** Die Eignung, wie die API sie für EIN Release liefert (G1). */
const eignung = (releaseSeq: number, version: string, gruppen: Record<string, [string, string | null]>, andereLinie = 0) => ({
  releaseSeq, version, boxArt: version.startsWith('edge-light-') ? 'light' : 'docker', andereLinie,
  boxen: Object.entries(gruppen).map(([id, [gruppe, grund]]) => {
    const namen: Record<string, [string, string]> = { d1: ['Pilsting', 'edge-a1'], d2: ['Auernheim', 'edge-b2'],
      gate: ['Heizstab-Pilot', 'edge-h5atkys'], zuhause: ['Zuhause', 'edge-tgjn9gd'] };
    const [siteName, ref] = namen[id] ?? [id, id];
    return { deviceId: id, label: ref, externalRef: ref, siteName, tenantName: 'Kunde A', ist: null, gruppe, grund,
      lastSeenAt: vor(30_000) };
  }),
});

describe('EdgeUpdatesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    edgeUpdates.mockResolvedValue(data());
    edgeRelease.mockRejectedValue(new Error('keine Release-Seite'));
    boxVerlauf.mockResolvedValue({ deviceId: 'd1', eintraege: [] });
    listDevices.mockResolvedValue([]);
  });

  it('zeigt Lage, Linien und den Verlauf - der Lauf steht in der Linien-Karte, nicht darunter (G6)', async () => {
    render(<EdgeUpdatesPage />);
    expect(await screen.findByTestId('lage')).toBeInTheDocument();
    expect(screen.getByTestId('linie-docker')).toHaveTextContent('edge-2026.08.0');
    // Die Boxenliste entfällt hier (Scheibe S2, §4.3) - sie wohnt in der Geräte-Liste.
    expect(screen.queryByTestId('box-versions')).toBeNull();
    expect(screen.queryByTestId('rollout-card')).toBeNull();
    expect(screen.getByTestId('journal')).toBeInTheDocument();
    expect(screen.getByText('Verlauf').closest('details')).not.toHaveAttribute('open');
    // Die Online-Uhr kommt mit der Flotte (G2) - kein zweiter Abruf des Inventars.
    expect(listDevices).not.toHaveBeenCalled();
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
    const nav = vi.fn();
    edgeUpdates.mockResolvedValue(stand0511());
    edgeRelease.mockResolvedValue({ releaseSeq: 60, programme: [
      { arch: 'linux/mipsle', groesse: 9, empfangen: 9, fertig: true },
      { arch: 'linux/arm64', groesse: 9, empfangen: 3, fertig: false },
    ] });
    render(<EdgeUpdatesPage onNavigate={nav} />);
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

    // Stufe 1: der Knopf führt zur Box-Akte, nicht in einen Verteil-Dialog.
    fireEvent.click(within(light).getByRole('button', { name: 'Nachrüsten: so geht’s' }));
    expect(nav).toHaveBeenCalledWith(expect.objectContaining({
      page: 'geraete-registry', geraeteAkte: { ref: 'edge-tgjn9gd', reiter: 'software' },
    }));
    nav.mockClear();

    // Die Releases der Linie: verteilen öffnet den Dialog (G6); Zuhause kann nicht - mit dem Weg.
    edgeEignung.mockResolvedValue(eignung(60, 'edge-light-2026.11.4', {
      gate: ['aktuell', null],
      zuhause: ['kann_nicht', 'Release für Edge Light – diese Box hat Stufe 1 und nimmt keine Updates aus dem Portal an.'],
    }, 1));
    fireEvent.click(within(light).getByRole('button', { name: 'Releases (1)' }));
    const releases = await screen.findByRole('dialog', { name: 'Releases · Edge Light' });
    fireEvent.click(within(releases).getByRole('button', { name: /Verteilen/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Update verteilen · Edge Light' });
    expect(edgeEignung).toHaveBeenCalledWith(60);
    const kannNicht = await within(dialog).findByTestId('verteil-kann_nicht');
    expect(kannNicht).toHaveTextContent('Zuhause');
    expect(kannNicht).toHaveTextContent('diese Box hat Stufe 1');
    expect(within(kannNicht).getByRole('checkbox')).toBeDisabled();
    expect(within(dialog).getByTestId('verteil-aktuell')).toHaveTextContent('Heizstab-Pilot');
    expect(within(dialog).getByTestId('verteil-satz')).toHaveTextContent('Keine Box dieser Linie kann dieses Release jetzt bekommen.');
    expect(within(dialog).getByTestId('verteil-satz')).toHaveTextContent('1 Box kann nicht und bleibt, wie sie ist.');
    expect(within(dialog).getByRole('button', { name: '0 Boxen anfragen' })).toBeDisabled();
    expect(dialog).toHaveTextContent('1 Box der anderen Linie kommt für dieses Release nicht in Frage.');
    // „Nachrüsten" führt zur Box-Akte.
    fireEvent.click(within(kannNicht).getByRole('button', { name: 'Nachrüsten' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Update verteilen · Edge Light' })).toBeNull());
    expect(nav).toHaveBeenCalledWith(expect.objectContaining({
      page: 'geraete-registry', geraeteAkte: { ref: 'edge-tgjn9gd', reiter: 'software' },
    }));
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

  it('die Release-Seite: was drin ist, was neu ist, wo es läuft, wann verteilt - und „Verteilen …" (G7)', async () => {
    edgeUpdates.mockResolvedValue(mitStand(data({ rollouts: [] }), { d1: aelter07 }));
    edgeRelease.mockResolvedValue({
      releaseSeq: 12, version: 'edge-2026.08.0', boxArt: 'docker', signed: true, signingKeyId: 'rel-2026-a',
      createdAt: '2026-08-05T08:00:00Z', targetCommit: '3bf8c038', notes: 'Verbindung stabiler.',
      aenderungen: ['Core: Neuverbindung nach Funkloch (#1601)'], erlaubtRueckschritt: false, minFromSeq: null,
      inhalt: [{ typ: 'oci-image', name: 'core', arch: null, groesse: null, gzGroesse: null }], programme: [],
      laeuftAuf: ['d2'], boxenDerLinie: 2,
      verteilt: [{ rolloutId: 'r1', state: 'active', createdBy: 'admin', createdAt: '2026-08-05T08:00:00Z',
        total: 2, confirmed: 1, failed: 0 }],
    });
    edgeEignung.mockResolvedValue(eignung(12, 'edge-2026.08.0', { d1: ['bereit', null] }));
    render(<EdgeUpdatesPage />);
    fireEvent.click(within(await screen.findByTestId('linie-docker')).getByTestId('linie-neuestes'));
    const seite = await screen.findByRole('dialog', { name: 'edge-2026.08.0' });
    expect(edgeRelease).toHaveBeenCalledWith(12);
    expect(await within(seite).findByTestId('release-aenderungen')).toHaveTextContent('Änderungen an der Box seit edge-2026.07.2: 1');
    expect(seite).toHaveTextContent('Core: Neuverbindung nach Funkloch (#1601)');
    expect(within(seite).getByTestId('release-inhalt')).toHaveTextContent('Bild core');
    expect(within(seite).getByTestId('release-inhalt')).toHaveTextContent('nur Werkstatt');
    expect(within(seite).getByTestId('release-laeuft-auf')).toHaveTextContent('1 von 2 Docker-Boxen: Auernheim.');
    expect(within(seite).getByTestId('release-verteilt')).toHaveTextContent('an 2 Boxen angefragt · 1 bestätigt');
    fireEvent.click(within(seite).getByRole('button', { name: 'Verteilen …' }));
    expect(await screen.findByRole('dialog', { name: 'Update verteilen · Docker-Box' })).toBeInTheDocument();
  });

  it('erhält bei einem fehlgeschlagenen Refresh die Versionen mit sichtbarem Hinweis', async () => {
    render(<EdgeUpdatesPage />);
    await screen.findByTestId('linie-docker');
    edgeUpdates.mockRejectedValue(new Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Neu laden' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('zuletzt geladenen Versionsstände bleiben sichtbar');
    expect(screen.getByTestId('linie-docker')).toHaveTextContent('edge-2026.08.0');
  });

  it('bietet ein Update NUR für ein signiertes Release an', async () => {
    render(<EdgeUpdatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Releases (2)' }));
    const table = within(await screen.findByRole('dialog', { name: 'Releases · Docker-Box' })).getByTestId('releases');
    const rows = within(table).getAllByRole('row');
    // Das signierte Release trägt den Knopf, das unsignierte den Grund.
    expect(within(rows[1]).getByRole('button', { name: /Verteilen/ })).toBeEnabled();
    expect(within(rows[2]).queryByRole('button', { name: /Verteilen/ })).toBeNull();
    expect(rows[2]).toHaveTextContent('Nicht signiert');
  });

  it('ist EIN Schritt: Release wählen, Boxen ankreuzen, anfragen - „Erst eine Box" ist nur ein Vorschlag', async () => {
    // Das ist der Kern seit dem Ein-Schritt-Umbau: keine Welle, kein Canary, kein
    // zweiter Knopf. „Erst eine Box" (E1 A) sperrt nichts.
    createRollout.mockResolvedValue({ rolloutId: 'r2' });
    edgeUpdates.mockResolvedValue(mitStand(data({ rollouts: [] }), { d1: aelter07 }));
    edgeEignung.mockResolvedValue(eignung(12, 'edge-2026.08.0', { d1: ['bereit', null], d2: ['wartet', null] }));
    render(<EdgeUpdatesPage />);
    fireEvent.click(within(await screen.findByTestId('linie-docker')).getByRole('button', { name: 'Verteilen …' }));
    const dialog = await screen.findByRole('dialog', { name: 'Update verteilen · Docker-Box' });
    // Nur signierte Releases dieser Linie: das unsignierte steht nicht zur Wahl.
    expect(within(dialog).getAllByRole('radio', { name: /edge-2026/ })).toHaveLength(1);
    expect(within(dialog).getByRole('radio', { name: /edge-2026.08.0/ })).toBeChecked();
    expect(await within(dialog).findByTestId('verteil-bereit')).toHaveTextContent('Pilsting');
    expect(within(dialog).getByTestId('verteil-wartet')).toHaveTextContent('bekommt die Anfrage, sobald sie sich meldet');
    expect(within(dialog).getByRole('radio', { name: /Erst eine Box: Pilsting/ })).toBeChecked();
    expect(within(dialog).getByTestId('verteil-satz')).toHaveTextContent('Fragt jetzt 1 Box an.');
    fireEvent.click(within(dialog).getByRole('radio', { name: /Alle 2 auf einmal/ }));
    expect(within(dialog).getByTestId('verteil-satz')).toHaveTextContent('Fragt jetzt 2 Boxen an.');
    fireEvent.click(within(dialog).getByRole('button', { name: '2 Boxen anfragen' }));
    await waitFor(() => expect(createRollout).toHaveBeenCalledWith({ releaseSeq: 12, devices: ['d1', 'd2'] }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Update verteilen · Docker-Box' })).toBeNull());
  });

  it('fragt bei „Erst eine Box" genau die gewählte erste Box an', async () => {
    createRollout.mockResolvedValue({ rolloutId: 'r3' });
    edgeUpdates.mockResolvedValue(mitStand(data({ rollouts: [] }), { d1: aelter07 }));
    edgeEignung.mockResolvedValue(eignung(12, 'edge-2026.08.0', { d1: ['bereit', null], d2: ['wartet', null] }));
    render(<EdgeUpdatesPage />);
    fireEvent.click(within(await screen.findByTestId('linie-docker')).getByRole('button', { name: 'Verteilen …' }));
    const dialog = await screen.findByRole('dialog', { name: 'Update verteilen · Docker-Box' });
    await within(dialog).findByTestId('verteil-bereit');
    fireEvent.click(within(dialog).getByRole('button', { name: '1 Box anfragen' }));
    await waitFor(() => expect(createRollout).toHaveBeenCalledWith({ releaseSeq: 12, devices: ['d1'] }));
  });

  it('verteilt aus der Linien-Karte das neueste Release dieser Linie', async () => {
    edgeUpdates.mockResolvedValue(mitStand(data({ rollouts: [] }), { d1: aelter07 }));
    edgeEignung.mockResolvedValue(eignung(12, 'edge-2026.08.0', { d1: ['bereit', null] }));
    render(<EdgeUpdatesPage />);
    const docker = await screen.findByTestId('linie-docker');
    fireEvent.click(within(docker).getByRole('button', { name: 'Verteilen …' }));
    const dialog = await screen.findByRole('dialog', { name: 'Update verteilen · Docker-Box' });
    expect(within(dialog).getByRole('radio', { name: /edge-2026.08.0/ })).toBeChecked();
    expect(edgeEignung).toHaveBeenCalledWith(12);
  });

  it('An die übrigen (E1 A): nach der ersten Bestätigung fragt die Karte die übrigen an - ein neuer Lauf', async () => {
    createRollout.mockResolvedValue({ rolloutId: 'r4' });
    edgeUpdates.mockResolvedValue(mitStand(data({ rollouts: [] }), {
      d1: { ist: 'edge-2026.08.0-3bf8c038e1d2', istRelease: 'edge-2026.08.0', releasesDahinter: 0, stand: 'aktuell',
        fakten: fakten({ bestaetigt: 'ja', bestaetigtAm: vor(5 * 60_000) }) },
      d2: { ist: 'edge-2026.07.2-665d59b8c0de', istRelease: 'edge-2026.07.2', releasesDahinter: 1, stand: 'aelter' },
    }));
    edgeEignung.mockResolvedValue(eignung(12, 'edge-2026.08.0', { d1: ['aktuell', null], d2: ['bereit', null] }));
    render(<EdgeUpdatesPage />);
    const lauf = await screen.findByTestId('linie-lauf');
    expect(lauf).toHaveTextContent('edge-2026.08.0 an 1 Box');
    expect(lauf).toHaveTextContent('1angefragt (Portal)1angenommen (Box)1bestätigt (Box)');
    expect(within(lauf).getByTestId('linie-weiter')).toHaveTextContent(/Pilsting hat bestätigt \(\d\d:\d\d\)\. 1 Box läuft noch auf edge-2026\.07\.2\./);
    // Kein zweiter Hauptknopf: den Weg trägt der Lauf.
    expect(within(screen.getByTestId('linie-docker')).queryByRole('button', { name: 'Verteilen …' })).toBeNull();
    fireEvent.click(within(lauf).getByRole('button', { name: 'An die übrigen 1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Update verteilen · Docker-Box' });
    expect(await within(dialog).findByRole('checkbox', { name: /Auernheim/ })).toBeChecked();
    fireEvent.click(within(dialog).getByRole('button', { name: '1 Box anfragen' }));
    await waitFor(() => expect(createRollout).toHaveBeenCalledWith({ releaseSeq: 12, devices: ['d2'] }));
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
    // Der nächste Schritt: Fernwartung für die stumme Box …
    fireEvent.click(within(aufgaben[1]).getByRole('button', { name: 'Fernwartung' }));
    expect(nav).toHaveBeenCalledWith(expect.objectContaining({ page: 'fernwartung' }));
    // … „Noch einmal anfragen": dieselbe Anfrage neu (neuer assigned_at - die Box versucht es wieder) …
    setUpdateTarget.mockResolvedValue(undefined);
    fireEvent.click(within(aufgaben[0]).getByRole('button', { name: 'Noch einmal anfragen' }));
    await waitFor(() => expect(setUpdateTarget).toHaveBeenCalledWith('d1', { releaseSeq: 12 }));
    // … und die Anfrage an die stumme Box zurückziehen, mit einem Klick.
    revertUpdateTarget.mockResolvedValue(undefined);
    const neu = within(await screen.findByTestId('braucht-dich')).getAllByTestId('aufgabe');
    fireEvent.click(within(neu[1]).getByRole('button', { name: 'Anfrage zurückziehen' }));
    await waitFor(() => expect(revertUpdateTarget).toHaveBeenCalledWith('d2'));
    // „Box ansehen" führt seit Scheibe S2 in die Geräteakte statt in ein Fenster.
    fireEvent.click(within(neu[0]).getByRole('button', { name: 'Box ansehen' }));
    expect(nav).toHaveBeenCalledWith(expect.objectContaining({
      page: 'geraete-registry', geraeteAkte: { ref: 'edge-a1', reiter: 'software' },
    }));
  });

  it('nennt den Grund des Servers, wenn „Anfrage zurückziehen" scheitert', async () => {
    const { ApiError } = await import('../../api');
    revertUpdateTarget.mockRejectedValue(new ApiError(409, 'Die Box hat keine Anfrage mehr.'));
    edgeUpdates.mockResolvedValue(mitStand(data(), {
      d2: { stand: 'offline', lastSeenAt: vor(3 * 3600_000), fakten: fakten({ angenommen: 'wartet' }) },
    }));
    render(<EdgeUpdatesPage />);
    fireEvent.click(within(await screen.findByTestId('braucht-dich')).getByRole('button', { name: 'Anfrage zurückziehen' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Die Box hat keine Anfrage mehr.');
  });

  it('„Fortschritt" führt in die Geräte-Liste - die Boxenliste wohnt seit Scheibe S2 dort', async () => {
    const nav = vi.fn();
    edgeUpdates.mockResolvedValue(mitStand(data({ rollouts: [] }), {
      d1: { ist: 'edge-2026.07.2-665d59b8c0de', istRelease: 'edge-2026.07.2', releasesDahinter: 1, stand: 'laeuft',
        state: 'laedt', fakten: fakten({ bestaetigt: 'laeuft', schritt: 'laedt' }) },
    }));
    render(<EdgeUpdatesPage onNavigate={nav} />);
    expect(await screen.findByTestId('lage')).toHaveTextContent('Ein Update läuft: edge-2026.08.0 an 1 Docker-Box · 0 bestätigt.');
    fireEvent.click(within(screen.getByTestId('linie-docker')).getByRole('button', { name: 'Fortschritt' }));
    expect(nav).toHaveBeenCalledWith(expect.objectContaining({ page: 'geraete-registry' }));
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

  it('zeigt eine Ablehnung des Servers WÖRTLICH und lässt die Auswahl stehen', async () => {
    const { ApiError } = await import('../../api');
    createRollout.mockRejectedValue(
      new ApiError(409, 'Das Release ist nicht signiert und kann nicht verteilt werden.'),
    );
    edgeUpdates.mockResolvedValue(mitStand(data({ rollouts: [] }), { d1: aelter07 }));
    edgeEignung.mockResolvedValue(eignung(12, 'edge-2026.08.0', { d1: ['bereit', null], d2: ['wartet', null] }));
    render(<EdgeUpdatesPage />);
    fireEvent.click(within(await screen.findByTestId('linie-docker')).getByRole('button', { name: 'Verteilen …' }));
    const dialog = await screen.findByRole('dialog', { name: 'Update verteilen · Docker-Box' });
    await within(dialog).findByTestId('verteil-bereit');
    fireEvent.click(within(dialog).getByRole('radio', { name: /Alle 2 auf einmal/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: '2 Boxen anfragen' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Das Release ist nicht signiert und kann nicht verteilt werden.');
    // Die Auswahl bleibt stehen: der Betreiber soll den Grund lesen und es
    // erneut versuchen können, statt von vorn anzufangen.
    expect(screen.getByRole('dialog', { name: 'Update verteilen · Docker-Box' })).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: /Pilsting/ })).toBeChecked();
    expect(within(dialog).getByRole('radio', { name: /Alle 2 auf einmal/ })).toBeChecked();
  });

  it('sagt, wenn die Eignung nicht kommt, und versucht es auf Wunsch erneut', async () => {
    const { ApiError } = await import('../../api');
    edgeUpdates.mockResolvedValue(mitStand(data({ rollouts: [] }), { d1: aelter07 }));
    edgeEignung.mockRejectedValueOnce(new ApiError(503, 'Die Eignung ist gerade nicht erreichbar.'))
      .mockResolvedValueOnce(eignung(12, 'edge-2026.08.0', { d1: ['bereit', null] }));
    render(<EdgeUpdatesPage />);
    fireEvent.click(within(await screen.findByTestId('linie-docker')).getByRole('button', { name: 'Verteilen …' }));
    const dialog = await screen.findByRole('dialog', { name: 'Update verteilen · Docker-Box' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Die Eignung ist gerade nicht erreichbar.');
    expect(within(dialog).getByRole('button', { name: '0 Boxen anfragen' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Erneut versuchen' }));
    expect(await within(dialog).findByTestId('verteil-bereit')).toHaveTextContent('Pilsting');
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

    it('nennt Stufe 1 in „Braucht dich" ruhig als „nur von Hand" (die Box-Tabelle selbst wohnt seit S2 in der Geräte-Liste)', async () => {
      edgeUpdates.mockResolvedValue(mitEdgeLight());
      render(<EdgeUpdatesPage />);
      const aufgabe = within(await screen.findByTestId('braucht-dich')).getByTestId('aufgabe');
      expect(aufgabe).toHaveTextContent('Hof Linde: nur von Hand (Stufe 1)');
      expect(aufgabe).not.toHaveTextContent('ohne Vertrauens-Set');
    });

    it('nennt im Verteil-Dialog die Boxen der anderen Linie, statt sie anzubieten', async () => {
      createRollout.mockResolvedValue({ rolloutId: 'r2' });
      edgeUpdates.mockResolvedValue(mitEdgeLight());
      // Der Server liefert nur die Boxen der Linie (und unbekannter Art); die andere Linie zählt er.
      edgeEignung.mockResolvedValue(eignung(12, 'edge-2026.08.0', { d1: ['bereit', null], d2: ['wartet', null] }, 1));
      render(<EdgeUpdatesPage />);
      fireEvent.click(within(await screen.findByTestId('linie-docker')).getByRole('button', { name: 'Verteilen …' }));
      const dialog = await screen.findByRole('dialog', { name: 'Update verteilen · Docker-Box' });
      await within(dialog).findByTestId('verteil-bereit');
      expect(dialog).not.toHaveTextContent('Hof Linde');
      expect(dialog).toHaveTextContent('1 Box der anderen Linie kommt für dieses Release nicht in Frage.');
      fireEvent.click(within(dialog).getByRole('radio', { name: /Alle 2 auf einmal/ }));
      fireEvent.click(within(dialog).getByRole('button', { name: '2 Boxen anfragen' }));
      await waitFor(() =>
        expect(createRollout).toHaveBeenCalledWith({ releaseSeq: 12, devices: ['d1', 'd2'] }),
      );
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

  it('bietet NIRGENDS einen zweiten Schritt am Gerät an', async () => {
    render(<EdgeUpdatesPage />);
    await screen.findByTestId('lage');
    for (const gone of [/Nächste Welle/, /Jetzt anwenden/, /Auf dem Gerät anwenden/,
      /Not-Aus/, /Rollout einfrieren/, /Pausieren/]) {
      expect(screen.queryByRole('button', { name: gone })).toBeNull();
    }
  });

  it('zählt den Lauf nur aus der HEUTIGEN Anfrage je Box - ein alter Auftrag ist nie ein Live-Zustand', async () => {
    // Regression 28.08.2026, in neuer Form: der `.26`-Live-Status darf NICHT unter
    // einem historischen `.25`-Auftrag auftauchen. Der Lauf in der Karte zählt die
    // Fakten der heutigen Anfrage je Box; `rollouts` ist nur Geschichte.
    const d = mitStand(data(), {
      d1: { ...aelter07, stand: 'laeuft', state: 'laedt', fakten: fakten({ bestaetigt: 'laeuft', schritt: 'laedt' }) },
    });
    d.rollouts.push({ ...d.rollouts[0], id: 'r-old', releaseVersion: 'edge-2026.07.2', releaseSeq: 11,
      createdAt: '2026-07-20T08:00:00Z', devices: d.rollouts[0].devices.map((x) => ({ ...x, state: 'laedt' })) });
    edgeUpdates.mockResolvedValue(d);
    render(<EdgeUpdatesPage />);
    const lauf = await screen.findByTestId('linie-lauf');
    expect(lauf).toHaveTextContent('edge-2026.08.0 an 1 Box');
    expect(lauf).not.toHaveTextContent('edge-2026.07.2');
  });

  it('nennt den HEBEL einer stehenden Sperre, statt nur ihren Satz', async () => {
    edgeUpdates.mockResolvedValue(mitStand(data(), {
      d2: { state: 'blockiert', blocker: 'platte', stand: 'gehalten', reason: 'Autonomie blockiert: zu wenig Platz.',
        fakten: fakten({ angenommen: 'zurueckgestellt' }) },
    }));
    render(<EdgeUpdatesPage />);
    const aufgabe = within(await screen.findByTestId('braucht-dich')).getByTestId('aufgabe');
    expect(aufgabe).toHaveTextContent('Auernheim: hält das Update zurück');
    expect(aufgabe).toHaveTextContent('Autonomie blockiert: zu wenig Platz.');
    expect(aufgabe).toHaveTextContent('Platz auf dem Datenträger der Box schaffen');
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
    await screen.findByTestId('linie-docker');
    expect(document.body).not.toHaveTextContent('7a1f0c2e-1111');
    expect(document.body).not.toHaveTextContent('Entferntes Gerät');
  });

  it('blendet das Zustands-Protokoll aus dem Verlauf aus', async () => {
    render(<EdgeUpdatesPage />);
    const journal = await screen.findByTestId('journal');
    fireEvent.click(screen.getByText('Verlauf'));
    expect(journal).toHaveTextContent('Aktualisierung gestartet');
    expect(within(journal).queryByText(/bestaetigt/)).toBeNull();
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
