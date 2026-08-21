import { describe, expect, it } from 'vitest';
import {
  abregelungDiesesGeraets,
  gattungVon,
  gesicht,
  KEINE_MESSWERTE,
  type GesichtInput,
} from './geraetGesicht';
import type { ControlStatus, CurtailmentStatus, SiteEntity, SiteSource } from './api';
import type { PlantComponent } from './komponenten';
import type { ChargePoint } from './ladepunkte';
import { NBSP } from './format';

const FRISCH = new Date().toISOString();

function komponente(over: Partial<PlantComponent> = {}): PlantComponent {
  return {
    id: 'k-1',
    entityId: 'e-1',
    aspect: 'main',
    label: 'Speicher',
    alias: null,
    derivedLabel: 'Speicher',
    renameable: true,
    role: 'storage',
    summary: '',
    deviceIds: ['inverter'],
    provenance: null,
    reading: null,
    channels: [],
    control: false,
    schaltbar: false,
    freigabeQuelle: null,
    freigabeFaehig: false,
    health: 'ok',
    primary: false,
    orphanedPin: null,
    capacityKwp: null,
    ...(over as Partial<PlantComponent>),
  } as PlantComponent;
}

function src(over: Partial<SiteSource> = {}): SiteSource {
  return {
    deviceId: 'gw',
    sourceId: 'inverter',
    kind: 'primary',
    role: null,
    label: null,
    brand: 'deye',
    model: 'SUN-30K',
    pvKw: null,
    powerKw: null,
    loadKw: null,
    health: 'ok',
    readAt: FRISCH,
    reportedAt: FRISCH,
    ...over,
  };
}

function input(over: Partial<GesichtInput> = {}): GesichtInput {
  return {
    art: 'hauptgeraet',
    geraetId: 'inverter',
    rolle: null,
    communication: 'solarman_v5',
    komponenten: [],
    ...over,
  };
}

/**
 * ⚠ Der behobene Befund ist ZUSCHNITT, nicht Gestaltung: dieselbe Sektionsliste
 * schickte jeden Gerätetyp durch dieselbe erste Frage. Die Gattung IST die
 * Entscheidung, welche Frage zuerst beantwortet wird.
 */
describe('die Gattung wird BELEGT, nie geraten', () => {
  it('unterscheidet Wechselrichter MIT und OHNE Speicher', () => {
    expect(gattungVon({ art: 'hauptgeraet', rolle: null, komponenten: [komponente()] }))
      .toBe('wechselrichter-speicher');
    expect(gattungVon({
      art: 'hauptgeraet', rolle: null, komponenten: [komponente({ role: 'pv' })],
    })).toBe('wechselrichter');
  });

  it('folgt der GEMELDETEN Rolle - sie ist die Aussage des Geräts über sich selbst', () => {
    const args = { art: 'quelle' as const, komponenten: [] };
    expect(gattungVon({ ...args, rolle: 'pv-generation' })).toBe('pv-melder');
    expect(gattungVon({ ...args, rolle: 'grid-meter' })).toBe('zaehler');
    expect(gattungVon({ ...args, rolle: 'consumer' })).toBe('verbraucher');
  });

  it('nimmt die Komponenten nur, wenn sie EINDEUTIG sind', () => {
    expect(gattungVon({
      art: 'quelle', rolle: null, komponenten: [komponente({ role: 'pv' })],
    })).toBe('pv-melder');
    // Zwei verschiedene Rollen: es wird NICHTS behauptet.
    expect(gattungVon({
      art: 'quelle',
      rolle: null,
      komponenten: [komponente({ role: 'pv' }), komponente({ id: 'k-2', role: 'grid' })],
    })).toBe('geraet');
    expect(gattungVon({ art: 'quelle', rolle: null, komponenten: [] })).toBe('geraet');
  });

  it('ein Ladepunkt ist immer ein Ladepunkt', () => {
    expect(gattungVon({
      art: 'ladepunkt', rolle: 'pv-generation', komponenten: [komponente({ role: 'pv' })],
    })).toBe('ladepunkt');
  });
});

