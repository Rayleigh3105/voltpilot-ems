import { describe, expect, it } from 'vitest';
import { LADEPUNKT_DAUERN, type ChargePoint, type ChargingBudget, type SiteCharging } from './ladepunkte';
import {
  SCHNELL_DAUER_VORGABE,
  schnellFolgenKarte,
  schnellFuerPrivatkunden,
  schnellZeilen,
} from './schnellLaden';
import { schnellZeileRelevant } from './ladeRegel';

/**
 * „Auto steckt · Jetzt schnell laden“ im Cockpit (Kapitän 07.11.2026, F3 b,
 * F4 a, F5 a): wann die Zeile erscheint - und vor allem, wann nicht.
 */
const NOW = Date.parse('2026-11-07T11:10:00Z');

const budget = (over: Partial<ChargingBudget> = {}): ChargingBudget => ({
  deviceId: 'box-1', enabled: true, controlEnabled: true, connectorCount: 1,
  gridLimitKw: 22, surplusActive: false, ...over,
} as ChargingBudget);

const saeule = (over: Partial<ChargePoint> = {}, con: Record<string, unknown> = {}): ChargePoint => ({
  deviceId: 'box-1', chargePointId: 'CP-GARAGE', label: 'Wallbox Garage', priority: false,
  connected: true, ready: true, lastSeen: '2026-11-07T11:09:50Z',
  quelle: { source: 'nur_sonne', minKw: null, storageRelease: false },
  connectors: [{
    connectorId: 1, status: 'SuspendedEVSE', charging: true, powerKw: 0, allocatedKw: 0,
    sessionSince: '2026-11-07T10:53:00Z', reason: 'kein_ueberschuss',
    reasonText: 'wartet — kein Überschuss (Ihre Priorität: Nur Sonnenstrom)', ...con,
  }],
  ...over,
});

const anlage = (chargers: ChargePoint[], b: ChargingBudget = budget()): SiteCharging => ({ budget: b, chargers } as SiteCharging);

const zeilen = (charging: SiteCharging, betriebsart: 'endkunde' | 'betreiber' | null = null, anzahl: number | null = null) =>
  schnellZeilen({ charging, betriebsart, ladepunktAnzahl: anzahl, nowMs: NOW });

describe('schnellZeilen', () => {
  it('bietet „Schnell“ an, wenn ein Auto auf „Nur Sonne“ wartet - auch bei einer Box, die die Bahn der Anlage nicht meldet', () => {
    const z = zeilen(anlage([saeule()]));
    expect(z).toHaveLength(1);
    expect(z[0]).toMatchObject({ name: 'Wallbox Garage', satz: 'Auto steckt · wartet auf Sonne', laeuft: false, chargePointId: 'CP-GARAGE', connectorId: 1 });
  });

  it('nennt eine laufende Ladung mit Leistung', () => {
    const z = zeilen(anlage([saeule({}, { status: 'Charging', powerKw: 3.2, allocatedKw: 3.2, reason: 'laedt', reasonText: 'lädt' })]));
    expect(z[0].satz).toBe('Auto steckt · lädt · 3,2 kW');
  });

  it('bietet den Rückweg an, solange „Schnell“ läuft', () => {
    const z = zeilen(anlage([saeule({}, { status: 'Charging', powerKw: 11, boost: true, reason: 'laedt' })]));
    expect(z[0]).toMatchObject({ laeuft: true, satz: 'Lädt schnell auf Ihren Wunsch · 11,0 kW' });
  });

  it('nennt bei einem Auto ohne Ladevorgang den Ausweg, ohne Knopf (Pilotanlage 07.11.2026)', () => {
    // Die Box im Feld schickt kein Wort dafür: SuspendedEVSE, charging falsch, keine Sitzung.
    const alt = zeilen(anlage([saeule({}, { charging: false, sessionSince: null, allocatedKw: null, reason: null, reasonText: null })]));
    expect(alt).toHaveLength(1);
    expect(alt[0]).toMatchObject({
      satz: 'Auto steckt · kein Ladevorgang',
      laeuft: false,
      hinweis: 'Die Wallbox hat für dieses Auto keinen Ladevorgang begonnen. Stecker kurz ziehen und wieder einstecken.',
    });
    // Eine neue Box nennt den Grund selbst - derselbe Satz.
    const neu = zeilen(anlage([saeule({}, {
      charging: false, sessionSince: null, allocatedKw: null, reason: 'kein_ladevorgang',
      reasonText: 'Die Wallbox hat für dieses Auto keinen Ladevorgang begonnen. Stecker kurz ziehen und wieder einstecken.',
    })]));
    expect(neu[0].hinweis).toMatch(/Stecker kurz ziehen und wieder einstecken/);
    // Mit laufendem Ladevorgang bleibt der Knopf.
    expect(zeilen(anlage([saeule()]))[0].hinweis).toBeNull();
  });

  it('bietet ohne laufenden Ladevorgang keinen Knopf an - dieselbe Regel wie der Server (charging)', () => {
    // Die Fixture von PR 1768 trägt charging: true; dasselbe Bild mit charging: false endete beim Server im 409.
    expect(zeilen(anlage([saeule({}, { charging: false })]))).toEqual([]);
  });

  it('lädt die Zeile nach, wo sie etwas zu sagen hat', () => {
    expect(schnellZeileRelevant(anlage([saeule()]))).toBe(true);
    expect(schnellZeileRelevant(anlage([saeule({}, { charging: false, sessionSince: null, allocatedKw: null, reason: null })]))).toBe(true);
    expect(schnellZeileRelevant(anlage([saeule({}, { status: 'Available', charging: false, sessionSince: null, allocatedKw: null, reason: null })]))).toBe(false);
    expect(schnellZeileRelevant(anlage([saeule({ connected: false })]))).toBe(false);
  });

  it('erscheint nicht ohne Auto', () => {
    expect(zeilen(anlage([saeule({}, { status: 'Available', charging: false, sessionSince: null, reason: null })]))).toEqual([]);
  });

  it('erscheint nicht, wo „Schnell“ nichts ändert', () => {
    // Das Auto nimmt nichts (voll oder Timer) …
    expect(zeilen(anlage([saeule({}, { status: 'SuspendedEV', reason: null })]))).toEqual([]);
    // … die Säule lädt ohnehin ohne Sonnen-Bahn …
    expect(zeilen(anlage([saeule({ quelle: { source: 'schnell', minKw: null, storageRelease: false } }, { status: 'Charging', powerKw: 11, reason: 'laedt' })]))).toEqual([]);
    // … oder der Kunde hat diese Ladung selbst pausiert.
    expect(zeilen(anlage([saeule({}, { reason: 'handeingriff' })]))).toEqual([]);
  });

  it('erscheint nicht, wo VoltPilot die Wallbox nicht regelt', () => {
    expect(zeilen(anlage([saeule({ connected: false })]))).toEqual([]);
    expect(zeilen(anlage([saeule()], budget({ controlEnabled: false })))).toEqual([]);
    expect(zeilen(anlage([saeule({ ready: false })]))).toEqual([]);
  });

  it('gilt nur für Privatkunden (F5 a)', () => {
    const zwei = anlage([saeule(), saeule({ chargePointId: 'CP-CARPORT', label: 'Carport' })]);
    expect(zeilen(zwei)).toHaveLength(2);
    expect(zeilen(zwei, 'endkunde', 6)).toHaveLength(2);
    expect(zeilen(zwei, 'betreiber', 2)).toEqual([]);
    expect(zeilen(zwei, null, 3)).toEqual([]);
    const drei = anlage([saeule(), saeule({ chargePointId: 'B' }), saeule({ chargePointId: 'C' })]);
    expect(zeilen(drei)).toEqual([]);
  });

  it('nennt bei zwei Steckern einer Säule den Stecker', () => {
    const cp = saeule();
    cp.connectors = [cp.connectors![0], { ...cp.connectors![0], connectorId: 2 }];
    expect(zeilen(anlage([cp])).map((z) => z.name)).toEqual(['Wallbox Garage · Stecker A', 'Wallbox Garage · Stecker B']);
  });
});

