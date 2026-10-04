import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  aktuellerZeitraum,
  bandGeometrie,
  jahresstand,
  naechsteKwh,
  pauschalgrenzen,
  rumpfjahrGrenzen,
  sommertage,
  standChip,
  type PauschalStand,
} from './mispelPauschal';

/**
 * Die Pauschalgrenzen und das Rumpfjahr des Portals (MP-27) gegen die Vektoren des Vertrags
 * `docs/contracts/v2/mispel-pauschal-vectors.json` — dieselben Fälle, die Java und Python prüfen (A2 S. 12, S. 28–30,
 * S. 54–56). Werte der Vektoren sind ungerundete Brüche; verglichen wird auf 1e-9.
 */
const vektoren = JSON.parse(
  readFileSync(resolve(process.cwd(), '../../docs/contracts/v2/mispel-pauschal-vectors.json'), 'utf8'),
) as {
  pauschalgrenzen: { name: string; formelsatz: string; stammdaten: { Pinst: number; SKinst: number }; erwartet: Record<string, number | string> }[];
  faelle: { name: string; stammdaten: Record<string, number>; rumpfjahre?: { von: string; bis: string; stammdaten: { Pinst: number; SKinst: number } }[]; erwartet: { jahre: Record<string, Record<string, number | string>> } }[];
};

function wert(v: number | string): number {
  if (typeof v === 'number') return v;
  const [z, n] = v.split('/').map(Number);
  return n === undefined ? z : z / n;
}

describe('Pauschalgrenzen (A2 S. 28–30) gegen die Vertragsvektoren', () => {
  it.each(vektoren.pauschalgrenzen.map((f) => [f.name, f] as const))('%s', (_name, f) => {
    const g = pauschalgrenzen('P1', f.stammdaten.Pinst, f.stammdaten.SKinst)!;
    expect(g.p1).toBeCloseTo(wert(f.erwartet['(P1)']), 9);
    expect(g.p2).toBeCloseTo(wert(f.erwartet['(P2)P1']), 9);
    expect(g.p3).toBeCloseTo(wert(f.erwartet['(P3)']), 9);
    expect(g.p4).toBeCloseTo(wert(f.erwartet['(P4)']), 9);
  });

  it('P2 rechnet mit 0,2, P3 mit MIN [ (P2)P1 ; 0,2 ]; unbekannt ist keine Null', () => {
    expect(pauschalgrenzen('P2', 10, null)?.p2).toBe(0.2);
    expect(pauschalgrenzen('P3', 10, 2)?.p2).toBe(0.2);
    expect(pauschalgrenzen('P3', 10, 10)?.p2).toBeCloseTo(0.1, 12);
    expect(pauschalgrenzen('P1', null, 10)).toBeNull();
    expect(pauschalgrenzen('P1', 10, null)).toBeNull();
  });
});

describe('Rumpfjahr (A2 S. 54–56) gegen den Beispielsfall der BNetzA', () => {
  const fall = vektoren.faelle.find((f) => f.name === 'bnetza-rumpfjahre-zweiter-speicher-am-16-mai')!;
  it.each(fall.rumpfjahre!.map((r) => [`${r.von}/${r.bis}`, r] as const))('%s', (schluessel, r) => {
    const e = fall.erwartet.jahre[schluessel];
    const g = pauschalgrenzen('P1', r.stammdaten.Pinst, r.stammdaten.SKinst)!;
    const rj = rumpfjahrGrenzen(r.von, r.bis, g);
    expect(rj.sommer).toBe(wert(e['(P19)R']));
    expect(rj.tage).toBe(wert(e['(P22)R']));
    expect(rj.p1r).toBeCloseTo(wert(e['(P1)R']), 9);
    expect(rj.p3r).toBeCloseTo(wert(e['(P3)R']), 9);
    expect(rj.p4r).toBeCloseTo(wert(e['(P4)R']), 9);
  });

  it('Sommerperiode 1. April bis 30. September, beide Tage eingeschlossen', () => {
    expect(sommertage('2027-01-01', '2027-12-31')).toBe(183);
    expect(sommertage('2027-11-01', '2027-12-31')).toBe(0);
    expect(sommertage('2027-07-01', '2027-12-31')).toBe(92);
  });
});