describe('jede Gattung beantwortet ihre EIGENE erste Frage', () => {
  it('B · der Speicher-Wechselrichter führt mit dem Steuerungs-Satz', () => {
    const control: ControlStatus = {
      deviceId: 'gw',
      checkedAt: FRISCH,
      controlEnabled: true,
      certified: true,
      allMatch: true,
      commandedKw: 11.1,
      registers: [],
    } as unknown as ControlStatus;
    const g = gesicht(input({
      komponenten: [komponente({
        role: 'storage',
        control: true,
        reading: { value: 76, unit: '%', caption: 'lädt' },
      })],
      src: src({ pvKw: 23.9, powerKw: 3.4, loadKw: 7.6 }),
      control,
    }));
    expect(g.gattung).toBe('wechselrichter-speicher');
    expect(g.held.titel).toBe('Jetzt');
    expect(g.held.kacheln.map((k) => k.label))
      .toEqual(['Solarstrom', 'Ladestand', 'Netz', 'Haus']);
    // ⚠ DIESELBE Ableitung wie Cockpit und Steuerungs-Karte - nie ein eigener Satz.
    expect(g.held.satz).toMatch(/Speicher/);
    // Die Sektions-Folge führt mit dem Jetzt, die Verbindung steht hinten.
    expect(g.sektionen[0]).toBe('jetzt');
    expect(g.sektionen.indexOf('verbindung'))
      .toBeGreaterThan(g.sektionen.indexOf('befehle'));
  });

  it("B' · ohne gesteuerte Komponente sagt der Held, dass nur gelesen wird", () => {
    const g = gesicht(input({
      komponenten: [komponente({ role: 'pv', control: false })],
      src: src({ pvKw: 8.3 }),
    }));
    expect(g.gattung).toBe('wechselrichter');
    expect(g.held.satz).toMatch(/nur gelesen/);
    expect(g.held.satzTon).toBe('off');
  });

  it('C · der PV-Melder führt mit Erzeugung, Nennleistung und Auslastung', () => {
    const entities: SiteEntity[] = [
      { id: 'e-1', capacityKwp: 27 } as unknown as SiteEntity,
    ];
    const g = gesicht(input({
      art: 'quelle',
      geraetId: 'src-fr1',
      rolle: 'pv-generation',
      communication: 'fronius_sunspec',
      komponenten: [komponente({ role: 'pv', entityId: 'e-1' })],
      entities,
      src: src({ sourceId: 'src-fr1', pvKw: 21.2 }),
    }));
    expect(g.gattung).toBe('pv-melder');
    expect(g.held.titel).toBe('Erzeugung');
    expect(g.held.satz).toBe(`Erzeugt gerade 21,2${NBSP}kW von 27,0${NBSP}kWp.`);
    expect(g.held.balken?.pct).toBeCloseTo((21.2 / 27) * 100, 5);
    // Die Einspeise-Begrenzung steht DIREKT hinter dem Held.
    expect(g.sektionen[1]).toBe('einspeise');
  });

  it('⚠ C · ohne gepflegte Nennleistung gibt es KEINEN Balken', () => {
    const g = gesicht(input({
      art: 'quelle',
      rolle: 'pv-generation',
      komponenten: [komponente({ role: 'pv' })],
      src: src({ pvKw: 21.2 }),
    }));
    // Ein Balken ohne Maßstab wäre eine erfundene Aussage.
    expect(g.held.balken).toBeNull();
    expect(g.held.satz).toBe(`Erzeugt gerade 21,2${NBSP}kW.`);
  });

  it('D · der Zähler führt mit Richtung und sagt, ob er maßgeblich ist', () => {
    const g = gesicht(input({
      art: 'quelle',
      rolle: 'grid-meter',
      communication: 'modbus_tcp',
      komponenten: [komponente({ role: 'grid', primary: true })],
      src: src({ powerKw: -16.6 }),
    }));
    expect(g.gattung).toBe('zaehler');
    expect(g.held.satz).toMatch(/speist gerade/);
    expect(g.held.kacheln[0].wort).toBe('Einspeisung');
    expect(g.held.hinweis).toMatch(/maßgeblich/);
    // Ein Zähler bekommt KEINEN Befehls-Kasten - an ihn geht kein Befehl.
    expect(g.sektionen).not.toContain('befehle');
  });

  it('E · der Verbraucher nennt seinen Grund NUR mit einer belegten Regel', () => {
    const basis = input({
      art: 'quelle',
      rolle: 'consumer',
      communication: 'shelly_http',
      komponenten: [komponente({ role: 'consumer' })],
      src: src({ loadKw: 2.8 }),
    });
    expect(gesicht(basis).held.hinweis).toBeNull();
    const mit = gesicht({ ...basis, regeln: ['Überschuss ab 2 kW'] });
    expect(mit.held.hinweis).toBe('Geschaltet von der Regel „Überschuss ab 2 kW".');
    expect(mit.held.kacheln[0].wort).toBe('läuft');
  });

  it('F · der Ladepunkt führt mit seinen Steckern und reicht den Satz der Box durch', () => {
    const charger = {
      chargePointId: 'LP-1',
      connected: true,
      connectors: [
        { connectorId: 1, charging: true, powerKw: 41, allocatedKw: 41,
          reasonText: 'Zwei Fahrzeuge - das Budget ist geteilt.' },
        { connectorId: 2, charging: false, status: 'Available' },
      ],
    } as unknown as ChargePoint;
    const g = gesicht(input({
      art: 'ladepunkt', geraetId: 'cp-LP-1', communication: 'ocpp', charger,
    }));
    expect(g.gattung).toBe('ladepunkt');
    expect(g.held.titel).toBe('Stecker');
    expect(g.held.kacheln.map((k) => k.label)).toEqual(['Stecker 1', 'Stecker 2']);
    expect(g.held.kacheln[1].wert).toBe('frei');
    expect(g.held.hinweis).toBe('Zwei Fahrzeuge - das Budget ist geteilt.');
    // Eine Säule spricht OCPP - eine Register-Sektion, die das erklärt, entfällt.
    expect(g.sektionen).not.toContain('register');
    expect(g.sektionen).toContain('ausfallschutz');
  });
});