describe('schnellFuerPrivatkunden', () => {
  it('folgt der Unterscheidung der Navigation', () => {
    expect(schnellFuerPrivatkunden('endkunde', 10, null)).toBe(true);
    expect(schnellFuerPrivatkunden('betreiber', 1, null)).toBe(false);
    expect(schnellFuerPrivatkunden(null, 2, null)).toBe(true);
    expect(schnellFuerPrivatkunden(undefined, null, anlage([saeule()]))).toBe(true);
  });
});

describe('schnellFolgenKarte', () => {
  const abstecken = LADEPUNKT_DAUERN.find((d) => d.key === SCHNELL_DAUER_VORGABE)!;

  it('wählt „bis Abstecken, höchstens 14 Std“ vor (F4 a)', () => {
    expect(abstecken).toMatchObject({ minutes: null, label: 'bis Abstecken, höchstens 14 Std' });
  });

  it('spricht in den Wörtern des Reiters Laden und nennt nur die gemeldete Zahl', () => {
    const k = schnellFolgenKarte(budget(), abstecken, 0);
    expect(k.titel).toBe('Jetzt schnell laden');
    expect(k.bestaetigen).toBe('Schnell laden bis zum Abstecken');
    const text = k.bloecke.flatMap((b) => b.zeilen).join(' ');
    expect(text).toContain('Ihr Netzanschluss (22,0 kW) bleibt geschützt.');
    expect(text).toContain('spätestens nach 14 Stunden - danach wieder Smart.');
    expect(text).toContain('„Zurück zu Smart“ beendet es sofort.');
    expect(text).not.toMatch(/Automatik|anderen Ladepunkte/);
    expect(schnellFolgenKarte(budget({ gridLimitKw: null }), abstecken, 0).bloecke[2].zeilen[0]).toBe('Ihr Netzanschluss bleibt geschützt.');
  });

  it('nennt die anderen Ladepunkte nur, wo es welche gibt, und eine Dauer als Dauer', () => {
    const zweiStd = LADEPUNKT_DAUERN.find((d) => d.minutes === 120)!;
    const k = schnellFolgenKarte(budget(), zweiStd, 1);
    expect(k.bloecke[1].zeilen).toContain('Die anderen Ladepunkte teilen sich den Rest und können dadurch langsamer laden.');
    expect(k.bestaetigen).toBe(`Schnell laden - ${zweiStd.label}`);
    expect(k.bloecke[3].zeilen[0]).toBe(`Endet nach ${zweiStd.label}, beim Abstecken schon früher - danach wieder Smart.`);
  });
});
