import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EdgeUpdates } from '../../adminEdgeUpdates';

const edgeUpdates = vi.fn();
const promoteRollout = vi.fn();
const haltRollout = vi.fn();
const setUpdateTarget = vi.fn();
const setAutoAdvance = vi.fn();

vi.mock('../../admin/adminApi', () => ({
  adminApi: {
    edgeUpdates: (...a: unknown[]) => edgeUpdates(...a),
    promoteRollout: (...a: unknown[]) => promoteRollout(...a),
    haltRollout: (...a: unknown[]) => haltRollout(...a),
    pauseRollout: vi.fn(),
    resumeRollout: vi.fn(),
    createRollout: vi.fn(),
    setUpdateTarget: (...a: unknown[]) => setUpdateTarget(...a),
    setAutoAdvance: (...a: unknown[]) => setAutoAdvance(...a),
    revertUpdateTarget: vi.fn(),
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
  activeRollout: {
    id: 'r1', releaseVersion: 'edge-2026.08.0', releaseSeq: 12, channel: 'stable',
    state: 'active', currentWave: 1, waveCount: 2, haltedReason: null, createdBy: 'admin',
    createdAt: '2026-08-05T08:00:00Z', canPromote: false,
    promoteBlockedReason: 'Noch 21 Std. gesunder Betrieb bis zur Freigabe.',
    waves: [
      {
        index: 1, name: 'Canary', released: true, confirmed: false,
        devices: [{
          deviceId: 'd1', label: 'edge-a1', siteName: 'Pilsting', tenantName: 'Kunde A',
          state: 'bestaetigt', reason: null, since: '2026-08-05T08:00:00Z',
          bakeRemainingMinutes: 1260, bakeCycle: 'nicht_pruefbar',
          bakeReason: 'Auf dieser Anlage steuert VoltPilot (noch) nicht.',
        }],
      },
      { index: 2, name: 'Flotte', released: false, confirmed: false, devices: [] },
    ],
  },
  fleet: [
    {
      deviceId: 'd1', label: 'edge-a1', siteId: 's1', siteName: 'Pilsting', tenantId: 't1',
      tenantName: 'Kunde A', ist: 'edge-2026.08.0', soll: 'edge-2026.08.0', sollSeq: 12,
      channel: 'canary', pinned: false, state: 'bestaetigt', reason: null,
      since: '2026-08-05T08:00:00Z', reportedAt: '2026-08-05T09:00:00Z', rolloutId: 'r1',
    },
    {
      deviceId: 'd2', label: 'edge-b2', siteId: 's2', siteName: 'Auernheim', tenantId: 't1',
      tenantName: 'Kunde A', ist: null, soll: null, sollSeq: null, channel: null,
      pinned: false, state: 'unbekannt',
      reason: 'Dieses Gerät hat noch keinen Software-Stand gemeldet.',
      since: null, reportedAt: null, rolloutId: null,
    },
  ],
  journal: [
    {
      id: 2, at: '2026-08-05T08:01:00Z', actor: 'system', event: 'device_state',
      rolloutId: 'r1', deviceId: 'd1', detail: 'bestaetigt',
    },
    {
      id: 1, at: '2026-08-05T08:00:00Z', actor: 'admin', event: 'rollout_created',
      rolloutId: 'r1', deviceId: null, detail: 'edge-2026.08.0 → stable',
    },
  ],
  kpi: { known: 1, upToDate: 1, unknown: 1, inRollout: 1, failed: 0, newestRelease: 'edge-2026.08.0' },
  ...over,
});

describe('EdgeUpdatesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    edgeUpdates.mockResolvedValue(data());
  });

  it('zeigt die vier Abschnitte', async () => {
    render(<EdgeUpdatesPage />);
    expect(await screen.findByText('Releases')).toBeInTheDocument();
    expect(screen.getByText('Aktiver Rollout')).toBeInTheDocument();
    expect(screen.getByText('Flotten-Matrix')).toBeInTheDocument();
    expect(screen.getByText('Verlauf')).toBeInTheDocument();
  });

  it('bietet ein Rollout NUR für ein signiertes Release an', async () => {
    render(<EdgeUpdatesPage />);
    await screen.findByText('Releases');
    // Ohne Manifest-Bytes hat ein Gerät nichts zu prüfen - kein Knopf.
    expect(screen.getAllByRole('button', { name: /Rollout starten/ })).toHaveLength(1);
    expect(screen.getByText(/Nicht signiert – nicht verteilbar/)).toBeInTheDocument();
    expect(screen.getByText(/signiert \(rel-2026-a\)/)).toBeInTheDocument();
  });

  it('sperrt „Nächste Welle" MIT Grund', async () => {
    render(<EdgeUpdatesPage />);
    const btn = await screen.findByRole('button', { name: /Nächste Welle/ });
    expect(btn).toBeDisabled();
    expect(screen.getByTestId('promote-hint')).toHaveTextContent('21 Std.');
    // Und der Server ist die eigentliche Sperre - der Knopf ruft gar nicht erst.
    expect(promoteRollout).not.toHaveBeenCalled();
  });

  it('nennt einen nicht prüfbaren Steuerzyklus beim Namen', async () => {
    render(<EdgeUpdatesPage />);
    await screen.findByText('Releases');
    expect(screen.getByText(/Steuerzyklus nicht prüfbar/)).toBeInTheDocument();
  });

  it('zeigt ein Gerät ohne Meldung als „unbekannt" MIT Grund - nie als veraltet', async () => {
    render(<EdgeUpdatesPage />);
    await screen.findByTestId('fleet');
    const matrix = screen.getByTestId('fleet');
    expect(matrix).toHaveTextContent('unbekannt');
    expect(matrix).toHaveTextContent('noch keinen Software-Stand gemeldet');
    expect(matrix).not.toHaveTextContent('veraltet');
  });

  it('blendet das Zustands-Protokoll aus dem Verlauf aus', async () => {
    render(<EdgeUpdatesPage />);
    const journal = await screen.findByTestId('journal');
    expect(journal).toHaveTextContent('Rollout gestartet');
    expect(journal).not.toHaveTextContent('Zustand geändert');
  });

  it('warnt LAUT und benennt die Anlage', async () => {
    const d = data();
    d.fleet[1].state = 'fehlgeschlagen';
    d.fleet[1].reason = 'Signatur ungültig';
    edgeUpdates.mockResolvedValue(d);
    render(<EdgeUpdatesPage />);
    // Der Banner NENNT die Anlage - ein Alarm ohne Adresse ist Lärm.
    expect(await screen.findByTestId('loud-banner')).toHaveTextContent('Auernheim');
  });

  it('zeigt den GRUND eines eingefrorenen Rollouts', async () => {
    const d = data();
    d.activeRollout!.state = 'halted';
    d.activeRollout!.haltedReason = 'Automatisch angehalten - ein Gerät meldet: fehlgeschlagen';
    edgeUpdates.mockResolvedValue(d);
    render(<EdgeUpdatesPage />);
    expect(await screen.findByTestId('halted-reason')).toHaveTextContent('Automatisch angehalten');
    expect(screen.getByText('eingefroren ⚠')).toBeInTheDocument();
  });

  it('weist ein Einzelgerät über die Matrix-Zeile zu', async () => {
    setUpdateTarget.mockResolvedValue(undefined);
    render(<EdgeUpdatesPage />);
    await screen.findByTestId('fleet');
    fireEvent.click(screen.getByText('Auernheim'));

    const drawer = await screen.findByRole('dialog');
    // Nur signierte Releases stehen zur Wahl.
    expect(drawer).toHaveTextContent('edge-2026.08.0');
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt aktualisieren' }));
    await waitFor(() =>
      expect(setUpdateTarget).toHaveBeenCalledWith('d2', {
        releaseSeq: 12, channel: 'stable', pinned: false,
      }),
    );
  });

  it('zeigt eine Ablehnung des Servers WÖRTLICH', async () => {
    const { ApiError } = await import('../../api');
    promoteRollout.mockRejectedValue(new ApiError(409, 'Die laufende Welle ist noch nicht bestätigt: Noch 3 Std.'));
    const d = data();
    d.activeRollout!.canPromote = true;
    d.activeRollout!.promoteBlockedReason = null;
    edgeUpdates.mockResolvedValue(d);
    render(<EdgeUpdatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Nächste Welle/ }));
    expect(await screen.findByText(/noch nicht bestätigt/)).toBeInTheDocument();
  });
});

