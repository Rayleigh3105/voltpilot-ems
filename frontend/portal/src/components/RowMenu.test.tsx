import { fireEvent, render, screen } from '@testing-library/react';
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
});
