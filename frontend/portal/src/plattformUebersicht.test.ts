import { describe, expect, it } from 'vitest';
import type { AdminFleetBox, AdminFleetSite } from './admin/fleetApi';
import type { EdgeUpdatesKpi, EdgeUpdatesLine, FleetRow as EdgeFleetRow, Rollout } from './adminEdgeUpdates';
import { edgeUpdatesUrteil, kpiText, rolloutsLaufend } from './adminEdgeUpdates';
import type { PendingEnrollment } from './admin/adminApi';
import type { FernwartungBox, FernwartungUebersicht } from './adminFernwartung';
import type { WerkstattDienst } from './werkstattBank';
import {
  brauchtDichMitErledigt,
  uebersichtAuffaellig,
  uebersichtBrauchtDich,
  uebersichtDienste,
  uebersichtFlotte,
  uebersichtKacheln,
  flotteAmTelefon,
  FLOTTE_TELEFON_KLAPPEN_AB,
} from './plattformUebersicht';
import { fleetBoxGroups } from './adminFleet';

const NOW = new Date('2026-11-06T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function site(over: Partial<AdminFleetSite> = {}): AdminFleetSite {
  return {
    siteId: 's1', siteName: 'Anlage A', tenantId: 't1', tenantName: 'Kunde A',
    plantKind: 'eigenverbrauch', netzladenErlaubt: false, tarifArt: 'fest',
    deviceCount: 1, onlineCount: 1, waitingCount: 0, worstStatus: 'online',
    lastSeenAt: ago(10_000), lastPlanGeneratedAt: ago(6 * 60_000), hasStorage: false,
    batteryWithoutDevice: false, sources: null, edge: null, update: null, control: null,
    curtailment: null, kwp: { configuredKwp: null, observedPeakKw: null, buckets: 0, verdict: 'unbekannt', reason: 'x' },
    forecast: [], pflege: [],
    boxes: [{ deviceId: 'd1', externalRef: 'VP-BOX-0001', name: 'Box A', fuehrtAnlage: true, lastSeenAt: ago(10_000), edge: null, update: null }],
    ...over,
  } as AdminFleetSite;
}

function rollout(over: Partial<Rollout> = {}): Rollout {
  return {
    id: 'r1', releaseVersion: 'edge-2026.09.0', releaseSeq: 2, state: 'laufend',
    createdBy: 'admin', createdAt: ago(10 * 60_000), total: 1, confirmed: 0, failed: 0,
    devices: [{ deviceId: 'd1', label: 'Box A', siteName: 'Anlage A', tenantName: 'Kunde A', state: 'angefragt', reason: null, since: ago(10 * 60_000) }],
    ...over,
  } as Rollout;
}

function edgeRow(over: Partial<EdgeFleetRow> = {}): EdgeFleetRow {
  return {
    deviceId: 'd1', label: 'Box A', externalRef: 'VP-BOX-0001', siteId: 's1', siteName: 'Anlage A',
    tenantId: 't1', tenantName: 'Kunde A', ist: 'edge-2026.08.0', soll: 'edge-2026.08.0', sollSeq: 1,
    state: 'bestaetigt', reason: null, since: null, reportedAt: ago(10_000), rolloutId: null,
    lastSeenAt: ago(10_000), boxArt: 'docker', linie: 'docker', stand: 'aktuell',
    istRelease: 'edge-2026.08.0', releasesDahinter: 0, istSeit: null, fakten: null,
    ...over,
  } as EdgeFleetRow;
}

