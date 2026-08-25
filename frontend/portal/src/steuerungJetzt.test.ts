import { describe, expect, it } from 'vitest';
import type { ControlStatus, CurtailmentStatus, ScheduleSlot } from './api';
import type { Consumer } from './consumers/types';
import type { ConsumerRuntimeStatus } from './consumers/status';
import type { ManualOverride } from './consumers/fulfillment';
import type { SiteCharging } from './ladepunkte';
import {
  GERAET_NICHT_FREIGEGEBEN,
  GERAET_NICHT_VERBUNDEN,
  JETZT_LEER,
  LADEPARK_KEIN_EINGRIFF,
  geraetZeile,
  jetztBanner,
  jetztZone,
  ladeparkZeile,
  restZeit,
  speicherZeile,
  speicherZustand,
  uhrzeit,
} from './steuerungJetzt';

const NOW = new Date('2026-08-25T12:30:00Z');

function slot(over: Partial<ScheduleSlot> = {}): ScheduleSlot {
  return {
    start: '2026-08-25T12:30:00Z',
    batteryKw: 3.2,
    gridKw: 0,
    socPct: 64,
    priceEurMwh: 40,
    costEur: 0,
    baselineCostEur: 0,
    curtailKw: null,
    pvKw: 5.8,
    loadKw: 1.3,
    slotRole: 'pv_speichern',
    slotFlags: null,
    storedValueCtKwh: 18.9,
    gridValueCtKwh: null,
    peakPressureEurKw: null,
    importPriceCtKwh: 32.5,
    exportValueCtKwh: 8.1,
    importPriceSource: 'preisblatt',
    ...over,
  } as ScheduleSlot;
}

function control(over: Partial<ControlStatus> = {}): ControlStatus {
  return {
    deviceId: 'd-1',
    commandedKw: 3.2,
    confirmedKw: 3.2,
    allMatch: true,
    controlEnabled: true,
    certified: true,
    mismatchRoles: null,
    slotStart: '2026-08-25T12:30:00Z',
    checkedAt: '2026-08-25T12:29:50Z',
    ...over,
  } as ControlStatus;
}

function consumer(over: Partial<Consumer> = {}): Consumer {
  return {
    id: 'c-rod',
    type: 'heating-rod',
    typeLabel: 'Heizstab',
    name: 'Heizstab Keller',
    controlKind: 'on_off',
    ratedPowerKw: 4,
    minPowerKw: null,
    levelsKw: null,
    resolutionKw: null,
    powerRangesKw: null,
    storageRelation: 'consumer_first',
    defaultGridEnergyPolicy: 'allow',
    allowStorageDischarge: false,
    failsafe: 'off',
    enabled: true,
    version: 1,
    connection: 'connected',
    edgeSourceId: 'src-1',
    controlActivation: 'active',
    hasDraftPolicy: true,
    draftPolicyVersion: 1,
    ...over,
  } as Consumer;
}

function status(over: Partial<ConsumerRuntimeStatus> = {}): ConsumerRuntimeStatus {
  return {
    entityId: 'c-rod',
    state: 'running_optimized',
    reasonCode: null,
    actualKw: 3.0,
    confirmed: true,
    ...over,
  } as ConsumerRuntimeStatus;
}

describe('Zone ① Jetzt — die Zeit-Bausteine', () => {
  it('rechnet die Restzeit als Countdown und schweigt, sobald sie abgelaufen ist', () => {
    expect(restZeit('2026-08-25T13:42:00Z', NOW)).toBe('noch 1 Std. 12 Min.');
    expect(restZeit('2026-08-25T12:45:00Z', NOW)).toBe('noch 15 Min.');
    expect(restZeit('2026-08-25T14:30:00Z', NOW)).toBe('noch 2 Std.');
    // Abgelaufen ist KEIN Handeingriff mehr - und kein negativer Countdown.
    expect(restZeit('2026-08-25T12:00:00Z', NOW)).toBeNull();
  });

  it('erfindet aus einem unlesbaren Stempel weder Uhrzeit noch Countdown', () => {
    expect(restZeit('unfug', NOW)).toBeNull();
    expect(restZeit(null, NOW)).toBeNull();
    expect(uhrzeit('unfug')).toBeNull();
    expect(uhrzeit(undefined)).toBeNull();
  });
});

