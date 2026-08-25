import { describe, expect, it } from 'vitest';

import type { EntityStrategy, Intervention, ScheduleSlot } from './api';
import type { Consumer } from './consumers/types';
import {
  GUENSTIG_SLOTS,
  MAX_VORSCHLAEGE,
  MIN_UEBERSCHUSS_SLOTS,
  fensterWort,
  guenstigFenster,
  keinVorschlagGrund,
  kommtInFrage,
  mindestLeistung,
  preisSchwelle,
  ueberschussFenster,
  ueberschussSchwelle,
  vorschlagKopf,
  vorschlaege,
  type VorschlagInput,
} from './vorschlaege';

const NOW = new Date('2026-08-25T08:00:00Z');

/** Eine Viertelstunde ab `idx` (relativ zu NOW). */
function slot(idx: number, patch: Partial<ScheduleSlot> = {}): ScheduleSlot {
  return {
    start: new Date(NOW.getTime() + idx * 900_000).toISOString(),
    batteryKw: null,
    gridKw: null,
    socPct: null,
    priceEurMwh: null,
    costEur: null,
    baselineCostEur: null,
    curtailKw: null,
    pvKw: null,
    loadKw: null,
    slotRole: null,
    slotFlags: null,
    storedValueCtKwh: null,
    gridValueCtKwh: null,
    peakPressureEurKw: null,
    importPriceCtKwh: null,
    exportValueCtKwh: null,
    importPriceSource: null,
    ...patch,
  } as ScheduleSlot;
}

function consumer(patch: Partial<Consumer> = {}): Consumer {
  return {
    id: 'c-wallbox',
    type: 'wallbox',
    typeLabel: 'Wallbox',
    name: 'Wallbox',
    controlKind: 'on_off',
    ratedPowerKw: 11,
    minPowerKw: 4,
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
    controlActivation: 'not_activated',
    hasDraftPolicy: false,
    draftPolicyVersion: null,
    ...patch,
  } as Consumer;
}

/** Ein Tag mit einem klaren Mittags-Überschuss ab Slot 4 (1 Stunde später). */
function ueberschussTag(): ScheduleSlot[] {
  const out: ScheduleSlot[] = [];
  for (let i = 0; i < 24; i += 1) {
    // Slots 4..15 tragen 6 kW Überschuss, der Rest keinen.
    const pv = i >= 4 && i <= 15 ? 8 : 0.5;
    out.push(slot(i, { pvKw: pv, loadKw: 2 }));
  }
  return out;
}

/** Ein Tag mit einer klaren Preis-Senke bei Slot 8..15. */
function preisTag(): ScheduleSlot[] {
  const out: ScheduleSlot[] = [];
  for (let i = 0; i < 32; i += 1) {
    out.push(slot(i, { importPriceCtKwh: i >= 8 && i <= 15 ? 9 : 32 }));
  }
  return out;
}

function input(patch: Partial<VorschlagInput> = {}): VorschlagInput {
  return {
    slots: ueberschussTag(),
    consumers: [consumer()],
    now: NOW,
    zone: 'Europe/Berlin',
    ...patch,
  };
}

