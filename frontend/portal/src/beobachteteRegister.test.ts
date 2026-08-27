import { describe, expect, it } from 'vitest';
import type { MeasurementCatalogPoint, MeasurementSelectionState } from './api';
import {
  HINZU,
  LEER,
  TITEL,
  WARTET_AUF_BOX,
  adresse,
  brueckeAusLesung,
  eigenePunkte,
  katalogTitel,
  kurzfassung,
  sparkPunkte,
  wortwahl,
  zeilen,
} from './beobachteteRegister';

type Selection = MeasurementSelectionState['selections'][number];

function auswahl(over: Partial<Selection> = {}): Selection {
  return {
    pointKey: 'deye.hybrid_3p.battery.soc',
    enabled: true,
    cadenceS: 30,
    applyStatus: 'applied',
    applyReason: null,
    enabledAt: '2026-08-26T10:00:00Z',
    disabledAt: null,
    label: 'SOC',
    family: 'hybrid_3p',
    group: 'Batterie',
    semanticStatus: 'known',
    customDefinition: null,
    ...over,
  };
}

function punkt(over: Partial<MeasurementCatalogPoint> = {}): MeasurementCatalogPoint {
  return {
    family: 'hybrid_3p',
    pointKey: 'deye.hybrid_3p.battery.soc',
    sourceKind: 'modbus_holding',
    address: { kind: 'modbus_holding', registers: [588], widthWords: 1 },
    selector: 'holding:0x024c',
    widthBits: 16,
    valueType: 'uint16',
    signed: false,
    endian: 'big',
    scale: { kind: 'factor', value: 1 },
    unit: '%',
    group: 'Batterie',
    labelDe: 'Ladestand',
    labelSource: 'Battery SOC',
    semanticStatus: 'known',
    aggregationKind: 'gauge',
    defaultCadenceS: 30,
    minCadenceS: 30,
    longTermCadenceS: 300,
    pollGroup: 'deye:hybrid_3p:battery:30',
    sourceUrl: '',
    sourceCommit: null,
    sourceRevision: null,
    dynamic: false,
    recommended: true,
    available: true,
    availabilityStatus: 'read',
    availabilityReason: 'Vom Gerät gelesen.',
    recorded: true,
    selected: true,
    selectedCadenceS: 30,
    lastReadAt: '2026-08-26T11:59:48Z',
    rawValue: '87',
    decodedValue: '87',
    quality: 'good',
    gap: false,
    droppedSamples: 0,
    estimatedDataPerYearBytes: 1_000,
    ...over,
  };
}

const NOW = Date.parse('2026-08-26T12:00:00Z');

describe('beobachteteRegister · die zwei Wortwahlen (D3a)', () => {
  it('nennt ein HTTP-/OCPP-Gerät nie „Register" - die Fähigkeit bleibt dieselbe', () => {
    expect(wortwahl(true)).toBe('register');
    expect(wortwahl(false)).toBe('messwert');
    expect(TITEL.register).toBe('Beobachtete Register');
    expect(TITEL.messwert).toBe('Beobachtete Messwerte');
    expect(HINZU.messwert).toBe('Messwert beobachten');
    expect(LEER.messwert).toContain('Messwert beobachten');
  });

  it('der Katalog-Titel NENNT das Gerät - ohne Namen bleibt es beim Auftrag', () => {
    expect(katalogTitel('register', 'Deye SUN-30K')).toBe('Register des Deye SUN-30K');
    expect(katalogTitel('messwert', 'go-e Charger')).toBe('Messwerte des go-e Charger');
    expect(katalogTitel('register', '  ')).toBe('Register beobachten');
    expect(katalogTitel('register', null)).toBe('Register beobachten');
  });
});

