import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listProvisionedDevices = vi.fn();
const listPendingEnrollments = vi.fn();

const listDevices = vi.fn();
const edgeUpdates = vi.fn();
const controlCandidates = vi.fn();
const fleet = vi.fn();

vi.mock('../../admin/adminApi', () => ({
  adminApi: {
    listProvisionedDevices: () => listProvisionedDevices(),
    listPendingEnrollments: () => listPendingEnrollments(),
    listDevices: () => listDevices(),
    edgeUpdates: () => edgeUpdates(),
    controlCandidates: () => controlCandidates(),
    provisionDevice: vi.fn(),
    deleteProvisionedDevice: vi.fn(),
    setUpdateTarget: vi.fn(),
    revertUpdateTarget: vi.fn(),
  },
}));

vi.mock('../../admin/fleetApi', () => ({ fleetApi: { fleet: () => fleet() } }));

const { GeraeteRegistryPage } = await import('./GeraeteRegistryPage');

const DEVICE = {
  externalRef: 'VP-DEMO-0001',
  kind: 'inverter',
  note: null,
  provisionedAt: '2026-07-01T00:00:00Z',
  claimed: true,
  claimedByTenant: 'Demo C&I',
};

/** Eine echte Bestandsbox: `edge-`Referenz, NICHT aus der Aufkleber-Registry. */
const FLEET_ROW = {
  deviceId: 'd1', externalRef: 'edge-k2m4pqj', label: 'edge-k2m4pqj',
  siteId: 's1', siteName: 'Auernheim', tenantId: 't1', tenantName: 'Maximilian Wüstholz',
  kind: null, ist: 'edge-2026.08.1-9b37439a02c1', soll: 'edge-2026.08.1', sollSeq: 14,
  channel: 'stable', pinned: false, state: 'bestaetigt', reason: null, blocker: null,
  lastSeenAt: '2026-08-05T09:00:00Z', reportedAt: '2026-08-05T09:00:00Z',
  provisioned: false, note: null, provisionedAt: null,
  trust: {
    rootKeyIds: ['root-2026-a'], trustSetKeyIds: ['rel-2026-a'],
    trustSetGeneratedAt: '2026-08-04T10:00:00Z', trustSetError: null,
  },
};

/** Die gedruckte, noch NICHT verbundene Aufkleber-ID. */
const PRINTED = {
  deviceId: null, externalRef: 'VP-DEMO-0002', label: null,
  siteId: null, siteName: null, tenantId: null, tenantName: null, kind: 'inverter',
  ist: null, soll: null, sollSeq: null, channel: null, pinned: false,
  state: null, reason: null, blocker: null, lastSeenAt: null, reportedAt: null,
  provisioned: true, note: null, provisionedAt: '2026-07-01T00:00:00Z', trust: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  // ⚠ jsdom teilt `window.location.hash` über ALLE Tests einer Datei - ohne
  // diesen Reset öffnet der `?geraet=`-Parameter des vorigen Tests die
  // Detailseite, und der folgende Test findet seine Tabelle nicht mehr.
  window.location.hash = '';
  controlCandidates.mockResolvedValue([]);
  fleet.mockResolvedValue({ sites: [], releases: [] });
  listProvisionedDevices.mockResolvedValue([DEVICE]);
  listPendingEnrollments.mockResolvedValue([]);
  // Das Inventar ist die VEREINIGUNG: die verbundene Aufkleber-ID, eine echte
  // `edge-`Bestandsbox und eine gedruckte, noch unverbundene ID.
  listDevices.mockResolvedValue([
    { ...FLEET_ROW, deviceId: 'd0', externalRef: DEVICE.externalRef, label: 'VP-DEMO-0001',
      siteName: 'Demo Site', tenantName: DEVICE.claimedByTenant, kind: 'inverter',
      provisioned: true, provisionedAt: DEVICE.provisionedAt },
    FLEET_ROW,
    PRINTED,
  ]);
  edgeUpdates.mockResolvedValue({
    releases: [{
      releaseSeq: 14, version: 'edge-2026.08.1', targetCommit: null, notes: null,
      signed: true, signingKeyId: 'rel-2026-a', createdAt: '2026-08-04T10:00:00Z',
      runningOnDevices: 1,
    }],
    activeRollout: null, fleet: [], journal: [],
    kpi: { known: 1, upToDate: 1, unknown: 0, inRollout: 0, failed: 0, newestRelease: null },
  });
});

