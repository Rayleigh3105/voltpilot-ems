import { useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Modal } from '../../designsystem/components/shell/Modal';
import { BottomSheet } from './BottomSheet';

/**
 * Das EINE Bottom-Sheet des Bereichs „Verlauf" (V9, Captain-Entscheid E5 a).
 *
 * Geprüft wird nicht sein Aussehen, sondern was es einem Menschen ZUSAGT: der
 * Fokus wandert hinein und beim Schließen ZURÜCK auf den Auslöser, der Körper
 * scrollt nicht hinter dem Blatt, und es lässt sich auf allen drei Wegen
 * schließen (Escape · Scrim · Knopf). Diese vier Zusagen sind der Grund, warum
 * es EIN Baustein ist und nicht zwei fast gleiche Blätter.
 */

function Buehne({ footer }: { footer?: ReactNode } = {}) {
  const [offen, setOffen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOffen(true)}>
        Messwerte wählen
      </button>
      <BottomSheet open={offen} title="Messwerte" onClose={() => setOffen(false)} footer={footer}>
        <button type="button">Erster Messwert</button>
        <button type="button">Zweiter Messwert</button>
      </BottomSheet>
    </>
  );
}

function oeffne() {
  const ausloeser = screen.getByRole('button', { name: 'Messwerte wählen' });
  ausloeser.focus();
  fireEvent.click(ausloeser);
  return ausloeser;
}