describe('uebersichtKacheln', () => {
  it('zeigt eine ruhige Verbindungs-Kachel ohne Ausnahme', () => {
    const k = uebersichtKacheln({ sites: [site()], releases: [], edgeLines: [], edgeKpi: { known: 1, upToDate: 1, unknown: 0, inRollout: 0, failed: 0, newestRelease: null }, edgeRollouts: [] }, NOW);
    const verbindung = k.find((x) => x.id === 'verbindung')!;
    expect(verbindung.zahl).toBe(0);
    expect(verbindung.ton).toBe('ok');
    expect(verbindung.wort).toContain('Alle 1 verbunden');
  });

  it('E6: eine verzögerte Box zählt NICHT als Ausnahme der Verbindungs-Kachel - reine Anzeige', () => {
    const k = uebersichtKacheln({
      sites: [site({ boxes: [{ deviceId: 'd1', externalRef: 'VP-BOX-0001', name: 'Box A', fuehrtAnlage: true, lastSeenAt: ago(2 * 60_000), edge: null, update: null }] })],
      releases: [], edgeLines: [], edgeKpi: { known: 0, upToDate: 0, unknown: 0, inRollout: 0, failed: 0, newestRelease: null }, edgeRollouts: [],
    }, NOW);
    const verbindung = k.find((x) => x.id === 'verbindung')!;
    expect(verbindung.zahl).toBe(0);
    expect(verbindung.ton).toBe('ok');
  });

  it('zählt Boxen, die sich nicht melden, als Ausnahme', () => {
    const k = uebersichtKacheln({
      sites: [site({ boxes: [{ deviceId: 'd1', externalRef: 'VP-BOX-0001', name: 'Box A', fuehrtAnlage: true, lastSeenAt: ago(3600_000), edge: null, update: null }] })],
      releases: [], edgeLines: [], edgeKpi: { known: 0, upToDate: 0, unknown: 0, inRollout: 0, failed: 0, newestRelease: null }, edgeRollouts: [],
    }, NOW);
    const verbindung = k.find((x) => x.id === 'verbindung')!;
    expect(verbindung.zahl).toBe(1);
    expect(verbindung.ton).toBe('warn');
  });

  it('N2: Einzahl bei genau einer schweigenden Box', () => {
    const k = uebersichtKacheln({
      sites: [site({ boxes: [{ deviceId: 'd1', externalRef: 'VP-BOX-0001', name: 'Box A', fuehrtAnlage: true, lastSeenAt: ago(3600_000), edge: null, update: null }] })],
      releases: [], edgeLines: [], edgeKpi: { known: 0, upToDate: 0, unknown: 0, inRollout: 0, failed: 0, newestRelease: null }, edgeRollouts: [],
    }, NOW);
    const verbindung = k.find((x) => x.id === 'verbindung')!;
    expect(verbindung.wort).toBe('meldet sich nicht');
  });

  it('N2: Mehrzahl bei mehreren schweigenden Boxen', () => {
    const k = uebersichtKacheln({
      sites: [site({ boxes: [
        { deviceId: 'd1', externalRef: 'VP-BOX-0001', name: 'Box A', fuehrtAnlage: true, lastSeenAt: ago(3600_000), edge: null, update: null },
        { deviceId: 'd2', externalRef: 'VP-BOX-0002', name: 'Box B', fuehrtAnlage: true, lastSeenAt: ago(3600_000), edge: null, update: null },
      ] })],
      releases: [], edgeLines: [], edgeKpi: { known: 0, upToDate: 0, unknown: 0, inRollout: 0, failed: 0, newestRelease: null }, edgeRollouts: [],
    }, NOW);
    const verbindung = k.find((x) => x.id === 'verbindung')!;
    expect(verbindung.wort).toBe('melden sich nicht');
  });

  it('N2: Einzahl bei genau einer Abweichung der Steuerungs-Kachel', () => {
    const k = uebersichtKacheln({
      sites: [site({
        hasStorage: true,
        control: {
          deviceId: 'd1', commandedKw: 1, confirmedKw: 2, allMatch: false,
          controlEnabled: true, certified: true, mismatchRoles: null, slotStart: null, checkedAt: ago(10_000),
        } as AdminFleetSite['control'],
      })],
      releases: [], edgeLines: [], edgeKpi: { known: 0, upToDate: 0, unknown: 0, inRollout: 0, failed: 0, newestRelease: null }, edgeRollouts: [],
    }, NOW);
    const steuerung = k.find((x) => x.id === 'steuerung')!;
    expect(steuerung.zahl).toBe(1);
    expect(steuerung.wort).toBe('Abweichung');
  });

  it('die Software-Kachel zählt „bekannt minus aktuell", je Linie aufgeschlüsselt', () => {
    const k = uebersichtKacheln({
      sites: [], releases: [],
      edgeLines: [{ boxArt: 'docker', newestRelease: 'edge-2026.09.0', newestReleaseSeq: 2, devices: 4, known: 4, upToDate: 2 }],
      edgeKpi: { known: 4, upToDate: 2, unknown: 0, inRollout: 1, failed: 0, newestRelease: 'edge-2026.09.0' },
      edgeRollouts: [rollout()],
    }, NOW);
    const software = k.find((x) => x.id === 'software')!;
    expect(software.zahl).toBe(2);
    expect(software.kontext).toContain('1 läuft');
    expect(software.kontext).toContain('Docker-Box 2 älter');
  });

  it('REGRESSION: zwei Linien, jede für sich auf dem neuesten Release - die Kachel zeigt 0, nicht „nicht aktuell" über die ANDERE Linie gemessen', () => {
    // Wie im Vorfall: 3 Docker-Boxen auf edge-2026.10.7 (neuestes ihrer
    // Linie), 3 Edge-Light-Boxen auf edge-light-2026.11.9 (neuestes ihrer
    // Linie). `kpi.upToDate` misst über BEIDE Linien gegen das insgesamt
    // neueste Release und zählte die Docker-Boxen früher fälschlich als
    // „nicht aktuell".
    const k = uebersichtKacheln({
      sites: [], releases: [],
      edgeLines: [
        { boxArt: 'docker', newestRelease: 'edge-2026.10.7', newestReleaseSeq: 5, devices: 3, known: 3, upToDate: 3 },
        { boxArt: 'light', newestRelease: 'edge-light-2026.11.9', newestReleaseSeq: 9, devices: 3, known: 3, upToDate: 3 },
      ],
      edgeKpi: { known: 6, upToDate: 3, unknown: 0, inRollout: 3, failed: 0, newestRelease: 'edge-light-2026.11.9' },
      edgeRollouts: [],
    }, NOW);
    const software = k.find((x) => x.id === 'software')!;
    expect(software.zahl).toBe(0);
    expect(software.ton).toBe('ok');
    expect(software.wort).toBe('Alle aktuell ✓');
  });

  it('REGRESSION: ein vollständig bestätigter Rollout zählt nicht mehr als „laufen"', () => {
    // Wie im Vorfall: Rollout-Feld zeigt 3 angefragt / 3 angenommen / 3
    // bestätigt - `kpi.inRollout` zählte trotzdem 3, weil es jedes Gerät
    // zählt, das im Fenster der letzten Rollouts VORKOMMT, nicht nur die
    // noch laufenden.
    const k = uebersichtKacheln({
      sites: [], releases: [],
      edgeLines: [{ boxArt: 'light', newestRelease: 'edge-light-2026.11.9', newestReleaseSeq: 9, devices: 3, known: 3, upToDate: 3 }],
      edgeKpi: { known: 3, upToDate: 3, unknown: 0, inRollout: 3, failed: 0, newestRelease: 'edge-light-2026.11.9' },
      edgeRollouts: [rollout({
        total: 3, confirmed: 3, failed: 0,
        devices: [
          { deviceId: 'd1', label: 'Box A', siteName: 'Anlage A', tenantName: 'Kunde A', state: 'bestaetigt', reason: null, since: ago(10 * 60_000) },
          { deviceId: 'd2', label: 'Box B', siteName: 'Anlage B', tenantName: 'Kunde A', state: 'bestaetigt', reason: null, since: ago(10 * 60_000) },
          { deviceId: 'd3', label: 'Box C', siteName: 'Anlage C', tenantName: 'Kunde A', state: 'bestaetigt', reason: null, since: ago(10 * 60_000) },
        ],
      })],
    }, NOW);
    const software = k.find((x) => x.id === 'software')!;
    expect(software.zahl).toBe(0);
    expect(software.kontext).not.toContain('laufen');
  });

  it('WÄCHTER: Übersicht-Kachel und Software-Seite fällen für dieselben Daten dasselbe Urteil', () => {
    // Beide Flächen lesen `edgeUpdatesUrteil`/`rolloutsLaufend` - eine Zahl an
    // zwei Orten mit zwei Rechnungen darf nicht wieder entstehen.
    const faelle: { kpi: EdgeUpdatesKpi; lines: EdgeUpdatesLine[]; rollouts: Rollout[] }[] = [
      {
        kpi: { known: 6, upToDate: 3, unknown: 0, inRollout: 3, failed: 0, newestRelease: 'edge-light-2026.11.9' },
        lines: [
          { boxArt: 'docker', newestRelease: 'edge-2026.10.7', newestReleaseSeq: 5, devices: 3, known: 3, upToDate: 3 },
          { boxArt: 'light', newestRelease: 'edge-light-2026.11.9', newestReleaseSeq: 9, devices: 3, known: 3, upToDate: 3 },
        ],
        rollouts: [rollout({
          total: 3, confirmed: 3, failed: 0,
          devices: [
            { deviceId: 'd1', label: 'Box A', siteName: 'Anlage A', tenantName: 'Kunde A', state: 'bestaetigt', reason: null, since: null },
            { deviceId: 'd2', label: 'Box B', siteName: 'Anlage B', tenantName: 'Kunde A', state: 'bestaetigt', reason: null, since: null },
            { deviceId: 'd3', label: 'Box C', siteName: 'Anlage C', tenantName: 'Kunde A', state: 'bestaetigt', reason: null, since: null },
          ],
        })],
      },
      {
        kpi: { known: 4, upToDate: 2, unknown: 0, inRollout: 1, failed: 0, newestRelease: 'edge-2026.09.0' },
        lines: [{ boxArt: 'docker', newestRelease: 'edge-2026.09.0', newestReleaseSeq: 2, devices: 4, known: 4, upToDate: 2 }],
        rollouts: [rollout()],
      },
    ];
    for (const fall of faelle) {
      const k = uebersichtKacheln(
        { sites: [], releases: [], edgeLines: fall.lines, edgeKpi: fall.kpi, edgeRollouts: fall.rollouts },
        NOW,
      );
      const software = k.find((x) => x.id === 'software')!;
      const { aktuell, bekannt } = edgeUpdatesUrteil(fall.kpi, fall.lines);
      expect(software.zahl).toBe(bekannt - aktuell);
      expect(software.ton).toBe(bekannt - aktuell > 0 ? 'warn' : 'ok');
      const text = kpiText(fall.kpi, fall.lines);
      expect(text).toContain(`${aktuell}/${bekannt} aktuell`);
      const laufend = rolloutsLaufend(fall.rollouts);
      const laufendWort = laufend === 1 ? 'läuft' : 'laufen';
      expect(software.kontext.includes(`${laufend} ${laufendWort}`)).toBe(laufend > 0);
    }
  });

  it('die Plan-Kachel nennt den jüngsten Lauf über die ganze Flotte', () => {
    const k = uebersichtKacheln({
      sites: [site({ lastPlanGeneratedAt: ago(3 * 3600_000) }), site({ siteId: 's2', lastPlanGeneratedAt: ago(5 * 60_000) })],
      releases: [], edgeLines: [], edgeKpi: { known: 0, upToDate: 0, unknown: 0, inRollout: 0, failed: 0, newestRelease: null }, edgeRollouts: [],
    }, NOW);
    const plan = k.find((x) => x.id === 'plan')!;
    expect(plan.zahl).toBe(1);
    expect(plan.kontext).toContain('5 Min.');
  });
});

