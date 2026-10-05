import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Blatt } from './Blatt';

// Safari/WebKit fokussiert einen angetippten Knopf nicht: nach einem Tipp im Blatt liegt der Fokus auf
// `body`. Escape muss das Blatt trotzdem schliessen - und nur das oberste (Gesamtlauf 04./05.10.2026,
// `steuerung.spec.ts` in mobile-webkit).

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function zweiBlaetter() {
  const unten = vi.fn();
  const oben = vi.fn();
  render(
    <>
      <Blatt titel="Unten" onClose={unten}>
        <button type="button">im unteren</button>
      </Blatt>
      <Blatt titel="Oben" onClose={oben}>
        <button type="button">im oberen</button>
      </Blatt>
    </>,
  );
  // Der Fokus-Takt des Blatts (60 ms) setzt den Fokus ins oberste Blatt.
  act(() => {
    vi.advanceTimersByTime(100);
  });
  return { unten, oben };
}

describe('Blatt · Escape über den Stapel', () => {
  it('Fokus ausserhalb des Blatts: Escape schliesst das oberste Blatt, das darunter bleibt offen', () => {
    vi.useFakeTimers();
    const { unten, oben } = zweiBlaetter();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    fireEvent.keyDown(document.body, { key: 'Escape' });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(oben).toHaveBeenCalledTimes(1);
    expect(unten).not.toHaveBeenCalled();
  });

  it('Fokus im Blatt: Escape schliesst es wie bisher, und nur dieses', () => {
    vi.useFakeTimers();
    const { unten, oben } = zweiBlaetter();
    const knopf = screen.getByRole('button', { name: 'im oberen' });
    knopf.focus();

    fireEvent.keyDown(knopf, { key: 'Escape' });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(oben).toHaveBeenCalledTimes(1);
    expect(unten).not.toHaveBeenCalled();
  });
});
