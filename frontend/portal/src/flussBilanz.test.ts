import { describe, expect, it } from 'vitest';
import type { PvComposition } from './pvComposition';
import { pvComposition } from './pvComposition';
import { cockpitRollenTopologie } from './pvRolle';
import { jetztFluss } from './flussJetzt';
import { herkunftMoment, satz, type FlussWerte } from './leitungsplan';
import {
  BILANZ_TOLERANZ_KW,
  bilanzRest,
  bilanzToleranz,
  flussBilanz,
  lueckenSatz,
  widerspruchSatz,
  type FlussBilanz,
} from './flussBilanz';
import { EB_KW, ebStand, type EbFall } from './test/flussBilanzFixtures';

const NBSP = ' ';

/** Der Moment, wie das Cockpit ihn seit 07.11.2026 rechnet (`CockpitHero` → `flussBilanz`). */
function bilanz(fall: EbFall = {}): FlussBilanz {
  const s = ebStand(fall);
  return flussBilanz({
    topology: s.topology,
    snapshot: s.snapshot,
    pv: pvComposition(s.topology, s.sources, s.pins),
    rollen: { pv: s.pvRollen, load: s.verbrauchRollen },
  });
}

/** Der Satz des Moments „jetzt“, wie die Bühne ihn bildet. */
function satzJetzt(w: FlussWerte): string | null {
  return satz({ betrieb: 'eigenverbrauch', ansicht: 'jetzt', zeit: 'live', werte: w, herkunft: herkunftMoment(w), uhr: '14:20' });
}

/** Erzeugung + Bezug − Einspeisung − (Laden − Entladen) - was beim Haus ankommt. */
const zufluss = (w: FlussWerte) => (w.pv ?? 0) + (w.grid ?? 0) - (w.batt ?? 0);

describe('Schramm „Zuhause“, 07.11.2026 14:20 (fiktiv nachgestellt): die Zuordnung am PIKO', () => {
  it('Gegenprobe: so rechnete das Cockpit bis heute - die Zuordnung war die ganze Sonne', () => {
    const s = ebStand();
    // Der alte Weg (`CockpitHero` vor dieser Änderung): PV-Knoten aus der Rolle, Haus aus der Box.
    const alt = jetztFluss(cockpitRollenTopologie(s.topology, [s.pvRollen]), s.snapshot, { pvTotalKw: null, loadKanonisch: null });
    expect(alt.werte).toMatchObject({ pv: EB_KW.piko, grid: EB_KW.netz, load: EB_KW.haus, batt: 0 });
    // 1,2 + 5,9 ≠ 9,6: 2,5 kW der drei KACO fehlen in der Sonne, stecken aber im Haus.
    expect(zufluss(alt.werte) - EB_KW.haus).toBeCloseTo(-2.5, 3);
    expect(satzJetzt(alt.werte)).toBe(`Sonne deckt 12${NBSP}% des Verbrauchs, der Rest kommt aus dem Netz.`);
  });

  it('die Zuordnung ersetzt nur die Zahl des PIKO; die drei KACO zählen mit ihrer Messung - der Fluss geht auf', () => {
    const b = bilanz();
    expect(b.werte.pv).toBeCloseTo(EB_KW.piko + EB_KW.kacoOst + EB_KW.kacoMitte + EB_KW.kacoWest, 6);
    expect(b.werte).toMatchObject({ grid: EB_KW.netz, load: EB_KW.haus, batt: 0 });
    // Erzeugung + Bezug − Einspeisung = Verbrauch, aus EINEM Satz von Werten.
    expect(zufluss(b.werte)).toBeCloseTo(b.werte.load!, 6);
    expect(b.restKw).toBeCloseTo(0, 6);
    expect(b.stimmig).toBe(true);
    expect(b.luecken).toEqual([]);
    expect(b.weitereErzeuger.map((p) => [p.label, p.kw])).toEqual([
      ['Kaco West', EB_KW.kacoWest],
      ['Kaco Mitte', EB_KW.kacoMitte],
      ['Kaco Ost', EB_KW.kacoOst],
    ]);
    // Der Satz und seine Prozente folgen denselben Zahlen: 3,68 / 9,62 = 38 %, der Rest (5,94) ist der Bezug.
    expect(satzJetzt(b.werte)).toBe(`Sonne deckt 38${NBSP}% des Verbrauchs, der Rest kommt aus dem Netz.`);
    const h = herkunftMoment(b.werte)!;
    expect(h['pv>load'] + h['grid>load']).toBeCloseTo(b.werte.load!, 6);
  });

  it('ohne Zuordnung ist es dieselbe Erzeugung - eine Zuordnung am eigenen Kanal ändert die Zahl nicht', () => {
    const ohne = bilanz({ zuordnung: 'keine' });
    expect(ohne.werte.pv).toBeCloseTo(bilanz().werte.pv!, 6);
    expect(ohne.weitereErzeuger).toEqual([]);
    expect(ohne.stimmig).toBe(true);
  });

  it('eine Zuordnung über alle Erzeuger bleibt die Zahl des Servers (ein Summenwert zählt einmal)', () => {
    const b = bilanz({ zuordnung: 'alle' });
    expect(b.werte.pv).toBe(3.7);
    expect(b.weitereErzeuger).toEqual([]);
    expect(b.stimmig).toBe(true);
  });

  it('eine stumme Zuordnung lässt die Erzeugung offen und nennt das Gerät - kein Rückfall auf die Rohzahl', () => {
    const b = bilanz({ zuordnungStumm: true });
    expect(b.werte.pv).toBeNull();
    expect(b.restKw).toBeNull();
    expect(b.luecken).toContainEqual({ rolle: 'pv', name: 'Kostal PIKO Scheune', grund: 'liefert gerade nicht' });
    expect(satzJetzt(b.werte)).toBeNull();
  });
});