describe('uebersichtBrauchtDich', () => {
  const leer = { edgeFleet: [], fernwartungBoxen: [], werkstatt: null, pending: [] };

  it('sortiert Fehler vor Zurückhalten vor offline-mit-Anfrage vor Stufe 1', () => {
    const zeilen = uebersichtBrauchtDich({
      ...leer,
      edgeFleet: [
        edgeRow({ externalRef: 'hand', siteName: 'hand', stand: 'hand' }),
        edgeRow({ externalRef: 'fehler', siteName: 'fehler', stand: 'fehler' }),
        edgeRow({
          externalRef: 'offline', siteName: 'offline', stand: 'offline', lastSeenAt: ago(3600_000),
          fakten: { angefragt: { release: 'x', releaseSeq: 1, am: null, von: null }, angenommen: { stand: 'wartet', am: null, grund: null }, bestaetigt: { stand: 'offen', am: null, schritt: null, grund: null } },
        }),
        edgeRow({ externalRef: 'halt', siteName: 'halt', stand: 'gehalten' }),
      ],
    }, NOW);
    expect(zeilen.map((z) => z.box)).toEqual(['fehler', 'halt', 'offline', 'hand']);
  });

  it('erkennt ein Fernwartungs-Fenster, das offen ist, aber keinen Schlüssel abgeholt hat', () => {
    const box: FernwartungBox = {
      id: 'f1', edgeRef: 'VP-BOX-9', publicKey: 'k', publicKeyKurz: 'k', adresse: '10.0.0.1',
      status: 'aktiv', notiz: null, angelegtAm: ago(100_000), geaendertAm: ago(100_000),
      siteId: 's1', siteName: 'Anlage A', tenantId: 't1', tenantName: 'Kunde A',
      laufendeFenster: [{
        id: 'fen1', edgeRef: 'VP-BOX-9', technikerId: 'tech1', technikerName: 'Max', grund: 'Service',
        beginn: ago(60_000), ende: ago(-3600_000), wirksamesEnde: ago(-3600_000), zustand: 'offen',
        geoeffnetAm: ago(60_000), geoeffnetVon: 'admin', geschlossenAm: null, geschlossenVon: null,
        rueckmeldung: { gemeldetAm: ago(10_000), schluesselAbgeholtUm: null },
      }],
    };
    const zeilen = uebersichtBrauchtDich({ ...leer, fernwartungBoxen: [box] }, NOW);
    expect(zeilen).toHaveLength(1);
    expect(zeilen[0]).toMatchObject({ box: 'VP-BOX-9', kurz: 'Fenster ohne Schlüssel' });
  });

  it('ein offenes Fenster MIT abgeholtem Schlüssel braucht niemanden', () => {
    const box: FernwartungBox = {
      id: 'f1', edgeRef: 'VP-BOX-9', publicKey: 'k', publicKeyKurz: 'k', adresse: '10.0.0.1',
      status: 'aktiv', notiz: null, angelegtAm: ago(100_000), geaendertAm: ago(100_000),
      siteId: null, siteName: null, tenantId: null, tenantName: null,
      laufendeFenster: [{
        id: 'fen1', edgeRef: 'VP-BOX-9', technikerId: 'tech1', technikerName: 'Max', grund: 'Service',
        beginn: ago(60_000), ende: ago(-3600_000), wirksamesEnde: ago(-3600_000), zustand: 'offen',
        geoeffnetAm: ago(60_000), geoeffnetVon: 'admin', geschlossenAm: null, geschlossenVon: null,
        rueckmeldung: { gemeldetAm: ago(10_000), schluesselAbgeholtUm: ago(5_000) },
      }],
    };
    expect(uebersichtBrauchtDich({ ...leer, fernwartungBoxen: [box] }, NOW)).toHaveLength(0);
  });

  it('ein angehaltener Werkstatt-Lauf braucht einen Handgriff', () => {
    const werkstatt: WerkstattDienst = {
      ansicht: null, gemeldetAm: ago(5_000), dienstZeit: ago(5_000), alterSekunden: 5, aktuell: true,
      laeufe: [{
        kennung: 'L1', freigabe: 'FR1', boxArt: 'edge-light', zustand: 'angehalten', schritt: 'tunnel',
        titel: null, grund: 'Kabel nicht gesteckt', beginn: ago(600_000), ende: null, aktualisiertAm: ago(10_000),
        stand: { kennung: 'L1', freigabe: 'FR1', box_art: 'edge-light', box: 'edge-m1', beginn: ago(600_000), zustand: 'angehalten', erledigt: [] },
      }],
    };
    const zeilen = uebersichtBrauchtDich({ ...leer, werkstatt }, NOW);
    expect(zeilen).toHaveLength(1);
    expect(zeilen[0]).toMatchObject({ box: 'edge-m1', kurz: 'Werkstatt nicht bereit' });
  });

  it('eine lang wartende, vermutlich falsch getippte Anmeldung braucht dich', () => {
    const pending: PendingEnrollment = { externalRef: 'edge-x9', deviceInfo: null, csrUpdatedAt: ago(2 * 24 * 3600_000), everIssued: false, issuedAt: null };
    const zeilen = uebersichtBrauchtDich({ ...leer, pending: [pending] }, NOW);
    expect(zeilen).toHaveLength(1);
    expect(zeilen[0]).toMatchObject({ box: 'edge-x9', kurz: 'ohne Kunde' });
  });

  it('eine frische, normale Anmeldung braucht niemanden', () => {
    const pending: PendingEnrollment = { externalRef: 'edge-x9', deviceInfo: null, csrUpdatedAt: ago(60_000), everIssued: false, issuedAt: null };
    expect(uebersichtBrauchtDich({ ...leer, pending: [pending] }, NOW)).toHaveLength(0);
  });
});