describe('Überschuss-Fenster', () => {
  it('findet das längste zusammenhängende Fenster mit seiner Energie', () => {
    const f = ueberschussFenster(ueberschussTag(), NOW, 4);
    expect(f).not.toBeNull();
    // Slots 4..15 = 12 Viertelstunden × 6 kW = 18 kWh.
    expect(f?.kwh).toBeCloseTo(18, 6);
    expect(f?.minKw).toBeCloseTo(6, 6);
    expect(f?.maxKw).toBeCloseTo(6, 6);
    expect(f?.von).toBe(slot(4).start);
  });

  it('EIN Slot ohne pv ODER load BRICHT das Fenster, statt es zu überbrücken', () => {
    const mitLoch = ueberschussTag();
    mitLoch[9] = slot(9, { pvKw: null, loadKw: 2 });
    const f = ueberschussFenster(mitLoch, NOW, 4);
    // Übrig bleibt der LÄNGERE der zwei Teile (10..15 = 6 Slots).
    expect(f).not.toBeNull();
    expect(f?.von).toBe(slot(10).start);
    const nurLast = ueberschussTag();
    nurLast[9] = slot(9, { pvKw: 8, loadKw: null });
    expect(ueberschussFenster(nurLast, NOW, 4)?.von).toBe(slot(10).start);
  });

  it('unter der Mindestlänge entsteht KEIN Fenster', () => {
    const kurz: ScheduleSlot[] = [];
    for (let i = 0; i < 12; i += 1) {
      kurz.push(slot(i, { pvKw: i < MIN_UEBERSCHUSS_SLOTS - 1 ? 8 : 0.5, loadKw: 2 }));
    }
    expect(ueberschussFenster(kurz, NOW, 4)).toBeNull();
  });

  it('ein Fenster, das die Mindestleistung nicht trägt, entsteht gar nicht erst', () => {
    // 6 kW Überschuss, aber 9 kW verlangt.
    expect(ueberschussFenster(ueberschussTag(), NOW, 9)).toBeNull();
  });

  it('VERGANGENE Viertelstunden zählen nicht mit', () => {
    const spaeter = new Date(NOW.getTime() + 16 * 900_000);
    expect(ueberschussFenster(ueberschussTag(), spaeter, 4)).toBeNull();
  });

  it('ohne Fahrplan gibt es kein Fenster', () => {
    expect(ueberschussFenster(null, NOW, 4)).toBeNull();
    expect(ueberschussFenster([], NOW, 4)).toBeNull();
  });
});

describe('Preis-Fenster', () => {
  it('findet die günstigsten Stunden samt Vergleichs-Mittel', () => {
    const f = guenstigFenster(preisTag(), NOW);
    expect(f).not.toBeNull();
    expect(f?.ctMittel).toBeCloseTo(9, 6);
    expect(f?.ctMax).toBeCloseTo(9, 6);
    expect(f?.von).toBe(slot(8).start);
    // Der Horizont-Schnitt liegt DEUTLICH darüber - das ist die Aussage.
    expect(f?.ctHorizont).toBeGreaterThan(20);
  });

  it('auf einem FLACHEN Tag entsteht kein Fenster (keine Behauptung ohne Inhalt)', () => {
    const flach = Array.from({ length: 32 }, (_, i) => slot(i, { importPriceCtKwh: 30 }));
    expect(guenstigFenster(flach, NOW)).toBeNull();
    // Auch eine Spanne knapp unter der Schwelle schweigt.
    const knapp = Array.from({ length: 32 }, (_, i) =>
      slot(i, { importPriceCtKwh: i < 8 ? 28 : 32 }));
    expect(guenstigFenster(knapp, NOW)).toBeNull();
  });

  it('ohne Preise entsteht kein Fenster', () => {
    const ohne = Array.from({ length: 32 }, (_, i) => slot(i));
    expect(guenstigFenster(ohne, NOW)).toBeNull();
  });

  it('ein Fenster, das den ganzen Rest verschlucken würde, benennt nichts', () => {
    const kurz = Array.from({ length: GUENSTIG_SLOTS + 2 }, (_, i) =>
      slot(i, { importPriceCtKwh: i < 4 ? 9 : 32 }));
    expect(guenstigFenster(kurz, NOW)).toBeNull();
  });
});

