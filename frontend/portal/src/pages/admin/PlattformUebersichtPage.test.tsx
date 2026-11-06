import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminFleetSite } from '../../admin/fleetApi';
import type { EdgeUpdates } from '../../adminEdgeUpdates';

/**
 * Scheibe S4 (Konzept `vp-adminview-konzept-k1` §4.3): die neue Landung von
 * `#/plattform`. Geprüft wird hier nur die SEITE - laden, Fail-soft,
 * Navigation und das Fehlen von Geld; die Zahlen selbst prüft
 * `plattformUebersicht.test.ts`.
 */
const fleet = vi.fn();
const edgeUpdates = vi.fn();
const fernwartung = vi.fn();
const fernwartungBoxen = vi.fn();
const werkstattDienst = vi.fn();
const listPendingEnrollments = vi.fn();
const plattformDienste = vi.fn(() => Promise.resolve({ dienste: [] }));

// Eine winzige, persistente In-Memory-Ablage statt eines statischen Mocks:
// `erledigen`/`wiederherstellen` wirken sich wirklich auf die nächste
// `erledigt`-Antwort aus - genau wie beim echten Server, den `load()` nach
// jedem Schreiben erneut abruft.
let brauchtDichAblage = new Map<string, { schluessel: string; stand: string; erledigtAm: string; erledigtVon: string }>();
const brauchtDichErledigt = vi.fn(() => Promise.resolve({ erledigt: [...brauchtDichAblage.values()] }));
const brauchtDichErledigen = vi.fn((eintraege: { schluessel: string; stand: string }[]) => {
  for (const e of eintraege) {
    brauchtDichAblage.set(e.schluessel, { ...e, erledigtAm: new Date().toISOString(), erledigtVon: 'admin' });
  }
  return Promise.resolve();
});
const brauchtDichWiederherstellen = vi.fn((schluessel: string) => {
  brauchtDichAblage.delete(schluessel);
  return Promise.resolve();
});

vi.mock('../../admin/fleetApi', () => ({
  fleetApi: { fleet: (...a: unknown[]) => fleet(...a) },
}));
vi.mock('../../admin/adminApi', () => ({
  adminApi: {
    edgeUpdates: (...a: unknown[]) => edgeUpdates(...a),
    fernwartung: (...a: unknown[]) => fernwartung(...a),
    fernwartungBoxen: (...a: unknown[]) => fernwartungBoxen(...a),
    werkstattDienst: (...a: unknown[]) => werkstattDienst(...a),
    listPendingEnrollments: (...a: unknown[]) => listPendingEnrollments(...a),
    plattformDienste: (...a: unknown[]) => plattformDienste(...a),
    brauchtDichErledigt: (...a: unknown[]) => brauchtDichErledigt(...a),
    brauchtDichErledigen: (...a: Parameters<typeof brauchtDichErledigen>) => brauchtDichErledigen(...a),
    brauchtDichWiederherstellen: (...a: Parameters<typeof brauchtDichWiederherstellen>) => brauchtDichWiederherstellen(...a),
  },
}));

const { PlattformUebersichtPage } = await import('./PlattformUebersichtPage');

function site(id: string, name: string, extra: Partial<AdminFleetSite> = {}): AdminFleetSite {
  return {
    siteId: id, siteName: name, tenantId: 't1', tenantName: 'Demo C&I',
    plantKind: 'eigenverbrauch', netzladenErlaubt: false, tarifArt: 'fest',
    deviceCount: 1, onlineCount: 1, waitingCount: 0, worstStatus: 'online',
    lastSeenAt: new Date().toISOString(), lastPlanGeneratedAt: new Date().toISOString(),
    hasStorage: false, batteryWithoutDevice: false, sources: null, edge: null, update: null,
    control: null, curtailment: null,
    kwp: { configuredKwp: null, observedPeakKw: null, buckets: 0, verdict: 'unbekannt', reason: '-' },
    forecast: [], pflege: [],
    boxes: [{ deviceId: `${id}-d1`, externalRef: `VP-${id}`, name: null, fuehrtAnlage: true, lastSeenAt: new Date().toISOString(), edge: null, update: null }],
    ...extra,
  };
}

