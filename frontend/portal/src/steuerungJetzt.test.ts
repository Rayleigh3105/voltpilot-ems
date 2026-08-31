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
  LADEPUNKTE_ALLE_BIS,
  LADEPUNKT_BANNER_ID,
  PAUSE_BANNER_ID,
  geraetZeile,
  jetztBanner,
  jetztZone,
  ladepunktName,
  ladepunktZeilen,
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

describe('Zone ① Jetzt — eine Zeile je LADEPUNKT (Verbrauchsmanagement v1 §6.2)', () => {
  function saeule(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      deviceId: 'd-1', chargePointId: 'CP1', label: 'Wallbox Garage', priority: false,
      connected: true, ready: true, entityId: 'e-1',
      connectors: [{ connectorId: 1, status: 'Charging', charging: true, powerKw: 7.4 }],
      ...over,
    };
  }

  function charging(chargers: Record<string, unknown>[]): SiteCharging {
    return { budget: null, chargers } as unknown as SiteCharging;
  }

  it('nennt Name, Zustand mit Leistung und die übergebene Steuerart', () => {
    const { zeilen } = ladepunktZeilen(charging([saeule()]), () => 'Überschuss (Sonne zuerst)');
    expect(zeilen).toHaveLength(1);
    expect(zeilen[0].art).toBe('ladepunkt');
    expect(zeilen[0].name).toBe('Wallbox Garage');
    expect(zeilen[0].zustand).toBe('lädt 7,4\u00a0kW');
    expect(zeilen[0].quelleText).toBe('Überschuss (Sonne zuerst)');
    expect(zeilen[0].quelle).toBe('steuerart');
    // Der Schlüssel des Boost-Auftrags (P3a) reist an der Zeile mit.
    expect(zeilen[0].ladepunkt).toEqual({
      chargePointId: 'CP1', connectorId: 1, name: 'Wallbox Garage', eingriff: null,
    });
  });

  it('sagt ohne Auto den GRUND und behauptet keine Quelle', () => {
    const frei = saeule({ connectors: [{ connectorId: 1, status: 'Available', charging: false }] });
    const { zeilen } = ladepunktZeilen(charging([frei]), () => 'Überschuss');
    expect(zeilen[0].zustand).toBe('kein Auto eingesteckt');
    // Wo nichts lädt, steuert auch nichts - eine Quelle wäre eine Aussage
    // über einen Ladevorgang, den es nicht gibt.
    expect(zeilen[0].quelleText).toBeNull();
    expect(zeilen[0].quelle).toBe('unbekannt');
  });

  it('behauptet für eine GETRENNTE Säule GAR NICHTS', () => {
    // ⚠ Sie bekommt keine Zeile: was sie tut, wissen wir gerade nicht, und ihr
    // Zustand steht auf ihrer Komponenten-Karte (P3a).
    const { zeilen, weitere } = ladepunktZeilen(
      charging([saeule({ connected: false })]), () => 'Sofort',
    );
    expect(zeilen).toEqual([]);
    // Sie zählt auch nicht als „ohne Auto" - das wäre eine Aussage über sie.
    expect(weitere).toBeNull();
  });

  it('nennt bei MEHREREN Steckern den Stecker, bei einem nur die Säule', () => {
    const zwei = saeule({
      connectors: [
        { connectorId: 1, status: 'Charging', charging: true, powerKw: 7.4 },
        { connectorId: 2, status: 'Available', charging: false },
      ],
    });
    const { zeilen } = ladepunktZeilen(charging([zwei]));
    expect(zeilen).toHaveLength(2);
    expect(zeilen[0].name).toBe('Wallbox Garage · Stecker A');
    expect(zeilen[1].name).toBe('Wallbox Garage · Stecker B');
  });

  it('ohne Steuerart bleibt die Quelle ehrlich leer', () => {
    const { zeilen } = ladepunktZeilen(charging([saeule()]));
    expect(zeilen[0].quelleText).toBeNull();
    expect(zeilen[0].quelle).toBe('unbekannt');
  });

  it('ein VERALTETER Messwert liest nie als aktuelle Leistung', () => {
    // ⚠ Die Regel wohnt in `ladepunkte.ladeZustand`/`aktuelleLeistung` und
    // wird hier nur konsumiert: ein stehengebliebenes Kilowatt wird ein
    // eigener ZUSTAND, nie eine Zahl, die aktuell aussieht.
    const alt = saeule({
      connectors: [{
        connectorId: 1, status: 'Charging', charging: true, powerKw: 7.4,
        meteredAt: '2026-08-25T11:00:00Z',
      }],
    });
    const { zeilen } = ladepunktZeilen(charging([alt]), undefined, NOW.getTime());
    expect(zeilen[0].zustand).toBe('lädt — Leistung nicht messbar');
    expect(zeilen[0].zustand).not.toContain('7,4');
  });

  it('zeigt bei einem grossen Ladepark nur die mit Auto — und ZÄHLT den Rest', () => {
    const mitAuto = saeule({ chargePointId: 'CP0', entityId: 'e-0' });
    const ohne = Array.from({ length: LADEPUNKTE_ALLE_BIS }, (_, i) => saeule({
      chargePointId: `CPx${i}`, entityId: `e-x${i}`,
      connectors: [{ connectorId: 1, status: 'Available', charging: false }],
    }));
    const { zeilen, weitere } = ladepunktZeilen(charging([mitAuto, ...ohne]));
    expect(zeilen).toHaveLength(1);
    expect(zeilen[0].ladepunkt?.chargePointId).toBe('CP0');
    expect(weitere).toBe(`${LADEPUNKTE_ALLE_BIS} weitere Ladepunkte ohne Auto`);
  });

  it('bis zur Grenze steht JEDER Ladepunkt einzeln — auch ein freier', () => {
    const frei = Array.from({ length: LADEPUNKTE_ALLE_BIS }, (_, i) => saeule({
      chargePointId: `CP${i}`, entityId: `e-${i}`,
      connectors: [{ connectorId: 1, status: 'Available', charging: false }],
    }));
    const { zeilen, weitere } = ladepunktZeilen(charging(frei));
    expect(zeilen).toHaveLength(LADEPUNKTE_ALLE_BIS);
    expect(weitere).toBeNull();
  });

  it('entsteht ohne Ladepunkt gar nicht', () => {
    expect(ladepunktZeilen(null).zeilen).toEqual([]);
    expect(ladepunktZeilen(charging([])).zeilen).toEqual([]);
    expect(ladepunktZeilen(null).weitere).toBeNull();
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
    // P1: die Sammelzeile ist entfallen, jede Ladung steht als eigene Zeile.
    expect(v.zeilen.map((z) => z.art)).toEqual(['speicher', 'geraet', 'ladepunkt']);
    expect(v.leer).toBeNull();
  });

  it('zeigt einen Ladepunkt GENAU EINMAL, auch wenn er ein Verbraucher-Profil traegt', () => {
    // Eine Entitaet, die BEIDES ist: gemeldeter Ladepunkt UND Verbraucher-Profil.
    // Zwei Zeilen waeren zwei Wahrheiten ueber dieselbe Saeule.
    const v = jetztZone({
      geraete: [
        { consumer: consumer({ id: 'e-cp', name: 'Carport' }), status: status(), anyStatusReported: true },
        { consumer: consumer(), status: status(), anyStatusReported: true },
      ],
      charging: {
        budget: null,
        chargers: [{
          deviceId: 'd-1', chargePointId: 'CP1', label: 'Carport', priority: false,
          connected: true, ready: true, entityId: 'e-cp',
          connectors: [{ connectorId: 1, status: 'Charging', charging: true, powerKw: 7.4 }],
        }],
      } as unknown as SiteCharging,
      now: NOW,
    });
    expect(v.zeilen.filter((z) => z.entityId === 'e-cp')).toHaveLength(1);
    expect(v.zeilen.find((z) => z.entityId === 'e-cp')!.art).toBe('ladepunkt');
    // Der andere Verbraucher bleibt unangetastet.
    expect(v.zeilen.some((z) => z.art === 'geraet' && z.entityId === 'c-rod')).toBe(true);
  });
});