describe('Zone ① Jetzt — die Speicher-Zeile', () => {
  it('nennt Zustand, Richtung als WORT und den Fahrplan als Quelle', () => {
    const z = speicherZeile({
      control: control(), expectControl: true, slots: [slot()],
      plantKind: 'eigenverbrauch', now: NOW,
    });
    expect(z).not.toBeNull();
    expect(z!.zustand).toContain('lädt');
    expect(z!.zustand).toContain('3,2');
    // Nie ein Vorzeichen - die Richtung ist ein Wort.
    expect(z!.zustand).not.toContain('-3,2');
    expect(z!.quelle).toBe('fahrplan');
    expect(z!.quelleText).toBe('Fahrplan');
    expect(z!.grund).toBeTruthy();
  });

  it('sagt „entlädt" bzw. „pausiert" — und pausiert im Totband', () => {
    expect(speicherZustand(-4)).toContain('entlädt');
    expect(speicherZustand(0)).toBe('pausiert');
    expect(speicherZustand(0.02)).toBe('pausiert');
    expect(speicherZustand(null)).toBe('pausiert');
  });

  it('bietet seit Stufe 4 beide Speicher-Eingriffe an', () => {
    const z = speicherZeile({
      control: control(), expectControl: true, slots: [slot()],
      plantKind: 'eigenverbrauch', now: NOW,
    });
    expect(z!.aktionen).toEqual(['speicher_laden', 'speicher_halten']);
    expect(z!.keinEingriff).toBeNull();
  });

  it('⚠ ohne belegte Steuerbarkeit steht der GRUND statt eines Knopfes', () => {
    const z = speicherZeile({
      control: control(), expectControl: true, slots: [slot()],
      plantKind: 'eigenverbrauch', steuerbar: false, now: NOW,
    });
    expect(z!.aktionen).toEqual([]);
    expect(z!.keinEingriff).toContain('steuert diesen Speicher noch nicht');
  });

  it('ein laufender Eingriff IST die Quelle und bietet nur den Rückweg', () => {
    const z = speicherZeile({
      control: control(), expectControl: true, slots: [slot()],
      plantKind: 'eigenverbrauch', now: NOW,
      // Die Regel wäre sonst die Quelle - der Handeingriff schlägt sie.
      regelHaeltAn: true,
      eingriff: {
        kind: 'speicher_halten', entityId: 'e-batt', targetValueKw: 0,
        endsAt: new Date(NOW.getTime() + 90 * 60_000).toISOString(),
        createdBy: null, createdAt: NOW.toISOString(),
      },
    });
    expect(z!.quelle).toBe('handeingriff');
    expect(z!.quelleText).toContain('Handeingriff bis');
    expect(z!.bis).toBeTruthy();
    expect(z!.aktionen).toEqual(['resume']);
  });

  it('während einer ANLAGEN-Pause greift man nicht einzeln ein', () => {
    const z = speicherZeile({
      control: control(), expectControl: true, slots: [slot()],
      plantKind: 'eigenverbrauch', pausiert: true, now: NOW,
    });
    expect(z!.aktionen).toEqual([]);
    expect(z!.keinEingriff).toContain('pausiert gerade');
  });

  it('nennt die Regel als Quelle NUR, wenn der Aufrufer sie belegt', () => {
    const ohne = speicherZeile({
      control: control(), expectControl: true, slots: [slot()],
      plantKind: 'eigenverbrauch', now: NOW,
    });
    expect(ohne!.quelle).toBe('fahrplan');
    const mit = speicherZeile({
      control: control(), expectControl: true, slots: [slot()],
      plantKind: 'eigenverbrauch', regelHaeltAn: true, now: NOW,
    });
    expect(mit!.quelle).toBe('regel');
    expect(mit!.quelleText).toBe('Ihre Regel');
  });

  it('entsteht GAR NICHT, solange nichts über den Speicher belegt ist', () => {
    expect(speicherZeile({
      control: null, expectControl: false, plantKind: 'eigenverbrauch', now: NOW,
    })).toBeNull();
  });

  it('behauptet ohne tragendes Rücklesen KEINE Zahl, sondern den ehrlichen Satz', () => {
    const z = speicherZeile({
      control: control({ certified: false }), expectControl: true, slots: [slot()],
      plantKind: 'eigenverbrauch', now: NOW,
    });
    expect(z).not.toBeNull();
    expect(z!.zustand).not.toMatch(/\d,\d\s*kW/);
    expect(z!.ton).toBe('off');
  });

  it('reicht die Abregel-Beleglage nur dem laufenden Abregel-Slot durch', () => {
    const curtail = {
      deviceId: 'd-1', units: 2, certifiedUnits: 0, controlEnabled: true,
      active: true, appliedCapKw: 0, allMatch: null, possibleOverride: false,
      checkedAt: '2026-08-25T12:29:50Z',
    } as CurtailmentStatus;
    // Ein NICHT abregelnder Slot bekommt den Beleg nicht (er erzählte sonst
    // die Geschichte eines anderen Slots).
    const a = speicherZeile({
      control: control(), expectControl: true, slots: [slot()], curtail,
      plantKind: 'eigenverbrauch', now: NOW,
    });
    const b = speicherZeile({
      control: control(), expectControl: true, slots: [slot()],
      plantKind: 'eigenverbrauch', now: NOW,
    });
    expect(a!.grund).toBe(b!.grund);
  });
});

