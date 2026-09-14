import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { HeroRing } from '../../cockpitWidgets';
import { NBSP } from '../../format';
import { ErgebnisRing } from './CockpitErgebnis';

/**
 * AP-10 E16 Nr. 5 — der Ring hält eine Quote außerhalb 0…100 % aus, ohne sie
 * zu klemmen: kein Bogen (eine Füllung über 100 % oder unter 0 % bräuchte eine
 * Klemme), die Zahl bleibt, der Satz steht unter dem Etikett.
 */

const MINUS = '−';

function ring(over: Partial<HeroRing>): HeroRing {
  return {
    id: 'autarkie',
    label: 'Autarkie · Juli',
    pct: 82,
    valueText: `82${NBSP}%`,
    hinweis: null,
    hue: 'var(--vp-flow-pv)',
    ...over,
  };
}

describe('ErgebnisRing', () => {
  it('Normalfall unverändert: ein Bogen auf dem Wert, kein Satz, keine Stauchung', () => {
    const { container } = render(<ErgebnisRing ring={ring({})} />);
    const bogen = container.querySelector('.vp-c-ck-ring-bogen');
    expect(bogen).not.toBeNull();
    const C = 2 * Math.PI * 26;
    expect(bogen?.getAttribute('stroke-dashoffset')).toBe((C - 0.82 * C).toFixed(2));
    expect(container.querySelector('text')?.getAttribute('textLength')).toBeNull();
    expect(container.querySelector('.vp-c-ck-ring-label')?.textContent).toBe('Autarkie · Juli');
  });

  it('unplausibel über 100 %: kein Bogen, kein negativer Versatz, die Zahl und der Satz', () => {
    const satz = `Messwerte passen nicht zusammen (110${NBSP}%)`;
    const { container } = render(
      <ErgebnisRing ring={ring({ pct: null, valueText: `110${NBSP}%`, hinweis: satz })} />,
    );
    expect(container.querySelector('.vp-c-ck-ring-bogen')).toBeNull();
    expect(container.querySelectorAll('circle')).toHaveLength(1);
    expect(container.querySelector('text')?.textContent).toBe(`110${NBSP}%`);
    expect(container.querySelector('.vp-c-ck-ring-label')?.textContent).toContain(satz);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toContain(satz);
  });

  it('eine lange Zahl wird in den Ring gestaucht statt abgeschnitten', () => {
    const { container } = render(
      <ErgebnisRing
        ring={ring({
          pct: null,
          valueText: `${MINUS}1.250${NBSP}%`,
          hinweis: `Messwerte passen nicht zusammen (${MINUS}1.250${NBSP}%)`,
        })}
      />,
    );
    expect(container.querySelector('text')?.getAttribute('textLength')).toBe('44');
  });
});