describe('Vorschläge', () => {
  it('macht aus dem Überschuss-Fenster eine Karte mit Zahlen aus dem Fahrplan', () => {
    const v = vorschlaege(input());
    expect(v).toHaveLength(1);
    expect(v[0].art).toBe('ueberschuss');
    expect(v[0].key).toBe('ueberschuss:c-wallbox');
    expect(v[0].titel).toContain('Wallbox');
    // Die Zahlen stehen im Text - sonst wäre es keine Begründung.
    expect(v[0].begruendung).toContain('18,0');
    expect(v[0].begruendung).toContain('6,0');
    expect(v[0].prefill.intent).toBe('react');
    expect(v[0].prefill.conditions?.[0].signal).toBe('site.pv_surplus_kw');
    expect(v[0].prefill.conditions?.[0].value).toBe(4);
    expect(v[0].prefill.gridEnergyPolicy).toBe('avoid');
  });

  it('nimmt das günstige Fenster, wenn es keinen Überschuss gibt', () => {
    const v = vorschlaege(input({ slots: preisTag() }));
    expect(v).toHaveLength(1);
    expect(v[0].art).toBe('guenstig');
    expect(v[0].begruendung).toContain('9,0 ct/kWh');
    expect(v[0].prefill.intent).toBe('cheap');
    expect(v[0].prefill.conditions?.[0].signal).toBe('market.import_price_ct_kwh');
    expect(v[0].prefill.conditions?.[0].operator).toBe('lt');
    expect(v[0].prefill.conditions?.[0].value).toBe(9);
  });

  it('gibt je Komponente HÖCHSTENS EINE Karte - Überschuss gewinnt', () => {
    const beides = ueberschussTag().map((s, i) =>
      ({ ...s, importPriceCtKwh: i >= 16 && i <= 23 ? 9 : 32 }));
    const v = vorschlaege(input({ slots: beides }));
    expect(v).toHaveLength(1);
    expect(v[0].art).toBe('ueberschuss');
  });

  it('deckelt bei drei Karten', () => {
    const viele = [0, 1, 2, 3, 4].map((i) =>
      consumer({ id: `c-${i}`, name: `Gerät ${i}` }));
    expect(vorschlaege(input({ consumers: viele }))).toHaveLength(MAX_VORSCHLAEGE);
  });

  it('schlägt NICHTS vor, was schon läuft (Regel, Anspruch, Handeingriff)', () => {
    const claims: Record<string, EntityStrategy[]> = {
      'c-wallbox': [{ flowId: 'f1', flowName: 'Andere Regel' }],
    };
    expect(vorschlaege(input({ claims }))).toEqual([]);
    expect(vorschlaege(input({
      consumers: [consumer({ controlActivation: 'active' })],
    }))).toEqual([]);
    expect(vorschlaege(input({
      consumers: [consumer({ hasDraftPolicy: true })],
    }))).toEqual([]);
    const eingriffe: Intervention[] = [{
      kind: 'speicher_halten', entityId: 'c-wallbox', targetValueKw: null,
      endsAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
      createdBy: null, createdAt: NOW.toISOString(),
    }];
    expect(vorschlaege(input({ eingriffe }))).toEqual([]);
  });

  it('drängt sich während einer Anlagen-Pause nicht auf', () => {
    expect(vorschlaege(input({ pausiert: true }))).toEqual([]);
  });

  it('respektiert „Später"/„Ablehnen" über den Schlüssel', () => {
    expect(vorschlaege(input({ stumm: ['ueberschuss:c-wallbox'] }))).toEqual([]);
    // Ein FREMDER Schlüssel blendet nichts aus.
    expect(vorschlaege(input({ stumm: ['ueberschuss:c-anders'] }))).toHaveLength(1);
  });

  it('ein nicht verbundenes oder pausiertes Gerät bekommt keine Karte', () => {
    expect(vorschlaege(input({
      consumers: [consumer({ connection: 'disconnected' })],
    }))).toEqual([]);
    expect(vorschlaege(input({ consumers: [consumer({ enabled: false })] }))).toEqual([]);
  });

  it('OHNE Fahrplan-Fakten entsteht KEINE Karte (die Echtheits-Regel)', () => {
    const nackt = Array.from({ length: 32 }, (_, i) => slot(i));
    expect(vorschlaege(input({ slots: nackt }))).toEqual([]);
    expect(vorschlaege(input({ slots: null }))).toEqual([]);
    expect(vorschlaege(input({ slots: [] }))).toEqual([]);
  });

  it('ohne steuerbare Komponente entsteht keine Karte', () => {
    expect(vorschlaege(input({ consumers: [] }))).toEqual([]);
  });

  it('ohne bekannte Leistung wird kein Überschuss-Vorschlag gemacht', () => {
    const ohne = consumer({ minPowerKw: null, ratedPowerKw: 0 });
    expect(mindestLeistung(ohne)).toBeNull();
    expect(vorschlaege(input({ consumers: [ohne] }))).toEqual([]);
  });
});