describe('Zone ① Jetzt — die Geräte-Zeile', () => {
  it('nennt Zustand + gemessene Leistung und die Regel als Quelle', () => {
    const z = geraetZeile({ consumer: consumer(), status: status(), anyStatusReported: true }, NOW);
    expect(z.name).toBe('Heizstab Keller');
    expect(z.zustand).toContain('3,0');
    expect(z.quelle).toBe('regel');
    expect(z.entityId).toBe('c-rod');
  });

  it('erfindet ohne gemessene Leistung KEINE 0', () => {
    const z = geraetZeile(
      { consumer: consumer(), status: status({ actualKw: null }), anyStatusReported: true },
      NOW,
    );
    expect(z.zustand).not.toMatch(/0,0\s*kW/);
  });

  it('behauptet ohne EINEN gemeldeten Zustand nichts über den Betrieb', () => {
    const z = geraetZeile({ consumer: consumer(), anyStatusReported: false }, NOW);
    expect(z.ton).toBe('off');
    expect(z.quelle).toBe('regel'); // die Aktivierung ist ein Server-Fakt
  });

  it('lässt den Handeingriff die Regel als Quelle schlagen und zeigt sein Ende', () => {
    const ov: ManualOverride = {
      entityId: 'c-rod', kind: 'start', targetCommand: 'on_off',
      endsAt: '2026-08-25T13:42:00Z',
    };
    const z = geraetZeile(
      { consumer: consumer(), status: status(), override: ov, anyStatusReported: true },
      NOW,
    );
    expect(z.quelle).toBe('handeingriff');
    expect(z.quelleText).toContain('Handeingriff bis');
    expect(z.bis).toBe('noch 1 Std. 12 Min.');
    expect(z.ton).toBe('warn');
    // Solange einer läuft, ist der einzige Ausweg „Automatik fortsetzen".
    expect(z.aktionen).toEqual(['resume']);
  });

  it('ein ABGELAUFENER Handeingriff ist keiner mehr', () => {
    const ov: ManualOverride = {
      entityId: 'c-rod', kind: 'start', targetCommand: 'on_off',
      endsAt: '2026-08-25T12:00:00Z',
    };
    const z = geraetZeile(
      { consumer: consumer(), status: status(), override: ov, anyStatusReported: true },
      NOW,
    );
    expect(z.quelle).toBe('regel');
    expect(z.bis).toBeNull();
    expect(z.aktionen).toEqual(['start', 'stop']);
  });

  it('bietet keinem unerreichbaren Gerät einen Knopf an — und nennt den Grund', () => {
    const weg = geraetZeile(
      { consumer: consumer({ connection: 'disconnected' }), anyStatusReported: true }, NOW,
    );
    expect(weg.aktionen).toEqual([]);
    expect(weg.keinEingriff).toBe(GERAET_NICHT_VERBUNDEN);

    const ohneFreigabe = geraetZeile(
      { consumer: consumer({ controlActivation: 'not_activated' }), anyStatusReported: true }, NOW,
    );
    expect(ohneFreigabe.aktionen).toEqual([]);
    expect(ohneFreigabe.keinEingriff).toBe(GERAET_NICHT_FREIGEGEBEN);
  });

  it('wiederholt einen Grund nicht, der wörtlich der Zustand ist', () => {
    const z = geraetZeile(
      { consumer: consumer(), status: status({ state: 'offline', actualKw: null }), anyStatusReported: true },
      NOW,
    );
    if (z.grund) expect(z.grund).not.toBe(z.zustand);
  });
});

