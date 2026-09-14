import { describe, expect, it } from 'vitest';
import type { MeasurementCatalogPoint } from './api';
import {
  ankerAus,
  anhakbar,
  gruppen,
  istGenPort,
  sperrArt,
  sperrGrund,
  sperrKurz,
  suchePasst,
  unterzeile,
  vorauswahl,
  zeileAus,
  zuQuellwert,
} from './summenwertQuellen';

/** Ein Katalog-Punkt mit sinnvollen Vorgaben; jede Eigenschaft ist überschreibbar. */
function pt(over: Partial<MeasurementCatalogPoint> = {}): MeasurementCatalogPoint {
  return {
    family: 'hybrid_3p',
    pointKey: 'deye.hybrid_3p.pv.pv1-power',
    sourceKind: 'modbus',
    address: null,
    selector: 'holding:0x00bf',
    widthBits: 16,
    valueType: 'uint16',
    signed: false,
    endian: 'big',
    scale: { kind: 'fixed', value: 1 },
    unit: 'W',
    group: 'PV',
    labelDe: 'PV 1',
    labelSource: 'PV1 Power',
    semanticStatus: 'known',
    aggregationKind: 'gauge',
    quantity: 'active_power',
    direction: 'generation',
    defaultCadenceS: 5,
    minCadenceS: 1,
    longTermCadenceS: 900,
    pollGroup: 'pv',
    sourceUrl: 'https://example',
    sourceCommit: 'abc',
    sourceRevision: null,
    dynamic: false,
    recommended: true,
    available: true,
    availabilityStatus: 'read',
    availabilityReason: '',
    recorded: true,
    selected: true,
    selectedCadenceS: 5,
    lastReadAt: '2026-09-14T10:00:00Z',
    rawValue: '5200',
    decodedValue: '5.2',
    quality: 'good',
    gap: false,
    droppedSamples: 0,
    estimatedDataPerYearBytes: 400_000_000,
    ...over,
  };
}

describe('summenwertQuellen: zeileAus leitet Guard, Kategorie und Live-Wert ab', () => {
  it('ein beobachteter PV-Strang ist summierbar mit Live-Wert und Größe/Richtung', () => {
    const z = zeileAus(pt(), 'ent-1');
    expect(z.summierbar).toBe(true);
    expect(z.richtungslos).toBe(false);
    expect(z.groesse).toBe('Wirkleistung');
    expect(z.richtung).toBe('Erzeugung');
    expect(z.wertart).toBe('Momentanwert');
    expect(z.beobachtet).toBe(true);
    expect(z.wert).toBe(5.2);
    expect(z.kategorie).toBe('Wirkleistung · Erzeugung');
    expect(z.entityId).toBe('ent-1');
  });

  it('der Gen-Port (Wirkleistung, direction null) ist summierbar, richtungslos UND genPort', () => {
    const z = zeileAus(
      pt({ pointKey: 'deye.hybrid_1p.load.generator-power', labelDe: 'Gen-Port',
        direction: null, selected: false, decodedValue: null, recorded: false }),
      'ent-1',
    );
    expect(z.summierbar).toBe(true);
    expect(z.richtungslos).toBe(true);
    expect(z.genPort).toBe(true);
    expect(z.kategorie).toBe('Wirkleistung · richtungslos');
    // Nicht beobachtet → kein Live-Wert vorgetäuscht.
    expect(z.beobachtet).toBe(false);
    expect(z.wert).toBeNull();
  });

  it('ein generisches richtungsloses Register (Hausverbrauch) ist richtungslos, aber KEIN Gen-Port', () => {
    // `load-consumption-power` trägt `direction: null` (Deye-Katalog), ist also richtungslos -
    // aber kein ambivalenter Anschluss-Kanal. Es bekommt die neutrale Erzeugungs-Frage, nicht
    // das Gen-Port-Wording.
    const z = zeileAus(
      pt({ pointKey: 'deye.hybrid_3p.load.load-consumption-power', labelDe: 'Hausverbrauch',
        group: 'Load', direction: null }),
      'ent-1',
    );
    expect(z.richtungslos).toBe(true);
    expect(z.genPort).toBe(false);
  });

  it('ein Zahlenwert ohne Vertrags-Größe (Spannung) ist nicht summierbar, mit Kategorie', () => {
    const z = zeileAus(
      pt({ quantity: 'voltage', direction: null, unit: 'V', labelDe: 'Batteriespannung',
        aggregationKind: 'gauge' }),
      'ent-1',
    );
    expect(z.summierbar).toBe(false);
    expect(z.groesse).toBeNull();
    expect(z.kategorie).toBe('Spannung');
  });

  it('ein Zustandsregister trägt keinen Zahlenwert', () => {
    const z = zeileAus(
      pt({ quantity: null, direction: null, aggregationKind: 'text', unit: null,
        labelDe: 'Betriebszustand', decodedValue: 'Netzparallel' }),
      'ent-1',
    );
    expect(z.summierbar).toBe(false);
    // Ein Zustands-/Textregister trägt keine summierbare Wertart und ist nicht numerisch.
    expect(z.wertart).toBeNull();
    expect(z.numerisch).toBe(false);
    expect(z.kategorie).toBe('Text');
  });

  it('ein nicht beobachtetes summierbares Register hat keinen erfundenen Wert', () => {
    const z = zeileAus(pt({ selected: false, recorded: false, decodedValue: null }), 'ent-1');
    expect(z.beobachtet).toBe(false);
    expect(z.wert).toBeNull();
    expect(z.stand).not.toBeNull(); // lastReadAt bleibt, ist aber nur Zustandsanker
  });
});