describe('beobachteteRegister · die Zeilen', () => {
  it('zeigt Name, Adresse, Wert mit Einheit und Frische aus dem Katalog', () => {
    const [zeile] = zeilen({ selections: [auswahl()], katalog: [punkt()], now: NOW });
    expect(zeile.name).toBe('Ladestand');
    expect(zeile.adresse).toBe('0x024c');
    expect(zeile.wert).toBe('87 %');
    expect(zeile.frische).toMatch(/^vor \d+ Sek\.$/);
    expect(zeile.zustand).toBe('beobachtet');
    expect(zeile.verlaufMoeglich).toBe(true);
  });

  it('eine ABGEWÄHLTE Auswahl ist Historie, keine Beobachtung', () => {
    const rows = zeilen({
      selections: [auswahl({ enabled: false, disabledAt: '2026-08-26T09:00:00Z' })],
      katalog: [punkt()],
      now: NOW,
    });
    expect(rows).toEqual([]);
  });

  it('behauptet ohne gemessenen Wert KEINEN - nie eine erfundene 0', () => {
    const [zeile] = zeilen({
      selections: [auswahl()],
      katalog: [punkt({ decodedValue: null, rawValue: null, lastReadAt: null, recorded: false })],
      now: NOW,
    });
    expect(zeile.wert).toBeNull();
    expect(zeile.frische).toBeNull();
    expect(zeile.verlaufMoeglich).toBe(false);
  });

  it('beschriftet einen rohen Wert als ROH und hängt ihm keine Einheit an', () => {
    const [zeile] = zeilen({
      selections: [auswahl()],
      katalog: [punkt({ decodedValue: null, rawValue: '3300' })],
      now: NOW,
    });
    expect(zeile.wert).toBe('roh 3300');
  });

  it('ohne Katalog-Punkt bleibt der gespeicherte Name, ohne den der Schlüssel', () => {
    const [mitLabel] = zeilen({ selections: [auswahl({ label: 'SOC' })], katalog: [], now: NOW });
    expect(mitLabel.name).toBe('SOC');
    expect(mitLabel.adresse).toBeNull();
    const [ohne] = zeilen({ selections: [auswahl({ label: '' })], katalog: [], now: NOW });
    expect(ohne.name).toBe('deye.hybrid_3p.battery.soc');
  });

  it('eine Ablehnung trägt den Grund des SERVERS, nie einen erfundenen', () => {
    const [zeile] = zeilen({
      selections: [auswahl({ applyStatus: 'rejected', applyReason: 'Buslast zu hoch.' })],
      katalog: [punkt()],
      now: NOW,
    });
    expect(zeile.zustand).toBe('abgelehnt');
    expect(zeile.ton).toBe('warn');
    expect(zeile.grund).toBe('Buslast zu hoch.');
  });

  it('wartet, solange die Box den Punkt nicht angewandt hat', () => {
    const [zeile] = zeilen({
      selections: [auswahl({ applyStatus: 'pending_edge' })],
      katalog: [punkt()],
      now: NOW,
    });
    expect(zeile.zustand).toBe('wartet');
    expect(zeile.zustandWort).toBe('wartet auf die Box');
  });

  it('behauptet auf einem NICHT gepollten Gerät keine Beobachtung (Stufe 3c)', () => {
    const [zeile] = zeilen({
      selections: [auswahl()],
      katalog: [punkt({ decodedValue: null, rawValue: null, lastReadAt: null })],
      lesbar: false,
      now: NOW,
    });
    expect(zeile.zustand).toBe('wartet');
    expect(zeile.grund).toBe(WARTET_AUF_BOX);
  });

  it('aber ein angekommener WERT ist der Beleg - er schlägt die Vermutung', () => {
    const [zeile] = zeilen({
      selections: [auswahl()],
      katalog: [punkt()],
      lesbar: false,
      now: NOW,
    });
    expect(zeile.zustand).toBe('beobachtet');
    expect(zeile.wert).toBe('87 %');
  });

  it('sortiert Aufmerksamkeit zuerst, dann alphabetisch', () => {
    const rows = zeilen({
      selections: [
        auswahl({ pointKey: 'c', label: 'Zink' }),
        auswahl({ pointKey: 'a', label: 'Alpha' }),
        auswahl({ pointKey: 'b', label: 'Beta', applyStatus: 'rejected' }),
        auswahl({ pointKey: 'd', label: 'Delta', applyStatus: 'pending_edge' }),
      ],
      katalog: [],
      now: NOW,
    });
    expect(rows.map((r) => r.name)).toEqual(['Beta', 'Delta', 'Alpha', 'Zink']);
  });

  it('erkennt ein eigenes Register an seiner Definition und nimmt dessen Selektor', () => {
    const [zeile] = zeilen({
      selections: [auswahl({
        pointKey: 'custom.1',
        label: 'Kessel Vorlauf',
        customDefinition: {
          label: 'Kessel Vorlauf', sourceKind: 'modbus_holding', address: 42,
          selector: 'holding:0x002a', valueType: 'uint16', widthBits: 16, signed: false,
          endian: 'big', scale: 1, unit: 'C', cadenceS: 30, retentionClass: 'gauge',
          readOnly: true, requestCostMs: 2000,
        },
      })],
      katalog: [],
      now: NOW,
    });
    expect(zeile.eigen).toBe(true);
    expect(zeile.adresse).toBe('holding:0x002a');
  });

  it('die Adresse eines SunSpec-Punktes nennt Modell und Offset', () => {
    expect(adresse(punkt({
      address: { kind: 'sunspec', modelId: 103, offsetWords: 8 },
    } as Partial<MeasurementCatalogPoint>))).toBe('SunSpec M103, Offset 8');
  });
});

