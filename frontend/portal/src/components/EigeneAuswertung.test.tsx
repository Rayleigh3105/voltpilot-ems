import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EigenerBaustein } from './EigeneAuswertung';

describe('EigenerBaustein', () => {
  it('rendert einen älteren Kachelwert ohne verlauf ohne nachlaufenden Renderfehler', async () => {
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => errors.push(event.error);
    window.addEventListener('error', onError);

    try {
      const { container } = render(
        <EigenerBaustein
          wert={{
            id: 'eigen:k1',
            titel: 'Wärmepumpe jetzt',
            darstellung: 'kachel',
            entityId: 'e-wb',
            channel: 'power_kw',
            aggregat: 'jetzt',
            wert: 3.25,
            kanalart: 'leistung',
            komponente: 'Wärmepumpe',
            entityType: 'wallbox',
            hinweis: null,
          }}
          einheit="kW"
        />,
      );

      expect(container.querySelector('.vp-eigen-kachel')).toHaveTextContent('3,25 kW');
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(errors).toEqual([]);
    } finally {
      window.removeEventListener('error', onError);
    }
  });
});
