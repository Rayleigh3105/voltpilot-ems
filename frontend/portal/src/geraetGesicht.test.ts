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
    // ⚠ Seit Stufe 4 ist die Reihenfolge KANONISCH (§4.4) - die
    // Einspeise-Begrenzung ist da, sie steht nur nicht mehr frei sortiert
    // direkt hinter dem Held.
    expect(g.sektionen).toContain('einspeise');
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

/**
 * Geräteseiten Stufe 4 - DIE NEUN BLÄTTER.
 *
 * Der behobene Befund war ZUSCHNITT, nicht Gestaltung: die Gattungs-Auswahl
 * stand seit Stufe 2, aber jedes Blatt bekam noch dieselben Sektionen in
 * derselben Ordnung und dieselben Kacheln. Hier steht je Gattung, was sie
 * BRAUCHT - und die Gegenprobe, was sie ausdrücklich NICHT braucht (§4.6:
 * strukturell Leeres entfällt, sein Grund zieht in die Diagnose).
 */
describe('Stufe 4 · je Gattung genau das, was sie braucht', () => {
  const kanonisch = [
    'jetzt', 'befehle', 'komponenten', 'register', 'verbindung', 'software',
  ] as const;

  /** Die Ordnung ist FEST (§4.4) - ein Blatt lässt aus, es sortiert nie um. */
  function istKanonisch(sektionen: readonly string[]) {
    const nur = sektionen.filter((s) => (kanonisch as readonly string[]).includes(s));
    return nur.every((s, i) => kanonisch.indexOf(s as never)
      >= kanonisch.indexOf(nur[Math.max(0, i - 1)] as never));
  }

  it('B · der Hybrid trägt PV-Teil, Speicher-Teil und die Grundausstattung', () => {
    const g = gesicht(input({
      komponenten: [
        komponente({ role: 'storage', entityId: 'e-batt', reading: { value: 62, unit: '%', caption: 'lädt' } as never }),
        komponente({ id: 'k-2', role: 'pv', entityId: 'e-pv' }),
        komponente({ id: 'k-3', role: 'grid', entityId: 'e-netz' }),
      ],
      // Netz/Haus stehen NUR, weil dieses Gerät sie MISST - die Zahl kommt aus
      // der gemeldeten Quelle, nie aus einer Komponenten-Zeile daneben.
      src: src({ pvKw: 8.4, powerKw: 2.1, loadKw: 3.9 }),
      topologie: [
        { id: 'e-batt', capabilities: [{ channel: 'battery_power_kw', unit: 'kW', value: 4.2 }] },
      ] as never,
    }));
    expect(g.gattung).toBe('wechselrichter-speicher');
    const keys = g.held.kacheln.map((k) => k.key);
    // PV-Teil UND Speicher-Teil - der Hybrid ist beides.
    expect(keys).toContain('pv');
    expect(keys).toContain('speicher');
    // Die Batterieleistung ist GEMESSEN (Topologie), nie eine Bilanz-Ableitung.
    expect(keys).toContain('batterie');
    // Netz/Haus nur, weil DIESES Gerät sie misst.
    expect(keys).toContain('netz');
    expect(istKanonisch(g.sektionen)).toBe(true);
  });

  /**
   * P6 Speiser-Bindung: der Live-Fall dieses Pakets. Der Deye im
   * Spannungsmodus MISST keinen Ladestand - das gebundene DIYBMS rechnet ihn.
   * Ohne diesen Zweig zeigte die Geräteseite weiter das Schweigen des
   * Wechselrichters, während das Cockpit daneben den gebundenen Wert führt.
   */
  it('B · der gebundene Ladestand steht am Wechselrichter - und sagt, von wem', () => {
    const g = gesicht(input({
      komponenten: [komponente({ role: 'storage', entityId: 'e-batt', reading: null })],
      speicherKnoten: {
        role: 'storage',
        soc_pct: 7.4,
        soc_source: { entity_id: 'e-diy', label: 'DIY-Speicher Keller' },
        flow_active: false,
        members: [{ entity_id: 'e-batt', label: 'Deye SUN-30K', primary: true }],
      } as never,
    }));
    const speicher = g.held.kacheln.find((k) => k.key === 'speicher');
    expect(speicher?.wert).toBe(`7,4${NBSP}%`);
    expect(speicher?.wort).toBe('Ladestand von: DIY-Speicher Keller');
  });

  /** Meldet das Gerät SELBST den Ladestand, ändert P6 nichts. */
  it('B · der eigene Ladestand des Geräts bleibt unangetastet', () => {
    const g = gesicht(input({
      komponenten: [komponente({
        role: 'storage', entityId: 'e-batt',
        reading: { value: 62, unit: '%', caption: 'geladen' } as never,
      })],
      speicherKnoten: {
        role: 'storage',
        soc_pct: 62,
        soc_source: { entity_id: 'e-batt', label: 'Deye SUN-30K' },
        flow_active: false,
        members: [{ entity_id: 'e-batt', label: 'Deye SUN-30K', primary: true }],
      } as never,
    }));
    const speicher = g.held.kacheln.find((k) => k.key === 'speicher');
    expect(speicher?.wert).toBe(`62,0${NBSP}%`);
    expect(speicher?.wort).toBe('geladen');
  });

  /**
   * P6: was das BMS ZULÄSST. Eine gesperrte Richtung erklärt einen ruhenden
   * Speicher, den sonst niemand erklärt - und ein abwesendes Feld wird
   * ÜBERGANGEN, nie als „erlaubt" gelesen.
   */
  it('B · die BMS-Hülle steht neben dem Ladestand, ohne Freigaben zu erfinden', () => {
    const g = gesicht(input({
      komponenten: [komponente({ role: 'storage', entityId: 'e-batt', reading: null })],
      speicherKnoten: {
        role: 'storage',
        flow_active: false,
        limits: {
          source: { entity_id: 'e-diy', label: 'DIY' },
          charge_limit_a: 22,
          discharge_allowed: false,
        },
        members: [],
      } as never,
    }));
    const keys = g.held.kacheln.map((k) => k.key);
    expect(keys).toContain('bms-laden');
    expect(keys).toContain('bms-entladen');
    expect(g.held.kacheln.find((k) => k.key === 'bms-entladen')?.wert).toBe('gesperrt');

    const ohne = gesicht(input({
      komponenten: [komponente({ role: 'storage', entityId: 'e-batt', reading: null })],
      speicherKnoten: { role: 'storage', flow_active: false, members: [] } as never,
    }));
    expect(ohne.held.kacheln.map((k) => k.key)).not.toContain('bms-laden');
  });

  it('⚠ B · was dieses Gerät NICHT misst, bekommt keine Kachel', () => {
    const g = gesicht(input({
      komponenten: [komponente({ role: 'storage', reading: { value: 40, unit: '%', caption: null } as never })],
    }));
    const keys = g.held.kacheln.map((k) => k.key);
    expect(keys).toContain('speicher');
    expect(keys).not.toContain('netz');
    expect(keys).not.toContain('haus');
    // Ohne gemessene Batterieleistung wird sie nicht abgeleitet.
    expect(keys).not.toContain('batterie');
  });

  it('D · der Zähler braucht KEINE Befehle - an ihn geht keiner', () => {
    const g = gesicht(input({
      art: 'quelle',
      geraetId: 'src-zaehler',
      rolle: 'grid-meter',
      communication: 'modbus_tcp',
      komponenten: [komponente({ role: 'grid', entityId: 'e-netz' })],
      src: src({ sourceId: 'src-zaehler', powerKw: -3.4 }),
    }));
    expect(g.gattung).toBe('zaehler');
    expect(g.sektionen).not.toContain('befehle');
    // Der Grund verschwindet nicht, er zieht in die Diagnose (§4.6).
    expect(g.entfallen.find((e) => e.id === 'befehle')?.grund).toBeTruthy();
    // Und ein Zähler wird von niemandem gesteuert.
    expect(g.steuerung).toBe(false);
    expect(g.entfallen.find((e) => e.id === 'steuerung')?.grund).toBeTruthy();
  });

  it('E · die Wallbox führt mit ihrer Ladeleistung und ihrer Erfüllung', () => {
    const g = gesicht(input({
      art: 'quelle',
      geraetId: 'src-goe',
      rolle: 'consumer',
      communication: 'goe_http_api',
      komponenten: [komponente({ role: 'consumer', entityId: 'e-wb', label: 'Wallbox' })],
      src: src({ sourceId: 'src-goe', loadKw: 11 }),
      erfuellung: 'Heute: 1 von 2 Aufgaben erfüllt',
      gemessen: true,
    }));
    expect(g.gattung).toBe('verbraucher');
    expect(g.held.kacheln.map((k) => k.key)).toContain('leistung');
    expect(g.held.zeilen).toContain('Heute: 1 von 2 Aufgaben erfüllt');
    // D3: ohne Messung wird nie „erfüllt" behauptet - hier IST gemessen.
    expect(g.held.zeilen.some((z) => /gemessen/.test(z))).toBe(true);
  });

  it('⚠ E · die SG-Ready-Wärmepumpe zeigt die FREIGABE, nie eine Leistung (P8)', () => {
    const basis = {
      art: 'quelle' as const,
      rolle: 'consumer',
      communication: 'shelly_http',
      komponenten: [komponente({ role: 'consumer', entityId: 'e-wp', label: 'Wärmepumpe' })],
      nachweis: 'freigabe' as const,
    };
    const gesetzt = gesicht(input({
      ...basis,
      // ⚠ Das Relais MELDET eine Leistung (sein eigener Verbrauch) - sie darf
      // nie als „läuft mit X kW" über die Wärmepumpe auftreten.
      src: src({ loadKw: 0.4 }),
      topologie: [{ id: 'e-wp', capabilities: [{ channel: 'relay_on', value: 1 }] }] as never,
    }));
    const kachel = gesetzt.held.kacheln[0];
    expect(kachel.key).toBe('freigabe');
    expect(kachel.label).toBe('Freigabe');
    expect(kachel.wert).toBe('Gesetzt');
    expect(gesetzt.held.satz).toContain('entscheidet sie selbst');
    expect(gesetzt.held.kacheln.some((k) => k.key === 'leistung')).toBe(false);
    // ⚠ KEIN „Energie: …"-Satz - über den Verbrauch wissen wir nichts.
    expect(gesetzt.held.zeilen.some((z) => /Energie/.test(z))).toBe(false);
    expect(gesetzt.held.zeilen.some((z) => /nur die Freigabe/.test(z))).toBe(true);

    const auf = gesicht(input({
      ...basis,
      topologie: [{ id: 'e-wp', capabilities: [{ channel: 'relay_on', value: 0 }] }] as never,
    }));
    expect(auf.held.kacheln[0].wert).toBe('Aufgehoben');
    expect(auf.held.satz).toContain('Normalbetrieb');

    // Ohne gemeldeten Zustand wird NICHTS behauptet.
    const stumm = gesicht(input(basis));
    expect(stumm.held.kacheln[0].wert).toBe('—');
    expect(stumm.held.satz).toContain('keine Freigabe');
  });

  it('⚠ E · ohne Messung sagt das Blatt es, statt Erfüllung zu behaupten', () => {
    const g = gesicht(input({
      art: 'quelle',
      rolle: 'consumer',
      communication: 'shelly_http',
      komponenten: [komponente({ role: 'consumer', entityId: 'e-hz' })],
      gemessen: false,
    }));
    expect(g.held.zeilen.some((z) => /angenommen|ohne Leistungsmessung|nicht gemessen/i.test(z)))
      .toBe(true);
    // Ein HTTP-Gerät hat keine Modbus-Register - die Sektion entfällt MIT Grund.
    expect(g.sektionen).not.toContain('register');
    expect(g.entfallen.find((e) => e.id === 'register')?.grund).toBeTruthy();
  });

  it('⚠ E · ohne gemeldete Erfüllung behauptet das Blatt keine', () => {
    const g = gesicht(input({
      art: 'quelle',
      rolle: 'consumer',
      communication: 'shelly_http',
      komponenten: [komponente({ role: 'consumer', entityId: 'e-hz' })],
    }));
    expect(g.held.zeilen).toEqual([]);
  });

  it('F · die Ladesäule braucht keine Register - sie spricht OCPP', () => {
    const g = gesicht(input({
      art: 'ladepunkt',
      geraetId: 'cp-A1',
      communication: null,
      komponenten: [],
      charger: {
        chargePointId: 'A1',
        connected: true,
        connectors: [],
      } as unknown as ChargePoint,
    }));
    expect(g.gattung).toBe('ladepunkt');
    expect(g.sektionen).not.toContain('register');
    expect(g.entfallen.find((e) => e.id === 'register')?.grund).toMatch(/OCPP|Register/i);
  });

  it('⚠ G · ein Eigenbau hat KEINE Software, die wir lesen könnten', () => {
    const g = gesicht(input({
      art: 'quelle',
      geraetId: 'src-eigen',
      rolle: null,
      communication: 'modbus_tcp',
      komponenten: [komponente({
        role: 'grid',
        entityId: 'e-eigen',
        freigabeFaehig: true,
        channels: [{ raw: 'druck_bar', label: 'Druck' }] as never,
      })],
      topologie: [
        { id: 'e-eigen', capabilities: [{ channel: 'druck_bar', unit: 'bar', value: 2.4 }] },
      ] as never,
    }));
    expect(g.eigenbau).toBe(true);
    expect(g.sektionen).not.toContain('software');
    expect(g.entfallen.find((e) => e.id === 'software')?.grund).toBeTruthy();
    // Seine SELBST definierten Kanäle sind sein Gesicht. ⚠ Der Name kommt aus
    // der geteilten `channelLabel`, die für einen unbekannten Kanal auf den
    // ROHNAMEN zurückfällt - statt ihn zu verstecken oder zu erfinden.
    expect(g.held.kacheln.map((k) => k.key)).toContain('kanal:druck_bar');
    expect(g.held.kacheln.find((k) => k.key === 'kanal:druck_bar')?.wert)
      .toBe(`2,4${NBSP}bar`);
  });

  it('⚠ die Ordnung ist KANONISCH - kein Blatt sortiert um', () => {
    const gattungen = [
      input({ komponenten: [komponente({ role: 'storage' })] }),
      input({ art: 'quelle', rolle: 'pv-generation', komponenten: [komponente({ role: 'pv' })] }),
      input({ art: 'quelle', rolle: 'grid-meter', komponenten: [komponente({ role: 'grid' })] }),
      input({ art: 'quelle', rolle: 'consumer', komponenten: [komponente({ role: 'consumer' })] }),
      input({ art: 'ladepunkt', komponenten: [] }),
    ];
    for (const i of gattungen) expect(istKanonisch(gesicht(i).sektionen)).toBe(true);
  });
});
