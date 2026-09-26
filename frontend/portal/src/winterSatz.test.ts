import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WENIG_SONNE_ANTEIL, winterSatz } from './winterSatz';

/**
 * Der Winter-Satz (Konzept k1 §8, E6 = A) — dieselbe Schwelle wie der Grund
 * `wenig_sonne` des Servers; der Test liest sie aus dem Vertrag.
 */
const VERTRAG = JSON.parse(
  readFileSync(resolve(process.cwd(), '../../docs/contracts/steuerung-tag-vectors.json'), 'utf8'),
) as { grund: { schwellen: { wenig_sonne_unter_anteil: number } } };

const sp = (s: string | null) => (s == null ? null : s.replace(/ /g, ' '));

describe('winterSatz', () => {
  it('liest dieselbe Schwelle wie der Server-Grund „wenig Sonne"', () => {
    expect(WENIG_SONNE_ANTEIL).toBe(VERTRAG.grund.schwellen.wenig_sonne_unter_anteil);
  });

  it('09.09.2026 (Herzogau, dunkelster Tag der Reihe): der Satz des Konzepts', () => {
    expect(
      sp(winterSatz({ pvKwh: 96.327, verbrauchKwh: 182.075, selbstGenutztKwh: 90.770762, laeuft: false })),
    ).toBe('Wenig Sonne: 96 kWh erzeugt, 91 kWh selbst genutzt.');
  });

  it('ein angenommener Januartag: alles selbst genutzt', () => {
    expect(sp(winterSatz({ pvKwh: 18.2, verbrauchKwh: 201, selbstGenutztKwh: 18.2, laeuft: false }))).toBe(
      'Wenig Sonne: 18 kWh erzeugt, alles selbst genutzt.',
    );
  });

  it('kleine Mengen mit einer Nachkommastelle, ohne Sonne ein eigener Satz', () => {
    expect(sp(winterSatz({ pvKwh: 4.24, verbrauchKwh: 80, selbstGenutztKwh: 3.9, laeuft: false }))).toBe(
      'Wenig Sonne: 4,2 kWh erzeugt, 3,9 kWh selbst genutzt.',
    );
    expect(winterSatz({ pvKwh: 0, verbrauchKwh: 80, selbstGenutztKwh: 0, laeuft: false })).toBe(
      'Wenig Sonne: kein Solarstrom erzeugt.',
    );
  });

  it('Kante: genau 60 % ist nicht „wenig Sonne", 59,9 % schon (wie der Vertrag)', () => {
    expect(winterSatz({ pvKwh: 60, verbrauchKwh: 100, selbstGenutztKwh: 50, laeuft: false })).toBeNull();
    expect(winterSatz({ pvKwh: 59.9, verbrauchKwh: 100, selbstGenutztKwh: 50, laeuft: false })).not.toBeNull();
  });

  it('der laufende Tag bekommt keinen Satz — morgens liegt jeder Tag unter 60 %', () => {
    expect(winterSatz({ pvKwh: 5, verbrauchKwh: 40, selbstGenutztKwh: 5, laeuft: true })).toBeNull();
  });

  it('ein Sonnentag (23.09.) und fehlende Zahlen sagen nichts — nie geraten', () => {
    expect(winterSatz({ pvKwh: 377.3, verbrauchKwh: 234.4, selbstGenutztKwh: 201, laeuft: false })).toBeNull();
    expect(winterSatz({ pvKwh: null, verbrauchKwh: 100, selbstGenutztKwh: 1, laeuft: false })).toBeNull();
    expect(winterSatz({ pvKwh: 10, verbrauchKwh: 0, selbstGenutztKwh: 1, laeuft: false })).toBeNull();
    expect(sp(winterSatz({ pvKwh: 10, verbrauchKwh: 100, selbstGenutztKwh: null, laeuft: false }))).toBe(
      'Wenig Sonne: 10 kWh erzeugt.',
    );
  });
});
