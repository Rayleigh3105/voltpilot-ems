import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { render, screen } from '@testing-library/react';
import { SwapNumber, SwapText } from './SwapNumber';

/**
 * Der Zahlenwechsel-Baustein (Bewegungs-Programm P3, §6 Zeile
 * „Zahlenwechsel"). Die REGEL steht rein in `src/swapNumber.ts` und wird dort
 * geprüft; hier geht es um die zwei Zusagen, die nur im DOM sichtbar sind:
 *
 *  1. **Im Ruhezustand ist er unsichtbar.** Er rendert genau das, was ohne ihn
 *     dastünde — sonst zerbräche jede Abfrage der Art
 *     `getByText(…, { selector: '.eltern-klasse' })`, denn die
 *     Testing-Library liest dort nur die DIREKTEN Textkinder.
 *  2. **Es steht nie ein Zwischenwert da.** Während des Wechsels liegen genau
 *     die zwei echten Werte im Baum, und der alte trägt `aria-hidden`.
 */
describe('SwapNumber · der Ruhezustand ist byte-gleich mit „kein Baustein"', () => {
  it('rendert einen nackten Textknoten, kein Wrapper-Element', () => {
    const { container } = render(
      <p className="ziel">
        <SwapNumber value="27,04 €" />
      </p>,
    );
    const p = container.querySelector('.ziel') as HTMLElement;
    expect(p.children).toHaveLength(0);
    expect(p.textContent).toBe('27,04 €');
    // Genau die Abfrage, an der ein bleibender Wrapper scheitern würde.
    expect(screen.getByText('27,04 €', { selector: '.ziel' })).toBe(p);
  });

  it('gibt den Träger nach dem Wechsel wieder her', async () => {
    const { container, rerender } = render(
      <p className="ziel">
        <SwapNumber value="27,04 €" />
      </p>,
    );
    rerender(
      <p className="ziel">
        <SwapNumber value="301,46 €" />
      </p>,
    );
    const p = container.querySelector('.ziel') as HTMLElement;
    // Während des Wechsels: der Träger und die zwei echten Werte.
    expect(p.querySelector('.vp-swap')).not.toBeNull();
    expect(p.querySelector('.vp-swap-in')?.textContent).toBe('301,46 €');
    expect(p.querySelector('.vp-swap-out')?.textContent).toBe('27,04 €');
    expect(p.querySelector('.vp-swap-out')?.getAttribute('aria-hidden')).toBe('true');
    // Und danach steht wieder nur der Wert da.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 500));
    });
    expect(p.children).toHaveLength(0);
    expect(p.textContent).toBe('301,46 €');
  });

  it('bewegt sich nicht, wenn derselbe Wert erneut hereinkommt', () => {
    const { container, rerender } = render(
      <p className="ziel">
        <SwapNumber value="27,04 €" />
      </p>,
    );
    rerender(
      <p className="ziel">
        <SwapNumber value="27,04 €" />
      </p>,
    );
    expect((container.querySelector('.ziel') as HTMLElement).children).toHaveLength(0);
  });
});

describe('SwapText · die SVG-Fassung', () => {
  it('rendert im Ruhezustand das EINE `<text>` mit den Attributen des Aufrufers', () => {
    const { container } = render(
      <svg>
        <SwapText value="37 %" x="32" y="36" textAnchor="middle" />
      </svg>,
    );
    const texts = container.querySelectorAll('text');
    expect(texts).toHaveLength(1);
    expect(texts[0].getAttribute('x')).toBe('32');
    expect(texts[0].getAttribute('class')).toBeNull();
    expect(texts[0].textContent).toBe('37 %');
  });

  it('legt beim Wechsel zwei `<text>` auf DIESELBE Stelle', () => {
    const { container, rerender } = render(
      <svg>
        <SwapText value="37 %" x="32" y="36" />
      </svg>,
    );
    rerender(
      <svg>
        <SwapText value="82 %" x="32" y="36" />
      </svg>,
    );
    const texts = [...container.querySelectorAll('text')];
    expect(texts.map((t) => t.textContent)).toEqual(['37 %', '82 %']);
    // Dieselbe Position — das ist der Grund, warum es hier keinen Träger braucht.
    expect(texts.every((t) => t.getAttribute('x') === '32' && t.getAttribute('y') === '36')).toBe(
      true,
    );
    expect(texts[0].getAttribute('aria-hidden')).toBe('true');
    expect(texts[1].getAttribute('aria-hidden')).toBeNull();
  });
});