// ── OTA Stufe 4 „Politur" ──────────────────────────────────────────────────

describe('Wellen-Automatik + TOFU-Abschluss auf der Seite', () => {
  it('sagt, in welchem Modus der Rollout läuft - und warum die Welle wartet', async () => {
    edgeUpdates.mockResolvedValue(data({
      activeRollout: {
        ...data().activeRollout!,
        autoAdvance: true,
        advanceNote: 'Automatischer Vorschub: die nächste Welle wird freigegeben, sobald das '
          + 'Bake-Kriterium erfüllt ist. Offen: Noch 21 Std. gesunder Betrieb.',
      },
    }));
    render(<EdgeUpdatesPage />);

    await waitFor(() => expect(screen.getByTestId('advance-mode')).toBeInTheDocument());
    expect(screen.getByTestId('advance-mode')).toHaveTextContent('Automatischer Wellen-Vorschub');
    expect(screen.getByTestId('advance-note')).toHaveTextContent('Offen:');
  });

  it('schaltet den Vorschub um - und fragt VORHER, was sich dabei ändert', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    edgeUpdates.mockResolvedValue(data());
    setAutoAdvance.mockResolvedValue(undefined);
    render(<EdgeUpdatesPage />);

    await waitFor(() => expect(screen.getByTestId('advance-mode')).toBeInTheDocument());
    expect(screen.getByTestId('advance-mode')).toHaveTextContent('Wellen von Hand');
    fireEvent.click(screen.getByRole('button', { name: /Automatisch weiterschalten/ }));

    await waitFor(() => expect(setAutoAdvance).toHaveBeenCalledWith('r1', true));
    // Die Rückfrage nennt, was GLEICH bleibt - sonst liest sich das Umlegen
    // wie ein Lockern der Regeln.
    expect(confirmSpy.mock.calls[0][0]).toContain('Bake-Kriterium');
    confirmSpy.mockRestore();
  });

  it('zeigt den Vertrauens-Stand je Gerät und nennt Abwesenheit „unbekannt"', async () => {
    const base = data();
    edgeUpdates.mockResolvedValue({
      ...base,
      fleet: [
        {
          ...base.fleet[0],
          trust: {
            rootKeyIds: ['root-2026-a'], trustSetKeyIds: ['rel-2026-a'],
            trustSetGeneratedAt: '2026-09-01T10:00:00Z', trustSetError: null,
          },
        },
        {
          ...base.fleet[1],
          trust: {
            rootKeyIds: [], trustSetKeyIds: [], trustSetGeneratedAt: null,
            trustSetError: 'Diesem Stand ist kein Vertrauensanker eingebacken.',
          },
        },
      ],
    });
    render(<EdgeUpdatesPage />);

    await waitFor(() => expect(screen.getByTestId('fleet')).toBeInTheDocument());
    expect(screen.getByText('gekreuzt ✓')).toBeInTheDocument();
    expect(screen.getByText('Crossover offen')).toBeInTheDocument();
    // Der ruhige Hinweis über der Flotte zählt nur die BELEGT offenen.
    expect(screen.getByTestId('crossover-hint'))
      .toHaveTextContent('Crossover offen: 1 Gerät');
  });

  it('schweigt über den Crossover, solange kein Gerät ihn meldet', async () => {
    edgeUpdates.mockResolvedValue(data());
    render(<EdgeUpdatesPage />);

    await waitFor(() => expect(screen.getByTestId('fleet')).toBeInTheDocument());
    // Zwei Geräte OHNE trust-Block: das ist „unbekannt" und wird als solches
    // genannt - nie als „Crossover offen".
    expect(screen.getByTestId('crossover-hint'))
      .toHaveTextContent('melden ihren Vertrauensanker nicht');
    expect(screen.getByTestId('crossover-hint')).not.toHaveTextContent('Crossover offen');
  });
});