const LEERE_EDGE_UPDATES: EdgeUpdates = {
  fleet: [], rollouts: [], journal: [], kpi: { known: 0, upToDate: 0, unknown: 0, inRollout: 0, failed: 0, newestRelease: null }, lines: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  brauchtDichAblage = new Map();
  fleet.mockResolvedValue({ sites: [] });
  edgeUpdates.mockResolvedValue(LEERE_EDGE_UPDATES);
  fernwartung.mockResolvedValue(null);
  fernwartungBoxen.mockResolvedValue([]);
  werkstattDienst.mockResolvedValue(null);
  listPendingEnrollments.mockResolvedValue([]);
  plattformDienste.mockResolvedValue({ dienste: [] });
});

describe('PlattformUebersichtPage', () => {
  it('lädt alle Antworten EINMAL und zeigt die vier Kacheln', async () => {
    fleet.mockResolvedValue({ sites: [site('s1', 'Anlage A')] });
    render(<PlattformUebersichtPage />);
    const kacheln = within(await screen.findByTestId('ueb-kacheln'));
    expect(kacheln.getByText('Verbindung')).toBeInTheDocument();
    expect(kacheln.getByText('Software')).toBeInTheDocument();
    expect(kacheln.getByText('Steuerung')).toBeInTheDocument();
    expect(kacheln.getByText('Plan')).toBeInTheDocument();
    await waitFor(() => expect(fleet).toHaveBeenCalledTimes(1));
    expect(edgeUpdates).toHaveBeenCalledTimes(1);
  });

  it('zeigt eine leere Flotte als ehrlichen Leerstand, keine erfundene Zahl', async () => {
    render(<PlattformUebersichtPage />);
    expect(await screen.findByText(/Noch keine Anlage/)).toBeInTheDocument();
  });

  it('nennt einen Fehlschlag, statt eine leere Flotte zu behaupten', async () => {
    fleet.mockRejectedValue(new Error('kaputt'));
    render(<PlattformUebersichtPage />);
    expect(await screen.findByText(/nicht geladen werden/)).toBeInTheDocument();
    expect(screen.queryByText(/Noch keine Anlage/)).toBeNull();
  });

  it('eine Box, die sich nicht meldet, braucht dich und führt in ihre Geräteakte', async () => {
    fleet.mockResolvedValue({
      sites: [site('s1', 'Anlage A', {
        boxes: [{ deviceId: 'd1', externalRef: 'VP-BOX-9', name: 'Box 9', fuehrtAnlage: true, lastSeenAt: null, edge: null, update: null }],
      })],
    });
    edgeUpdates.mockResolvedValue({
      ...LEERE_EDGE_UPDATES,
      fleet: [{
        deviceId: 'd1', label: 'Box 9', externalRef: 'VP-BOX-9', siteId: 's1', siteName: 'Anlage A',
        tenantId: 't1', tenantName: 'Demo C&I', ist: null, soll: null, sollSeq: null, state: 'unbekannt',
        reason: null, since: null, reportedAt: null, rolloutId: null, boxArt: null, linie: null,
        stand: 'fehler', lastSeenAt: null, istRelease: null, releasesDahinter: null, istSeit: null, fakten: null,
      }],
    });
    const onNavigate = vi.fn();
    render(<PlattformUebersichtPage onNavigate={onNavigate} />);
    const zeile = await screen.findByTestId('ueb-braucht-zeile');
    expect(zeile).toHaveTextContent('Anlage A');
    fireEvent.click(within(zeile).getByText('Anlage A'));
    expect(onNavigate).toHaveBeenCalledWith({ page: 'geraete-registry', siteId: null, sub: null, geraeteAkte: { ref: 'VP-BOX-9', reiter: 'software', werkzeug: null } });
  });

  describe('Braucht dich: gelesen/erledigt (Nachbesserung)', () => {
    function mitFehlerbox() {
      fleet.mockResolvedValue({
        sites: [site('s1', 'Anlage A', {
          boxes: [{ deviceId: 'd1', externalRef: 'VP-BOX-9', name: 'Box 9', fuehrtAnlage: true, lastSeenAt: null, edge: null, update: null }],
        })],
      });
      edgeUpdates.mockResolvedValue({
        ...LEERE_EDGE_UPDATES,
        fleet: [{
          deviceId: 'd1', label: 'Box 9', externalRef: 'VP-BOX-9', siteId: 's1', siteName: 'Anlage A',
          tenantId: 't1', tenantName: 'Demo C&I', ist: null, soll: null, sollSeq: null, state: 'unbekannt',
          reason: null, since: null, reportedAt: null, rolloutId: null, boxArt: null, linie: null,
          stand: 'fehler', lastSeenAt: null, istRelease: null, releasesDahinter: null, istSeit: null, fakten: null,
        }],
      });
    }

    it('erledigt eine Zeile serverseitig, sie verschwindet, und lässt sich einklappbar zurückholen', async () => {
      mitFehlerbox();
      render(<PlattformUebersichtPage />);
      const zeile = await screen.findByTestId('ueb-braucht-zeile');
      fireEvent.click(within(zeile).getByRole('button', { name: /als erledigt markieren/i }));
      await waitFor(() => expect(brauchtDichErledigen).toHaveBeenCalledTimes(1));
      const [[eintraege]] = brauchtDichErledigen.mock.calls;
      expect(eintraege).toHaveLength(1);
      expect(eintraege[0].schluessel).toMatch(/^fehler-/);
      await waitFor(() => expect(screen.queryByTestId('ueb-braucht-zeile')).toBeNull());
      expect(screen.getByText(/Keine Box braucht dich gerade/)).toBeInTheDocument();

      const auf = screen.getByRole('button', { name: /Erledigte anzeigen \(1\)/ });
      fireEvent.click(auf);
      expect(await screen.findByText('Box 9')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /zurückholen/ }));
      await waitFor(() => expect(brauchtDichWiederherstellen).toHaveBeenCalledWith(eintraege[0].schluessel));
      await waitFor(() => expect(screen.getByTestId('ueb-braucht-zeile')).toBeInTheDocument());
    });

    it('bietet eine Sammel-Handlung, wenn mindestens zwei Zeilen dieselbe Art tragen', async () => {
      fleet.mockResolvedValue({
        sites: [
          site('s1', 'Anlage A', { boxes: [{ deviceId: 'd1', externalRef: 'VP-BOX-9', name: 'Box 9', fuehrtAnlage: true, lastSeenAt: null, edge: null, update: null }] }),
          site('s2', 'Anlage B', { tenantId: 't2', tenantName: 'Demo C&I 2', boxes: [{ deviceId: 'd2', externalRef: 'VP-BOX-10', name: 'Box 10', fuehrtAnlage: true, lastSeenAt: null, edge: null, update: null }] }),
        ],
      });
      edgeUpdates.mockResolvedValue({
        ...LEERE_EDGE_UPDATES,
        fleet: [
          { deviceId: 'd1', label: 'Box 9', externalRef: 'VP-BOX-9', siteId: 's1', siteName: 'Anlage A', tenantId: 't1', tenantName: 'Demo C&I', ist: null, soll: null, sollSeq: null, state: 'unbekannt', reason: null, since: null, reportedAt: null, rolloutId: null, boxArt: null, linie: null, stand: 'fehler', lastSeenAt: null, istRelease: null, releasesDahinter: null, istSeit: null, fakten: null },
          { deviceId: 'd2', label: 'Box 10', externalRef: 'VP-BOX-10', siteId: 's2', siteName: 'Anlage B', tenantId: 't2', tenantName: 'Demo C&I 2', ist: null, soll: null, sollSeq: null, state: 'unbekannt', reason: null, since: null, reportedAt: null, rolloutId: null, boxArt: null, linie: null, stand: 'fehler', lastSeenAt: null, istRelease: null, releasesDahinter: null, istSeit: null, fakten: null },
        ],
      });
      render(<PlattformUebersichtPage />);
      await screen.findAllByTestId('ueb-braucht-zeile');
      fireEvent.click(screen.getByRole('button', { name: /alle 2 .Fehler. erledigen/ }));
      await waitFor(() => expect(brauchtDichErledigen).toHaveBeenCalledTimes(1));
      const [[eintraege]] = brauchtDichErledigen.mock.calls;
      expect(eintraege).toHaveLength(2);
      await waitFor(() => expect(screen.queryByTestId('ueb-braucht-zeile')).toBeNull());
    });
  });

  it('die Software-Kachel führt auf die Software-Seite', async () => {
    fleet.mockResolvedValue({ sites: [site('s1', 'Anlage A')] });
    edgeUpdates.mockResolvedValue({
      ...LEERE_EDGE_UPDATES,
      kpi: { known: 2, upToDate: 0, unknown: 0, inRollout: 0, failed: 0, newestRelease: 'edge-2026.09.0' },
    });
    const onNavigate = vi.fn();
    render(<PlattformUebersichtPage onNavigate={onNavigate} />);
    const kacheln = within(await screen.findByTestId('ueb-kacheln'));
    fireEvent.click(kacheln.getByRole('button', { name: /Software/ }));
    expect(onNavigate).toHaveBeenCalledWith({ page: 'edge-updates', siteId: null, sub: null });
  });

  it('trägt kein Geld - ein reiner Technik-Blick (Captain-Entscheid Q2)', async () => {
    fleet.mockResolvedValue({ sites: [site('s1', 'Anlage A')] });
    const { container } = render(<PlattformUebersichtPage />);
    await screen.findByText('Verbindung');
    expect(container.textContent).not.toContain('€');
    expect(container.textContent).not.toMatch(/verdient|gespart|Erlös/i);
  });

  it('bleibt fail-soft: eine gescheiterte Fernwartungs- oder Werkstatt-Antwort behauptet nie eine fehlende Box', async () => {
    fleet.mockResolvedValue({ sites: [site('s1', 'Anlage A')] });
    fernwartung.mockRejectedValue(new Error('kaputt'));
    fernwartungBoxen.mockRejectedValue(new Error('kaputt'));
    werkstattDienst.mockRejectedValue(new Error('kaputt'));
    listPendingEnrollments.mockRejectedValue(new Error('kaputt'));
    render(<PlattformUebersichtPage />);
    expect(await screen.findByText('Verbindung')).toBeInTheDocument();
  });

  describe('S7: Live-Feinschliff (§5.2) - eine fehlgeschlagene Aktualisierung ist keine Datenlage', () => {
    it('eine spätere gescheiterte Abfrage blendet die Übersicht nicht leer - die Fehlerzeile erscheint oben', async () => {
      vi.useFakeTimers();
      try {
        fleet.mockResolvedValue({ sites: [site('s1', 'Anlage A')] });
        render(<PlattformUebersichtPage />);
        await act(async () => { await Promise.resolve(); });
        expect(screen.getByText('Verbindung')).toBeInTheDocument();
        expect(screen.queryByText(/Noch keine Anlage/)).toBeNull();

        fleet.mockRejectedValue(new Error('netz weg'));
        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

        expect(screen.getByTestId('ueb-stand')).toHaveTextContent('Aktualisierung schlägt fehl');
        // Die Kacheln und die Flotte bleiben stehen - keine leere Übersicht.
        expect(screen.getByText('Verbindung')).toBeInTheDocument();
        expect(screen.queryByText(/Noch keine Anlage/)).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