/**
 * Zone ① — die ZEILE JE LADEPUNKT (Verbrauchsmanagement v1, P3a). Sie ist der
 * Ort, an dem „Jetzt voll laden" endlich steht, wo eingegriffen wird.
 */
describe('Zone ① Jetzt — Ladepunkt-Zeilen (P3a)', () => {
  const charging = (over: Record<string, unknown> = {}, con: Record<string, unknown> = {}) => ({
    budget: {
      deviceId: 'd-1', enabled: true, controlEnabled: true, connectorCount: 1,
      surplusActive: true, gridLimitKw: 32, ...over,
    },
    chargers: [{
      deviceId: 'd-1', chargePointId: 'CP1', label: 'Wallbox Garage', priority: false,
      connected: true, ready: true,
      connectors: [{
        connectorId: 1, charging: true, status: 'Charging', powerKw: 7.4, ...con,
      }],
    }],
  } as unknown as SiteCharging);

  it('macht aus einer laufenden Ladung eine eigene Zeile mit „Eingreifen"', () => {
    const [z] = ladepunktZeilen(charging()).zeilen;
    expect(z.art).toBe('ladepunkt');
    expect(z.name).toBe('Wallbox Garage');
    // ⚠ `fmtNum` setzt ein geschütztes Leerzeichen vor die Einheit.
    expect(z.zustand.replace(/\u00a0/g, ' ')).toBe('lädt 7,4 kW');
    expect(z.aktionen).toEqual(['voll_laden', 'laden_pausieren']);
    expect(z.keinEingriff).toBeNull();
    // Die Adresse ist der STECKER - eine Komponenten-Id kann sie nicht tragen.
    expect(z.ladepunkt).toEqual({
      chargePointId: 'CP1', connectorId: 1, name: 'Wallbox Garage', eingriff: null,
    });
    expect(z.entityId).toBeNull();
  });

  it('nennt den Stecker nur, wo er UNTERSCHEIDET', () => {
    const eine = charging().chargers[0];
    expect(ladepunktName(eine, 1)).toBe('Wallbox Garage');
    const zwei = {
      ...eine,
      connectors: [{ connectorId: 1, charging: true }, { connectorId: 2, charging: false }],
    } as typeof eine;
    expect(ladepunktName(zwei, 2)).toBe('Wallbox Garage · Stecker B');
  });

  it('erfindet keine Leistung, wenn die Säule keine meldet', () => {
    const [z] = ladepunktZeilen(charging({}, { powerKw: null })).zeilen;
    expect(z.zustand).not.toMatch(/\d/);
  });

  it('gibt einer Ladung OHNE Auto kein Menü, sondern den Grund', () => {
    const [z] = ladepunktZeilen(
      charging({}, { charging: false, status: 'Available', powerKw: null }),
    ).zeilen;
    expect(z.aktionen).toEqual([]);
    // Der Zustand der Zeile sagt es schon - er wird nicht wiederholt.
    expect(z.zustand).toBe('kein Auto eingesteckt');
    expect(z.keinEingriff).toBeNull();
  });

  it('nennt bei laufendem Eingriff den Urheber und bietet den Rückweg', () => {
    const [z] = ladepunktZeilen(charging({}, { boost: true })).zeilen;
    // Der Urheber steht als QUELLE - im Zustand steht er nicht ein zweites Mal.
    expect(z.zustand.replace(/\u00a0/g, ' ')).toBe('lädt 7,4 kW');
    expect(z.quelle).toBe('handeingriff');
    expect(z.quelleText).toBe('Jetzt voll laden');
    expect(z.aktionen).toEqual(['resume']);
    // ⚠ KEIN Countdown: der Herzschlag meldet kein Ende.
    expect(z.bis).toBeNull();
  });

  it('gibt einer GETRENNTEN Säule keine Zeile - was sie tut, wissen wir nicht', () => {
    const c = charging();
    (c.chargers[0] as { connected: boolean }).connected = false;
    expect(ladepunktZeilen(c).zeilen).toEqual([]);
    expect(ladepunktZeilen(null).zeilen).toEqual([]);
  });

  it('setzt bei laufendem Boost den Banner mit dem Rückweg', () => {
    const b = jetztBanner(null, {}, NOW, null, charging({}, { boost: true }));
    expect(b?.text).toContain('Wallbox Garage lädt voll (nur diese Ladung)');
    expect(b?.aktion).toBe('Automatik fortsetzen');
    expect(b?.entityId).toBe(LADEPUNKT_BANNER_ID);
    expect(b?.ladepunkt?.connectorId).toBe(1);
  });

  it('lässt die Zone ohne Boost Zeichen für Zeichen wie vorher', () => {
    // ⚠ Der Ladepunkt-Zweig ist ein No-op, solange niemand eingegriffen hat -
    // der Banner gehört dann weiter dem, dem er vorher gehörte.
    expect(jetztBanner(null, {}, NOW, null, charging())).toBeNull();
  });

  it('lässt Anlagen-Pause und Speicher-Eingriff vorgehen', () => {
    const pausiert = {
      automationPaused: true, pausedUntil: '2026-08-28T14:30:00Z', interventions: [],
    } as unknown as Parameters<typeof jetztBanner>[3];
    const b = jetztBanner(null, {}, NOW, pausiert, charging({}, { boost: true }));
    // Die Pause beschreibt die ganze Anlage - der engste Eingriff steht zuletzt.
    expect(b?.entityId).toBe(PAUSE_BANNER_ID);
  });
});

