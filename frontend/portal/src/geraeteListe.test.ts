import { describe, expect, it } from 'vitest';
import {
  filterGeraeteListe, geraeteListeLinien, geraeteListeZeilen, listeChipZahlen, LEERER_LISTE_FILTER,
} from './geraeteListe';
import type { AdminDeviceRow, PendingEnrollment } from './admin/adminApi';
import type { FleetRow } from './adminEdgeUpdates';
import type { WerkstattBox } from './werkstatt';

const now = new Date('2026-11-06T12:00:00Z');
const vor = (ms: number) => new Date(now.getTime() - ms).toISOString();

const fleetRow = (over: Partial<FleetRow> = {}): FleetRow => ({
  deviceId: 'd1', label: 'edge-a1', externalRef: 'edge-a1', siteId: 's1', siteName: 'Pilsting',
  tenantId: 't1', tenantName: 'Kunde A', ist: 'edge-2026.08.0', soll: 'edge-2026.08.0', sollSeq: 12,
  state: 'bestaetigt', reason: null, since: '2026-08-05T08:00:00Z', reportedAt: vor(10_000),
  rolloutId: null, lastSeenAt: vor(10_000), boxArt: 'docker', linie: 'docker',
  stand: 'aktuell', istRelease: 'edge-2026.08.0', releasesDahinter: 0, istSeit: null, fakten: null,
  ...over,
} as FleetRow);

const deviceRow = (over: Partial<AdminDeviceRow> = {}): AdminDeviceRow => ({
  deviceId: null, externalRef: 'VP-0001', label: null, siteId: null, siteName: null, tenantId: null,
  tenantName: null, kind: 'inverter', ist: null, soll: null, sollSeq: null, state: null, reason: null,
  blocker: null, lastSeenAt: null, reportedAt: null, provisioned: true, note: null,
  provisionedAt: vor(3600_000),
  ...over,
} as AdminDeviceRow);

const pending = (over: Partial<PendingEnrollment> = {}): PendingEnrollment => ({
  externalRef: 'edge-wartend', deviceInfo: null, csrUpdatedAt: vor(60_000), everIssued: false, issuedAt: null,
  ...over,
});

const werkstattBox = (over: Partial<WerkstattBox> = {}): WerkstattBox => ({
  id: 'w1', edgeRef: 'edge-werkstatt', boxArt: 'edge-light', lanNetz: null, schritte: {},
  notiz: null, angelegtAm: vor(7200_000), angelegtVon: 'admin', geaendertAm: vor(600_000), abnahmen: [],
  ...over,
});

describe('geraeteListeZeilen: eine Zeile je Box, jeder Lebensabschnitt genau einmal', () => {
  it('zeigt eine verbundene Box über boxZeile (dieselbe Wahrheit wie die Software-Seite)', () => {
    const zeilen = geraeteListeZeilen({ fleet: [fleetRow()], devices: [], pending: [], werkstattBoxen: [] }, now);
    expect(zeilen).toHaveLength(1);
    expect(zeilen[0].lebensabschnitt).toBe('verbunden');
  });

  it('zeigt eine wartende Anmeldung (meldet sich, kein Claim) als „wartet"', () => {
    const zeilen = geraeteListeZeilen({ fleet: [], devices: [], pending: [pending()], werkstattBoxen: [] }, now);
    expect(zeilen).toHaveLength(1);
    expect(zeilen[0]).toMatchObject({ lebensabschnitt: 'wartet', ref: 'edge-wartend' });
  });

  it('zeigt eine Werkstatt-Box, die noch nicht verbunden ist, als „werkstatt"', () => {
    const zeilen = geraeteListeZeilen({ fleet: [], devices: [], pending: [], werkstattBoxen: [werkstattBox()] }, now);
    expect(zeilen).toHaveLength(1);
    expect(zeilen[0]).toMatchObject({ lebensabschnitt: 'werkstatt', ref: 'edge-werkstatt' });
  });

  it('zeigt eine gedruckte, unverbundene Aufkleber-ID als „gedruckt"', () => {
    const zeilen = geraeteListeZeilen({ fleet: [], devices: [deviceRow()], pending: [], werkstattBoxen: [] }, now);
    expect(zeilen).toHaveLength(1);
    expect(zeilen[0]).toMatchObject({ lebensabschnitt: 'gedruckt', ref: 'VP-0001' });
  });

  it('zeigt jede Referenz GENAU EINMAL - verbunden schlägt wartet schlägt Werkstatt schlägt gedruckt', () => {
    const ref = 'edge-x1';
    const zeilen = geraeteListeZeilen({
      fleet: [fleetRow({ externalRef: ref, deviceId: 'dX' })],
      devices: [deviceRow({ externalRef: ref, provisioned: true })],
      pending: [pending({ externalRef: ref })],
      werkstattBoxen: [werkstattBox({ edgeRef: ref })],
    }, now);
    expect(zeilen).toHaveLength(1);
    expect(zeilen[0].lebensabschnitt).toBe('verbunden');
  });

  it('eine bereits verbundene Box, die früher durch die Werkstatt lief, bleibt „verbunden" (keine Dopplung)', () => {
    const ref = 'edge-y2';
    const zeilen = geraeteListeZeilen({
      fleet: [fleetRow({ externalRef: ref, deviceId: 'dY' })],
      devices: [],
      pending: [],
      werkstattBoxen: [werkstattBox({ edgeRef: ref })],
    }, now);
    expect(zeilen).toHaveLength(1);
    expect(zeilen[0].lebensabschnitt).toBe('verbunden');
  });

  it('ordnet: verbunden vor wartet vor Werkstatt vor gedruckt vor ausgebaut', () => {
    const zeilen = geraeteListeZeilen({
      fleet: [fleetRow()],
      devices: [deviceRow()],
      pending: [pending()],
      werkstattBoxen: [werkstattBox()],
      geraeteListe: [{ externalRef: 'edge-ausgebaut', lebensabschnitt: 'ausgebaut', seit: vor(1000), deviceId: null, siteId: null, tenantId: null, tenantName: null, name: null }],
    }, now);
    expect(zeilen.map((z) => z.lebensabschnitt)).toEqual(['verbunden', 'wartet', 'werkstatt', 'gedruckt', 'ausgebaut']);
  });

  it('L7: eine ausgebaute Box mit Aufkleber-Eintrag erscheint als „ausgebaut", nicht als „gedruckt"', () => {
    const ref = 'edge-z9';
    const zeilen = geraeteListeZeilen({
      fleet: [], devices: [deviceRow({ externalRef: ref })], pending: [], werkstattBoxen: [],
      geraeteListe: [{ externalRef: ref, lebensabschnitt: 'ausgebaut', seit: vor(1000), deviceId: null, siteId: null, tenantId: null, tenantName: null, name: null }],
    }, now);
    expect(zeilen).toHaveLength(1);
    expect(zeilen[0].lebensabschnitt).toBe('ausgebaut');
  });
});