describe('brauchtDichMitErledigt', () => {
  const leer = { edgeFleet: [], fernwartungBoxen: [], werkstatt: null, pending: [] };

  it('verbirgt eine Zeile, deren Grund zum erledigten Stand passt', () => {
    const zeilen = uebersichtBrauchtDich({ ...leer, edgeFleet: [edgeRow({ externalRef: 'fehler', siteName: 'fehler', stand: 'fehler' })] }, NOW);
    expect(zeilen).toHaveLength(1);
    const { aktiv, erledigt } = brauchtDichMitErledigt(zeilen, [
      { schluessel: zeilen[0].key, stand: zeilen[0].grund, erledigtAm: ago(0), erledigtVon: 'admin' },
    ]);
    expect(aktiv).toHaveLength(0);
    expect(erledigt).toHaveLength(1);
    expect(erledigt[0]).toMatchObject({ erledigtVon: 'admin' });
  });

  it('eine Zeile mit NEUEREM Grund erscheint wieder, obwohl derselbe Schlüssel schon erledigt war', () => {
    const zeilen = uebersichtBrauchtDich({ ...leer, edgeFleet: [edgeRow({ externalRef: 'fehler', siteName: 'fehler', stand: 'fehler' })] }, NOW);
    const { aktiv, erledigt } = brauchtDichMitErledigt(zeilen, [
      { schluessel: zeilen[0].key, stand: 'ein ganz anderer, älterer Grund', erledigtAm: ago(0), erledigtVon: 'admin' },
    ]);
    expect(aktiv).toHaveLength(1);
    expect(erledigt).toHaveLength(0);
  });

  it('ein erledigter Schlüssel ohne passende aktuelle Zeile verschwindet einfach (kein Ghost)', () => {
    const { aktiv, erledigt } = brauchtDichMitErledigt([], [
      { schluessel: 'fehler-weg', stand: 'x', erledigtAm: ago(0), erledigtVon: 'admin' },
    ]);
    expect(aktiv).toHaveLength(0);
    expect(erledigt).toHaveLength(0);
  });
});

