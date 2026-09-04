import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Modal } from '../../designsystem/components/shell/Modal';

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