/**
 * ⚠ Die Box-Lehre der Stufe 1, verallgemeinert: eine Sektion, die nur ihre
 * eigene Nicht-Zuständigkeit erklärt, entfällt - ihr Grund wandert in den
 * Technik-Aufklapper.
 */
describe('eine Sektion ohne Gegenstand entfällt', () => {
  it('ein HTTP-Gerät bekommt keine Register-Sektion', () => {
    for (const comm of ['shelly_http', 'goe_http_api', 'fronius_solar_api']) {
      const g = gesicht(input({
        art: 'quelle', rolle: 'consumer', communication: comm,
        komponenten: [komponente({ role: 'consumer' })],
      }));
      expect(g.sektionen, comm).not.toContain('register');
    }
  });

  it('ein Modbus-Gerät behält sie', () => {
    const g = gesicht(input({
      art: 'quelle', rolle: 'grid-meter', communication: 'modbus_tcp',
      komponenten: [komponente({ role: 'grid' })],
    }));
    expect(g.sektionen).toContain('register');
  });

  it('⚠ ohne einen einzigen Messwert steht der GRUND da, nie eine Reihe von Strichen', () => {
    const g = gesicht(input({ komponenten: [komponente({ role: 'pv' })] }));
    expect(g.held.kacheln.every((k) => k.wert === '—')).toBe(true);
    expect(g.held.hinweis).toBe(KEINE_MESSWERTE);
  });
});

/**
 * Die Abregelung AUS SICHT EINES GERÄTS - erst die Einheiten-Liste des
 * Herzschlags (Geräteseiten Stufe 1) macht die Aussage möglich.
 */
describe('abregelungDiesesGeraets', () => {
  const basis = (over: Partial<CurtailmentStatus>): CurtailmentStatus => ({
    deviceId: 'gw',
    checkedAt: FRISCH,
    units: 2,
    certifiedUnits: 2,
    controlEnabled: true,
    active: false,
    allMatch: null,
    ...over,
  } as CurtailmentStatus);

  it('nennt die Begrenzung DIESES Geräts samt Bestätigung', () => {
    const s = basis({
      perUnit: [{ sourceId: 'src-fr1', certified: true, appliedCapKw: 8, match: true }],
    });
    expect(abregelungDiesesGeraets(s, 'src-fr1')?.satz)
      .toBe(`Begrenzt gerade auf 8,0${NBSP}kW · vom Gerät bestätigt.`);
  });

  it('⚠ behauptet ohne Eintrag NICHTS über DIESES Gerät', () => {
    const s = basis({ perUnit: [{ sourceId: 'src-andere', certified: true, appliedCapKw: null, match: null }] });
    const v = abregelungDiesesGeraets(s, 'src-fr1');
    // Die Zähler sind eine Aussage über die ANLAGE - sie einem von mehreren
    // Wechselrichtern anzulasten wäre eine erfundene Zuordnung.
    expect(v?.satz).toMatch(/anlagenweit/);
    expect(v?.satz).toMatch(/2 von 2/);
  });

  it('sagt eine fehlende Freigabe, statt eine Begrenzung zu behaupten', () => {
    const s = basis({
      certifiedUnits: 0,
      perUnit: [{ sourceId: 'src-fr1', certified: false, appliedCapKw: null, match: null }],
    });
    expect(abregelungDiesesGeraets(s, 'src-fr1')?.satz).toMatch(/noch nicht freigegeben/);
  });

  it('ohne Status und ohne Einheit gibt es gar keine Zeile', () => {
    expect(abregelungDiesesGeraets(null, 'src-fr1')).toBeNull();
    expect(abregelungDiesesGeraets(basis({ units: 0, certifiedUnits: 0 }), 'x')).toBeNull();
  });
});
