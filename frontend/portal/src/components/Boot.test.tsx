import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BootErrorBoundary, BootSplash, removeBootSkeleton } from './Boot';

/** The inline skeleton index.html ships (see its comment block). */
function mountSkeleton(): HTMLElement {
  const el = document.createElement('div');
  el.id = 'vp-boot-skeleton';
  document.body.appendChild(el);
  return el;
}

describe('BootSplash', () => {
  it('renders the boot state synchronously (never a white first frame)', () => {
    render(<BootSplash />);
    expect(screen.getByText('Anmeldung wird geprüft …')).toBeInTheDocument();
    expect(screen.getByAltText('VoltPilot')).toBeInTheDocument();
  });
});

describe('BootErrorBoundary', () => {
  it('renders its children when nothing throws', () => {
    render(
      <BootErrorBoundary>
        <p>Portal-Inhalt</p>
      </BootErrorBoundary>,
    );
    expect(screen.getByText('Portal-Inhalt')).toBeInTheDocument();
  });

  it('a throwing child lands on the German recovery card, never blank', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Boom(): never {
      throw new Error('render explosion');
    }
    render(
      <BootErrorBoundary>
        <Boom />
      </BootErrorBoundary>,
    );
    expect(
      screen.getByText(/Es ist ein unerwarteter Fehler aufgetreten/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Neu laden' })).toBeInTheDocument();
    consoleError.mockRestore();
  });

  it('removes the inline first-paint skeleton on its first committed frame', () => {
    mountSkeleton();
    render(
      <BootErrorBoundary>
        <BootSplash />
      </BootErrorBoundary>,
    );
    // Gone in the same commit React wrote its first DOM - no flicker, and the
    // splash it hands over to is already on screen.
    expect(document.getElementById('vp-boot-skeleton')).toBeNull();
    expect(screen.getByText('Anmeldung wird geprüft …')).toBeInTheDocument();
  });

  it('also removes it when the very first render throws', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mountSkeleton();
    function Boom(): never {
      throw new Error('render explosion');
    }
    render(
      <BootErrorBoundary>
        <Boom />
      </BootErrorBoundary>,
    );
    expect(document.getElementById('vp-boot-skeleton')).toBeNull();
    consoleError.mockRestore();
  });
});

describe('removeBootSkeleton', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--vp-motion-exit');
    vi.useRealTimers();
  });

  it('is idempotent and safe when the skeleton is absent', () => {
    mountSkeleton();
    removeBootSkeleton();
    expect(() => removeBootSkeleton()).not.toThrow();
    expect(document.getElementById('vp-boot-skeleton')).toBeNull();
  });

  /*
   * Bewegungs-Programm P4. Der Nachweis, der wirklich zaehlt: das Skelett
   * verschwindet AUCH DANN, wenn gar nicht ausgeblendet wird. Unter
   * reduzierter Bewegung steht `--vp-motion-exit` auf 0 ms (der EINE
   * Schalter `--vp-motion-scale`), und ein Uebergang ueber 0 ms feuert kein
   * `transitionend` - wer nur darauf hoert, laesst das Skelett fuer immer
   * ueber dem Portal stehen.
   */
  it('entfernt das Skelett SOFORT, wenn die Ausblend-Dauer 0 ms ist', () => {
    document.documentElement.style.setProperty('--vp-motion-exit', '0ms');
    mountSkeleton();
    removeBootSkeleton();
    expect(document.getElementById('vp-boot-skeleton')).toBeNull();
  });

  it('entfernt das Skelett SOFORT, wenn die Dauer gar nicht zu ermitteln ist', () => {
    // Keine aufgeloeste Custom Property (Buendel noch nicht da, jsdom, ...):
    // im Zweifel wird nicht gewartet.
    mountSkeleton();
    removeBootSkeleton();
    expect(document.getElementById('vp-boot-skeleton')).toBeNull();
  });

  it('blendet aus und entfernt DANACH - der Zeitgeber traegt es, nicht das Ereignis', () => {
    vi.useFakeTimers();
    document.documentElement.style.setProperty('--vp-motion-exit', '160ms');
    const el = mountSkeleton();

    removeBootSkeleton();
    // Waehrend des Ausblendens steht es noch da - genau das ist die
    // Ueberblendung ueber das schon fertige erste Bild.
    expect(el.classList.contains('vp-bs-leaving')).toBe(true);
    expect(document.getElementById('vp-boot-skeleton')).not.toBeNull();

    // KEIN `transitionend` - der Zeitgeber allein muss es schaffen.
    vi.advanceTimersByTime(400);
    expect(document.getElementById('vp-boot-skeleton')).toBeNull();
  });

  it('raeumt beim Uebergangs-Ende frueher auf, und der Zeitgeber danach tut nichts mehr', () => {
    vi.useFakeTimers();
    document.documentElement.style.setProperty('--vp-motion-exit', '160ms');
    const el = mountSkeleton();

    removeBootSkeleton();
    el.dispatchEvent(new Event('transitionend'));
    expect(document.getElementById('vp-boot-skeleton')).toBeNull();

    // ⚠ Geprueft wird der ZUSTAND, nicht die Zahl der Aufrufe: `remove()`
    //   kehrt ohne Eltern einfach zurueck (`ChildNode.remove()`), der
    //   Rueckfall-Zeitgeber darf also ruhig ein zweites Mal feuern. Eine
    //   Aufruf-Zaehlung wuerde die DOM-Spezifikation pruefen, nicht uns —
    //   und zwaenge dem Einstiegs-Buendel eine Merke-Fahne auf, die nichts
    //   verhindert.
    expect(() => vi.advanceTimersByTime(400)).not.toThrow();
    expect(document.getElementById('vp-boot-skeleton')).toBeNull();
    expect(el.isConnected).toBe(false);
  });
});
