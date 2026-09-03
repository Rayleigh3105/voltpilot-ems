import { useState, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