describe('uebersichtFlotte (Gerätewand, Konzept vp-flottenbild-konzept Weg B)', () => {
  const box = (over: Partial<AdminFleetBox> = {}): AdminFleetBox => ({
    deviceId: 'd1', externalRef: 'VP-BOX-0001', name: null, fuehrtAnlage: true, lastSeenAt: ago(10_000), edge: null, update: null,
    ...over,
  });
  const STILL = ago(3600_000);

  it('nennt eine Box wie die Akte: Kunde und Anlage - nie nur die Kennung', () => {
    // Beim Verbinden bekommt eine Box keinen Namen (`DeviceRepository.claim`).
    const groups = fleetBoxGroups([
      site({ siteName: 'Wohnhaus Hörmann', tenantName: 'Hörmann', boxes: [box({ externalRef: 'edge-k7q2m9x' })] }),
    ], NOW);
    const bild = uebersichtFlotte(groups, []);
    expect(bild.boxen[0]).toMatchObject({ ref: 'edge-k7q2m9x', kunde: 'Hörmann', anlage: 'Wohnhaus Hörmann', zusatz: null, ton: 'ok' });
  });

  it('unterscheidet mehrere Boxen EINER Anlage am Gerätenamen, sonst an der Kennung', () => {
    const groups = fleetBoxGroups([
      site({
        siteName: 'Werk Süd',
        boxes: [box({ externalRef: 'VP-BOX-2041' }), box({ deviceId: 'd2', externalRef: 'VP-BOX-2042', name: 'Halle 2', fuehrtAnlage: false })],
      }),
    ], NOW);
    const bild = uebersichtFlotte(groups, []);
    expect(bild.boxen.map((b) => b.zusatz)).toEqual(['Halle 2', 'VP-BOX-2041']);
  });

  it('stellt Störungen vor Hinweise vor die ruhigen Boxen - darin nach Kunde', () => {
    const groups = fleetBoxGroups([
      site({ siteId: 's1', tenantId: 't1', tenantName: 'Anton', boxes: [box({ externalRef: 'A' })] }),
      site({ siteId: 's2', tenantId: 't2', tenantName: 'Berta', boxes: [box({ externalRef: 'B', lastSeenAt: STILL })] }),
      site({ siteId: 's3', tenantId: 't3', tenantName: 'Cäsar', boxes: [box({ externalRef: 'C', lastSeenAt: ago(2 * 60_000) })] }),
      site({ siteId: 's4', tenantId: 't4', tenantName: 'Dora', boxes: [box({ externalRef: 'D' })] }),
      site({ siteId: 's5', tenantId: 't5', tenantName: 'Emil', boxes: [box({ externalRef: 'E', lastSeenAt: null })] }),
    ], NOW);
    const bild = uebersichtFlotte(groups, [edgeRow({ externalRef: 'D', stand: 'laeuft' })]);
    expect(bild.boxen.map((b) => [b.ref, b.ton, b.stufe])).toEqual([
      ['B', 'aus', 0], ['E', 'nie', 0], ['C', 'verzoegert', 1], ['D', 'lauf', 1], ['A', 'ok', 2],
    ]);
  });

  it('die Verbindung schlägt das Update: eine Box, die sich nicht meldet, „läuft" nicht', () => {
    const groups = fleetBoxGroups([site({ boxes: [box({ lastSeenAt: STILL })] })], NOW);
    const bild = uebersichtFlotte(groups, [edgeRow({ stand: 'laeuft' })]);
    expect(bild.boxen[0].ton).toBe('aus');
  });

  it('„nur von Hand" und die Linie kommen aus der Software-Zeile der Box; ohne sie bleibt die Linie unbekannt', () => {
    const groups = fleetBoxGroups([
      site({ siteId: 's1', boxes: [box({ externalRef: 'edge-a' })] }),
      site({ siteId: 's2', siteName: 'Anlage B', boxes: [box({ deviceId: 'd2', externalRef: 'VP-BOX-B' })] }),
    ], NOW);
    const bild = uebersichtFlotte(groups, [edgeRow({ externalRef: 'edge-a', stand: 'hand', linie: 'light', boxArt: 'light' })]);
    expect(bild.boxen.find((b) => b.ref === 'edge-a')).toMatchObject({ ton: 'hand', linie: 'light' });
    expect(bild.boxen.find((b) => b.ref === 'VP-BOX-B')).toMatchObject({ ton: 'ok', linie: null });
  });

  it('eine Anlage ohne Box ist kein Feld der Wand, sondern ein Hinweis - keine Zeile „· 0"', () => {
    const groups = fleetBoxGroups([
      site({ siteId: 's1', tenantId: 't1', tenantName: 'Mit Box' }),
      site({ siteId: 's2', tenantId: 't2', tenantName: 'Lena Brandl', siteName: 'PV Dach', boxes: [] }),
    ], NOW);
    const bild = uebersichtFlotte(groups, []);
    expect(bild.boxen.map((b) => b.kunde)).toEqual(['Mit Box']);
    expect(bild.ohneBox).toEqual([{ kunde: 'Lena Brandl', tenantId: 't2', anlage: 'PV Dach' }]);
    expect(bild.kunden).toBe(1);
  });

  it('zählt Kunden, nicht Anlagen', () => {
    const groups = fleetBoxGroups([
      site({ siteId: 's1', siteName: 'Hof', boxes: [box({ externalRef: 'A' })] }),
      site({ siteId: 's2', siteName: 'Scheune', boxes: [box({ deviceId: 'd2', externalRef: 'B' })] }),
    ], NOW);
    expect(uebersichtFlotte(groups, []).kunden).toBe(1);
  });

  it('Wächter: dieselbe Box heißt in der Flotte wie in „Braucht dich" (Kunde, Anlage)', () => {
    const groups = fleetBoxGroups([
      site({ siteName: 'Kleingarten Ostend', tenantName: 'Familie Beispiel', boxes: [box({ externalRef: 'edge-m4ng0q1', name: 'Box am Zaun' })] }),
    ], NOW);
    const row = edgeRow({
      externalRef: 'edge-m4ng0q1', label: 'Box am Zaun', siteName: 'Kleingarten Ostend', tenantName: 'Familie Beispiel',
      stand: 'hand', stufe1: true, linie: 'light',
    });
    const flotte = uebersichtFlotte(groups, [row]).boxen[0];
    const brauchtDich = uebersichtBrauchtDich({ edgeFleet: [row], fernwartungBoxen: [], werkstatt: null, pending: [] }, NOW)[0];
    expect(brauchtDich.art).toBe('stufe1');
    expect([flotte.kunde, flotte.anlage]).toEqual([brauchtDich.kunde, brauchtDich.box]);
  });
});

