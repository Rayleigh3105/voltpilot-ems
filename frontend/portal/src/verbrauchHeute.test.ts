import { describe, expect, it } from 'vitest';
import type { EntityHistory, OcppMeterSample, SiteTopology, TopologyEntity } from './api';
import {
  gemesseneEntitaeten,
  heuteAusEntitaet,
  heuteAusRegister,
  REGISTER_POINT_KEY,
  tagesBeginn,
} from './verbrauchHeute';
import { verbrauchKomposition } from './verbrauchKomposition';
import type { ChargePoint } from './ladepunkte';

function probe(
  chargePointId: string,
  connectorId: number,
  sampledAt: string,
  numericValue: number | null,
  unit: string | null = 'Wh',
  pointKey = REGISTER_POINT_KEY,
): OcppMeterSample {
  return {
    sampledAt,
    eventId: `${chargePointId}-${sampledAt}`,
    meterValueIndex: 0,
    sampledValueIndex: 0,
    deviceId: 'dev',
    chargePointId,
    connectorId,
    transactionId: 1,
    source: 'MeterValues',
    pointKey,
    measurand: pointKey,
    context: 'Sample.Periodic',
    format: 'Raw',
    phase: null,
    location: null,
    unit,
    value: String(numericValue ?? ''),
    numericValue,
  };
}

function history(bucketMinutes: number, avgs: (number | null)[]): EntityHistory {
  return {
    range: 'day',
    from: '2026-08-28T00:00:00Z',
    to: '2026-08-28T23:59:59Z',
    bucketMinutes,
    channels: {
      power_kw: avgs.map((avg, i) => ({
        start: `2026-08-28T${String(i).padStart(2, '0')}:00:00Z`,
        avg,
        min: avg,
        max: avg,
        last: avg,
        n: avg == null ? 0 : 10,
      })),
    },
  };
}

describe('heuteAusEntitaet · die Tagesenergie einer gemessenen Komponente', () => {
  it('summiert Mittelwert × Eimerdauer', () => {
    // 4 Viertelstunden à 2 kW = 4 × 0,25 h × 2 kW = 2 kWh.
    expect(heuteAusEntitaet(history(15, [2, 2, 2, 2]))).toBe(2);
  });

  it('rechnet mit der GEMELDETEN Eimerdauer, nicht mit einer angenommenen', () => {
    // Dieselben vier Werte, aber Stunden-Eimer: 4 × 1 h × 2 kW = 8 kWh.
    expect(heuteAusEntitaet(history(60, [2, 2, 2, 2]))).toBe(8);
  });

  it('überspringt Eimer ohne Messwert, statt sie als 0 zu zählen', () => {
    expect(heuteAusEntitaet(history(60, [3, null, 1]))).toBe(4);
  });

  it('behauptet ohne einen einzigen Messwert NICHTS (nie eine 0)', () => {
    expect(heuteAusEntitaet(history(60, [null, null]))).toBeNull();
    expect(heuteAusEntitaet(history(60, []))).toBeNull();
    expect(heuteAusEntitaet(null)).toBeNull();
  });

  it('kennt den Leistungs-Kanal nicht, wenn die Komponente ihn nicht meldet', () => {
    const h: EntityHistory = {
      range: 'day', from: 'a', to: 'b', bucketMinutes: 15,
      channels: { soc_pct: [{ start: 'a', avg: 50, min: 50, max: 50, last: 50, n: 1 }] },
    };
    expect(heuteAusEntitaet(h)).toBeNull();
  });

  it('zieht einen negativen Mittelwert nicht ab (ein Verbrauchskanal ist keine Erzeugung)', () => {
    expect(heuteAusEntitaet(history(60, [2, -5, 1]))).toBe(3);
  });
});

