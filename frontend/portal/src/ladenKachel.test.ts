import { describe, expect, it } from 'vitest';
import type { ChargePoint, ChargingBudget, SiteCharging } from './ladepunkte';
import { ladenKachel, VOLLE_ZEILEN } from './ladenKachel';

function saeule(over: Partial<ChargePoint> & { chargePointId: string }): ChargePoint {
  return {
    deviceId: 'd1',
    chargePointId: over.chargePointId,
    label: over.label ?? null,
    priority: false,
    connected: over.connected ?? true,
    ready: true,
    lastSeen: over.lastSeen ?? '2026-08-28T09:41:00Z',
    entityId: null,
    reportedAt: '2026-08-28T09:41:00Z',
    connectors: over.connectors ?? [],
  };
}

const BUDGET: ChargingBudget = {
  deviceId: 'd1',
  enabled: true,
  controlEnabled: true,
  gridLimitKw: 32,
  effLimitKw: 32,
  marginPct: 10,
  minPowerKw: 4.2,
  budgetKw: 22,
  allocatedKw: 22,
  measuredKw: 11,
  siteLoadKw: 12.2,
  siteGridKw: 12.2,
  budgetMode: 'gemessen',
  budgetNote: 'Das Budget folgt der Messung am Netzanschluss.',
  budgetBlind: false,
  connectorCount: 1,
};

const laedt = (id: string, kw: number | null, label?: string) =>
  saeule({
    chargePointId: id,
    label: label ?? id,
    connectors: [{
      connectorId: 1, status: 'Charging', charging: true, powerKw: kw,
      sessionSince: '2026-08-28T12:10:00Z',
    }],
  });

function k(chargers: ChargePoint[], budget: ChargingBudget | null = null) {
  return ladenKachel({ charging: { budget, chargers } as SiteCharging })!;
}

describe('ladenKachel · der Kopf sagt die Lage', () => {
  it('eine einzelne Ladung nennt ihre Leistung und ihre Geschichte', () => {
    const v = k([laedt('GARAGE-1', 11, 'Wallbox Garage')]);
    expect(v.kopf).toBe('Lädt · 11,0 kW');
    expect(v.unterzeile).toBe('Auto eingesteckt · seit 14:10');
    expect(v.ladenKw).toBe(11);
    expect(v.zeilen).toHaveLength(1);
  });

  it('mehrere Säulen zählen - und die Unterzeile sagt, was die anderen tun', () => {
    const v = k([
      laedt('P1', 11, 'Stellplatz 1'),
      laedt('P2', 11, 'Stellplatz 2'),
      saeule({ chargePointId: 'P3', label: 'Stellplatz 3', connectors: [{
        connectorId: 1, status: 'SuspendedEVSE', charging: true, allocatedKw: 0,
        reasonText: 'Budget vergeben' }] }),
      saeule({ chargePointId: 'P4', label: 'Stellplatz 4', connectors: [{
        connectorId: 1, status: 'Available', charging: false }] }),
    ]);
    expect(v.kopf).toBe('2 von 4 laden · 22,0 kW');
    expect(v.unterzeile).toBe('1 wartet · 1 frei');
    expect(v.ladend).toBe(2);
  });

  it('ohne Auto wird kein Auto behauptet', () => {
    const v = k([saeule({ chargePointId: 'P1', connectors: [{
      connectorId: 1, status: 'Available', charging: false }] })]);
    expect(v.kopf).toBe('Kein Auto eingesteckt');
    expect(v.ladenKw).toBeNull();
  });

  it('ein eingestecktes, aber wartendes Auto ist NICHT „kein Auto"', () => {
    const v = k([saeule({ chargePointId: 'P1', connectors: [{
      connectorId: 1, status: 'SuspendedEVSE', charging: true, allocatedKw: 0,
      reasonText: 'kein Überschuss (Ihre Priorität: Nur Sonnenstrom)' }] })]);
    expect(v.kopf).toBe('Eingesteckt · lädt gerade nicht');
    expect(v.zeilen[0].word).toBe('Eingesteckt · wartet');
    // Der Satz der Box reist unverändert mit.
    expect(v.zeilen[0].note).toBe('kein Überschuss (Ihre Priorität: Nur Sonnenstrom)');
  });

  it('lädt ohne Messwert: der Kopf SAGT die Lücke, statt sie zu füllen', () => {
    const v = k([laedt('GARAGE-1', null, 'Wallbox')]);
    expect(v.kopf).toBe('Lädt · Leistung nicht messbar');
    expect(v.ladenKw).toBeNull();
    expect(v.zeilen[0].kw).toBeNull();
  });

  it('sind ALLE Säulen getrennt, gibt es keine Aussage über Autos', () => {
    const v = k([
      saeule({ chargePointId: 'P1', connected: false, lastSeen: '2026-08-28T06:50:00Z',
        connectors: [{ connectorId: 1, status: 'Charging', charging: true, powerKw: 11 }] }),
      saeule({ chargePointId: 'P2', connected: false, lastSeen: '2026-08-28T06:50:00Z',
        connectors: [{ connectorId: 1, status: 'Available', charging: false }] }),
    ]);
    expect(v.kopf).toBe('Säulen getrennt');
    expect(v.unterzeile).toBe('2 getrennt');
    // …und ihre gemeldete Leistung wird NICHT als aktuell ausgegeben.
    expect(v.ladenKw).toBeNull();
    expect(v.zeilen.every((z) => z.kw == null)).toBe(true);
  });

  it('ohne Ladepunkt gibt es die Kachel gar nicht', () => {
    expect(ladenKachel({ charging: { budget: BUDGET, chargers: [] } })).toBeNull();
    expect(ladenKachel({ charging: null })).toBeNull();
  });
});