describe('GeraeteRegistryPage (B3 - der Onboarding-Funnel)', () => {
  it('shows the FOUR funnel stages - der Funnel endet nicht mehr bei „verbunden"', async () => {
    render(<GeraeteRegistryPage />);
    expect(await screen.findByText('Registriert')).toBeInTheDocument();
    expect(screen.getByText('Wartet auf Zuordnung')).toBeInTheDocument();
    expect(screen.getByText('Verbunden')).toBeInTheDocument();
    // Die vierte Stufe: erst der TOFU-Crossover macht eine Box update-fähig.
    // Sie wohnte bis zum Umbau als Spalte in der Matrix der ANDEREN Seite.
    expect(await screen.findByText('Vertrauen gekreuzt')).toBeInTheDocument();
  });

  it('surfaces a device that reported but met no claim - the typo window', async () => {
    listPendingEnrollments.mockResolvedValue([
      {
        externalRef: 'edge-k7m2p4x',
        deviceInfo: 'VP Edge · Raspberry Pi',
        csrUpdatedAt: new Date(Date.now() - 3 * 24 * 3600_000).toISOString(),
        everIssued: false,
        issuedAt: null,
      },
    ]);
    render(<GeraeteRegistryPage />);

    expect(await screen.findByText('edge-k7m2p4x')).toBeInTheDocument();
    expect(screen.getByText('VP Edge · Raspberry Pi')).toBeInTheDocument();
    expect(screen.getByText('Vermutlich Tippfehler beim Kunden')).toBeInTheDocument();
  });

  it('says plainly that nobody is waiting instead of showing an empty table', async () => {
    render(<GeraeteRegistryPage />);
    expect(await screen.findByText('Kein Gerät wartet auf Zuordnung')).toBeInTheDocument();
  });

  it('a failed pending load is a FAILURE, never "nobody is waiting"', async () => {
    listPendingEnrollments.mockRejectedValue(new Error('kaputt'));
    render(<GeraeteRegistryPage />);

    // Die Registry darunter bleibt benutzbar ...
    expect(await screen.findByText('VP-DEMO-0001')).toBeInTheDocument();
    // ... und die Sektion sagt, dass sie gerade nichts weiß.
    expect(screen.getByText(/wartenden Geräte konnten nicht geladen werden/)).toBeInTheDocument();
    expect(screen.queryByText('Kein Gerät wartet auf Zuordnung')).toBeNull();
  });
});

