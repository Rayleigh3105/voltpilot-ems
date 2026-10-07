import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RowMenu } from './RowMenu';

describe('RowMenu', () => {
  it('ein Eintrag darf eine leise zweite Zeile tragen; ohne sie bleibt er, wie er war', async () => {
    const tag = vi.fn();
    render(
      <RowMenu
        label="Weitere Aktionen"
        items={[
          { label: 'Stand an einem Tag ansehen', hinweis: 'Nur lesen, z. B. für eine Prüfung', onClick: tag },
          { label: 'Korrekturen am Standort', onClick: () => undefined },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Weitere Aktionen' }));
    const [mitHinweis, ohne] = await screen.findAllByRole('menuitem');
    expect(mitHinweis.querySelector('.vp-rowmenu-text small')?.textContent).toBe('Nur lesen, z. B. für eine Prüfung');
    expect(ohne.querySelector('.vp-rowmenu-text')).toBeNull();
    expect(ohne.textContent).toBe('Korrekturen am Standort');
    fireEvent.click(mitHinweis);
    expect(tag).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Tastatur: Fokus auf dem ersten Eintrag, Pfeiltasten wandern, Escape gibt den Fokus an den Auslöser zurück (Review r4 S23)', async () => {
    render(
      <RowMenu
        label="Weitere Aktionen"
        items={[
          { label: 'Erster', onClick: () => undefined },
          { label: 'Zweiter', onClick: () => undefined },
          { label: 'Dritter', onClick: () => undefined },
        ]}
      />,
    );
    const ausloeser = screen.getByRole('button', { name: 'Weitere Aktionen' });
    fireEvent.click(ausloeser);
    const [erster, zweiter, dritter] = await screen.findAllByRole('menuitem');
    await waitFor(() => expect(erster).toHaveFocus());
    fireEvent.keyDown(erster, { key: 'ArrowDown' });
    expect(zweiter).toHaveFocus();
    fireEvent.keyDown(zweiter, { key: 'End' });
    expect(dritter).toHaveFocus();
    fireEvent.keyDown(dritter, { key: 'ArrowDown' });
    expect(erster).toHaveFocus();
    fireEvent.keyDown(erster, { key: 'ArrowUp' });
    expect(dritter).toHaveFocus();
    fireEvent.keyDown(dritter, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(ausloeser).toHaveFocus();
  });

  it('ein gewählter Eintrag läuft mit dem Fokus auf dem Auslöser - ein Dialog kehrt beim Schließen dorthin zurück', async () => {
    let fokusBeimWaehlen: Element | null = null;
    render(<RowMenu label="Weitere Aktionen" items={[{ label: 'Korrekturen', onClick: () => (fokusBeimWaehlen = document.activeElement) }]} />);
    const ausloeser = screen.getByRole('button', { name: 'Weitere Aktionen' });
    fireEvent.click(ausloeser);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Korrekturen' }));
    expect(fokusBeimWaehlen).toBe(ausloeser);
  });
});
