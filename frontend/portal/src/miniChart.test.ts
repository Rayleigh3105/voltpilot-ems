import { describe, expect, it } from 'vitest';
import {
  MINI_HEIGHT,
  SHARE_HEIGHT,
  VISIBILITY_PX,
  miniBars,
  miniDomain,
  miniLine,
  type MiniPoint,
} from './miniChart';

/**
 * Diese Suite nagelt die EHRLICHKEITS-Garantien des Mini-Systems fest, nicht
 * die einzelnen Pixel. Die vier Regeln, wegen derer es die Datei gibt:
 * echte Nulllinie · negative Werte hängen darunter · keine Mindesthöhen-
 * Fälschung · Lücken bleiben Lücken.
 */

const p = (key: string, value: number | null, label?: string): MiniPoint => ({
  key,
  value,
  label,
});

describe('miniDomain (Null ist immer im Bild)', () => {
  it('schliesst die Null ein, auch wenn alle Werte positiv sind', () => {
    expect(miniDomain([3, 5, 4])).toEqual({ min: 0, max: 5, hasNegative: false });
  });

  it('schliesst die Null ein, auch wenn alle Werte negativ sind', () => {
    expect(miniDomain([-3, -5])).toEqual({ min: -5, max: 0, hasNegative: true });
  });

  it('meldet null, wenn kein einziger endlicher Wert vorliegt', () => {
    expect(miniDomain([null, undefined, Number.NaN])).toBeNull();
  });

  it('ignoriert Lücken statt sie als 0 zu zählen', () => {
    // Wären Lücken 0, käme hier min 0 heraus und die Reihe sähe aus, als habe
    // sie einen Nullwert gehabt.
    expect(miniDomain([4, null, 6])?.hasNegative).toBe(false);
    expect(miniDomain([-4, null, -6])?.min).toBe(-6);
  });
});

describe('miniBars · der Verlusttag hängt unter der Nulllinie', () => {
  // Die Zahlen des abgenommenen Mockups (`sparks.svg`): 14 Tage bis 3,60 €
  // mit EINEM Verlusttag von −0,40 €. Genau dieser Fall wurde vorher per
  // `Math.max(0, …)` auf 0 geklemmt - der Verlusttag war ein Nulltag.
  const view = miniBars([p('mo', 3.6), p('di', -0.4), p('mi', 2.0)], {
    height: MINI_HEIGHT.spark,
  })!;

  it('zeichnet eine ECHTE Nulllinie zwischen Gewinn und Verlust', () => {
    expect(view.hasNegative).toBe(true);
    expect(view.zeroY).toBeGreaterThan(0);
    expect(view.zeroY).toBeLessThan(MINI_HEIGHT.spark);
  });

  it('hängt den Verlusttag UNTER die Nulllinie, statt ihn auf 0 zu klemmen', () => {
    const verlust = view.bars[1];
    expect(verlust.sign).toBe(-1);
    // Er beginnt AN der Nulllinie und wächst nach unten - egal ob als Balken
    // oder (wie hier, 0,40 gegen 3,60 auf 18 px) als Sichtbarkeits-Strich.
    expect(verlust.y).toBeCloseTo(view.zeroY, 5);
    expect(verlust.h).toBeGreaterThan(0);
    expect(verlust.y + verlust.h).toBeLessThanOrEqual(MINI_HEIGHT.spark + 1e-9);
  });

  it('zeichnet den Verlusttag als echten Balken, sobald die Fläche hoch genug ist', () => {
    const gross = miniBars([p('mo', 3.6), p('di', -0.4)], {
      height: MINI_HEIGHT.streifen,
    })!;
    expect(gross.bars[1].form).toBe('bar');
    expect(gross.bars[1].y).toBeCloseTo(gross.zeroY, 5);
  });

  it('lässt die positiven Balken auf der Nulllinie ENDEN', () => {
    const gewinn = view.bars[0];
    expect(gewinn.y + gewinn.h).toBeCloseTo(view.zeroY, 5);
  });

  it('ordnet die Höhen nach den Werten - der grösste Wert ist der höchste Balken', () => {
    expect(view.bars[0].h).toBeGreaterThan(view.bars[2].h);
  });

  it('hält die Balken-VERHÄLTNISSE exakt, obwohl die Achse Luft für den Strich bekommt', () => {
    // Die Reserve skaliert alle Balken mit demselben Faktor - 3,60 zu 2,00
    // bleibt 1,8 : 1.
    expect(view.bars[0].h / view.bars[2].h).toBeCloseTo(3.6 / 2.0, 5);
  });
});