function stand(jahreswerte: Record<string, number | null>, teil: Partial<PauschalStand> = {}): PauschalStand {
  return {
    tag_von: '2028-01-01',
    tag_bis: '2028-12-31',
    rumpfjahr: false,
    fassung: 1,
    formelsatz: 'P1',
    basisfall: 'P1',
    stand: 'vorlaeufig',
    stand_gruende: ['zeitraum_offen'],
    wertequelle: 'geraet',
    viertelstunden_erwartet: 35136,
    viertelstunden_gerechnet: 23424,
    gerechnet_am: '2028-09-01T03:00:00Z',
    stammdaten: { Pinst: 10, SKinst: 10 },
    jahreswerte,
    ...teil,
  };
}

const GRENZEN = { '(P1)': 5000, '(P3)': 500, '(P4)': 5500 };

describe('Jahresstand: wo das Jahr steht (A2 Abb. 1)', () => {
  it('förderfähig: Strich bei (P14), die nächste kWh bekommt die Marktprämie', () => {
    const j = jahresstand(stand({ ...GRENZEN, '(P14)': 3900, '(P15)': 3900, '(P7)': 4030, '(P9)': 1480, '(P10)': 0, '(P11)': 1480 }));
    expect(j.bereich).toBe('foerderfaehig');
    expect(j.marke).toBe(3900);
    expect(naechsteKwh(j)?.titel).toBe('Die nächste eingespeiste kWh bekommt die Marktprämie');
    const g = bandGeometrie(j);
    expect(g.foerder + g.indifferent + g.saldo).toBeCloseTo(100, 9);
    expect(g.marke!).toBeLessThan(g.foerder);
  });

  it('indifferent: über (P1), unter (P4) — die nächsten kWh bringen nur den Marktwert', () => {
    const j = jahresstand(stand({ ...GRENZEN, '(P14)': 5120, '(P15)': 5000, '(P7)': 5120, '(P9)': 1890, '(P10)': 0, '(P11)': 1890 }));
    expect(j.bereich).toBe('indifferent');
    expect(j.indifferent).toBe(120);
    expect(naechsteKwh(j)?.titel).toBe(`Die nächsten 380${String.fromCharCode(160)}kWh bringen nur den Marktwert`);
  });

  it('saldierungsfähig: über (P4); mit ausgeschöpftem Netzbezug (P10) = (P9) sagt die Karte das', () => {
    const j = jahresstand(stand({ ...GRENZEN, '(P14)': 6600, '(P15)': 5000, '(P7)': 6800, '(P8)': 1300, '(P9)': 1200, '(P10)': 1200, '(P11)': 0 }));
    expect(j.bereich).toBe('saldierungsfaehig');
    expect(j.marke).toBe(6800);
    expect(naechsteKwh(j)?.titel).toBe('Ihr Netzbezug ist ausgeschöpft');
  });

  it('Rumpfjahr: (P1)R und (P4)R treten an die Stelle von (P1) und (P4) (Regel rumpfjahre)', () => {
    const j = jahresstand(
      stand(
        { ...GRENZEN, '(P1)R': 2514, '(P3)R': 252, '(P4)R': 2766, '(P14)': 2600, '(P15)': 2514, '(P7)': 2600 },
        { tag_von: '2027-07-01', tag_bis: '2027-12-31', rumpfjahr: true },
      ),
    );
    expect(j.foerderName).toBe('(P1)R');
    expect(j.foerdergrenze).toBe(2514);
    expect(j.bereich).toBe('indifferent');
  });

  it('unbekannt ist keine Null: ohne (P14) kein Bereich, kein Strich', () => {
    const j = jahresstand(stand({ ...GRENZEN, '(P14)': null }));
    expect(j.bereich).toBeNull();
    expect(j.marke).toBeNull();
    expect(naechsteKwh(j)).toBeNull();
  });

  it('der Zeitraum mit heute darin trägt das Jahr; sonst der jüngste', () => {
    const a = stand({}, { tag_von: '2027-01-01', tag_bis: '2027-05-16' });
    const b = stand({}, { tag_von: '2027-05-17', tag_bis: '2027-12-31' });
    expect(aktuellerZeitraum([a, b], '2027-03-01')).toBe(a);
    expect(aktuellerZeitraum([a, b], '2028-02-01')).toBe(b);
    expect(aktuellerZeitraum([], '2027-03-01')).toBeNull();
  });

  it('Stand: vorläufig mit Grund in Kundendeutsch, die EU-Genehmigung ausdrücklich', () => {
    expect(standChip(stand({}, { stand_gruende: ['eu_genehmigung_ausstehend'] })).text).toBe('vorläufig · EU-Genehmigung ausstehend');
    expect(standChip(stand({}, { stand: 'endgueltig', stand_gruende: [] }))).toEqual({ text: 'endgültig · Messstellenbetreiber', ton: 'ok' });
  });
});