describe('Ein Teil fehlt oder ist veraltet: das Cockpit sagt es', () => {
  it('ein KACO, den die Box nicht liest, zählt nicht still mit - Haus und Sonne ohne ihn, er wird genannt', () => {
    const b = bilanz({ veraltet: ['eb-kaco-west'] });
    expect(b.werte.pv).toBeCloseTo(EB_KW.piko + EB_KW.kacoOst + EB_KW.kacoMitte, 6);
    expect(b.werte.load).toBeCloseTo(EB_KW.haus - EB_KW.kacoWest, 6);
    expect(b.stimmig).toBe(true);
    expect(b.luecken).toEqual([{ rolle: 'pv', name: 'Kaco West', grund: 'meldet sich gerade nicht' }]);
    expect(lueckenSatz(b.luecken)).toBe('Nicht mitgezählt: Kaco West (meldet sich gerade nicht).');
    // Im Blatt steht er ohne Zahl, mit seinem Grund.
    const west = b.weitereErzeuger.find((p) => p.label === 'Kaco West')!;
    expect(west.kw).toBeNull();
    expect(west.note).toBe('meldet sich gerade nicht');
  });

  it('ohne Zuordnung ebenso: die Zusammensetzung des Blatts zählt ihn nicht, ihre Summe ist der Knoten', () => {
    const b = bilanz({ zuordnung: 'keine', veraltet: ['eb-kaco-west'] });
    const c = b.erzeugung as PvComposition;
    expect(c.totalKw).toBeCloseTo(b.werte.pv!, 6);
    expect(c.parts.map((p) => p.label)).not.toContain('Kaco West');
    expect(c.unmeasured.map((p) => [p.label, p.note])).toContainEqual(['Kaco West', 'meldet sich gerade nicht']);
    expect(zufluss(b.werte)).toBeCloseTo(b.werte.load!, 6);
  });

  it('der Netzzähler allein veraltet: kein Netzwert, keine Aufteilung, der Zähler wird genannt', () => {
    const b = bilanz({ netzVeraltet: true });
    expect(b.werte.grid).toBeNull();
    expect(b.restKw).toBeNull();
    expect(b.luecken).toContainEqual({ rolle: 'grid', name: 'Netzanschluss', grund: 'meldet sich gerade nicht' });
    expect(herkunftMoment(b.werte)).toBeNull();
  });

  it('schweigt die ganze Anlage, bleibt der letzte Stand (die Frische-Marke der Bühne sagt es)', () => {
    const b = bilanz({ stumm: true });
    expect(b.luecken).toEqual([]);
    expect(b.werte.grid).toBe(EB_KW.netz);
    expect(b.werte.pv).toBeCloseTo(bilanz().werte.pv!, 6);
  });

  it('ein zugeordneter Teilverbrauch passt nicht zum Haus: keine Anteile, beide Seiten mit Zahl', () => {
    const b = bilanz({ teilverbrauch: true });
    expect(b.werte.load).toBe(EB_KW.uvHalle);
    expect(b.stimmig).toBe(false);
    expect(b.restKw!).toBeGreaterThan(bilanzToleranz(b.werte));
    expect(widerspruchSatz(b.werte)).toBe(
      `Die Werte passen gerade nicht zusammen: Erzeugung und Bezug liefern 9,6${NBSP}kW, der Verbrauch zeigt 7,9${NBSP}kW. ` +
        'Darum rechnet das Cockpit keine Anteile aus.',
    );
  });
});

