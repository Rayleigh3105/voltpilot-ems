import { describe, expect, it } from 'vitest';
import { swapInit, swapNext, swapRendered, swapSettle, type SwapState } from './swapNumber';

/**
 * Der Wächter des Zahlenwechsels (Bewegungs-Programm P3).
 *
 * Die eine Frage, die er beantwortet: **kann im DOM je ein Wert stehen, den
 * niemand geschickt hat?** Ein Count-up täte genau das — und deshalb ist der
 * Beweis hier eine Mengen-Aussage über zufällige Folgen, nicht eine Handvoll
 * Beispiele.
 */
describe('swapNumber', () => {
  it('startet mit dem Wert und ohne Vorgaenger', () => {
    const s = swapInit('12,4 kW');
    expect(s.value).toBe('12,4 kW');
    expect(s.prev).toBeNull();
    expect(s.seq).toBe(0);
    expect(swapRendered(s)).toEqual(['12,4 kW']);
  });

  it('haelt bei einem Wechsel BEIDE echten Werte nebeneinander', () => {
    const s = swapNext(swapInit('12,4 kW'), '13,1 kW');
    expect(s.value).toBe('13,1 kW');
    expect(s.prev).toBe('12,4 kW');
    expect(s.seq).toBe(1);
    expect(swapRendered(s)).toEqual(['13,1 kW', '12,4 kW']);
  });

  it('ist bei GLEICHEM Wert ein No-op - dasselbe Objekt, keine Bewegung', () => {
    const a = swapInit('0,0 kW');
    expect(swapNext(a, '0,0 kW')).toBe(a);
    const b = swapNext(a, '1,0 kW');
    expect(swapNext(b, '1,0 kW')).toBe(b);
  });

  it('zaehlt WECHSEL, nicht Werte - hin und zurueck gibt zwei Schluessel', () => {
    const a = swapInit('A');
    const b = swapNext(a, 'B');
    const c = swapNext(b, 'A');
    expect([a.seq, b.seq, c.seq]).toEqual([0, 1, 2]);
    // Ohne diese Regel liefe der dritte Wechsel unter demselben React-Key und
    // damit ohne Animation ab.
    expect(c.seq).not.toBe(a.seq);
  });

  it('laesst den Vorgaenger nach dem Ausblenden fallen, ohne seq zu bewegen', () => {
    const s = swapSettle(swapNext(swapInit('A'), 'B'));
    expect(s.prev).toBeNull();
    expect(s.value).toBe('B');
    expect(s.seq).toBe(1);
    expect(swapRendered(s)).toEqual(['B']);
  });

  it('ist beim Aufraeumen ohne Vorgaenger ein No-op', () => {
    const s = swapInit('A');
    expect(swapSettle(s)).toBe(s);
  });

  it('ZEIGT NIE EINEN ZWISCHENWERT - ueber 500 zufaellige Folgen gemessen', () => {
    // Werte, die sich als Zahlen zum Interpolieren anboeten: ein Count-up
    // zwischen 0 und 100 wuerde "37" erfinden, das hier nie vorkommt.
    const pool = ['0 %', '100 %', '4,20 €', '-1,80 €', '12,4 kW', '–'];
    const seen = new Set<string>();
    let rng = 1234567;
    const next = () => {
      rng = (rng * 1103515245 + 12345) % 2147483648;
      return rng / 2147483648;
    };
    for (let run = 0; run < 500; run += 1) {
      let s: SwapState = swapInit(pool[Math.floor(next() * pool.length)]);
      swapRendered(s).forEach((v) => seen.add(v));
      for (let step = 0; step < 12; step += 1) {
        s = swapNext(s, pool[Math.floor(next() * pool.length)]);
        swapRendered(s).forEach((v) => seen.add(v));
        if (next() < 0.5) {
          s = swapSettle(s);
          swapRendered(s).forEach((v) => seen.add(v));
        }
      }
    }
    // Jede je gerenderte Zeichenkette war eine EINGABE.
    seen.forEach((v) => expect(pool).toContain(v));
    // Und der Test ist nicht vakuum: er hat wirklich alle Werte gesehen.
    expect(seen.size).toBe(pool.length);
  });

  it('behandelt einen Leerwert wie jeden anderen (kein Sonderfall)', () => {
    const s = swapNext(swapInit(''), '1');
    expect(swapRendered(s)).toEqual(['1', '']);
  });
});