describe('Chips und Filter: kein leerer Chip, Lebensabschnitte zusammen als „Ohne Kunde"', () => {
  it('zählt Chips nur mit Treffern > 0', () => {
    const zeilen = geraeteListeZeilen({ fleet: [fleetRow()], devices: [], pending: [], werkstattBoxen: [] }, now);
    const chips = listeChipZahlen(zeilen);
    expect(chips.every((c) => c.n > 0)).toBe(true);
    expect(chips.find((c) => c.chip === 'braucht')).toBeUndefined();
  });

  it('„Ohne Kunde" zählt gedruckte UND wartende Zeilen zusammen', () => {
    const zeilen = geraeteListeZeilen({
      fleet: [], devices: [deviceRow()], pending: [pending()], werkstattBoxen: [],
    }, now);
    const chips = listeChipZahlen(zeilen);
    expect(chips.find((c) => c.chip === 'ohne_kunde')?.n).toBe(2);
  });

  it('„Werkstatt" zählt nur die Werkstatt-Zeile', () => {
    const zeilen = geraeteListeZeilen({
      fleet: [fleetRow()], devices: [], pending: [], werkstattBoxen: [werkstattBox()],
    }, now);
    expect(listeChipZahlen(zeilen).find((c) => c.chip === 'werkstatt')?.n).toBe(1);
  });

  it('E6/S7: „Verzögert" zählt eine Box zwischen 45 Sekunden und 5 Minuten - getrennt von „Offline"', () => {
    const zeilen = geraeteListeZeilen({
      fleet: [fleetRow({ lastSeenAt: vor(2 * 60_000) })], devices: [], pending: [], werkstattBoxen: [],
    }, now);
    const chips = listeChipZahlen(zeilen);
    expect(chips.find((c) => c.chip === 'verzoegert')?.n).toBe(1);
    expect(chips.find((c) => c.chip === 'offline')).toBeUndefined();
  });

  it('filtert nach Chip und nach Suchtext', () => {
    const zeilen = geraeteListeZeilen({
      fleet: [fleetRow(), fleetRow({ externalRef: 'edge-b2', deviceId: 'd2', siteName: 'Auernheim', tenantName: 'Kunde A' })],
      devices: [deviceRow()],
      pending: [],
      werkstattBoxen: [],
    }, now);
    expect(filterGeraeteListe(zeilen, { ...LEERER_LISTE_FILTER, chip: 'gedruckt' })).toHaveLength(1);
    expect(filterGeraeteListe(zeilen, { ...LEERER_LISTE_FILTER, suche: 'auernheim' })).toHaveLength(1);
    expect(filterGeraeteListe(zeilen, { ...LEERER_LISTE_FILTER, suche: 'nirgendwo' })).toHaveLength(0);
  });

  it('zählt Linien nur über die verbundene Flotte - gedruckt/wartet/werkstatt tragen keine Linie', () => {
    const zeilen = geraeteListeZeilen({
      fleet: [fleetRow()], devices: [deviceRow()], pending: [], werkstattBoxen: [],
    }, now);
    const linien = geraeteListeLinien(zeilen);
    expect(linien.find((l) => l.wert === 'docker')?.n).toBe(1);
    expect(linien.find((l) => l.wert === 'alle')?.n).toBe(2);
  });
});
