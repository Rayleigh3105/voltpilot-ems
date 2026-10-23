import { describe, expect, it } from 'vitest';
import TAG from './ladeVorschau-tag.json';
import {
  abfahrt, laeufe, ladeVorschau, quantil, vorschauSaetze,
  type VorschauRahmen, type VorschauReihen,
} from './ladeVorschau';
import type { LadeQuelle } from './laden';

/**
 * Die VEKTOREN stammen aus dem Prototyp des Konzepts k1 (`werkzeug/sim.js` mit
 * `werkzeug/tag.json`, hier als `ladeVorschau-tag.json`): die E2E-Beispielanlage
 * am 29.09. ab 13:00 bis morgen 7:00, Wallbox 11 kW, Startleistung 1,4 kW,
 * Speicher 10 kWh / 5 kW, Speicher zuerst, Reserve 1 kWh; Bezugspreis =
 * (Börse + 17 ct) × 1,19, Einspeisewert 7,9 ct. Die Zahlen sind die des
 * Berichts (Abschnitt 2, „Ein Beispieltag“) - weicht die Ableitung ab, fällt
 * dieser Test, nicht die Erklärung.
 */
const bezug = TAG.preis.map((p) => (p + 17) * 1.19);
const R: VorschauReihen = {
  pv: TAG.pv, last: TAG.last, soc: TAG.soc, bezug, einspeise: TAG.pv.map(() => 7.9),
};
const O: VorschauRahmen = {
  t0: 52, t1: 124, maxKw: 11, startKw: 1.4, mindestKw: 1.4,
  speicher: { kapKwh: 10, kw: 5, minPct: 10, reserveKwh: 1 },
  speicherZuerst: true, preisgrenzeCt: quantil(bezug, 0.25), zielKwh: null,
};

describe('ladeVorschau: die Vektoren des Prototyps', () => {
  const faelle: [LadeQuelle, { kwh: number; netz: number; ct: number; laeufe: [number, number][]; s0: [number, number, number] }][] = [
    ['sonne', { kwh: 23.945, netz: 0, ct: 7.9, laeufe: [[52, 70]], s0: [7.4, 0, 0] }],
    ['min', { kwh: 42.845, netz: 18.62, ct: 19.8876, laeufe: [[52, 124]], s0: [7.4, 0, 0] }],
    ['speicher', { kwh: 24.065, netz: 0, ct: 7.9, laeufe: [[52, 61], [69, 70]], s0: [7.4, 3.6, 0] }],
    ['guenstig', { kwh: 33, netz: 13.5375, ct: 14.2236, laeufe: [[52, 64]], s0: [7.4, 0, 3.6] }],
  ];
  for (const [modus, soll] of faelle) {
    it(`${modus}: Menge, Netzanteil, Ø ct/kWh und Ladezeiten`, () => {
      const v = ladeVorschau(modus, R, O);
      expect(v.kwh).toBeCloseTo(soll.kwh, 3);
      expect(v.netzKwh).toBeCloseTo(soll.netz, 3);
      expect(v.ctKwh!).toBeCloseTo(soll.ct, 3);
      expect(laeufe(v)).toEqual(soll.laeufe);
      const s0 = v.slots[0];
      expect([s0.sonne, s0.speicher, s0.netz].map((x) => Math.round(x * 1000) / 1000)).toEqual(soll.s0);
      expect(v.gekuerzt).toBe(false);
      expect(v.schafft).toBeNull();
    });
  }

  it('die Preisgrenze des Beispiels ist das billigste Viertel des Bezugspreises', () => {
    expect(O.preisgrenzeCt!).toBeCloseTo(30.2022, 3);
    const v = ladeVorschau('guenstig', R, O);
    expect(v.slots.filter((s) => s.billig).every((s) => bezug[s.t] < O.preisgrenzeCt!)).toBe(true);
    // Nur „Günstig“ trägt Preisstriche.
    expect(ladeVorschau('sonne', R, O).slots.some((s) => s.billig)).toBe(false);
  });

  const ziele: [LadeQuelle, number, { kwh: number; netz: number; ct: number; fertig: number }][] = [
    ['sonne', 20, { kwh: 20, netz: 0, ct: 7.9, fertig: 65 }],
    ['sonne', 40, { kwh: 40, netz: 16.055, ct: 17.2242, fertig: 115 }],
    ['min', 40, { kwh: 40, netz: 15.775, ct: 18.8992, fertig: 116 }],
    ['speicher', 40, { kwh: 40, netz: 15.935, ct: 16.2592, fertig: 112 }],
    ['guenstig', 20, { kwh: 20, netz: 7.0632, ct: 12.3642, fertig: 60 }],
  ];
  for (const [modus, ziel, soll] of ziele) {
    it(`${modus} mit +${ziel} kWh: erst der Modus, der Rest in den billigsten Viertelstunden`, () => {
      const v = ladeVorschau(modus, R, { ...O, zielKwh: ziel });
      expect(v.kwh).toBeCloseTo(soll.kwh, 3);
      expect(v.netzKwh).toBeCloseTo(soll.netz, 3);
      expect(v.ctKwh!).toBeCloseTo(soll.ct, 3);
      expect(v.fertig).toBe(soll.fertig);
      expect(v.schafft).toBe(true);
    });
  }
});

