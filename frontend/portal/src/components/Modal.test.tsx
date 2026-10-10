import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Modal } from '../../designsystem/components/shell/Modal';
import { merkeAusloeser } from '../../designsystem/components/shell/ueberlagerung';

/**
 * **Das zentrierte Modal des Design-Systems** (Captain-Entscheid 04.09.2026:
 * „Every Sidebar should be a modal."). Es hat das rechts einfahrende `Drawer`
 * ersetzt — dieselben Zusagen, nur zentriert und nach `document.body`
 * gerendert. Geprüft wird genau das, was ein Aufrufer sich darauf verlässt.
 */
describe('Modal', () => {
  it('rendert nach `document.body`, nicht in den Container des Aufrufers', () => {
    const { container } = render(
      <Modal open onClose={() => {}} title="Anlage anlegen">
        <p>Inhalt</p>
      </Modal>,
    );
    expect(container.querySelector('.vp-modal')).toBeNull();
    const panel = document.body.querySelector('.vp-modal');
    expect(panel).not.toBeNull();
    expect(panel?.tagName).toBe('DIV'); // kein `aside` mehr
    expect(screen.getByRole('dialog', { name: 'Anlage anlegen' })).toBe(panel);
    expect(panel).toHaveAttribute('aria-modal', 'true');
  });

  it('rendert nichts, solange es geschlossen ist', () => {
    render(
      <Modal open={false} onClose={() => {}} title="Zu">
        <p>Inhalt</p>
      </Modal>,
    );
    expect(document.body.querySelector('.vp-modal')).toBeNull();
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('schließt über Schleier-Klick, ✕ und Escape', () => {
    const onClose = vi.fn();
    const { rerender } = render(<Modal open onClose={onClose} title="T">x</Modal>);

    fireEvent.mouseDown(document.body.querySelector('.vp-modal-scrim')!);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);

    // Ein Klick INNERHALB der Fläche schließt nicht.
    fireEvent.mouseDown(document.body.querySelector('.vp-modal')!);
    expect(onClose).toHaveBeenCalledTimes(3);

    rerender(<Modal open={false} onClose={onClose} title="T">x</Modal>);
  });

  it('Escape trifft nur das OBERSTE von zwei gestapelten Modalen', () => {
    const untenZu = vi.fn();
    const obenZu = vi.fn();
    render(
      <>
        <Modal open onClose={untenZu} title="Unten">u</Modal>
        <Modal open onClose={obenZu} title="Oben">o</Modal>
      </>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(obenZu).toHaveBeenCalledTimes(1);
    expect(untenZu).not.toHaveBeenCalled();
  });

  it('gibt den Seiten-Scroll erst nach dem LETZTEN Modal wieder frei', () => {
    const { rerender } = render(
      <>
        <Modal open onClose={() => {}} title="Unten">u</Modal>
        <Modal open onClose={() => {}} title="Oben">o</Modal>
      </>,
    );
    expect(document.body.style.overflow).toBe('hidden');

    rerender(
      <>
        <Modal open onClose={() => {}} title="Unten">u</Modal>
        <Modal open={false} onClose={() => {}} title="Oben">o</Modal>
      </>,
    );
    expect(document.body.style.overflow).toBe('hidden');

    rerender(
      <>
        <Modal open={false} onClose={() => {}} title="Unten">u</Modal>
        <Modal open={false} onClose={() => {}} title="Oben">o</Modal>
      </>,
    );
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('nimmt den Fokus auf und gibt ihn beim Schließen zurück', () => {
    const ausloeser = document.createElement('button');
    document.body.appendChild(ausloeser);
    ausloeser.focus();
    expect(document.activeElement).toBe(ausloeser);

    const { rerender } = render(<Modal open onClose={() => {}} title="T">x</Modal>);
    expect(document.activeElement).toBe(document.body.querySelector('.vp-modal'));

    rerender(<Modal open={false} onClose={() => {}} title="T">x</Modal>);
    expect(document.activeElement).toBe(ausloeser);
    ausloeser.remove();
  });

  // Safari fokussiert einen angetippten Knopf nicht (jsdom ebenso wenig): der Stapel merkt sich das Ziel des Zeigers.
  it('gibt den Fokus an den angetippten Knopf zurück, auch wenn der Browser ihn nicht fokussiert hat', () => {
    const ausloeser = document.createElement('button');
    document.body.appendChild(ausloeser);
    fireEvent.pointerDown(ausloeser);
    fireEvent.click(ausloeser);
    expect(document.activeElement).toBe(document.body);

    const { rerender } = render(<Modal open onClose={() => {}} title="T">x</Modal>);
    rerender(<Modal open={false} onClose={() => {}} title="T">x</Modal>);
    expect(document.activeElement).toBe(ausloeser);
    ausloeser.remove();
  });

  it('ein Knopf IN der Fläche darunter ist der Auslöser, nicht die Fläche, die den Fokus trägt', () => {
    const { rerender } = render(
      <Modal open onClose={() => {}} title="Unten"><button type="button">Erklären</button></Modal>,
    );
    const knopf = screen.getByRole('button', { name: 'Erklären' });
    fireEvent.pointerDown(knopf);
    fireEvent.click(knopf);
    expect(document.activeElement).toBe(document.body.querySelector('.vp-modal'));

    const oben = (open: boolean) => (
      <>
        <Modal open onClose={() => {}} title="Unten"><button type="button">Erklären</button></Modal>
        <Modal open={open} onClose={() => {}} title="Oben">y</Modal>
      </>
    );
    rerender(oben(true));
    rerender(oben(false));
    expect(document.activeElement).toBe(knopf);
  });

  it('eine Taste seit dem Antippen: der Zeiger war nicht der Auslöser', () => {
    const angetippt = document.createElement('button');
    document.body.appendChild(angetippt);
    fireEvent.pointerDown(angetippt);
    fireEvent.click(angetippt);
    fireEvent.keyDown(document.body, { key: '?' });

    const { rerender } = render(<Modal open onClose={() => {}} title="T">x</Modal>);
    rerender(<Modal open={false} onClose={() => {}} title="T">x</Modal>);
    expect(document.activeElement).not.toBe(angetippt);
    angetippt.remove();
  });

  it('ein ausdrücklich genannter Auslöser gewinnt: der Menüeintrag verschwindet, sein Knopf bleibt', () => {
    const knopf = document.createElement('button');
    const eintrag = document.createElement('button');
    document.body.append(knopf, eintrag);
    fireEvent.pointerDown(eintrag);
    fireEvent.click(eintrag);
    merkeAusloeser(knopf);
    eintrag.remove();

    const { rerender } = render(<Modal open onClose={() => {}} title="T">x</Modal>);
    rerender(<Modal open={false} onClose={() => {}} title="T">x</Modal>);
    expect(document.activeElement).toBe(knopf);

    // Genannt für genau EINE Fläche: die nächste liest wieder den Fokus.
    const anderer = document.createElement('button');
    document.body.appendChild(anderer);
    anderer.focus();
    rerender(<Modal open onClose={() => {}} title="T">x</Modal>);
    rerender(<Modal open={false} onClose={() => {}} title="T">x</Modal>);
    expect(document.activeElement).toBe(anderer);
    knopf.remove();
    anderer.remove();
  });

  it('hält Tab und Shift-Tab in der Fläche', () => {
    render(
      <Modal open onClose={() => {}} title="T" footer={<button type="button">Speichern</button>}>
        <button type="button">Erster</button>
      </Modal>,
    );
    const panel = document.body.querySelector('.vp-modal') as HTMLElement;
    // Reihenfolge im DOM: ✕ (Kopf) · Erster (Körper) · Speichern (Fuß).
    const schliessen = within(panel).getByRole('button', { name: 'Schließen' });
    const erster = within(panel).getByRole('button', { name: 'Erster' });
    const speichern = within(panel).getByRole('button', { name: 'Speichern' });

    erster.focus();
    fireEvent.keyDown(panel, { key: 'Tab' });
    expect(document.activeElement).toBe(speichern);

    // Am Ende der Liste geht es rundherum, nicht auf die Seite dahinter.
    fireEvent.keyDown(panel, { key: 'Tab' });
    expect(document.activeElement).toBe(schliessen);

    fireEvent.keyDown(panel, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(speichern);
  });

  it('rendert Kopf, Körper und Fuß in den bekannten Hüllen', () => {
    render(
      <Modal open onClose={() => {}} title="Titel" icon={<span data-testid="icon" />} footer={<em>Fuß</em>}>
        <p>Körper</p>
      </Modal>,
    );
    const panel = document.body.querySelector('.vp-modal') as HTMLElement;
    expect(panel.querySelector('.dhead h2')).toHaveTextContent('Titel');
    expect(panel.querySelector('.dhead')).toContainElement(screen.getByTestId('icon'));
    expect(panel.querySelector('.dbody')).toHaveTextContent('Körper');
    expect(panel.querySelector('.dfoot')).toHaveTextContent('Fuß');
  });

  it('lässt den Fuß weg, wenn es keinen gibt', () => {
    render(<Modal open onClose={() => {}} title="T">x</Modal>);
    expect(document.body.querySelector('.vp-modal .dfoot')).toBeNull();
  });
});

/**
 * **Bewegung P6 · das Modal blendet AUS** (Konzept §6 Zeile „Modal / Drawer":
 * „Ausblenden immer … Zustand ‚closing' im Modal").
 *
 * ⚠ Warum die Tests das Token selbst setzen: `useAusblenden` misst
 * `--vp-motion-exit` an der `documentElement`, und jsdom lädt kein
 * Stylesheet — ohne gemessene Dauer wird nicht gewartet. Das ist die
 * Ehrlichkeitsregel des Bausteins und zugleich der Grund, warum die anderen
 * Modal-Tests oben unverändert synchron durchlaufen.
 */
describe('Modal · Bewegung P6 (Ausblenden)', () => {
  const setzeDauer = (wert: string | null) => {
    if (wert === null) document.documentElement.style.removeProperty('--vp-motion-exit');
    else document.documentElement.style.setProperty('--vp-motion-exit', wert);
  };

  afterEach(() => {
    setzeDauer(null);
    vi.useRealTimers();
  });

  it('bleibt nach dem Schließen im Baum und geht erst nach der Ausblend-Dauer', () => {
    vi.useFakeTimers();
    setzeDauer('160ms');
    const { rerender } = render(
      <Modal open onClose={() => {}} title="Anlage anlegen">
        <p>Inhalt</p>
      </Modal>,
    );
    expect(document.body.querySelector('.vp-modal')).not.toBeNull();

    rerender(
      <Modal open={false} onClose={() => {}} title="Anlage anlegen">
        <p>Inhalt</p>
      </Modal>,
    );
    // Noch da — und sichtbar als „geht gerade".
    expect(document.body.querySelector('.vp-modal')).not.toBeNull();
    expect(document.body.querySelector('.vp-modal-scrim')).toHaveClass('is-closing');
    // Die Seite ist noch gesperrt: darunter darf nichts scrollen, solange die
    // Fläche steht.
    expect(document.body.style.overflow).toBe('hidden');

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(document.body.querySelector('.vp-modal')).toBeNull();
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('verschwindet bei Schalter 0 (reduced motion) SOFORT — kein Hänger', () => {
    setzeDauer('0s');
    const { rerender } = render(
      <Modal open onClose={() => {}} title="T">
        x
      </Modal>,
    );
    rerender(
      <Modal open={false} onClose={() => {}} title="T">
        x
      </Modal>,
    );
    expect(document.body.querySelector('.vp-modal')).toBeNull();
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('gibt den Fokus erst zurück, wenn die Fläche wirklich fort ist', () => {
    vi.useFakeTimers();
    setzeDauer('160ms');
    const ausloeser = document.createElement('button');
    document.body.appendChild(ausloeser);
    ausloeser.focus();

    const { rerender } = render(
      <Modal open onClose={() => {}} title="T">
        <button type="button">drin</button>
      </Modal>,
    );
    expect(document.activeElement).toBe(document.body.querySelector('.vp-modal'));

    rerender(
      <Modal open={false} onClose={() => {}} title="T">
        <button type="button">drin</button>
      </Modal>,
    );
    expect(document.activeElement).not.toBe(ausloeser);

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(document.activeElement).toBe(ausloeser);
    ausloeser.remove();
  });

  it('ein `animationend` beendet das Warten früher als der Zeitgeber', () => {
    vi.useFakeTimers();
    setzeDauer('160ms');
    const { rerender } = render(
      <Modal open onClose={() => {}} title="T">
        x
      </Modal>,
    );
    rerender(
      <Modal open={false} onClose={() => {}} title="T">
        x
      </Modal>,
    );
    const panel = document.body.querySelector('.vp-modal') as HTMLElement;
    act(() => {
      panel.dispatchEvent(new Event('animationend'));
    });
    expect(document.body.querySelector('.vp-modal')).toBeNull();
  });

  it('gestapelte Modale blenden je für sich — die Sperre bleibt bis zum letzten', () => {
    vi.useFakeTimers();
    setzeDauer('160ms');
    function Stapel({ unten, oben }: { unten: boolean; oben: boolean }) {
      return (
        <>
          <Modal open={unten} onClose={() => {}} title="Unten">
            u
          </Modal>
          <Modal open={oben} onClose={() => {}} title="Oben">
            o
          </Modal>
        </>
      );
    }
    const { rerender } = render(<Stapel unten oben />);
    expect(document.body.querySelectorAll('.vp-modal')).toHaveLength(2);

    // Nur das obere geht.
    rerender(<Stapel unten oben={false} />);
    const schleier = document.body.querySelectorAll('.vp-modal-scrim');
    expect(schleier).toHaveLength(2);
    expect(schleier[0]).not.toHaveClass('is-closing');
    expect(schleier[1]).toHaveClass('is-closing');

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(document.body.querySelectorAll('.vp-modal')).toHaveLength(1);
    expect(document.body.style.overflow).toBe('hidden');

    rerender(<Stapel unten={false} oben={false} />);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(document.body.querySelectorAll('.vp-modal')).toHaveLength(0);
    expect(document.body.style.overflow).not.toBe('hidden');
  });
});