describe('BottomSheet', () => {
  it('ist geschlossen, solange es niemand geöffnet hat', () => {
    render(<Buehne />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.style.overflow).toBe('');
  });

  it('benennt sich als Dialog über seine eigene Überschrift', () => {
    render(<Buehne />);
    oeffne();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const titel = screen.getByRole('heading', { name: 'Messwerte' });
    expect(dialog.getAttribute('aria-labelledby')).toBe(titel.id);
  });

  it('nimmt den Fokus hinein und gibt ihn beim Schließen an den Auslöser zurück', () => {
    render(<Buehne />);
    const ausloeser = oeffne();
    expect(document.activeElement).toBe(screen.getByRole('dialog'));

    fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(ausloeser);
  });

  it('sperrt den Körper-Scroll und gibt ihn beim Schließen wieder frei', () => {
    render(<Buehne />);
    oeffne();
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
    expect(document.body.style.overflow).toBe('');
  });

  it('schließt auf Escape', () => {
    render(<Buehne />);
    const ausloeser = oeffne();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(ausloeser);
    expect(document.body.style.overflow).toBe('');
  });

  it('schließt beim Tippen auf den Scrim daneben', () => {
    render(<Buehne />);
    oeffne();
    const scrim = document.querySelector('.vp-bs-scrim');
    expect(scrim).not.toBeNull();
    fireEvent.click(scrim as Element);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('hält den Tabulator IM Blatt, statt ihn dahinter laufen zu lassen', () => {
    render(<Buehne />);
    oeffne();
    const dialog = screen.getByRole('dialog');
    const schliessen = screen.getByRole('button', { name: 'Schließen' });
    const erster = screen.getByRole('button', { name: 'Erster Messwert' });
    const letzter = screen.getByRole('button', { name: 'Zweiter Messwert' });

    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(schliessen);

    letzter.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(schliessen);

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(letzter);

    erster.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(letzter);
  });

  it('trägt die klebende Fußzeile nur, wenn der Aufrufer eine gibt', () => {
    const { unmount } = render(<Buehne />);
    oeffne();
    expect(document.querySelector('.vp-bs-foot')).toBeNull();
    unmount();

    render(<Buehne footer={<button type="button">Fertig</button>} />);
    oeffne();
    expect(document.querySelector('.vp-bs-foot')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Fertig' })).toBeInTheDocument();
  });
});

/**
 * **Bewegung P6 · das Sheet blendet AUS** (Konzept §6: „Feder von unten 300 ms
 * … Ausblenden 160 ms"). Bis hierher kam es und verschwand im selben Frame.
 *
 * ⚠ Die Dauer wird an der `documentElement` gesetzt, weil `useAusblenden` sie
 * dort MISST und jsdom kein Stylesheet lädt — ohne gemessene Dauer wird nicht
 * gewartet. Genau deshalb laufen die Tests oben unverändert synchron.
 */
describe('BottomSheet · Bewegung P6 (Ausblenden)', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--vp-motion-exit');
    vi.useRealTimers();
  });

  it('bleibt beim Schliessen noch die Ausblend-Dauer im Baum und trägt `is-closing`', () => {
    vi.useFakeTimers();
    document.documentElement.style.setProperty('--vp-motion-exit', '160ms');
    render(<Buehne />);
    oeffne();
    expect(document.querySelector('.vp-bs')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
    expect(document.querySelector('.vp-bs')).not.toBeNull();
    expect(document.querySelector('.vp-bs-wrap')).toHaveClass('is-closing');
    expect(document.body.style.overflow).toBe('hidden');

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(document.querySelector('.vp-bs')).toBeNull();
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('verschwindet bei Schalter 0 sofort', () => {
    document.documentElement.style.setProperty('--vp-motion-exit', '0s');
    render(<Buehne />);
    oeffne();
    fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
    expect(document.querySelector('.vp-bs')).toBeNull();
  });
});

/**
 * **Der EINE Stapel der Überlagerungen** (Review Nachweisen r1, Q-1 und Q-2): Blätter folgen aufeinander (das Blatt
 * einer Gruppe schließt und öffnet im selben Klick das Blatt eines Teils), stecken ineinander (ein Erklär-Blatt im
 * Teil-Blatt) und öffnen Modale. Jede Fläche merkte sich früher ihr eigenes „vorher“ - nach Gruppe → Teil →
 * Schließen blieb die Seite am Handy gesperrt, und Escape im inneren Blatt schloss beide.
 */
describe('BottomSheet · ein Stapel mit dem Modal', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--vp-motion-exit');
    vi.useRealTimers();
  });

  /** Gruppe → Teil wie im Überblick von Nachweisen: ein Klick schließt das eine Blatt und öffnet das nächste. */
  function Wechsel({ zweites = 'blatt' }: { zweites?: 'blatt' | 'modal' }) {
    const [gruppe, setGruppe] = useState(false);
    const [teil, setTeil] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setGruppe(true)}>
          Grundlagen
        </button>
        <BottomSheet open={gruppe} title="Grundlagen" onClose={() => setGruppe(false)}>
          <button
            type="button"
            onClick={() => {
              setGruppe(false);
              setTeil(true);
            }}
          >
            Kontext
          </button>
        </BottomSheet>
        {zweites === 'blatt' ? (
          <BottomSheet open={teil} title="Kontext festhalten" onClose={() => setTeil(false)}>
            <button type="button">Weiter</button>
          </BottomSheet>
        ) : (
          <Modal open={teil} title="Kontext festhalten" onClose={() => setTeil(false)}>
            <button type="button">Weiter</button>
          </Modal>
        )}
      </>
    );
  }

  for (const zweites of ['blatt', 'modal'] as const) {
    it(`gibt die Seite nach Gruppe → ${zweites === 'blatt' ? 'Teil-Blatt' : 'Modal'} → Schließen wieder frei, auch während das erste ausblendet`, () => {
      vi.useFakeTimers();
      document.documentElement.style.setProperty('--vp-motion-exit', '160ms');
      render(<Wechsel zweites={zweites} />);
      const ausloeser = screen.getByRole('button', { name: 'Grundlagen' });
      ausloeser.focus();
      fireEvent.click(ausloeser);
      fireEvent.click(screen.getByRole('button', { name: 'Kontext' }));
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
      expect(document.body.style.overflow).toBe('hidden');

      fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.body.style.overflow).toBe('');
      // Der Auslöser im ersten Blatt ist fort - der Fokus geht an den Auslöser des ersten Blatts.
      expect(document.activeElement).toBe(ausloeser);
    });
  }

  /** Ein Erklär-Blatt im Blatt eines Teils: React-Kind des äußeren, im DOM ein eigenes Portal. */
  function Verschachtelt({ aussenZu, innenZu }: { aussenZu: () => void; innenZu: () => void }) {
    const [innen, setInnen] = useState(false);
    return (
      <BottomSheet open title="Kontext festhalten" onClose={aussenZu}>
        <input aria-label="Grund" />
        <button type="button" onClick={() => setInnen(true)}>
          Was heißt das?
        </button>
        <BottomSheet
          open={innen}
          title="Erklärung"
          onClose={() => {
            innenZu();
            setInnen(false);
          }}
        >
          <button type="button">Verstanden</button>
        </BottomSheet>
      </BottomSheet>
    );
  }

  it('Escape im inneren Blatt schließt nur das innere', () => {
    const aussenZu = vi.fn();
    const innenZu = vi.fn();
    render(<Verschachtelt aussenZu={aussenZu} innenZu={innenZu} />);
    const knopf = screen.getByRole('button', { name: 'Was heißt das?' });
    knopf.focus();
    fireEvent.click(knopf);
    const innen = screen.getByRole('dialog', { name: 'Erklärung' });
    fireEvent.keyDown(innen, { key: 'Escape' });
    expect(innenZu).toHaveBeenCalledTimes(1);
    expect(aussenZu).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Erklärung' })).toBeNull();
    expect(document.activeElement).toBe(knopf);
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('Tab bleibt im inneren Blatt, statt ins äußere zu springen', () => {
    render(<Verschachtelt aussenZu={() => {}} innenZu={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Was heißt das?' }));
    const innen = screen.getByRole('dialog', { name: 'Erklärung' });
    const verstanden = screen.getByRole('button', { name: 'Verstanden' });
    verstanden.focus();
    fireEvent.keyDown(verstanden, { key: 'Tab' });
    expect(innen.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement as Element, { key: 'Tab' });
    expect(innen.contains(document.activeElement)).toBe(true);
  });
});