describe('summenwertQuellen: der Guard mit Anker und seine Gründe', () => {
  const pv = zeileAus(pt(), 'ent-1');
  const energie = zeileAus(
    pt({ pointKey: 'x.energy', quantity: 'active_energy', unit: 'Wh', aggregationKind: 'counter' }),
    'ent-1',
  );
  const spannung = zeileAus(pt({ quantity: 'voltage', aggregationKind: 'gauge' }), 'ent-1');
  const zustand = zeileAus(pt({ quantity: null, aggregationKind: 'state' }), 'ent-1');

  it('ohne Anker ist jeder summierbare Wert anhakbar', () => {
    expect(sperrArt(pv, null)).toBe('summierbar');
    expect(anhakbar(pv, null)).toBe(true);
  });

  it('eine andere Größe als der Anker ist gesperrt (kW ≠ kWh)', () => {
    const anker = ankerAus([zuQuellwert(pv, 'Deye')]);
    expect(anker).toEqual({ groesse: 'Wirkleistung', wertart: 'Momentanwert' });
    expect(sperrArt(energie, anker)).toBe('andere_groesse');
    expect(anhakbar(energie, anker)).toBe(false);
    expect(sperrKurz('andere_groesse')).toBe('andere Messgröße');
  });

  it('ein Zahlenwert ohne Größe und ein Zustand sind unterschiedlich gesperrt', () => {
    expect(sperrArt(spannung, null)).toBe('keine_groesse');
    expect(sperrKurz('keine_groesse')).toBe('keine Messgröße');
    expect(sperrArt(zustand, null)).toBe('kein_zahlenwert');
    expect(sperrKurz('kein_zahlenwert')).toBe('kein Zahlenwert');
    expect(sperrGrund('kein_zahlenwert')).toContain('keinen Zahlenwert');
  });
});

describe('summenwertQuellen: Unterzeile, Suche, Gruppen', () => {
  it('die Unterzeile nennt „noch nicht beobachtet" nur bei rohem summierbaren Register', () => {
    const roh = zeileAus(pt({ selected: false, recorded: false, decodedValue: null }), 'ent-1');
    expect(unterzeile(roh, null)).toBe('noch nicht beobachtet · Wirkleistung · Erzeugung');
    const beob = zeileAus(pt(), 'ent-1');
    expect(unterzeile(beob, null)).toBe('Wirkleistung · Erzeugung');
  });

  it('die Suche trifft Name, Gruppe und Einheit normalisiert', () => {
    const z = zeileAus(pt({ labelDe: 'Batteriespannung', group: 'Batterie', unit: 'V' }), 'ent-1');
    expect(suchePasst(z, 'batterie')).toBe(true);
    expect(suchePasst(z, 'BATTERIESPANNUNG')).toBe(true);
    expect(suchePasst(z, 'netz')).toBe(false);
    expect(suchePasst(z, '')).toBe(true);
  });

  it('gruppen trennt beobachtete Messwerte von allen übrigen Registern', () => {
    const zeilen = [
      zeileAus(pt({ pointKey: 'a', labelDe: 'PV 1', selected: true }), 'e'),
      zeileAus(pt({ pointKey: 'b', labelDe: 'Gen-Port', selected: false, direction: null }), 'e'),
      zeileAus(pt({ pointKey: 'c', labelDe: 'Batteriespannung', selected: false,
        quantity: 'voltage' }), 'e'),
    ];
    const g = gruppen(zeilen);
    expect(g.messwerte.map((z) => z.name)).toEqual(['PV 1']);
    expect(g.alle.map((z) => z.name)).toEqual(['Gen-Port', 'Batteriespannung']);
    // Ein beobachtetes Register steht NICHT doppelt.
    expect(g.alle.some((z) => z.name === 'PV 1')).toBe(false);
  });

  it('zuQuellwert überträgt die Term-Bindung und den Live-Wert', () => {
    const q = zuQuellwert(zeileAus(pt(), 'ent-9'), 'Deye SUN-30K');
    expect(q).toMatchObject({
      entityId: 'ent-9',
      channel: 'deye.hybrid_3p.pv.pv1-power',
      name: 'PV 1',
      geraet: 'Deye SUN-30K',
      groesse: 'Wirkleistung',
      richtung: 'Erzeugung',
      wertart: 'Momentanwert',
      wert: 5.2,
    });
  });
});

