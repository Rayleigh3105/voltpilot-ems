import { describe, expect, it } from 'vitest';

import { capTextLength } from './svgText';

/**
 * Die EINE Textkappung für handgezeichnete SVG-Bilder. Die Tests standen bis
 * zum Balken-Umbau von „So verdient Ihre Anlage" (25.09.2026) in
 * `soVerdient.test.ts`; sie ziehen mit dem Helfer um, damit er bewacht bleibt.
 */
describe('capTextLength · eine Zeile läuft nie über ihr Fenster', () => {
  it('kappt eine zu breite Zeile hart', () => {
    expect(capTextLength('Ein sehr langer Chip-Titel', 10, 60)).toBe(60);
  });

  it('lässt eine bequem passende Zeile in Ruhe', () => {
    expect(capTextLength('1,1 ct', 10, 200)).toBeUndefined();
  });

  it('kappt auch dann, wenn nur die ERSATZ-Schrift breiter ausfällt', () => {
    // Die Schätzung ist absichtlich großzügig: lieber einmal zu oft stauchen
    // als eine Zeile still über den Rand laufen lassen.
    expect(capTextLength('Marktprämie', 10, 60)).toBe(60);
  });
});