describe('beobachteteRegister · die Kurzfassung', () => {
  it('zählt die Zustände GETRENNT und führt den ersten belegten Wert', () => {
    const rows = zeilen({
      selections: [
        auswahl(),
        auswahl({ pointKey: 'p2', label: 'PV2', applyStatus: 'pending_edge' }),
      ],
      katalog: [punkt()],
      now: NOW,
    });
    const text = kurzfassung(rows) ?? '';
    expect(text).toContain('1 beobachtet');
    expect(text).toContain('1 wartet');
    expect(text).toContain('Ladestand 87 %');
  });

  it('behauptet ohne Zeile GAR NICHTS - der leere Zustand steht im Körper', () => {
    expect(kurzfassung([])).toBeNull();
  });
});

describe('beobachteteRegister · der Mini-Verlauf', () => {
  it('macht aus einer Lücke eine Lücke, nie eine 0', () => {
    const punkte = sparkPunkte({
      meta: {} as never,
      data: [
        { time: 't1', value: 3, minimum: null, maximum: null, text: null, sampleCount: 1, gap: false },
        { time: 't2', value: 0, minimum: null, maximum: null, text: null, sampleCount: 0, gap: true },
      ],
      markers: [],
    });
    expect(punkte).toEqual([
      { key: 't1', value: 3 },
      { key: 't2', value: null },
    ]);
    expect(sparkPunkte(null)).toEqual([]);
  });
});

describe('beobachteteRegister · die Brücke aus einer Lesung', () => {
  it('übernimmt Adresse, Art, Einheit und die aus dem Paar abgeleitete Skala', () => {
    const v = brueckeAusLesung({
      adresse: '0x00E7',
      art: 'holding',
      registerLabel: 'Einspeisegrenze',
      scaleUnit: 'kW',
      beforeRaw: 3300,
      beforeScaled: 33,
    });
    expect(v).toEqual({
      label: 'Einspeisegrenze',
      address: '231',
      sourceKind: 'modbus_holding',
      unit: 'kW',
      scale: '0.01',
    });
  });

  it('erfindet ohne gelesenes Paar keine Skala und ohne Server keine Einheit', () => {
    const v = brueckeAusLesung({ adresse: '231', art: 'input' });
    expect(v).toEqual({
      label: 'Register 0x00e7',
      address: '231',
      sourceKind: 'modbus_input',
      unit: '',
      scale: '1',
    });
  });

  it('macht aus einer SPULE keinen Vorschlag - das Formular kennt nur Register', () => {
    expect(brueckeAusLesung({ adresse: '0x0001', art: 'coil' })).toBeNull();
  });

  it('rät eine unauflösbare Adresse nicht - dann gibt es keinen Vorschlag', () => {
    expect(brueckeAusLesung({ adresse: 'E7', art: 'holding' })).toBeNull();
    expect(brueckeAusLesung({ adresse: '', art: 'holding' })).toBeNull();
  });
});

describe('beobachteteRegister · eigene Register als Katalog-Punkte', () => {
  const state = {
    selections: [auswahl({
      pointKey: 'custom.1',
      customDefinition: {
        label: 'Kessel Vorlauf', sourceKind: 'modbus_holding', address: 42,
        selector: 'holding:0x002a', valueType: 'uint16', widthBits: 16, signed: false,
        endian: 'big', scale: 1, unit: 'C', cadenceS: 30, retentionClass: 'gauge',
        readOnly: true, requestCostMs: 2000,
      },
    })],
  } as unknown as MeasurementSelectionState;

  it('zeigt sie nur, wo der Wirt sie erlaubt - sonst gar nicht', () => {
    expect(eigenePunkte(state, false)).toEqual([]);
    const [p] = eigenePunkte(state, true);
    expect(p.labelDe).toBe('Kessel Vorlauf');
    expect(p.selector).toBe('holding:0x002a');
    expect(p.unit).toBe('C');
    // Ein eigenes Register trägt KEINEN gelesenen Wert - er käme aus dem
    // Katalog, und dort steht es nicht.
    expect(p.decodedValue).toBeNull();
  });
});