describe('ladenKachel · E6 · die Kachel ist keine Liste', () => {
  const viele = (n: number, ladend: number) =>
    Array.from({ length: n }, (_, i) =>
      i < ladend
        ? laedt(`P${i}`, 11, `Stellplatz ${i}`)
        : saeule({ chargePointId: `P${i}`, label: `Stellplatz ${i}`, connectors: [{
            connectorId: 1, status: 'Available', charging: false }] }));

  it(`bis ${VOLLE_ZEILEN} Zeilen steht jede voll da`, () => {
    const v = k(viele(VOLLE_ZEILEN, 2));
    expect(v.zeilen).toHaveLength(VOLLE_ZEILEN);
    expect(v.ruhendText).toBeNull();
  });

  it('ab der siebten bleiben die AKTIVEN voll und die Ruhenden kollabieren', () => {
    const v = k(viele(12, 6));
    expect(v.zeilen).toHaveLength(6);
    expect(v.zeilen.every((z) => z.word === 'Lädt')).toBe(true);
    expect(v.ruhendText).toBe('6 weitere laden gerade nicht');
    // Der Kopf zählt weiterhin ALLE - kollabiert heisst zusammengefasst.
    expect(v.kopf).toBe('6 von 12 laden · 66,0 kW');
  });

  it('sortiert Aktive zuerst nach Leistung, Getrennte zuletzt', () => {
    const v = k([
      saeule({ chargePointId: 'A', label: 'Getrennt', connected: false,
        connectors: [{ connectorId: 1, status: 'Available', charging: false }] }),
      saeule({ chargePointId: 'B', label: 'Frei', connectors: [{
        connectorId: 1, status: 'Available', charging: false }] }),
      laedt('C', 7, 'Sieben'),
      laedt('D', 11, 'Elf'),
      saeule({ chargePointId: 'E', label: 'Wartet', connectors: [{
        connectorId: 1, status: 'SuspendedEVSE', charging: true, allocatedKw: 0 }] }),
    ]);
    expect(v.zeilen.map((z) => z.label)).toEqual(['Elf', 'Sieben', 'Wartet', 'Frei', 'Getrennt']);
  });
});

describe('ladenKachel · die Fusszeile IST das Netzanschluss-Band', () => {
  it('trägt das Band, sobald ein Budget gemeldet ist', () => {
    const v = k([laedt('P1', 11)], BUDGET);
    expect(v.band).not.toBeNull();
    expect(v.band!.headline).not.toBeNull();
    expect(v.band!.sourceLine).toBe('Das Budget folgt der Messung am Netzanschluss.');
  });

  it('ohne gemeldetes Budget gibt es KEINE Fusszeile - nie eine erfundene 0', () => {
    const v = k([laedt('P1', 11)]);
    expect(v.band).toBeNull();
  });
});

describe('ladenKachel · Sprünge und Namen', () => {
  it('verlinkt Kopf und Zeilen nur, wenn es ein Ziel gibt', () => {
    const ohne = k([laedt('P1', 11)]);
    expect(ohne.href).toBeNull();
    expect(ohne.zeilen[0].href).toBeNull();

    const mit = ladenKachel({
      charging: { budget: null, chargers: [laedt('P1', 11, 'Wallbox')] },
      links: { uebersicht: () => '#/anlage/s/ladevorgaenge', charger: (id) => `#/g/${id}` },
    })!;
    expect(mit.href).toBe('#/anlage/s/ladevorgaenge');
    expect(mit.zeilen[0].href).toBe('#/g/P1');
  });

  it('nennt den Stecker nur, wo es mehrere gibt', () => {
    const eins = k([laedt('P1', 11, 'Wallbox Garage')]);
    expect(eins.zeilen[0].label).toBe('Wallbox Garage');
    const zwei = k([saeule({ chargePointId: 'P1', label: 'Doppel', connectors: [
      { connectorId: 1, status: 'Charging', charging: true, powerKw: 11 },
      { connectorId: 2, status: 'Available', charging: false },
    ] })]);
    expect(zwei.zeilen.map((z) => z.label)).toEqual(['Doppel · Stecker A', 'Doppel · Stecker B']);
  });

  it('eine Säule ohne gemeldeten Stecker behauptet kein „kein Auto"', () => {
    const v = k([saeule({ chargePointId: 'NEU', label: 'Neue Säule', connectors: [] })]);
    expect(v.zeilen[0].word).toBe('Noch kein Stecker gemeldet');
    expect(v.kopf).toBe('Kein Auto eingesteckt');
  });
});