describe('summenwertQuellen: istGenPort verengt den Gen-Port auf den echten Anschluss-Kanal', () => {
  it('nur die Leistung AM Generatoranschluss (…generator[-lN]-power) ist der Gen-Port', () => {
    // Die echten Gen-Port-Schlüssel des Deye-Katalogs (hybrid_1p + hybrid_3p, alle direction:null).
    expect(istGenPort('deye.hybrid_1p.load.generator-power')).toBe(true);
    expect(istGenPort('deye.hybrid_3p.generator-smartload-microinverter.generator-power')).toBe(true);
    expect(istGenPort('deye.hybrid_3p.generator-smartload-microinverter.generator-l1-power')).toBe(true);
    expect(istGenPort('deye.hybrid_3p.generator-smartload-microinverter.generator-l3-power')).toBe(true);
  });

  it('Setpoints/Parameter mit „generator" im Schlüssel sind KEIN Gen-Port', () => {
    expect(istGenPort('deye.hybrid_3p.grid-parameters.generator-min-pv-power')).toBe(false);
    expect(istGenPort('deye.hybrid_3p.work-mode.generator-peak-shaving@r00be')).toBe(false);
  });

  it('sonstige richtungslose active_power-Register (Last/Ausgang/CT/Setpoint) sind KEIN Gen-Port', () => {
    // Die restlichen 39 direction:null-Register der hybrid_3p sind keine Anschluss-Kanäle.
    for (const key of [
      'deye.hybrid_3p.load.load-consumption-power',
      'deye.hybrid_3p.output.power',
      'deye.hybrid_3p.grid.internal-ct1-power',
      'deye.hybrid_3p.work-mode.pv-power',
      'deye.hybrid_3p.info.device-rated-power',
    ]) {
      expect(istGenPort(key)).toBe(false);
    }
  });
});

describe('summenwertQuellen: vorauswahl hakt nur Erzeugung vorab an (B2 - keine stille PV-Zählung)', () => {
  const pv = zeileAus(pt({ pointKey: 'pv1', labelDe: 'PV 1', selected: true }), 'e');
  const genPort = zeileAus(
    pt({ pointKey: 'deye.hybrid_1p.load.generator-power', labelDe: 'Gen-Port',
      direction: null, selected: true, recorded: true }),
    'e',
  );
  const hausverbrauch = zeileAus(
    pt({ pointKey: 'deye.hybrid_3p.load.load-consumption-power', labelDe: 'Hausverbrauch',
      group: 'Load', direction: null, selected: true, recorded: true }),
    'e',
  );

  it('nur die Erzeugungs-Stränge werden vorab gewählt', () => {
    expect(vorauswahl([pv, genPort, hausverbrauch]).map((z) => z.name)).toEqual(['PV 1']);
  });

  it('ein beobachtetes richtungsloses Nicht-Erzeugungs-Register wird NICHT automatisch aufgenommen', () => {
    // Kern-Ehrlichkeit (B2): ein beobachteter Hausverbrauch/Gen-Port wandert NIE still als
    // PV-Erzeugung in den Default-Summenwert - er braucht die ausdrückliche Entscheidung.
    const gewaehlt = vorauswahl([pv, genPort, hausverbrauch]);
    expect(gewaehlt.some((z) => z.name === 'Hausverbrauch')).toBe(false);
    expect(gewaehlt.some((z) => z.name === 'Gen-Port')).toBe(false);
  });
});
