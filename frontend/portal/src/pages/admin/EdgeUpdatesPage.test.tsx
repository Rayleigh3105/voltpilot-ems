import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EdgeUpdates } from '../../adminEdgeUpdates';

const edgeUpdates = vi.fn();
const createRollout = vi.fn();
const setUpdateTarget = vi.fn();
const revertUpdateTarget = vi.fn();

vi.mock('../../admin/adminApi', () => ({
  adminApi: {
    edgeUpdates: (...a: unknown[]) => edgeUpdates(...a),
    createRollout: (...a: unknown[]) => createRollout(...a),
    setUpdateTarget: (...a: unknown[]) => setUpdateTarget(...a),
    revertUpdateTarget: (...a: unknown[]) => revertUpdateTarget(...a),
  },
}));

const { EdgeUpdatesPage } = await import('./EdgeUpdatesPage');

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

describe('EdgeUpdatesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    edgeUpdates.mockResolvedValue(data());
  });

  it('zeigt Releases, die laufende Aktualisierung und den Verlauf', async () => {
    render(<EdgeUpdatesPage />);
    expect(await screen.findByTestId('releases')).toBeInTheDocument();
    expect(await screen.findByTestId('rollout-card')).toBeInTheDocument();
    expect(await screen.findByTestId('journal')).toBeInTheDocument();
  });

  it('zeigt jede Box mit installierter Version und Ziel, auch ohne laufenden Rollout', async () => {
    const d = data({ rollouts: [] });
    d.fleet[0].ist = 'edge-2026.08.0-3bf8c038e1d2';
    d.fleet[0].soll = 'edge-2026.07.2';
    edgeUpdates.mockResolvedValue(d);
    render(<EdgeUpdatesPage />);
    const table = await screen.findByTestId('box-versions');
    const row = within(table).getByText('Pilsting').closest('tr')!;
    expect(row).toHaveTextContent('edge-2026.08.0');
    expect(row).toHaveTextContent('Build 3bf8c038');
    expect(row).toHaveTextContent('edge-2026.07.2');
    expect(within(table).getByText('Auernheim').closest('tr')).toHaveTextContent('Noch nicht gemeldet');
    expect(screen.getByRole('button', { name: 'Update verteilen' })).toBeEnabled();
    expect(screen.getByText('Alle Releases (2)').closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText('Verlauf').closest('details')).not.toHaveAttribute('open');
  });

  it('sucht über Box, Anlage, Kunde und Version und setzt Filter gemeinsam zurück', async () => {
    render(<EdgeUpdatesPage />);
    await screen.findByTestId('box-versions');
    fireEvent.click(screen.getByText('Suche & Filter'));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'edge-a1' } });
    expect(screen.getByTestId('box-versions')).toHaveTextContent('Pilsting');
    expect(screen.getByTestId('box-versions')).not.toHaveTextContent('Auernheim');
    fireEvent.click(screen.getByRole('button', { name: /Ohne Versionsmeldung/ }));
    expect(screen.getByText('Keine passende Box')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Filter zurücksetzen' }));
    expect(screen.getByTestId('box-versions')).toHaveTextContent('Auernheim');
    expect(screen.getByRole('searchbox')).toHaveValue('');
  });

  it('ordnet Releases nach Sequenz und bietet ein unsigniertes neuestes Release nicht an', async () => {
    const d = data();
    d.releases[1].releaseSeq = 20;
    edgeUpdates.mockResolvedValue(d);
    render(<EdgeUpdatesPage />);
    await screen.findByTestId('box-versions');
    const newest = screen.getByRole('region', { name: 'Neueste Version' });
    expect(newest).toHaveTextContent('edge-2026.07.2');
    expect(within(newest).getByRole('button', { name: 'Update verteilen' })).toBeDisabled();
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

  it('behauptet bei einem laufenden Einzelupdate ohne Rollout keinen Ruhezustand', async () => {
    const d = data({ rollouts: [] });
    d.fleet[0].state = 'laedt';
    edgeUpdates.mockResolvedValue(d);
    render(<EdgeUpdatesPage />);
    await screen.findByTestId('box-versions');
    expect(screen.queryByTestId('resting-line')).toBeNull();
  });

  it('bietet ein Update NUR für ein signiertes Release an', async () => {
    render(<EdgeUpdatesPage />);
    const table = await screen.findByTestId('releases');
    fireEvent.click(screen.getByText('Alle Releases (2)'));
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
    const table = await screen.findByTestId('releases');
    fireEvent.click(screen.getByText('Alle Releases (2)'));
    fireEvent.click(within(table).getAllByRole('button', { name: /Aktualisieren/ })[0]);

    const drawer = await screen.findByRole('dialog');
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

  it('warnt LAUT und benennt die Anlage - ohne irgendetwas anzuhalten', async () => {
    const d = data();
    d.fleet[0].state = 'fehlgeschlagen';
    d.fleet[0].reason = 'Selbsttest fehlgeschlagen.';
    edgeUpdates.mockResolvedValue(d);
    render(<EdgeUpdatesPage />);
    expect(await screen.findByTestId('loud-banner')).toHaveTextContent('Pilsting');
    // Der Rollout läuft weiter - ein Fehlschlag ist INFORMATION.
    expect(await screen.findByTestId('rollout-card')).toHaveTextContent('läuft');
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

  it('zeigt eine Ablehnung des Servers WÖRTLICH', async () => {
    const { ApiError } = await import('../../api');
    createRollout.mockRejectedValue(
      new ApiError(409, 'Das Release ist nicht signiert und kann nicht verteilt werden.'),
    );
    render(<EdgeUpdatesPage />);
    const table = await screen.findByTestId('releases');
    fireEvent.click(screen.getByText('Alle Releases (2)'));
    fireEvent.click(within(table).getAllByRole('button', { name: /Aktualisieren/ })[0]);
    const drawer = await screen.findByRole('dialog');
    fireEvent.click(within(drawer).getByTestId('choose-all').querySelector('input')!);
    fireEvent.click(within(drawer).getByRole('button', { name: 'Aktualisieren' }));
    expect(await screen.findByText(/nicht signiert/)).toBeInTheDocument();
    // Die Auswahl bleibt stehen: der Betreiber soll den Grund lesen und es
    // erneut versuchen können, statt von vorn anzufangen.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByTestId('choose-all')
      .querySelector('input')!).toBeChecked();
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

  it('sagt im Ruhezustand in EINEM Satz, wie die Flotte steht', async () => {
    edgeUpdates.mockResolvedValue(data({ rollouts: [] }));
    render(<EdgeUpdatesPage />);
    const line = await screen.findByTestId('resting-line');
    expect(line).toHaveTextContent('1/1 Geräte auf edge-2026.08.0');
    expect(line).toHaveTextContent('unbekannt, nicht veraltet');
    expect(screen.queryByTestId('rollout-card')).toBeNull();
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

    expect(await screen.findByTestId('resting-line')).toHaveTextContent(
      'Gerade wird nichts aktualisiert',
    );
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
