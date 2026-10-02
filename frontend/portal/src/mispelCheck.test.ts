import { describe, expect, it } from 'vitest';
import fixtures from '../e2e/mispel-check-fixtures.json';
import { fensterText, jahresEuro, kurzfassung, spanneLage, type MispelCheckAnsicht } from './mispelCheck';

const NBSP = String.fromCharCode(160);
const a4 = fixtures.a4 as MispelCheckAnsicht;
const a2 = fixtures.a2 as MispelCheckAnsicht;

describe('MiSpeL-Check (MP-48, BK-48 Variante A)', () => {
  it('ohne Ergebnis „wird gerechnet“ — nie 0 €', () => {
    expect(kurzfassung(null)).toEqual({ art: 'wird_gerechnet' });
    const leer: MispelCheckAnsicht = { ...a4, stand: 'wird_gerechnet', differenz: null, posten: [] };
    expect(kurzfassung(leer)).toEqual({ art: 'wird_gerechnet' });
    // „fertig“ ohne Beträge verbietet die Datenbank; käme es doch, bleibt es beim Warten statt 0 €.
    expect(kurzfassung({ ...a4, differenz: null })).toEqual({ art: 'wird_gerechnet' });
  });

  it('positives Ergebnis (Kundentyp a4): Betrag, Urteil, Grund, Spanne', () => {
    const k = kurzfassung(a4);
    if (k.art !== 'ergebnis') throw new Error(k.art);
    expect(k.ton).toBe('plus');
    expect(k.betrag).toBe(`+${NBSP}1.899${NBSP}€`);
    expect(k.urteil).toBe('Lohnt sich für diese Anlage voraussichtlich.');
    expect(k.grund).toBe(
      `+${NBSP}2.749${NBSP}€ Handel trägt −${NBSP}850${NBSP}€ für Zähler und Bilanzkreis. Der Jahresmarktwert kostet bei dieser Anlage nichts.`,
    );
    expect([k.ungunstig, k.mittel, k.guenstig]).toEqual([158, 1899, 8043]);
    expect(k.fenster).toBe('10/2025–09/2026');
    expect(k.summe).toBe(1899);
    expect(k.posten.map((p) => p.wort)).toEqual([
      'Netzladen-Handel mit Saldierung',
      'Jahresmarktwert statt Monatsmarktwert',
      'Zweiter Zähler Z2',
      'Gesonderter Bilanzkreis',
    ]);
    expect(k.angenommen).toEqual(['Formelsatz A1 (noch nicht gewählt)']);
  });

  it('negatives Ergebnis (Kundentyp a2): ein Minus steht nie allein', () => {
    const k = kurzfassung(a2);
    if (k.art !== 'ergebnis') throw new Error(k.art);
    expect(k.ton).toBe('minus');
    expect(k.betrag).toBe(`−${NBSP}555${NBSP}€`);
    expect(k.urteil).toBe('Lohnt sich für diese Anlage voraussichtlich nicht.');
    expect(k.grund).toBe(
      `+${NBSP}330${NBSP}€ Handel trägt −${NBSP}885${NBSP}€ für Jahresmarktwert, Zähler und Bilanzkreis nicht. ` +
        'Sie können trotzdem wechseln — etwa für Rechtssicherheit beim Mischen.',
    );
    expect([k.ungunstig, k.guenstig]).toEqual([-1321, 691]);
    expect(k.summe).toBe(-555);
    expect(k.angenommen).toEqual([`Jahresverbrauch 60.000${NBSP}kWh (Konzept § 3 a2)`]);
  });

  it('die Summe der Posten ist der Unterschied jedes Falls (Vertrag § 3)', () => {
    for (const f of [a4, a2]) {
      for (const fall of ['niedrig', 'mittel', 'hoch'] as const) {
        const summe = f.posten.reduce((s, p) => s + (p[`${fall}_eur`] ?? 0), 0);
        expect(summe).toBe(f.differenz?.[`${fall}_eur`]);
      }
    }
  });

  it('fehlgeschlagen und nicht unterstützt sprechen einen Satz, keinen Betrag', () => {
    const f = kurzfassung({ ...a4, stand: 'fehlgeschlagen', differenz: null, hinweis: null });
    expect(f).toEqual({ art: 'hinweis', stand: 'fehlgeschlagen', satz: 'Der Check konnte für diese Anlage nicht gerechnet werden.' });
    const n = kurzfassung({ ...a4, stand: 'nicht_unterstuetzt', differenz: null, hinweis: 'Formelsatz A5: noch nicht unterstützt.' });
    expect(n).toEqual({ art: 'hinweis', stand: 'nicht_unterstuetzt', satz: 'Formelsatz A5: noch nicht unterstützt.' });
  });

  it('Euro im Jahr ganz, mit echtem Minus; 0 € ohne Vorzeichen', () => {
    expect(jahresEuro(-1320.5)).toBe(`−${NBSP}1.321${NBSP}€`);
    expect(jahresEuro(0.4)).toBe(`0${NBSP}€`);
    expect(jahresEuro(8043)).toBe(`+${NBSP}8.043${NBSP}€`);
    expect(fensterText('2025-10-01', '2026-09-30')).toBe('10/2025–09/2026');
    expect(fensterText(null, '2026-09-30')).toBeNull();
  });

  it('die Achse der Spanne schließt 0 € immer ein', () => {
    const p = spanneLage(158, 1899, 8043);
    expect(p.null).toBeLessThan(p.von);
    expect(p.von).toBeLessThan(p.mitte);
    expect(p.mitte).toBeLessThan(p.bis);
    const n = spanneLage(-1321, -555, 691);
    expect(n.von).toBeLessThan(n.mitte);
    expect(n.mitte).toBeLessThan(n.null);
    expect(n.null).toBeLessThan(n.bis);
    for (const v of [p, n]) for (const x of Object.values(v)) expect(x).toBeGreaterThan(0), expect(x).toBeLessThan(100);
  });
});