describe('flotteAmTelefon (E2=A)', () => {
  const flotte = (anzahl: number, gestoert: number) => uebersichtFlotte(fleetBoxGroups(
    Array.from({ length: anzahl }, (_, i) => site({
      siteId: `s${i}`, tenantId: `t${i}`, tenantName: `Kunde ${String(i).padStart(2, '0')}`,
      boxes: [{ deviceId: `d${i}`, externalRef: `VP-BOX-${i}`, name: null, fuehrtAnlage: true, lastSeenAt: i < gestoert ? ago(3600_000) : ago(10_000), edge: null, update: null }],
    })),
    NOW,
  ), []);

  it(`klappt unter ${FLOTTE_TELEFON_KLAPPEN_AB} Boxen nichts zu`, () => {
    const { offen, zugeklappt } = flotteAmTelefon(flotte(FLOTTE_TELEFON_KLAPPEN_AB - 1, 1));
    expect(offen).toHaveLength(FLOTTE_TELEFON_KLAPPEN_AB - 1);
    expect(zugeklappt).toHaveLength(0);
  });

  it(`ab ${FLOTTE_TELEFON_KLAPPEN_AB} Boxen bleiben Störungen offen, die ruhigen klappen zu`, () => {
    const { offen, zugeklappt } = flotteAmTelefon(flotte(FLOTTE_TELEFON_KLAPPEN_AB, 2));
    expect(offen.map((b) => b.ton)).toEqual(['aus', 'aus']);
    expect(zugeklappt).toHaveLength(FLOTTE_TELEFON_KLAPPEN_AB - 2);
    expect(zugeklappt.every((b) => b.ton === 'ok')).toBe(true);
  });
});