describe('ladeVorschau: Unbekanntes ist keine Null', () => {
  it('fehlen Sonne oder Verbrauch, endet die Vorschau dort und sagt es', () => {
    const pv = [...TAG.pv] as (number | null)[];
    pv[100] = null;
    const v = ladeVorschau('min', { ...R, pv }, O);
    expect(v.bis).toBe(100);
    expect(v.gekuerzt).toBe(true);
    expect(v.slots).toHaveLength(48);
  });

  it('ohne Bezugspreis gibt es keinen Schnitt, sobald Netzstrom fließt - und Günstig lädt dort nicht', () => {
    const ohne = { ...R, bezug: R.bezug.map(() => null) };
    expect(ladeVorschau('min', ohne, O).ctKwh).toBeNull();
    // Nur Sonne braucht nur den Einspeisewert.
    expect(ladeVorschau('sonne', ohne, O).ctKwh).toBeCloseTo(7.9, 6);
    expect(ladeVorschau('guenstig', ohne, O).netzKwh).toBe(0);
  });

  it('ohne Einspeisewert keinen Schnitt für Sonnenstrom', () => {
    expect(ladeVorschau('sonne', { ...R, einspeise: R.einspeise.map(() => null) }, O).ctKwh).toBeNull();
  });

  it('unbekannter Ladestand: der Speicher bleibt außen vor, „Sonne + Speicher“ lädt wie „Nur Sonne“', () => {
    const ohne = { ...R, soc: R.soc.map(() => null) };
    const sp = ladeVorschau('speicher', ohne, O);
    expect(sp.speicherUnbekannt).toBe(true);
    expect(sp.speicherKwh).toBe(0);
    expect(sp.kwh).toBeCloseTo(ladeVorschau('sonne', ohne, O).kwh, 6);
  });
});

describe('ladeVorschau: Vorrang und Untergrenze', () => {
  it('Autos zuerst: das Auto bekommt den Überschuss vor dem Speicher', () => {
    // Ein halb leerer Speicher: bei „Speicher zuerst“ nimmt er den Mittag.
    const halb = { ...R, soc: R.soc.map(() => 30) };
    const autos = ladeVorschau('sonne', halb, { ...O, speicherZuerst: false });
    const speicher = ladeVorschau('sonne', halb, O);
    expect(autos.kwh).toBeGreaterThan(speicher.kwh);
    expect(autos.netzKwh).toBe(0);
  });

  it('trägt der Fahrplan eine Untergrenze, gilt sie - null heißt dort keine Freigabe', () => {
    // Plan: bis 15:00 darf der Speicher bis 20 % herunter, danach gibt er nichts frei.
    const grenze = TAG.pv.map((_, t) => (t >= 52 && t < 60 ? 20 : null));
    const v = ladeVorschau('speicher', { ...R, grenze }, O);
    expect(v.grenzeAusPlan).toBe(true);
    expect(v.slots.filter((s) => s.t >= 60).every((s) => s.speicher === 0)).toBe(true);
    expect(v.speicherKwh).toBeGreaterThan(0);
    expect(ladeVorschau('speicher', R, O).grenzeAusPlan).toBe(false);
  });
});

describe('abfahrt', () => {
  it('ohne Ziel: der nächste Morgen 7:00', () => {
    expect(abfahrt(52, null, 192)).toBe(124);
  });
  it('ohne Ziel am frühen Morgen: der Morgen danach (mindestens vier Stunden)', () => {
    expect(abfahrt(20, null, 192)).toBe(124);
    expect(abfahrt(0, null, 192)).toBe(28);
  });
  it('mit Ziel: dessen Uhrzeit, heute oder morgen', () => {
    expect(abfahrt(52, '18:00', 192)).toBe(72);
    expect(abfahrt(52, '06:00', 192)).toBe(120);
  });
  it('nie hinter das Raster', () => {
    expect(abfahrt(95, '07:00', 110)).toBe(110);
  });
});

describe('vorschauSaetze', () => {
  it('sagt, was jetzt passiert und wann Pause ist', () => {
    expect(vorschauSaetze(ladeVorschau('sonne', R, O), 124)).toEqual({ jetzt: 'Jetzt 7,4 kW aus Sonne', dann: 'Pause ab 17:30 Uhr' });
    expect(vorschauSaetze(ladeVorschau('min', R, O), 124).dann).toBe('durchgehend bis 7:00');
    expect(vorschauSaetze(ladeVorschau('speicher', R, O), 124)).toEqual({ jetzt: 'Jetzt 11,0 kW aus Sonne + Speicher', dann: 'Pause 15:15 bis 17:15 Uhr' });
    expect(vorschauSaetze(ladeVorschau('guenstig', R, O), 124)).toEqual({ jetzt: 'Jetzt 11,0 kW aus Sonne + Netz', dann: 'Pause ab 16:00 Uhr' });
  });
  it('lädt nichts, sagt es das', () => {
    const nacht = { ...R, pv: R.pv.map(() => 0) };
    expect(vorschauSaetze(ladeVorschau('sonne', nacht, O), 124)).toEqual({ jetzt: 'Lädt bis 7:00 nicht', dann: null });
  });
});
