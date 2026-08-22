import { fireEvent, render, screen } from '@testing-library/react';
import { createPortal } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnlegenDialog } from './AnlegenDialog';

function phone(an: boolean) {
  // jsdom kennt `matchMedia` nicht - `useIsPhone` fällt sonst auf Desktop
  // zurück. Für die Vollbild-Fassung wird sie ausdrücklich gestubbt.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (q: string) => ({
      matches: q.includes('max-width') ? an : !an,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
}

const SCHRITTE = ['Was anbinden', 'Gerät wählen', 'Verbinden', 'Testen', 'Fertig'];

beforeEach(() => phone(false));
afterEach(() => {
  // @ts-expect-error - die Stubs gehören dem einzelnen Test
  delete window.matchMedia;
});

describe('der Schritt-Dialog (Rechner)', () => {
  it('zeigt die BENANNTEN Schritte und markiert den laufenden', () => {
    render(
      <AnlegenDialog titel="Gerät anbinden" schritte={SCHRITTE} aktiv={3} onClose={() => {}}>
        <p>Inhalt</p>
      </AnlegenDialog>,
    );
    const leiste = screen.getByLabelText('Schritte');
    expect(leiste.querySelectorAll('li')).toHaveLength(5);
    expect(leiste.querySelector('li.is-active')?.textContent).toContain('Verbinden');
    // Die zwei davor sind erledigt, nicht offen.
    expect(leiste.querySelectorAll('li.is-done')).toHaveLength(2);
    // Der Zähler gehört dem Telefon - auf dem Rechner stehen die Namen.
    expect(screen.queryByText('Schritt 3 von 5')).toBeNull();
  });

  it('ist ein echter Dialog: modal, benannt, mit Fokus im Panel', () => {
    render(
      <AnlegenDialog titel="Gerät anbinden" schritte={SCHRITTE} aktiv={1} onClose={() => {}}>
        <button type="button">A</button>
      </AnlegenDialog>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Gerät anbinden' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(document.activeElement).toBe(dialog);
    // Der Rumpf dahinter scrollt nicht mit.
    expect(document.body.style.overflow).toBe('hidden');
  });

  /**
   * ⚠ Im Browser-Durchstich gefunden: nach einem Schritt-Wechsel verschwindet
   * der gedrückte Knopf, und der Fokus fällt auf den `body` - wer ohne Maus
   * arbeitet, steht dann wieder am Anfang des DOKUMENTS.
   */
  it('holt den Fokus bei einem Schritt-Wechsel zurück und sagt, wo man ist', () => {
    const { rerender } = render(
      <AnlegenDialog titel="T" schritte={SCHRITTE} aktiv={1} onClose={() => {}}>
        <button type="button">Karte</button>
      </AnlegenDialog>,
    );
    screen.getByRole('button', { name: 'Karte' }).focus();
    rerender(
      <AnlegenDialog titel="T" schritte={SCHRITTE} aktiv={2} onClose={() => {}}>
        <button type="button">Feld</button>
      </AnlegenDialog>,
    );
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    expect(screen.getByRole('status')).toHaveTextContent('Schritt 2 von 5: Gerät wählen');
  });

  it('schließt über Escape, das Kreuz und den Schleier', () => {
    const onClose = vi.fn();
    render(
      <AnlegenDialog titel="T" schritte={SCHRITTE} aktiv={1} onClose={onClose}>
        <p>x</p>
      </AnlegenDialog>,
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
    fireEvent.click(document.querySelector('.vp-anlegen-scrim') as Element);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  /**
   * ⚠ Die Fokus-Falle ist der Durchstich ohne Maus: ein modaler Dialog, aus dem
   * der Tabulator in die Seite dahinter läuft, ist für eine Bedienung ohne Maus
   * kaputt.
   */
  it('hält den Tabulator im Dialog - vorwärts wie rückwärts', () => {
    render(
      <>
        <button type="button">draussen</button>
        <AnlegenDialog
          titel="T"
          schritte={SCHRITTE}
          aktiv={1}
          onClose={() => {}}
          footer={<button type="button">Weiter</button>}
        >
          <button type="button">Erster</button>
        </AnlegenDialog>
      </>,
    );
    const dialog = screen.getByRole('dialog');
    const x = screen.getByRole('button', { name: 'Schließen' });
    const erster = screen.getByRole('button', { name: 'Erster' });
    const weiter = screen.getByRole('button', { name: 'Weiter' });

    weiter.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    // Vom letzten wieder auf das erste - nie hinaus zu „draussen".
    expect(document.activeElement).toBe(x);
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(erster);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(x);
  });

  /**
   * ⚠ Ein Picker-Panel hängt an `document.body`, bleibt aber im React-Baum ein
   * Kind des Dialogs - sein Tastendruck blubbert hierher. Ohne die Grenze
   * überschriebe die Fokus-Falle des Dialogs die des Panels.
   */
  it('lässt Tasten aus einem angehängten Panel in Ruhe', () => {
    const onClose = vi.fn();
    render(
      <AnlegenDialog titel="T" schritte={SCHRITTE} aktiv={1} onClose={onClose}>
        <button type="button">Erster</button>
        {/* Ein Panel, wie der Picker es baut: am `body`, aber im React-Baum
            ein Kind dieses Dialogs - sein Tastendruck blubbert hierher. */}
        {createPortal(
          <button type="button">Im Panel</button>,
          document.body,
        )}
      </AnlegenDialog>,
    );
    const imPanel = screen.getByRole('button', { name: 'Im Panel' });
    imPanel.focus();
    fireEvent.keyDown(imPanel, { key: 'Tab' });
    fireEvent.keyDown(imPanel, { key: 'Escape' });
    // Der Dialog hat NICHTS getan - das Panel behält Fokus und Escape.
    expect(document.activeElement).toBe(imPanel);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('die Vollbild-Schrittfolge (Telefon)', () => {
  beforeEach(() => phone(true));

  it('zeigt EINEN Schritt mit Zähler und Balken statt der Namensleiste', () => {
    render(
      <AnlegenDialog titel="Gerät anbinden" schritte={SCHRITTE} aktiv={2} onClose={() => {}}>
        <p>Inhalt</p>
      </AnlegenDialog>,
    );
    expect(screen.getByText('Schritt 2 von 5')).toBeInTheDocument();
    const balken = screen.getByRole('progressbar');
    expect(balken).toHaveAttribute('aria-valuenow', '2');
    expect(balken).toHaveAttribute('aria-valuemax', '5');
    // ⚠ Die Namensleiste steht NICHT zusätzlich im DOM - sonst läse
    // Vorlesesoftware jeden Schrittnamen doppelt.
    expect(screen.queryByLabelText('Schritte')).toBeNull();
    expect(screen.getByRole('dialog')).toHaveClass('is-vollbild');
  });

  it('trägt den Zurück-Pfeil nur, wo es einen Rückweg GIBT', () => {
    const onBack = vi.fn();
    const { rerender } = render(
      <AnlegenDialog titel="T" schritte={SCHRITTE} aktiv={1} onClose={() => {}} onBack={null}>
        <p>x</p>
      </AnlegenDialog>,
    );
    expect(screen.queryByRole('button', { name: 'Einen Schritt zurück' })).toBeNull();

    rerender(
      <AnlegenDialog titel="T" schritte={SCHRITTE} aktiv={2} onClose={() => {}} onBack={onBack}>
        <p>x</p>
      </AnlegenDialog>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Einen Schritt zurück' }));
    expect(onBack).toHaveBeenCalled();
  });
});