describe('uebersichtDienste', () => {
  it('nennt Tunnel- und Werkstatt-Dienst mit ihrem Alter', () => {
    const fernwartung: FernwartungUebersicht = {
      server: { endpunkt: 'vm', port: 51820, publicKey: 'x', eingerichtet: true, boxNetz: '', technikerNetz: '', boxServerAdresse: '', technikerServerAdresse: '' },
      maxFensterMinuten: 60, abrufe: [], rueckmeldungen: [{ dienst: 'd1', zuletztAm: ago(18_000), gestartetUm: ago(100_000), schluesselausgabe: true, boxen: 3, fenster: 1 }],
      boxenAktiv: 3, boxenGesperrt: 0, technikerAktiv: 1, technikerGesperrt: 0, fensterOffen: 1, fensterGeplant: 0, stand: ago(0),
    };
    const werkstatt: WerkstattDienst = { ansicht: null, gemeldetAm: ago(7_000), dienstZeit: ago(7_000), alterSekunden: 7, aktuell: true, laeufe: [] };
    const dienste = uebersichtDienste(fernwartung, werkstatt, NOW);
    expect(dienste).toHaveLength(2);
    expect(dienste[0]).toMatchObject({ id: 'tunnel-dienst', ton: 'ok' });
    expect(dienste[1]).toMatchObject({ id: 'werkstatt-dienst', ton: 'ok' });
  });

  it('bleibt leer, ohne eine Null zu erfinden, wenn beide Quellen fehlen', () => {
    expect(uebersichtDienste(null, null, NOW)).toEqual([]);
  });

  it('L1: fügt Optimierer, Preise und Messwerte VOR Tunnel- und Werkstatt-Dienst an', () => {
    const dienste = uebersichtDienste(null, null, NOW, {
      dienste: [
        { name: 'optimierer', zuletztAm: ago(120_000) },
        { name: 'preise', zuletztAm: null },
        { name: 'messwerte', zuletztAm: ago(10_000) },
      ],
    });
    expect(dienste.map((d) => d.id)).toEqual(['optimierer', 'preise', 'messwerte']);
    expect(dienste[1]).toMatchObject({ text: 'noch nie gemeldet', ton: 'warn' });
    expect(dienste[2].ton).toBe('ok');
  });
});