/**
 * P3b in der Jetzt-Zone: die Zeile SAGT die Pause, der Banner NENNT die
 * Richtung, und die Rücknahme weiss, was sie beendet.
 */
describe('Zone ① Jetzt — eine pausierte Ladung (P3b)', () => {
  /** Eine Säule mit GENAU EINER von Hand pausierten Ladung. */
  function pausiert(): SiteCharging {
    return {
      budget: null,
      chargers: [{
        chargePointId: 'CP1',
        label: 'Wallbox Garage',
        connected: true,
        connectors: [{
          connectorId: 1,
          charging: true,
          status: 'SuspendedEVSE',
          allocatedKw: 0,
          powerKw: 0,
          // ⚠ Das MASCHINEN-Wort ist das Signal - der Satz daneben ist nur der
          // Beleg, den die Box mitschickt.
          reason: 'handeingriff',
          reasonText: 'pausiert — Handeingriff',
        }],
      }],
    } as unknown as SiteCharging;
  }

  it('liest „pausiert · Handeingriff" und bietet nur den Rückweg', () => {
    const { zeilen } = ladepunktZeilen(pausiert(), () => 'Überschuss (Sonne zuerst)');
    const z = zeilen[0];
    expect(z.zustand).toBe('pausiert');
    // ⚠ Die QUELLE ist der Eingriff, nicht die Steuerart: was gerade regiert,
    // ist der Kunde selbst.
    expect(z.quelle).toBe('handeingriff');
    expect(z.quelleText).toBe('Handeingriff');
    expect(z.aktionen).toEqual(['resume']);
    expect(z.ladepunkt?.eingriff).toBe('pausiert');
  });

  it('nennt im Banner die PAUSE, nicht die volle Ladung', () => {
    const b = jetztBanner(null, {}, new Date(), null, pausiert());
    expect(b?.text).toContain('pausiert (nur diese Ladung)');
    expect(b?.text).not.toContain('lädt voll');
    expect(b?.ladepunkt?.eingriff).toBe('pausiert');
  });
});
