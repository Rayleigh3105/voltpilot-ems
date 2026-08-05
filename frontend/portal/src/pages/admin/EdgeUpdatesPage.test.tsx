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
      {
        index: 2, name: 'Flotte', released: false, confirmed: false,
        devices: [{
          deviceId: 'd2', label: 'edge-b2', siteName: 'Auernheim', tenantName: 'Kunde A',
          state: 'unbekannt',
          reason: 'Dieses Gerät hat noch keinen Software-Stand gemeldet.',
          since: null, bakeRemainingMinutes: null, bakeCycle: null, bakeReason: null,
        }],
      },
    ],
  },
  fleet: [
    {
      deviceId: 'd1', label: 'edge-a1', externalRef: 'edge-a1', siteId: 's1',
      siteName: 'Pilsting', tenantId: 't1',
      tenantName: 'Kunde A', ist: 'edge-2026.08.0', soll: 'edge-2026.08.0', sollSeq: 12,
      channel: 'canary', pinned: false, state: 'bestaetigt', reason: null,
      since: '2026-08-05T08:00:00Z', reportedAt: '2026-08-05T09:00:00Z', rolloutId: 'r1',
    },
    {
      deviceId: 'd2', label: 'edge-b2', externalRef: 'edge-b2', siteId: 's2',
      siteName: 'Auernheim', tenantId: 't1',
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

  it('zeigt die Abschnitte - und die Flotten-Matrix ist ENTFALLEN (E2)', async () => {
    render(<EdgeUpdatesPage />);
    expect(await screen.findByText('Releases')).toBeInTheDocument();
    expect(screen.getByText('Aktiver Rollout')).toBeInTheDocument();
    expect(screen.getByText('Verlauf')).toBeInTheDocument();
    // Sie war die strukturelle Ursache der „zwei Wahrheiten auf einer Seite";
    // ihre drei Aufgaben haben bessere Wohnorte. Statt ihrer steht ein
    // Verweis - der Informationsgehalt geht nirgends verloren.
    expect(screen.queryByText('Flotten-Matrix')).toBeNull();
    expect(screen.queryByTestId('fleet')).toBeNull();
    expect(screen.getByTestId('fleet-pointer')).toHaveTextContent('Geräte-Übersicht');
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
    // Seit dem Wegfall der Matrix trägt das Wellen-Board diese Wahrheit - und
    // zwar als EINZIGE Fläche der Seite (keine zwei Antworten mehr).
    expect(await screen.findByText('Auernheim')).toBeInTheDocument();
    expect(document.body.textContent).toContain('unbekannt');
    expect(document.body.textContent).toContain('noch keinen Software-Stand gemeldet');
    expect(document.body.textContent).not.toContain('veraltet');
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

  it('weist ein Einzelgerät über die Wellen-Zeile zu', async () => {
    setUpdateTarget.mockResolvedValue(undefined);
    render(<EdgeUpdatesPage />);
    // Die Wellen-Zeile ist seit dem Wegfall der Matrix der Weg ins Gerät.
    fireEvent.click(await screen.findByText('Auernheim'));

    const drawer = await screen.findByRole('dialog');
    // Nur signierte Releases stehen zur Wahl.
    expect(drawer).toHaveTextContent('edge-2026.08.0');
    // Der Knopf heißt „Release zuweisen", nicht „Jetzt aktualisieren": er
    // veröffentlicht eine Zuweisung, das ANWENDEN bleibt beaufsichtigt am
    // Gerät - der alte Wortlaut versprach genau das, was danach nicht geschah.
    expect(screen.queryByRole('button', { name: 'Jetzt aktualisieren' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Release zuweisen' }));
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

  it('schaltet den Vorschub um - und fragt VORHER im Haus-Muster, was sich ändert', async () => {
    edgeUpdates.mockResolvedValue(data());
    setAutoAdvance.mockResolvedValue(undefined);
    render(<EdgeUpdatesPage />);

    await waitFor(() => expect(screen.getByTestId('advance-mode')).toBeInTheDocument());
    expect(screen.getByTestId('advance-mode')).toHaveTextContent('Wellen von Hand');
    fireEvent.click(screen.getByRole('button', { name: /Automatisch weiterschalten/ }));

    // Der Klick schaltet NICHT sofort um - erst die Folgenliste, dann die Tat.
    const list = await screen.findByTestId('confirm-consequences');
    // Sie nennt, was GLEICH bleibt: sonst liest sich das Umlegen wie ein
    // Lockern der Regeln.
    expect(list).toHaveTextContent('Bake-Kriterium');
    expect(list).toHaveTextContent('automatische Halt');
    expect(list).toHaveTextContent('Not-Aus');
    expect(setAutoAdvance).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Automatik einschalten' }));
    await waitFor(() => expect(setAutoAdvance).toHaveBeenCalledWith('r1', true));
  });

  it('friert NUR nach der Folgenliste ein - und nennt die Endgültigkeit', async () => {
    edgeUpdates.mockResolvedValue(data());
    haltRollout.mockResolvedValue(undefined);
    render(<EdgeUpdatesPage />);

    fireEvent.click(await screen.findByRole('button', { name: /Einfrieren/ }));
    const list = await screen.findByTestId('confirm-consequences');
    expect(list).toHaveTextContent('ENDGÜLTIG');
    // Bereits erteilte Zuweisungen BLEIBEN - das steht in der Rückfrage, nicht
    // erst hinterher.
    expect(list).toHaveTextContent('BLEIBEN bestehen');
    expect(haltRollout).not.toHaveBeenCalled();

    // Abbrechen ändert nichts.
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    await waitFor(() => expect(screen.queryByTestId('confirm-consequences')).toBeNull());
    expect(haltRollout).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Einfrieren/ }));
    await screen.findByTestId('confirm-consequences');
    fireEvent.click(screen.getByRole('button', { name: 'Endgültig einfrieren' }));
    await waitFor(() => expect(haltRollout).toHaveBeenCalledWith('r1'));
  });

  it('traegt den ruhigen Crossover-Hinweis im Verweis auf die Geraete-Seite', async () => {
    const d = data();
    d.fleet[0].trust = {
      rootKeyIds: [], trustSetKeyIds: [], trustSetGeneratedAt: null,
      trustSetError: 'Diesem Stand ist kein Vertrauensanker eingebacken.',
    };
    edgeUpdates.mockResolvedValue(d);
    render(<EdgeUpdatesPage />);

    // Die SPALTE „Vertrauen" wohnt seit E2 auf der Geraete-Seite; hier bleibt
    // die ruhige Zeile, weil sie eine Aufgabe der ganzen Flotte benennt.
    const pointer = await screen.findByTestId('fleet-pointer');
    expect(pointer).toHaveTextContent('Crossover offen: 1 Gerät');
  });

  it('behauptet ohne gemeldeten Vertrauensanker keinen offenen Crossover', async () => {
    edgeUpdates.mockResolvedValue(data());
    render(<EdgeUpdatesPage />);

    const pointer = await screen.findByTestId('fleet-pointer');
    // Zwei Geraete OHNE trust-Block: das ist „unbekannt" und wird als solches
    // genannt - nie als „Crossover offen".
    expect(pointer).toHaveTextContent('melden ihren Vertrauensanker nicht');
    expect(pointer).not.toHaveTextContent('Crossover offen');
  });
});

describe('Beobachten: die Vier-Klassen-Grammatik auf der Seite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    edgeUpdates.mockResolvedValue(data());
  });

  it('führt mit „Sie sind dran" und nennt Ort und Weg', async () => {
    const d = data();
    d.activeRollout!.canPromote = true;
    d.fleet[1].state = 'wartet_auf_anwendung';
    d.fleet[1].soll = 'edge-2026.08.0';
    edgeUpdates.mockResolvedValue(d);
    render(<EdgeUpdatesPage />);

    const card = await screen.findByTestId('handeln');
    expect(card).toHaveTextContent('Welle 2 „Flotte" freigeben');
    expect(card).toHaveTextContent('Auernheim');
    // Ohne den WEG wäre „Sie sind dran" nur ein Vorwurf.
    expect(card).toHaveTextContent('8484');
    expect(screen.getByTestId('handeln-count')).toHaveTextContent('2 Schritte');
  });

  it('zeigt die Karte GAR NICHT, wenn nichts ansteht', async () => {
    render(<EdgeUpdatesPage />);
    await screen.findByText('Aktiver Rollout');
    expect(screen.queryByTestId('handeln')).toBeNull();
  });

  it('trägt „wartet auf Sie" in einem anderen Kleid als „ausstehend"', async () => {
    const d = data();
    d.fleet[0].state = 'ausstehend';
    d.fleet[1].state = 'wartet_auf_anwendung';
    edgeUpdates.mockResolvedValue(d);
    render(<EdgeUpdatesPage />);

    await screen.findByText('Aktiver Rollout');
    // DER Kern des Umbaus: die zwei Situationen sehen nie wieder gleich aus.
    expect(screen.getAllByTestId('state-action').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('state-busy').length).toBeGreaterThan(0);
  });

  it('nennt den HEBEL einer Sperre, statt nur ihren Satz', async () => {
    const d = data();
    d.fleet[1].state = 'blockiert';
    d.fleet[1].blocker = 'neutralzeit';
    d.fleet[1].reason = 'Autonomie blockiert: keine belegte Neutral-Zeit.';
    edgeUpdates.mockResolvedValue(d);
    render(<EdgeUpdatesPage />);

    await screen.findByText('Aktiver Rollout');
    expect(screen.getAllByTestId('lever')[0]).toHaveTextContent('VP_OTA_NEUTRAL_VERIFIED');
    expect(screen.getAllByTestId('state-blocked').length).toBeGreaterThan(0);
  });

  it('rendert in der Wellen-Liste NIE eine UUID', async () => {
    const d = data();
    d.activeRollout!.waves[0].devices[0] = {
      ...d.activeRollout!.waves[0].devices[0],
      deviceId: 'cdba2ee8-91f3-4c1a-9d3e-000000000001',
      label: null, siteName: null, tenantName: null, removed: true,
    };
    edgeUpdates.mockResolvedValue(d);
    render(<EdgeUpdatesPage />);

    await screen.findByText('Aktiver Rollout');
    expect(screen.getByText(/Entferntes Gerät/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('91f3-4c1a');
  });

  it('rahmt einen eingefrorenen Rollout als Abschlussbild und ordnet die Historie unter',
    async () => {
      const d = data();
      d.activeRollout!.state = 'halted';
      // Die Zeile ist beim Einfrieren als fehlgeschlagen eingefroren worden,
      // heute meldet dasselbe Gerät „bestätigt" - genau die Zwei-Wahrheiten-
      // Reibung, die hier zur Präsentation wird.
      d.activeRollout!.waves[0].devices[0].state = 'fehlgeschlagen';
      d.fleet[0].state = 'bestaetigt';
      edgeUpdates.mockResolvedValue(d);
      render(<EdgeUpdatesPage />);

      expect(await screen.findByTestId('frozen-framing')).toHaveTextContent('eingefroren');
      expect(screen.getByTestId('wave-history')).toHaveTextContent('beim Abschluss');
    });

  it('zeigt die Bezugszeit der gezeigten Daten', async () => {
    render(<EdgeUpdatesPage />);
    // Ohne sie ist „nichts bewegt sich" von „niemand hat nachgesehen" nicht zu
    // trennen - genau das Gefühl vom 04.08.2026.
    expect(await screen.findByTestId('freshness')).toHaveTextContent('Stand:');
    expect(screen.getByTestId('freshness')).toHaveTextContent('alle 30 s');
  });

  it('pollt sich SELBST, statt auf einen Knopfdruck zu warten', async () => {
    vi.useFakeTimers();
    try {
      render(<EdgeUpdatesPage />);
      await vi.advanceTimersByTimeAsync(0);
      const initial = edgeUpdates.mock.calls.length;
      await vi.advanceTimersByTimeAsync(31_000);
      // Ein Beobachtungs-Werkzeug, das man von Hand aktualisieren muss,
      // erzeugt genau das „hängt es?"-Gefühl, für das dieser Umbau existiert.
      expect(edgeUpdates.mock.calls.length).toBeGreaterThan(initial);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sagt im Ruhezustand in EINEM Satz, wie die Flotte steht', async () => {
    edgeUpdates.mockResolvedValue(data({ activeRollout: null }));
    render(<EdgeUpdatesPage />);

    const line = await screen.findByTestId('resting-line');
    expect(line).toHaveTextContent('Kein Rollout aktiv');
    expect(line).toHaveTextContent('unbekannt, nicht veraltet');
  });
});
