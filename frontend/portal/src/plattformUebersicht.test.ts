import { describe, expect, it } from 'vitest';
import type { AdminFleetSite } from './admin/fleetApi';
import type { FleetRow as EdgeFleetRow } from './adminEdgeUpdates';
import type { PendingEnrollment } from './admin/adminApi';
import type { FernwartungBox, FernwartungUebersicht } from './adminFernwartung';
import type { WerkstattDienst } from './werkstattBank';
import {
  uebersichtAuffaellig,
  uebersichtBrauchtDich,
  uebersichtDienste,
  uebersichtFlottenbild,
  uebersichtKacheln,
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
    const k = uebersichtKacheln({ sites: [site()], releases: [], edgeLines: [], edgeKpi: { known: 1, upToDate: 1, unknown: 0, inRollout: 0, failed: 0, newestRelease: null } }, NOW);
    const verbindung = k.find((x) => x.id === 'verbindung')!;
    expect(verbindung.zahl).toBe(0);
    expect(verbindung.ton).toBe('ok');
    expect(verbindung.wort).toContain('Alle 1 verbunden');
  });

  it('zählt Boxen, die sich nicht melden, als Ausnahme', () => {
    const k = uebersichtKacheln({
      sites: [site({ boxes: [{ deviceId: 'd1', externalRef: 'VP-BOX-0001', name: 'Box A', fuehrtAnlage: true, lastSeenAt: ago(3600_000), edge: null, update: null }] })],
      releases: [], edgeLines: [], edgeKpi: { known: 0, upToDate: 0, unknown: 0, inRollout: 0, failed: 0, newestRelease: null },
    }, NOW);
    const verbindung = k.find((x) => x.id === 'verbindung')!;
    expect(verbindung.zahl).toBe(1);
    expect(verbindung.ton).toBe('warn');
  });

  it('die Software-Kachel zählt „bekannt minus aktuell", je Linie aufgeschlüsselt', () => {
    const k = uebersichtKacheln({
      sites: [], releases: [],
      edgeLines: [{ boxArt: 'docker', newestRelease: 'edge-2026.09.0', newestReleaseSeq: 2, devices: 4, known: 4, upToDate: 2 }],
      edgeKpi: { known: 4, upToDate: 2, unknown: 0, inRollout: 1, failed: 0, newestRelease: 'edge-2026.09.0' },
    }, NOW);
    const software = k.find((x) => x.id === 'software')!;
    expect(software.zahl).toBe(2);
    expect(software.kontext).toContain('1 laufen');
    expect(software.kontext).toContain('Docker-Box 2 älter');
  });

  it('die Plan-Kachel nennt den jüngsten Lauf über die ganze Flotte', () => {
    const k = uebersichtKacheln({
      sites: [site({ lastPlanGeneratedAt: ago(3 * 3600_000) }), site({ siteId: 's2', lastPlanGeneratedAt: ago(5 * 60_000) })],
      releases: [], edgeLines: [], edgeKpi: { known: 0, upToDate: 0, unknown: 0, inRollout: 0, failed: 0, newestRelease: null },
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

describe('uebersichtFlottenbild', () => {
  it('gruppiert nach Kunde und setzt gestörte Gruppen zuerst', () => {
    const groups = fleetBoxGroups([
      site({ siteId: 's1', tenantName: 'Ruhiger Kunde' }),
      site({
        siteId: 's2', tenantName: 'Gestörter Kunde',
        boxes: [{ deviceId: 'd2', externalRef: 'VP-BOX-0002', name: 'Box B', fuehrtAnlage: true, lastSeenAt: ago(3600_000), edge: null, update: null }],
      }),
    ], NOW);
    const bild = uebersichtFlottenbild(groups, []);
    expect(bild.map((g) => g.kunde)).toEqual(['Gestörter Kunde', 'Ruhiger Kunde']);
    expect(bild[0].felder[0].ton).toBe('aus');
    expect(bild[1].felder[0].ton).toBe('ok');
  });

  it('markiert eine laufende Aktualisierung als „lauf", auch wenn die Verbindung steht', () => {
    const groups = fleetBoxGroups([site()], NOW);
    const bild = uebersichtFlottenbild(groups, [edgeRow({ stand: 'laeuft' })]);
    expect(bild[0].felder[0].ton).toBe('lauf');
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
