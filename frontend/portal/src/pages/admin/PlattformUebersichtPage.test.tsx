import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminFleetSite } from '../../admin/fleetApi';
import type { EdgeUpdates } from '../../adminEdgeUpdates';
import { geraeteAkteRoute } from '../../nav';

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

function standardBrauchtDichMocks() {
  brauchtDichErledigt.mockImplementation(() => Promise.resolve({ erledigt: [...brauchtDichAblage.values()] }));
  brauchtDichErledigen.mockImplementation((eintraege: { schluessel: string; stand: string }[]) => {
    for (const e of eintraege) {
      brauchtDichAblage.set(e.schluessel, { ...e, erledigtAm: new Date().toISOString(), erledigtVon: 'admin' });
    }
    return Promise.resolve();
  });
  brauchtDichWiederherstellen.mockImplementation((schluessel: string) => {
    brauchtDichAblage.delete(schluessel);
    return Promise.resolve();
  });
}

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
  standardBrauchtDichMocks();
});

// Ein Fall setzt `mockImplementation` gezielt auf von Hand aufgelöste
// Versprechen (Netz-Überholung nachbilden) - das überlebt `clearAllMocks()`
// und muss daher IMMER zurückgesetzt werden, auch wenn der Fall selbst
// fehlschlägt.
afterEach(() => {
  standardBrauchtDichMocks();
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
      // Die erledigte Zeile nennt die Box wie „Braucht dich" und die Flotte: nach
      // ihrer Anlage (früher fand dieser Fall „Box 9" nur im Chip der alten Flotten-Karte).
      const liste = await waitFor(() => {
        const el = document.querySelector<HTMLElement>('.vp-ueb-braucht-erledigte-liste');
        if (!el) throw new Error('Erledigte noch nicht aufgeklappt');
        return el;
      });
      expect(within(liste).getByText('Anlage A')).toBeInTheDocument();
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

    it('zwei schnelle Klicks auf unterschiedliche Zeilen bleiben BEIDE erledigt, auch wenn die Nachlade-Abfragen in anderer Reihenfolge zurückkommen', async () => {
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

      // POST (`erledigen`) und GET (`erledigt`) werden hier von Hand
      // aufgelöst statt sofort, um eine Netz-Überholung nachzubilden: eine
      // SPÄTER zurückkommende Antwort einer FRÜHER gestarteten Abfrage -
      // genau das, was beim schnellen Hintereinander-Klicken auf einer
      // echten Verbindung passiert.
      function deferredPromise<T>() {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((res) => { resolve = res; });
        return { promise, resolve };
      }
      const postDeferreds: ReturnType<typeof deferredPromise<void>>[] = [];
      brauchtDichErledigen.mockImplementation(() => {
        const d = deferredPromise<void>();
        postDeferreds.push(d);
        return d.promise;
      });
      const getDeferreds: ReturnType<typeof deferredPromise<{ erledigt: unknown[] }>>[] = [];
      brauchtDichErledigt.mockImplementation(() => {
        const d = deferredPromise<{ erledigt: unknown[] }>();
        getDeferreds.push(d);
        return d.promise;
      });

      render(<PlattformUebersichtPage />);
      await waitFor(() => expect(getDeferreds).toHaveLength(1));
      getDeferreds[0].resolve({ erledigt: [] }); // das anfängliche load()

      const zeilen = await screen.findAllByTestId('ueb-braucht-zeile');
      expect(zeilen).toHaveLength(2);

      fireEvent.click(within(zeilen[0]).getByRole('button', { name: /als erledigt markieren/i }));
      fireEvent.click(within(zeilen[1]).getByRole('button', { name: /als erledigt markieren/i }));

      // Optimistisch verschwinden SOFORT beide Zeilen.
      await waitFor(() => expect(screen.queryByTestId('ueb-braucht-zeile')).toBeNull());

      await waitFor(() => expect(postDeferreds).toHaveLength(2));
      const [eintrag1] = brauchtDichErledigen.mock.calls[0][0] as { schluessel: string; stand: string }[];
      const [eintrag2] = brauchtDichErledigen.mock.calls[1][0] as { schluessel: string; stand: string }[];

      // Klick 1 schreibt zuerst fertig und löst dadurch SEIN load() aus.
      postDeferreds[0].resolve();
      await waitFor(() => expect(getDeferreds).toHaveLength(2));
      // Klick 2 schreibt danach fertig und löst SEIN (zweites) load() aus.
      postDeferreds[1].resolve();
      await waitFor(() => expect(getDeferreds).toHaveLength(3));

      // Die NEUERE Abfrage (von Klick 2 ausgelöst) kommt zuerst zurück, mit
      // dem vollständigen, korrekten Stand ...
      getDeferreds[2].resolve({
        erledigt: [
          { schluessel: eintrag1.schluessel, stand: eintrag1.stand, erledigtAm: new Date().toISOString(), erledigtVon: 'admin' },
          { schluessel: eintrag2.schluessel, stand: eintrag2.stand, erledigtAm: new Date().toISOString(), erledigtVon: 'admin' },
        ],
      });
      await act(async () => { await Promise.resolve(); });
      // ... und die ÄLTERE Abfrage (von Klick 1 ausgelöst) kommt erst danach
      // zurück, mit einem veralteten Stand, der von Klick 2 noch nichts weiß.
      getDeferreds[1].resolve({
        erledigt: [
          { schluessel: eintrag1.schluessel, stand: eintrag1.stand, erledigtAm: new Date().toISOString(), erledigtVon: 'admin' },
        ],
      });

      // Beide Zeilen bleiben erledigt - die überholte, ältere Antwort darf
      // die neuere nicht zurückdrehen.
      await waitFor(() => expect(screen.queryByTestId('ueb-braucht-zeile')).toBeNull());
      expect(screen.getByText(/Keine Box braucht dich gerade/)).toBeInTheDocument();
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

describe('Flotte als Gerätewand (Konzept vp-flottenbild-konzept, E1=B, E2=A)', () => {
  const box = (ref: string, lastSeenAt: string | null = new Date().toISOString()) => ({
    deviceId: `d-${ref}`, externalRef: ref, name: null, fuehrtAnlage: true, lastSeenAt, edge: null, update: null,
  });
  const vorEinerStunde = () => new Date(Date.now() - 3600_000).toISOString();

  it('nennt jede Box mit Kunde und Anlage und öffnet mit einem Tipp ihre Akte', async () => {
    const onNavigate = vi.fn();
    fleet.mockResolvedValue({ sites: [site('s1', 'Wohnhaus Hörmann', { tenantName: 'Hörmann', boxes: [box('edge-k7q2m9x')] })] });
    render(<PlattformUebersichtPage onNavigate={onNavigate} />);
    const kachel = await screen.findByRole('button', { name: /^Hörmann, Wohnhaus Hörmann: verbunden/ });
    expect(within(kachel).getByText('Hörmann')).toBeInTheDocument();
    expect(within(kachel).getByText('Wohnhaus Hörmann')).toBeInTheDocument();
    fireEvent.click(kachel);
    expect(onNavigate).toHaveBeenCalledWith(geraeteAkteRoute('edge-k7q2m9x'));
  });

  it('ein Wort steht nur bei einer Abweichung, die Störung steht vorn - keine Legende', async () => {
    fleet.mockResolvedValue({
      sites: [
        site('s1', 'Haus A', { boxes: [box('VP-A')] }),
        site('s2', 'Haus B', { boxes: [box('VP-B', vorEinerStunde())] }),
      ],
    });
    render(<PlattformUebersichtPage />);
    const flotte = within(await screen.findByTestId('ueb-flotte'));
    expect(flotte.getByText('offline')).toBeInTheDocument();
    expect(flotte.queryByText('verbunden')).toBeNull();
    expect(flotte.queryByText('nie gemeldet')).toBeNull();
    expect(flotte.getAllByTestId('ueb-flotte-box')[0]).toHaveAccessibleName(/Haus B: offline/);
    expect(flotte.getByText('2 Boxen · 1 Kunde')).toBeInTheDocument();
  });

  it('eine Anlage ohne Box ist ein Hinweis mit Weg zur Kundenakte, keine leere Zeile', async () => {
    fleet.mockResolvedValue({
      sites: [site('s1', 'Haus A'), site('s2', 'PV Dach', { tenantId: 't2', tenantName: 'Lena Brandl', boxes: [] })],
    });
    render(<PlattformUebersichtPage />);
    const hinweis = await screen.findByTestId('ueb-flotte-ohnebox');
    expect(hinweis).toHaveTextContent('1 Anlage ohne Box');
    expect(within(hinweis).getByRole('link', { name: /Lena Brandl/ })).toHaveAttribute('href', '#/plattform/benutzer/t2');
    expect(screen.queryByText(/Lena Brandl · 0/)).toBeNull();
  });

  describe('am Telefon', () => {
    beforeEach(() => {
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: (q: string) => ({
          matches: q.includes('max-width'), media: q, onchange: null,
          addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
          dispatchEvent: () => false,
        }),
      });
    });
    afterEach(() => {
      // @ts-expect-error - der Stub gehört zum einzelnen Fall
      delete window.matchMedia;
    });

    it('ab 13 Boxen klappen die ruhigen zu, die Störung bleibt offen (E2=A)', async () => {
      fleet.mockResolvedValue({
        sites: Array.from({ length: 13 }, (_, i) => site(`s${i}`, `Haus ${i}`, {
          tenantId: `t${i}`, tenantName: `Kunde ${String(i).padStart(2, '0')}`,
          boxes: [box(`VP-${i}`, i === 0 ? vorEinerStunde() : new Date().toISOString())],
        })),
      });
      render(<PlattformUebersichtPage />);
      const flotte = within(await screen.findByTestId('ueb-flotte'));
      const klappe = flotte.getByRole('button', { name: /12 weitere Boxen · alle verbunden/ });
      expect(klappe).toHaveAttribute('aria-expanded', 'false');
      expect(flotte.getAllByRole('button', { name: /Geräteakte öffnen/ }).map((b) => b.getAttribute('aria-label')))
        .toEqual([expect.stringMatching(/^Kunde 00, Haus 0: offline/)]);
      fireEvent.click(klappe);
      expect(klappe).toHaveAttribute('aria-expanded', 'true');
      expect(flotte.getAllByRole('button', { name: /Geräteakte öffnen/ })).toHaveLength(13);
    });

    it('unter 13 Boxen klappt nichts zu', async () => {
      fleet.mockResolvedValue({ sites: [site('s1', 'Haus A'), site('s2', 'Haus B', { boxes: [box('VP-B')] })] });
      render(<PlattformUebersichtPage />);
      const flotte = within(await screen.findByTestId('ueb-flotte'));
      expect(flotte.getAllByRole('button', { name: /Geräteakte öffnen/ })).toHaveLength(2);
      expect(flotte.queryByRole('button', { name: /weitere Boxen/ })).toBeNull();
    });
  });
});

