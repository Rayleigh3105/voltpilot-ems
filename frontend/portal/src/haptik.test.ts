import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HAPTIK_ABSTAND_MS, haptik, haptikZuruecksetzen } from './haptik';

function zeiger(grob: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((q: string) => ({ matches: grob && q === '(pointer: coarse)', media: q, addEventListener() {}, removeEventListener() {} })),
  );
  window.matchMedia = globalThis.matchMedia;
}

describe('haptik · fühlbare Rückmeldung am Telefon', () => {
  const vibrate = vi.fn(() => true);

  beforeEach(() => {
    haptikZuruecksetzen();
    vibrate.mockClear();
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true, writable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (navigator as { vibrate?: unknown }).vibrate;
  });

  it('vibriert auf Android mit dem Muster der Art', () => {
    zeiger(true);
    expect(haptik('tick', 1000)).toBe('vibrate');
    expect(vibrate).toHaveBeenLastCalledWith(8);
    expect(haptik('jetzt', 2000)).toBe('vibrate');
    expect(vibrate).toHaveBeenLastCalledWith([6, 45, 10]);
  });

  it('bleibt mit Maus oder Stift still', () => {
    zeiger(false);
    expect(haptik('ziel', 1000)).toBeNull();
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('lässt zwischen zwei Impulsen Luft, damit schnelles Ziehen tickt statt brummt', () => {
    zeiger(true);
    expect(haptik('tick', 1000)).toBe('vibrate');
    expect(haptik('tick', 1000 + HAPTIK_ABSTAND_MS - 1)).toBeNull();
    expect(haptik('tick', 1000 + HAPTIK_ABSTAND_MS)).toBe('vibrate');
    expect(vibrate).toHaveBeenCalledTimes(2);
  });

  it('leiht sich auf dem iPhone den Impuls eines unsichtbaren Schalters und räumt ihn sofort weg', () => {
    zeiger(true);
    delete (navigator as { vibrate?: unknown }).vibrate;
    const erzeugen = document.createElement.bind(document);
    const umgeschaltet: boolean[] = [];
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = erzeugen(tag);
      if (tag === 'input') {
        // Safari kennt das Attribut als Eigenschaft; jsdom nicht.
        Object.defineProperty(el, 'switch', { value: false, configurable: true });
        el.addEventListener('change', () => umgeschaltet.push((el as HTMLInputElement).checked));
      }
      return el;
    }) as typeof document.createElement);
    expect(haptik('ziel', 1000)).toBe('schalter');
    // Der Klick auf das Label schaltet den Schalter genau einmal um …
    expect(umgeschaltet).toEqual([true]);
    // … und nichts bleibt im Dokument zurück.
    expect(document.head.querySelector('input[switch]')).toBeNull();
  });

  it('tut ohne beide Wege schlicht nichts', () => {
    zeiger(true);
    delete (navigator as { vibrate?: unknown }).vibrate;
    expect(haptik('tick', 1000)).toBeNull();
  });
});
