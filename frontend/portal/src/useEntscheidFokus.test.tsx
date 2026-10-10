import { act, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENTSCHEID_MARKE, entscheidZiel, useEntscheidFokus } from './useEntscheidFokus';

function Schale({ kinder }: { kinder: React.ReactNode }) {
  useEntscheidFokus();
  return <>{kinder}</>;
}

/** Eine Zielseite, die ihren Entscheid erst nach dem Laden zeigt. */
function Seite() {
  const [da, setDa] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setDa(true)} data-testid="laden">
        laden
      </button>
      {da && (
        <div data-entscheid="dokument_ueberpruefung">
          <button type="button">Geprüft, bleibt</button>
          <button type="button">Neue Fassung</button>
        </div>
      )}
    </div>
  );
}

describe('useEntscheidFokus: der Blick landet beim offenen Entscheid', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    history.replaceState(null, '', '/#/portfolio/energiemanagement/dokumente/d1?entscheid=dokument_ueberpruefung');
  });
  afterEach(() => {
    vi.useRealTimers();
    history.replaceState(null, '', '/');
  });

  it('wartet, bis die Seite ihn zeigt, fokussiert den ersten Knopf, markiert kurz und nimmt den Parameter aus der Adresse', async () => {
    const { getByTestId, getByText } = render(<Schale kinder={<Seite />} />);
    expect(window.location.hash).toContain('entscheid=');
    await act(async () => {
      getByTestId('laden').click();
    });
    await act(async () => {
      vi.advanceTimersToNextFrame();
    });
    // Erst nach der Ruhezeit (kein Umbau mehr) wird gescrollt und fokussiert.
    expect(document.activeElement).not.toBe(getByText('Geprüft, bleibt'));
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    const knopf = getByText('Geprüft, bleibt');
    expect(document.activeElement).toBe(knopf);
    expect(knopf.classList.contains(ENTSCHEID_MARKE)).toBe(true);
    expect(window.location.hash).toBe('#/portfolio/energiemanagement/dokumente/d1');
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(knopf.classList.contains(ENTSCHEID_MARKE)).toBe(false);
  });

  it('trägt der Entscheid mehrere Knöpfe, landet der Blick beim Knopf des Schritts', async () => {
    history.replaceState(null, '', '/#/portfolio/berichte/BR-2026-0001?entscheid=bericht_anstoss');
    const { getByText } = render(
      <Schale
        kinder={
          <section data-entscheid="bericht_anstoss">
            <button type="button">Anstoß verwerfen</button>
            <button type="button" data-entscheid-schritt>
              Entwurf vergleichen
            </button>
          </section>
        }
      />,
    );
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(document.activeElement).toBe(getByText('Entwurf vergleichen'));
    expect(window.location.hash).toBe('#/portfolio/berichte/BR-2026-0001');
  });

  it('erscheint der Entscheid nicht (etwa ohne das Recht dazu), bleibt die Seite stehen und die Adresse wird sauber', async () => {
    render(<Schale kinder={<p>ohne Entscheid</p>} />);
    await act(async () => {
      vi.advanceTimersByTime(9000);
    });
    expect(window.location.hash).toBe('#/portfolio/energiemanagement/dokumente/d1');
  });

  it('bei mehreren Gegenständen gilt das Kennzeichen; ohne Kennzeichen an der Seite der eine Entscheid', () => {
    document.body.innerHTML = `
      <ul>
        <li data-entscheid="messbedarf_frist" data-entscheid-kennzeichen="MB-1">eins</li>
        <li data-entscheid="messbedarf_frist" data-entscheid-kennzeichen="MB-2">zwei</li>
      </ul>
      <div data-entscheid="bezugsbasis_ueberpruefung">bb</div>`;
    expect(entscheidZiel(document, { art: 'messbedarf_frist', kennzeichen: 'MB-2' })?.textContent).toBe('zwei');
    expect(entscheidZiel(document, { art: 'messbedarf_frist', kennzeichen: 'MB-9' })).toBeNull();
    expect(entscheidZiel(document, { art: 'bezugsbasis_ueberpruefung', kennzeichen: 'BB-0002' })?.textContent).toBe('bb');
    document.body.innerHTML = '';
  });
});