describe('Copy + Schwellen', () => {
  it('die Schwellen runden konservativ', () => {
    expect(ueberschussSchwelle(4)).toBe(4);
    expect(ueberschussSchwelle(3.7)).toBe(3.5);
    expect(ueberschussSchwelle(0.1)).toBe(0.5);
    expect(preisSchwelle(9)).toBe(9);
    expect(preisSchwelle(9.1)).toBe(9.5);
  });

  it('das Fenster-Wort nennt Tag und Uhrzeit in der Zone der Anlage', () => {
    const f = ueberschussFenster(ueberschussTag(), NOW, 4)!;
    const wort = fensterWort(f, NOW, 'Europe/Berlin');
    expect(wort).toContain('heute');
    expect(wort).toMatch(/\d{2}:\d{2}–\d{2}:\d{2} Uhr/);
  });

  it('der Kopf trägt die Zahl', () => {
    expect(vorschlagKopf(1)).toContain('einen Vorschlag');
    expect(vorschlagKopf(2)).toContain('2 Vorschläge');
  });

  it('ein Leer-Grund wird nur BELEGT genannt', () => {
    expect(keinVorschlagGrund(input({ pausiert: true }))).toContain('pausiert');
    expect(keinVorschlagGrund(input({ consumers: [] }))).toContain('schaltbares Gerät');
    expect(keinVorschlagGrund(input({ slots: [] }))).toContain('Fahrplan');
    // Es GIBT Zutaten, nur gerade kein Fenster: dann schweigt die Fläche.
    const nackt = Array.from({ length: 32 }, (_, i) => slot(i));
    expect(keinVorschlagGrund(input({ slots: nackt }))).toBeNull();
  });
});

describe('Copy-Konsistenz (im Browser-Beweis aufgefallen)', () => {
  it('Titel und Begründung nennen DENSELBEN Tag', () => {
    // Ein Fenster, das erst MORGEN liegt: die Karte darf nicht „morgen 11:00"
    // im Titel und „heute also voraussichtlich" in der Begründung sagen.
    const morgen: ScheduleSlot[] = [];
    for (let i = 0; i < 96; i += 1) {
      // NOW ist 08:00Z; ab Slot 60 (= +15 h) liegt der nächste Tag.
      const drin = i >= 64 && i <= 79;
      morgen.push(slot(i, { pvKw: drin ? 8 : 0.5, loadKw: 2 }));
    }
    const v = vorschlaege(input({ slots: morgen }));
    expect(v).toHaveLength(1);
    expect(v[0].titel).toContain('morgen');
    expect(v[0].begruendung).toContain('morgen');
    expect(v[0].begruendung).not.toContain('heute');
  });

  it('ohne Tageswort behauptet die Begründung keinen Tag', () => {
    // Ein Fenster jenseits von morgen (langer Horizont): dann heisst es
    // „in diesem Zeitraum", nie ein geratener Wochentag.
    const spaet: ScheduleSlot[] = [];
    for (let i = 0; i < 300; i += 1) {
      spaet.push(slot(i, { pvKw: i >= 260 && i <= 280 ? 8 : 0.5, loadKw: 2 }));
    }
    const v = vorschlaege(input({ slots: spaet }));
    expect(v).toHaveLength(1);
    expect(v[0].begruendung).toContain('in diesem Zeitraum');
    expect(v[0].begruendung).not.toMatch(/\b(heute|morgen)\b/);
  });
});