describe('heuteAusRegister · der ZUWACHS, nie die Summe der Messwerte', () => {
  const morgen = '2026-08-28T06:00:00Z';
  const mittag = '2026-08-28T12:00:00Z';
  const abend = '2026-08-28T18:00:00Z';

  it('bildet max − min je Stecker und rechnet Wh in kWh', () => {
    const out = heuteAusRegister([
      probe('CP1', 1, morgen, 1_000_000),
      probe('CP1', 1, mittag, 1_007_400),
      probe('CP1', 1, abend, 1_012_400),
    ]);
    expect(out['cp:CP1#1']).toBe(12.4);
    // Die Säulen-Zeile ist die Summe IHRER Stecker.
    expect(out['cp:CP1']).toBe(12.4);
  });

  it('summiert zwei Stecker EINER Säule auf die Säulen-Zeile', () => {
    const out = heuteAusRegister([
      probe('CP1', 1, morgen, 0),
      probe('CP1', 1, abend, 4_000),
      probe('CP1', 2, morgen, 100_000),
      probe('CP1', 2, abend, 106_000),
    ]);
    expect(out['cp:CP1#1']).toBe(4);
    expect(out['cp:CP1#2']).toBe(6);
    expect(out['cp:CP1']).toBe(10);
  });

  it('⚠ ein ZURÜCKGESETZTER Zähler ergibt GAR KEINE Zahl - auch wenn die nackte Differenz PLAUSIBEL aussieht', () => {
    // Der gefährliche Fall, und der Grund für die Monotonie-Prüfung: der Stand
    // springt mittags von 900 auf 0 und steht abends bei 950. Letzter minus
    // erster wären 50 kWh - eine Zahl, die niemandem auffällt und trotzdem
    // grob falsch ist (wirklich geflossen sind mindestens 950). Ein
    // Vorzeichen-Test fängt sie NICHT: sie ist positiv.
    const out = heuteAusRegister([
      probe('CP1', 1, morgen, 900_000),
      probe('CP1', 1, mittag, 0),
      probe('CP1', 1, abend, 950_000),
    ]);
    expect(out['cp:CP1#1']).toBeNull();
    expect(out['cp:CP1']).toBeNull();
  });

  it('⚠ ein einzelner Ausreißer in der Mitte macht die ganze Reihe unbrauchbar', () => {
    // 10 → 999.999 → 20: letzter minus erster wären harmlose 10 kWh, aber eine
    // Reihe mit so einem Sprung trägt keine Aussage mehr.
    const out = heuteAusRegister([
      probe('CP1', 1, morgen, 10_000),
      probe('CP1', 1, mittag, 999_999_000),
      probe('CP1', 1, abend, 20_000),
    ]);
    expect(out['cp:CP1#1']).toBeNull();
  });

  it('und der ehrliche Rückschritt bleibt ehrlich: fällt sie am Ende, gibt es auch nichts', () => {
    const out = heuteAusRegister([
      probe('CP1', 1, morgen, 950_000),
      probe('CP1', 1, mittag, 5_000),
      probe('CP1', 1, abend, 57_000),
    ]);
    expect(out['cp:CP1#1']).toBeNull();
  });

  it('⚠ ein einziger unbelegbarer Stecker macht die SÄULEN-Summe unbelegbar', () => {
    const out = heuteAusRegister([
      probe('CP1', 1, morgen, 0),
      probe('CP1', 1, abend, 4_000),
      probe('CP1', 2, morgen, 900_000),
      probe('CP1', 2, abend, 10_000), // gefallen
    ]);
    expect(out['cp:CP1#1']).toBe(4);
    expect(out['cp:CP1#2']).toBeNull();
    expect(out['cp:CP1']).toBeNull();
  });

  it('braucht ZWEI Proben - eine einzelne ist ein Stand, kein Zuwachs', () => {
    const out = heuteAusRegister([probe('CP1', 1, mittag, 7_400)]);
    expect(out['cp:CP1#1']).toBeNull();
    expect(out['cp:CP1']).toBeNull();
  });

  it('nimmt kWh-Proben unverändert und lässt eine unbekannte Einheit fallen', () => {
    const kwh = heuteAusRegister([
      probe('CP1', 1, morgen, 1000, 'kWh'),
      probe('CP1', 1, abend, 1012.4, 'kWh'),
    ]);
    expect(kwh['cp:CP1#1']).toBe(12.4);
    const fremd = heuteAusRegister([
      probe('CP1', 1, morgen, 10, 'Celsius'),
      probe('CP1', 1, abend, 20, 'Celsius'),
    ]);
    expect(fremd['cp:CP1#1']).toBeUndefined();
  });

  it('liest eine fehlende Einheit als Wh (die OCPP-1.6-Vorgabe)', () => {
    const out = heuteAusRegister([
      probe('CP1', 1, morgen, 0, null),
      probe('CP1', 1, abend, 3_300, null),
    ]);
    expect(out['cp:CP1#1']).toBe(3.3);
  });

  it('ignoriert jede Probe, die kein Register ist', () => {
    const out = heuteAusRegister([
      probe('CP1', 1, morgen, 11_000, 'W', 'Power.Active.Import'),
      probe('CP1', 1, abend, 22_000, 'W', 'Power.Active.Import'),
    ]);
    expect(out['cp:CP1#1']).toBeUndefined();
  });

  it('sortiert die Proben selbst - die Reihenfolge der Antwort ist nicht zugesichert', () => {
    const out = heuteAusRegister([
      probe('CP1', 1, abend, 12_400),
      probe('CP1', 1, morgen, 0),
      probe('CP1', 1, mittag, 7_400),
    ]);
    expect(out['cp:CP1#1']).toBe(12.4);
  });

  it('behauptet ohne Proben nichts', () => {
    expect(heuteAusRegister([])).toEqual({});
    expect(heuteAusRegister(null)).toEqual({});
  });
});