describe('miniBars · keine Mindesthöhen-Fälschung', () => {
  it('gibt einem zu kleinen Wert eine eigene FORM statt einer erfundenen Höhe', () => {
    // 0,01 gegen einen Bereich bis 100 wäre auf 18 px ~0,002 px hoch.
    const view = miniBars([p('a', 100), p('b', 0.01)], { height: MINI_HEIGHT.spark })!;
    expect(view.bars[1].form).toBe('tick');
    expect(view.bars[1].h).toBe(VISIBILITY_PX);
    // Der Strich sitzt AN der Nulllinie, nicht irgendwo darüber - er behauptet
    // keine Grösse.
    expect(view.bars[1].y + view.bars[1].h).toBeCloseTo(view.zeroY, 5);
  });

  it('legt den Strich eines winzigen VERLUSTS unter die Nulllinie, nie darüber', () => {
    // Der Fall, an dem die Reserve hängt: ohne sie läge die Nulllinie bei
    // y = 17,998 und der Strich würde nach oben geklemmt - ein Verlust läse
    // sich dann als Gewinn.
    const view = miniBars([p('a', 100), p('b', -0.01)], { height: MINI_HEIGHT.spark })!;
    expect(view.bars[1].form).toBe('tick');
    expect(view.bars[1].sign).toBe(-1);
    expect(view.bars[1].y).toBeGreaterThanOrEqual(view.zeroY - 1e-9);
    expect(view.bars[1].y + view.bars[1].h).toBeLessThanOrEqual(MINI_HEIGHT.spark + 1e-9);
  });

  it('lässt umgekehrt einem winzigen GEWINN neben einem grossen Verlust Platz nach oben', () => {
    const view = miniBars([p('a', -100), p('b', 0.01)], { height: MINI_HEIGHT.spark })!;
    expect(view.bars[1].sign).toBe(1);
    expect(view.bars[1].y).toBeGreaterThanOrEqual(0);
    expect(view.bars[1].y + view.bars[1].h).toBeLessThanOrEqual(view.zeroY + 1e-9);
  });

  it('macht aus einer Reihe aus lauter Nullen STRICHE, nie Balken', () => {
    const view = miniBars([p('a', 0), p('b', 0)], { height: MINI_HEIGHT.spark })!;
    expect(view.bars.every((b) => b.form === 'tick')).toBe(true);
    expect(view.bars.every((b) => b.sign === 0)).toBe(true);
  });

  it('hält jeden Strich innerhalb der Flaeche', () => {
    for (const vals of [[5, 0.001], [-5, -0.001], [0]]) {
      const view = miniBars(
        vals.map((v, i) => p(String(i), v)),
        { height: MINI_HEIGHT.micro },
      )!;
      for (const b of view.bars) {
        expect(b.y).toBeGreaterThanOrEqual(0);
        expect(b.y + b.h).toBeLessThanOrEqual(MINI_HEIGHT.micro + 1e-9);
      }
    }
  });

  it('zieht einen echten Balken NICHT auf die Strich-Höhe hoch', () => {
    const view = miniBars([p('a', 10), p('b', 5)], { height: MINI_HEIGHT.spark })!;
    expect(view.bars[1].form).toBe('bar');
    expect(view.bars[1].h).toBeCloseTo(MINI_HEIGHT.spark / 2, 5);
  });
});

