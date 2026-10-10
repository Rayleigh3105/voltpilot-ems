import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FEHLER_IM_BEREICH, Fehlergrenze } from './Fehlergrenze';
import { LazyBoundary } from './Lazy';

/**
 * Demo 27.09.2026: ein `null` in einem Reiter (Bezugsbasis) und ein fehlendes Feld in einem Bericht (Managementbewertung)
 * ersetzten je das GANZE Portal durch die Boot-Karte. Die Grenze hält den Fehler an der Seite bzw. am Reiter.
 */
afterEach(() => vi.restoreAllMocks());

function Wirft({ an }: { an: boolean }) {
  if (an) throw new TypeError("Cannot read properties of null (reading 'variablen')");
  return <p>Inhalt</p>;
}

describe('Fehlergrenze', () => {
  it('zeigt ihren Satz statt des gescheiterten Bereichs; der Rest daneben bleibt', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <main>
        <nav>Navigation</nav>
        <Fehlergrenze>
          <Wirft an />
        </Fehlergrenze>
      </main>,
    );
    expect(screen.getByRole('alert').textContent).toBe(FEHLER_IM_BEREICH);
    expect(screen.getByText('Navigation')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('ein Wechsel der Hash-Route setzt sie zurück — die nächste Seite steht nicht hinter dem alten Fehler', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { rerender } = render(
      <Fehlergrenze>
        <Wirft an />
      </Fehlergrenze>,
    );
    rerender(
      <Fehlergrenze>
        <Wirft an={false} />
      </Fehlergrenze>,
    );
    expect(screen.getByTestId('fehlergrenze')).toBeTruthy();
    act(() => {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(screen.getByText('Inhalt')).toBeTruthy();
    expect(screen.queryByTestId('fehlergrenze')).toBeNull();
  });

  it('die Suspense-Grenze der Seiten (`LazyBoundary`) trägt sie: ein Fehler einer Seite bleibt in der Seite', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <div>
        <header>Kopf</header>
        <LazyBoundary>
          <Wirft an />
        </LazyBoundary>
      </div>,
    );
    expect(screen.getByText('Kopf')).toBeTruthy();
    expect(screen.getByTestId('fehlergrenze').textContent).toBe(FEHLER_IM_BEREICH);
  });
});
