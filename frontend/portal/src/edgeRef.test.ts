import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KENNUNG_ALPHABET,
  KENNUNG_PRAEFIX,
  kennungFehler,
  kennungGueltig,
  kennungSendbar,
  pruefeKennung,
  pruefzeichen,
} from './edgeRef';

/**
 * Der Portal-Zwilling von `EdgeRef.java` gegen die GETEILTEN Vektoren, die auch der Go-Erzeuger und
 * die API lesen (`docs/contracts/edge-ref-vectors.json`). B4 (Anlage-Flow a1): `k7m2xq3`,
 * `edgek7m2xq3` und `edge-k7m2xq1` legten Geister-Geräte an (`belege/kennung-api.txt`).
 */
const vektoren = JSON.parse(
  readFileSync(resolve(__dirname, '../../../docs/contracts/edge-ref-vectors.json'), 'utf8'),
) as {
  alphabet: string;
  praefix: string;
  gueltig: string[];
  ungueltig: { kennung: string; grund: string }[];
  eingabe: { faelle: { getippt: string; kennung: string }[] };
};

describe('Kennung einer Box (B4)', () => {
  it('Alphabet und Präfix wie Box und API', () => {
    expect(KENNUNG_ALPHABET).toBe(vektoren.alphabet);
    expect(KENNUNG_PRAEFIX).toBe(vektoren.praefix);
  });

  it.each(vektoren.gueltig)('gültig: %s', (kennung) => {
    expect(kennungGueltig(kennung)).toBe(true);
    expect(pruefzeichen(kennung.slice(5, 11))).toBe(kennung[11]);
    expect(pruefeKennung(kennung)).toEqual({ kennung, zustand: 'gueltig' });
  });

  it.each(vektoren.ungueltig)('ungültig für den Server: $kennung ($grund)', ({ kennung }) => {
    expect(kennungGueltig(kennung)).toBe(false);
  });

  it.each(vektoren.eingabe.faelle)('Eingabe „$getippt“ wird $kennung', ({ getippt, kennung }) => {
    const p = pruefeKennung(getippt);
    expect(p.kennung).toBe(kennung);
    expect(kennungSendbar(p)).toBe(true);
  });

  it('die Tippfehler aus der Nachstellung: nie sendbar, der Satz nennt den Grund', () => {
    const eins = pruefeKennung('edge-k7m2xq1');
    expect(eins.zustand).toBe('zeichen');
    expect(kennungFehler(eins, false)).toBe('Diese Kennung stimmt nicht. Eine Kennung enthält kein 0, 1, i, l oder o.');
    const falsch = pruefeKennung('edge-k7m2xqz');
    expect(falsch.zustand).toBe('pruefzeichen');
    expect(kennungSendbar(falsch)).toBe(false);
    expect(kennungFehler(falsch, false)).toMatch(/^Diese Kennung stimmt nicht\./);
  });

  it('beim Tippen kein Fehler, solange die Kennung nur unvollständig ist', () => {
    for (const teil of ['e', 'ed', 'edg', 'edge', 'edge-', 'edge-k7', 'edgek7m', 'k7m2xq']) {
      const p = pruefeKennung(teil);
      expect(p.zustand, teil).toBe('unvollstaendig');
      expect(kennungFehler(p, false), teil).toBeNull();
    }
    expect(kennungFehler(pruefeKennung('edge-k7'), true)).toBe('Die Kennung hat nach „edge-“ sieben Zeichen.');
    expect(kennungFehler(pruefeKennung(''), true)).toBe('Bitte tragen Sie die Kennung Ihrer Box ein.');
  });
});