describe('tagesBeginn', () => {
  it('schneidet auf Mitternacht der Anzeige-Zone', () => {
    const iso = tagesBeginn(new Date('2026-08-28T14:37:12'));
    const d = new Date(iso);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(d.getMilliseconds()).toBe(0);
    expect(d.getDate()).toBe(28);
  });
});

describe('gemesseneEntitaeten · wen die Aufschlüsselung lazy nachfragt', () => {
  function entity(id: string, entityType: string): TopologyEntity {
    return { id, entityType, typeLabel: entityType, label: null, category: 'consumer', health: 'ok', capabilities: [] };
  }
  const TOPO: SiteTopology = {
    schemaVersion: '1.0',
    entities: [entity('haus', 'house-load'), entity('rod', 'heating-rod')],
    topology: {
      schema_version: '1.0',
      nodes: [
        {
          role: 'consumer', flow_active: true, direction: 'out',
          members: [
            { entity_id: 'haus', label: 'Hausverbrauch', primary: true, value_kw: 13.3 },
            { entity_id: 'rod', label: 'Heizstab', primary: false, value_kw: 2.3 },
          ],
        },
      ],
    },
  };
  const CHARGER: ChargePoint = {
    deviceId: 'dev-1', chargePointId: 'CP1', label: null, priority: false,
    connected: true, ready: true, lastSeen: '2026-08-28T08:50:00Z', entityId: 'cp-ent',
    reportedAt: '2026-08-28T09:41:00Z',
    connectors: [{
      connectorId: 1, status: 'Charging', errorCode: null, powerKw: 11, allocatedKw: 11,
      reasonText: null, transactionId: 1, boost: false, since: null, nextTurn: null,
    } as never],
  };

  it('nennt jede gemessene Komponente - seit Phase 1 auch den Ladepunkt', () => {
    const k = verbrauchKomposition({
      topology: TOPO,
      chargers: [CHARGER],
      consumerStatus: null,
      hausTodayKwh: 40,
      ladenKachelSichtbar: false,
      links: {},
    });
    const ids = gemesseneEntitaeten(k);
    expect(ids).toContain('rod');
    // ⚠ Cockpit Phase 1 / E1: die Box publiziert je Ladepunkt-Entität
    // `power_kw` + den `energy_kwh`-Zähler als gewöhnliche Entitäts-Telemetrie,
    // ein Ladepunkt IST also eine messende Komponente. Der Register-Abruf
    // bleibt daneben - nur er kennt die Zahl je STECKER.
    expect(ids).toContain('cp-ent');
    // Nie die ChargePointId: gefragt wird die ENTITÄT.
    expect(ids).not.toContain('CP1');
  });

  it('fragt eine Säule mit zwei Steckern trotzdem nur EINMAL', () => {
    const k = verbrauchKomposition({
      topology: TOPO,
      chargers: [{
        ...CHARGER,
        connectors: [
          CHARGER.connectors![0],
          { ...CHARGER.connectors![0], connectorId: 2 },
        ],
      }],
      consumerStatus: null,
      hausTodayKwh: 40,
      ladenKachelSichtbar: false,
      links: {},
    });
    const ids = gemesseneEntitaeten(k);
    expect(ids.filter((id) => id === 'cp-ent')).toHaveLength(1);
  });

  it('fragt ohne Aufschlüsselung nichts nach', () => {
    expect(gemesseneEntitaeten(null)).toEqual([]);
  });
});

