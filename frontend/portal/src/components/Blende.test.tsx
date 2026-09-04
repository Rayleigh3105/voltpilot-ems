import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Blende } from './Lazy';

/**
 * **Bewegung P6 · Skelett → Inhalt** (Konzept
 * `data/vp-motion-konzept-m1/report.md` §6: „Crossfade 160/200 ms im
 * reservierten Rahmen (CLS 0)").
 *
 * ⚠ Die Dauer wird an der `documentElement` gesetzt, weil `useAusblenden` sie
 * dort MISST und jsdom kein Stylesheet lädt. Ohne gemessene Dauer wird nicht
 * gewartet — deshalb verhält sich `Blende` in jedem anderen Test wie ein
 * schlichtes Ternär.
 */
describe('Blende', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--vp-motion-exit');
    vi.useRealTimers();
  });

  it('zeigt allein das Skelett, solange geladen wird', () => {
    const { container } = render(
      <Blende laedt skelett={<p>Skelett</p>}>
        <p>Inhalt</p>
      </Blende>,
    );
    expect(container.textContent).toContain('Skelett');
    expect(container.textContent).not.toContain('Inhalt');
  });

  it('überblendet: der Inhalt steht sofort, das Skelett geht danach', () => {
    vi.useFakeTimers();
    document.documentElement.style.setProperty('--vp-motion-exit', '160ms');
    const { container, rerender } = render(
      <Blende laedt skelett={<p>Skelett</p>}>
        <p>Inhalt</p>
      </Blende>,
    );
    rerender(
      <Blende laedt={false} skelett={<p>Skelett</p>}>
        <p>Inhalt</p>
      </Blende>,
    );
    // Beide da — das IST das Überblenden.
    expect(container.textContent).toContain('Inhalt');
    expect(container.textContent).toContain('Skelett');
    const gehend = container.querySelector('.vp-blende.is-weg');
    expect(gehend).not.toBeNull();
    // Das gehende Skelett ist für Screenreader fort, bevor es für Augen fort
    // ist: es sagt „wird geladen", und das stimmt schon nicht mehr.
    expect(gehend).toHaveAttribute('aria-hidden', 'true');

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(container.textContent).not.toContain('Skelett');
    expect(container.textContent).toContain('Inhalt');
  });

  it('der Rahmen reserviert — das gehende Skelett trägt die Höhe NICHT mit', () => {
    vi.useFakeTimers();
    document.documentElement.style.setProperty('--vp-motion-exit', '160ms');
    const { container, rerender } = render(
      <Blende laedt skelett={<p>Skelett</p>}>
        <p>Inhalt</p>
      </Blende>,
    );
    rerender(
      <Blende laedt={false} skelett={<p>Skelett</p>}>
        <p>Inhalt</p>
      </Blende>,
    );
    // jsdom rechnet keine Kaskade; geprüft wird der VERTRAG: der Rahmen und
    // die Klasse, die `index.css` auf `position: absolute` legt.
    expect(container.querySelector('.vp-blende-rahmen')).not.toBeNull();
    expect(
      container.querySelector('.vp-blende-rahmen > .vp-blende.is-weg'),
    ).not.toBeNull();
  });

  it('bei Schalter 0 ist das Skelett im selben Frame fort', () => {
    document.documentElement.style.setProperty('--vp-motion-exit', '0s');
    const { container, rerender } = render(
      <Blende laedt skelett={<p>Skelett</p>}>
        <p>Inhalt</p>
      </Blende>,
    );
    rerender(
      <Blende laedt={false} skelett={<p>Skelett</p>}>
        <p>Inhalt</p>
      </Blende>,
    );
    expect(container.textContent).not.toContain('Skelett');
  });

  it('reicht eine zusätzliche Klasse an den Rahmen durch', () => {
    const { container } = render(
      <Blende laedt={false} skelett={null} className="vp-eigen">
        <p>Inhalt</p>
      </Blende>,
    );
    expect(container.querySelector('.vp-blende-rahmen.vp-eigen')).not.toBeNull();
  });
});