describe('miniBars · Lücken bleiben Lücken', () => {
  it('zeichnet für null GAR NICHTS, nie einen Nullbalken', () => {
    const view = miniBars([p('a', 3), p('b', null), p('c', 4)], {
      height: MINI_HEIGHT.spark,
    })!;
    expect(view.bars[1].form).toBe('gap');
    expect(view.bars[1].h).toBe(0);
    // Ein Nullbalken wäre ein `tick` mit sign 0 - genau der Unterschied.
    expect(view.bars[1].value).toBeNull();
  });

  it('meldet null, wenn die ganze Reihe leer ist', () => {
    expect(miniBars([p('a', null)], { height: MINI_HEIGHT.spark })).toBeNull();
  });
});

describe('miniBars · Betonung und Vergangenheit', () => {
  const pts = [p('7', 1), p('8', 2), p('9', 3), p('10', 4)];

  it('betont genau den benannten Punkt', () => {
    const view = miniBars(pts, { height: MINI_HEIGHT.spark, emphasisKey: '10' })!;
    expect(view.bars.map((b) => b.emphasis)).toEqual([false, false, false, true]);
  });

  it('dimmt alles VOR dem Jetzt-Punkt, den Jetzt-Punkt selbst aber nicht', () => {
    const view = miniBars(pts, { height: MINI_HEIGHT.spark, nowKey: '9' })!;
    expect(view.bars.map((b) => b.past)).toEqual([true, true, false, false]);
  });

  it('dimmt nichts, wenn der Jetzt-Punkt gar nicht in der Reihe liegt', () => {
    const view = miniBars(pts, { height: MINI_HEIGHT.spark, nowKey: 'gibt-es-nicht' })!;
    expect(view.bars.some((b) => b.past)).toBe(false);
  });
});

describe('miniLine (der MiniTrend-Vertrag, verallgemeinert)', () => {
  it('beendet ein Segment an einer Lücke, statt darüber hinwegzuzeichnen', () => {
    const view = miniLine([p('a', 1), p('b', 2), p('c', null), p('d', 4), p('e', 5)], {
      width: 80,
      height: MINI_HEIGHT.spark,
    })!;
    expect(view.segments).toHaveLength(2);
  });

  it('hält die Null im Bild, auch bei durchweg positiven Werten', () => {
    const view = miniLine([p('a', 10), p('b', 12)], { width: 80, height: 18 })!;
    expect(view.domain.min).toBe(0);
    expect(view.zeroY).toBeGreaterThan(0);
  });

  it('meldet negative Werte, damit die Nulllinie gezeichnet werden kann', () => {
    expect(
      miniLine([p('a', -1), p('b', 2)], { width: 80, height: 18 })!.hasNegative,
    ).toBe(true);
  });

  it('meldet null, wenn kein zusammenhängendes Segment übrig bleibt', () => {
    expect(miniLine([p('a', 1), p('b', null)], { width: 80, height: 18 })).toBeNull();
  });

  it('hält die Punkte innerhalb der Flaeche (Strichstärken-Rand)', () => {
    const view = miniLine([p('a', -5), p('b', 5)], { width: 80, height: 18, inset: 1 })!;
    const ys = view.segments
      .join(' ')
      .split(' ')
      .map((pair) => Number(pair.split(',')[1]));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...ys)).toBeLessThanOrEqual(17);
  });
});

describe('Das Höhen-Set ist EINES', () => {
  it('kennt genau drei Mini-Höhen', () => {
    expect(Object.keys(MINI_HEIGHT)).toEqual(['micro', 'spark', 'streifen']);
  });

  it('kennt genau drei Anteils-Höhen, und sie sind eine Ordnung', () => {
    expect(SHARE_HEIGHT.micro).toBeLessThan(SHARE_HEIGHT.md);
    expect(SHARE_HEIGHT.md).toBeLessThan(SHARE_HEIGHT.lg);
    expect(Object.keys(SHARE_HEIGHT)).toHaveLength(3);
  });
});