describe('Cockpit Phase 1 / E1 - der Ladepunkt-Zähler kommt über die Entität', () => {
  const eimer = (start: string, v: number) => ({
    start, avg: v, min: v, max: v, last: v, n: 1,
  });

  it('rechnet den ZUWACHS des energy_kwh-Zählers, nicht die Summe der Stände', () => {
    const kwh = heuteAusEntitaet({
      range: 'day', from: 'x', to: 'y', bucketMinutes: 15,
      channels: {
        energy_kwh: [
          eimer('2026-08-28T00:00:00Z', 1200),
          eimer('2026-08-28T00:15:00Z', 1211.5),
          eimer('2026-08-28T00:30:00Z', 1240.5),
        ],
      },
    });
    // 1240,5 − 1200 = 40,5 — die Summe der Stände wären 3652.
    expect(kwh).toBe(40.5);
  });

  it('gewinnt gegen die Leistungs-Integration, wo es einen Zähler gibt', () => {
    const kwh = heuteAusEntitaet({
      range: 'day', from: 'x', to: 'y', bucketMinutes: 60,
      channels: {
        energy_kwh: [eimer('2026-08-28T00:00:00Z', 10), eimer('2026-08-28T01:00:00Z', 14)],
        // Die Integration ergäbe 11 kWh - der Zähler ist die MESSUNG.
        power_kw: [eimer('2026-08-28T00:00:00Z', 11), eimer('2026-08-28T01:00:00Z', 0)],
      },
    });
    expect(kwh).toBe(4);
  });

  // ⚠ Die Monotonie-Regel des Registers gilt auf der Entitäts-Reihe wörtlich:
  // ein Zähler, der zurückspringt, ergibt GAR KEINE Zahl - und fällt hier auf
  // die Leistungs-Integration zurück, statt 945 statt 57 kWh zu behaupten.
  it('behauptet bei einem zurückgesetzten Zähler nichts und nimmt die Leistung', () => {
    const kwh = heuteAusEntitaet({
      range: 'day', from: 'x', to: 'y', bucketMinutes: 60,
      channels: {
        energy_kwh: [eimer('2026-08-28T00:00:00Z', 950), eimer('2026-08-28T01:00:00Z', 5)],
        power_kw: [eimer('2026-08-28T00:00:00Z', 8), eimer('2026-08-28T01:00:00Z', 4)],
      },
    });
    expect(kwh).toBe(12);
  });

  it('braucht mindestens zwei Zähler-Eimer, sonst gibt es keinen Zuwachs', () => {
    expect(
      heuteAusEntitaet({
        range: 'day', from: 'x', to: 'y', bucketMinutes: 60,
        channels: { energy_kwh: [eimer('2026-08-28T00:00:00Z', 10)] },
      }),
    ).toBeNull();
  });

  it('ist ohne Zähler-Kanal byte-identisch zur Leistungs-Integration', () => {
    const nur = {
      range: 'day' as const, from: 'x', to: 'y', bucketMinutes: 60,
      channels: { power_kw: [eimer('2026-08-28T00:00:00Z', 3), eimer('2026-08-28T01:00:00Z', 5)] },
    };
    expect(heuteAusEntitaet(nur)).toBe(8);
  });
});