describe('Geräte: EINE Tabelle über den ganzen Lebenszyklus (P2 · E1/E4)', () => {
  it('enthält die ECHTE Flotte, nicht nur die Aufkleber-IDs', async () => {
    render(<GeraeteRegistryPage />);
    const table = await screen.findByTestId('devices');
    // DER behobene Befund: eine `edge-`Bestandsbox kam auf dieser Seite mit
    // NULL Zeilen vor - wer „meine Geräte" suchte, fand sie nur als
    // Nebenspalten anderer Seiten.
    expect(table).toHaveTextContent('edge-k2m4pqj');
    expect(table).toHaveTextContent('Auernheim');
    // Und die gedruckte, noch unverbundene ID steht daneben - eine Tabelle.
    expect(table).toHaveTextContent('VP-DEMO-0002');
    expect(table).toHaveTextContent('noch nicht verbunden');
  });

  it('zeigt den Stempel als Tag + Build statt als Rohstring', async () => {
    render(<GeraeteRegistryPage />);
    const table = await screen.findByTestId('devices');
    // `edge-2026.08.1-9b37439a02c1` neben `edge-2026.08.1` sind zwei
    // verschieden AUSSEHENDE Zeichenketten für dieselbe Frage.
    expect(table).toHaveTextContent('edge-2026.08.1 (Build 9b37439a)');
    expect(table).not.toHaveTextContent('9b37439a02c1');
  });

  it('öffnet die GERÄTE-DETAILSEITE aus der Zeile - adressierbar', async () => {
    // Admin-Umbau Stufe 2: die Zeile führt auf die Vollansicht, nicht mehr in
    // den Drawer (der bleibt der Schnellblick am Wellen-Board).
    render(<GeraeteRegistryPage />);
    const table = await screen.findByTestId('devices');
    fireEvent.click(within(table).getByText('Auernheim'));

    expect(await screen.findByRole('heading', { name: 'edge-k2m4pqj' })).toBeInTheDocument();
    // Die REFERENZ steht in der Adresse - ein Lesezeichen darauf überlebt
    // Unclaim/Re-Claim, eine Geräte-UUID täte das nicht.
    expect(window.location.hash).toContain('geraet=edge-k2m4pqj');
    // Die Sektionen, die es im Drawer nie gab.
    expect(screen.getByRole('heading', { name: /Grenzen & Wächter/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Steuerung/ })).toBeInTheDocument();
    // Zuweisen kann sie wie der Drawer.
    expect(screen.getByRole('button', { name: 'Release zuweisen' })).toBeInTheDocument();
    // Und zurück in die Liste.
    fireEvent.click(screen.getByRole('button', { name: /Alle Geräte/ }));
    expect(await screen.findByTestId('devices')).toBeInTheDocument();
    expect(window.location.hash).not.toContain('geraet=');
  });

  it('öffnet ein Lesezeichen direkt auf der Detailseite', async () => {
    window.location.hash = '#/geraete-registry?geraet=edge-k2m4pqj';
    render(<GeraeteRegistryPage />);
    expect(await screen.findByRole('heading', { name: 'edge-k2m4pqj' })).toBeInTheDocument();
    expect(screen.queryByTestId('devices')).toBeNull();
  });

  it('sagt bei einer unbekannten Referenz, dass es sie nicht gibt', async () => {
    window.location.hash = '#/geraete-registry?geraet=VP-GIBT-ES-NICHT';
    render(<GeraeteRegistryPage />);
    expect(await screen.findByText(/keinen Eintrag/)).toBeInTheDocument();
  });

  it('bietet der noch unverbundenen ID keine Zuweisung an', async () => {
    render(<GeraeteRegistryPage />);
    const table = await screen.findByTestId('devices');
    // Eine gedruckte ID ist noch kein Gerät - eine Zeile, die sich nicht
    // öffnen lässt, ist ehrlicher als ein Drawer ohne Inhalt.
    const row = within(table).getByText('VP-DEMO-0002').closest('tr') as HTMLElement;
    expect(row.className).not.toContain('vp-row-click');
  });

  it('behauptet ohne Inventar KEINE Geräteliste - ein Fehlschlag ist keine Datenlage', async () => {
    // Die Registry als Ersatz zu rendern wäre eine sichtbare Lüge: eine
    // beanspruchte Aufkleber-ID hat dort zwar `claimed`, aber keine Geräte-Id,
    // und jede Zeile läse sich als „noch nicht verbunden".
    listDevices.mockRejectedValue(new Error('kaputt'));
    render(<GeraeteRegistryPage />);

    expect(await screen.findByText(/Geräte-Inventar ist gerade nicht abrufbar/))
      .toBeInTheDocument();
    expect(screen.queryByTestId('devices')).toBeNull();
    expect(document.body.textContent).not.toContain('noch nicht verbunden —');
    // Der Funnel oben bleibt gültig - er hat eine eigene Quelle.
    expect(screen.getByText('Registriert')).toBeInTheDocument();
  });

  it('fragt vor dem Entfernen im Haus-Muster - mit Folgenliste', async () => {
    render(<GeraeteRegistryPage />);
    const table = await screen.findByTestId('devices');
    fireEvent.click(within(table).getByRole('button', { name: /Entfernen/ }));

    const list = await screen.findByTestId('confirm-consequences');
    expect(list).toHaveTextContent('Kein Kunde kann diese ID danach mehr verbinden');
    // Umkehrbarkeit gehört dazu - sonst liest sich das Entfernen endgültiger,
    // als es ist.
    expect(list).toHaveTextContent('umkehrbar');
  });
});