describe('uebersichtAuffaellig', () => {
  it('zeigt Pflege-Hinweise und abgelehnte Fassungen, aber keine Fehler-Box doppelt', () => {
    const zeilen = uebersichtAuffaellig(
      [site({ pflege: [{ code: 'kwp', label: 'Einspeisegrenze prüfen', detail: null }] })],
      [
        edgeRow({ externalRef: 'abgelehnt', stand: 'aktuell', fakten: { angefragt: { release: 'x', releaseSeq: 2, am: null, von: null }, angenommen: { stand: 'abgelehnt', am: null, grund: 'Speicher knapp' }, bestaetigt: { stand: 'offen', am: null, schritt: null, grund: null } } }),
        edgeRow({ externalRef: 'fehlerbox', stand: 'fehler', fakten: { angefragt: { release: 'x', releaseSeq: 2, am: null, von: null }, angenommen: { stand: 'abgelehnt', am: null, grund: 'x' }, bestaetigt: { stand: 'offen', am: null, schritt: null, grund: null } } }),
      ],
      NOW,
    );
    expect(zeilen).toHaveLength(2);
    expect(zeilen.some((z) => z.text.includes('Einspeisegrenze'))).toBe(true);
    expect(zeilen.some((z) => z.text.includes('Speicher knapp'))).toBe(true);
  });
});