describe('Rest und Toleranz', () => {
  it('ein Rest im Messrauschen ist kein Widerspruch, 2,5 kW bei 9,6 kW schon', () => {
    const w = { pv: 1.18, grid: 5.94, batt: 0, load: 9.62 };
    expect(bilanzRest(w)).toBeCloseTo(-2.5, 6);
    expect(bilanzToleranz(w)).toBeCloseTo(0.962, 6);
    expect(bilanzToleranz({ pv: 0.2, grid: 0.3, batt: 0, load: 0.5 })).toBe(BILANZ_TOLERANZ_KW);
    expect(bilanzRest({ ...w, batt: null })).toBeNull();
  });

  it('der Widerspruchssatz nennt, was liefert und was abnimmt - ohne Klemmen auf null', () => {
    expect(widerspruchSatz({ pv: 2, grid: 1, batt: -1, load: 6 })).toContain(
      `Erzeugung, Bezug und Speicher liefern 4,0${NBSP}kW, der Verbrauch zeigt 6,0${NBSP}kW.`,
    );
    // Kein PV-Knoten, Einspeisung 2,1 und Laden 1,2 neben 1,1 kW Verbrauch: 4,4 kW ohne Herkunft.
    expect(widerspruchSatz({ pv: 0, grid: -2.1, batt: 1.2, load: 1.1 })).toContain(
      `Erzeugung liefert 0,0${NBSP}kW, Verbrauch, Einspeisung und Laden zeigen 4,4${NBSP}kW.`,
    );
    expect(widerspruchSatz({ pv: null, grid: 1, batt: 0, load: 6 })).toBeNull();
  });

  it('die Lücken-Zeile nennt höchstens drei Namen und jeden nur einmal', () => {
    const l = ['A', 'B', 'C', 'D'].map((name) => ({ rolle: 'pv' as const, name, grund: 'meldet sich gerade nicht' }));
    expect(lueckenSatz([...l, l[0]])).toBe(
      'Nicht mitgezählt: A (meldet sich gerade nicht), B (meldet sich gerade nicht), C (meldet sich gerade nicht) und 1 weitere.',
    );
    expect(lueckenSatz([])).toBeNull();
  });
});

describe('Ohne Topologie bleibt es beim Schnappschuss', () => {
  it('übernimmt die Werte der Übersicht unverändert', () => {
    const b = flussBilanz({
      topology: null,
      snapshot: { pvKw: 2, loadKw: 3, gridKw: 1, battKw: null, socPct: null, socAt: null },
      pv: null,
    });
    expect(b.werte).toEqual({ pv: 2, load: 3, grid: 1, batt: 0 });
    expect(b.stimmig).toBe(true);
    expect(b.luecken).toEqual([]);
  });
});