describe('Zone ① Jetzt — die Ladepark-Zeile', () => {
  function charging(over: Partial<SiteCharging> = {}): SiteCharging {
    return {
      budget: {
        deviceId: 'd-1', enabled: true, controlEnabled: true,
        gridLimitKw: 30, effLimitKw: 30, measuredKw: 22, siteLoadKw: 0,
        connectorCount: 2,
      },
      chargers: [
        {
          deviceId: 'd-1', chargePointId: 'CP1', label: 'Säule Hof', priority: false,
          connected: true, ready: true,
          connectors: [
            { connectorId: 1, charging: true },
            { connectorId: 2, charging: true },
          ],
        },
      ],
      ...over,
    } as SiteCharging;
  }

  it('zählt die ladenden Fahrzeuge und reicht die Budget-Zahl durch', () => {
    const z = ladeparkZeile(charging());
    expect(z!.zustand).toBe('2 Fahrzeuge laden');
    expect(z!.grund).toContain('Budget');
    // Die Zahl kommt WÖRTLICH aus `budgetBand.headline` — hier wird nichts
    // zweitgerechnet, also auch nicht anders gerundet.
    expect(z!.grund).toContain('30');
  });

  it('behauptet ohne hinterlegte Grenze KEINE Budget-Zahl', () => {
    const z = ladeparkZeile(charging({ budget: null }));
    expect(z!.grund).toBeNull();
  });

  it('ist rein lesend und sagt das', () => {
    const z = ladeparkZeile(charging());
    expect(z!.aktionen).toEqual([]);
    expect(z!.keinEingriff).toBe(LADEPARK_KEIN_EINGRIFF);
  });

  it('entsteht ohne Ladepunkt gar nicht', () => {
    expect(ladeparkZeile(null)).toBeNull();
    expect(ladeparkZeile({ budget: null, chargers: [] } as unknown as SiteCharging)).toBeNull();
  });
});

describe('Zone ① Jetzt — Banner und Leer-Zustand', () => {
  it('nennt im Banner Gerät, Ende als Uhrzeit UND Countdown', () => {
    const ov: ManualOverride = {
      entityId: 'c-rod', kind: 'start', targetCommand: 'on_off',
      endsAt: '2026-08-25T13:42:00Z',
    };
    const b = jetztBanner([ov], { 'c-rod': 'Heizstab Keller' }, NOW);
    expect(b!.text).toContain('Heizstab Keller');
    expect(b!.text).toContain('an bis');
    expect(b!.text).toContain('noch 1 Std. 12 Min.');
    expect(b!.aktion).toBe('Automatik fortsetzen');
    expect(b!.entityId).toBe('c-rod');
  });

  it('zeigt keinen Banner für einen abgelaufenen Handeingriff', () => {
    const ov: ManualOverride = {
      entityId: 'c-rod', kind: 'stop', targetCommand: 'on_off',
      endsAt: '2026-08-25T12:00:00Z',
    };
    expect(jetztBanner([ov], {}, NOW)).toBeNull();
    expect(jetztBanner(null, {}, NOW)).toBeNull();
  });

  it('gibt einer Anlage OHNE Steuerbares keine Zeile, sondern den Weg', () => {
    const v = jetztZone({ now: NOW });
    expect(v.zeilen).toEqual([]);
    expect(v.leer).toBe(JETZT_LEER);
    expect(v.banner).toBeNull();
  });

  it('setzt die Zeilen in der Reihenfolge Speicher → Geräte → Ladepunkte', () => {
    const v = jetztZone({
      speicher: {
        control: control(), expectControl: true, slots: [slot()],
        plantKind: 'eigenverbrauch', now: NOW,
      },
      geraete: [{ consumer: consumer(), status: status(), anyStatusReported: true }],
      charging: {
        budget: null,
        chargers: [{
          deviceId: 'd-1', chargePointId: 'CP1', priority: false, connected: true,
          ready: true, connectors: [{ connectorId: 1, charging: false }],
        }],
      } as unknown as SiteCharging,
      now: NOW,
    });
    expect(v.zeilen.map((z) => z.art)).toEqual(['speicher', 'geraet', 'ladepark']);
    expect(v.leer).toBeNull();
  });
});
