import { describe, expect, it } from 'vitest';
import type { GeraetBild } from './bild';
import { ladeWahl, smartSchritte } from './laden';

type Stand = Pick<GeraetBild, 'eingriff' | 'steuerart'>;
const stand = (eingriff: unknown, quelle: string | null): Stand =>
  ({ eingriff, steuerart: quelle == null ? null : { quelle, herkunft: 'standard' } }) as unknown as Stand;

describe('Smart an einem Ladepunkt', () => {
  it('macht aus dem Anlagen-Standard „sofort“ die Steuerart Sonne zuerst - sonst bliebe die Karte auf Schnell', () => {
    const g = stand(null, 'sofort');
    expect(ladeWahl(g as GeraetBild)).toBe('schnell');
    expect(smartSchritte(g)).toEqual({ eingriffBeenden: false, steuerart: 'min' });
  });

  it('beendet „Jetzt voll laden“ und lässt eine gewählte Sonnen-Steuerart stehen', () => {
    const g = stand({ art: 'an', bisMs: null }, 'ueberschuss');
    expect(ladeWahl(g as GeraetBild)).toBe('schnell');
    expect(smartSchritte(g)).toEqual({ eingriffBeenden: true, steuerart: null });
  });

  it('erledigt Eingriff UND Steuerart in einem Klick', () => {
    expect(smartSchritte(stand({ art: 'aus', bisMs: null }, 'sofort'))).toEqual({ eingriffBeenden: true, steuerart: 'min' });
  });

  it('tut nichts, wenn der Ladepunkt schon smart lädt', () => {
    const g = stand(null, 'ueberschuss');
    expect(ladeWahl(g as GeraetBild)).toBe('smart');
    expect(smartSchritte(g)).toEqual({ eingriffBeenden: false, steuerart: null });
    expect(smartSchritte(stand(null, null))).toEqual({ eingriffBeenden: false, steuerart: null });
  });
});
