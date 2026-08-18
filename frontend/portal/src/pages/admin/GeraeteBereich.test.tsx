import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Admin-Umbau Stufe 3 „Zusammenwachsen" (Captain-Entscheid F3): Geräte +
 * Updates sind EIN Nav-Punkt mit zwei Tabs, und BEIDE alten Routen bleiben
 * gültig - sie landen nur auf dem richtigen Tab.
 *
 * Die zwei Flächen selbst sind hier attrappiert: was sie zeigen, prüfen ihre
 * eigenen Suiten. Geprüft wird der WIRT - dass er die richtige rendert, die
 * Tab-Leiste durchreicht und ein Klick die passende Route navigiert.
 */
vi.mock('./GeraeteRegistryPage', () => ({
  GeraeteRegistryPage: ({ tabs }: { tabs?: React.ReactNode }) => (
    <div>
      {tabs}
      <h1>Inventar-Fläche</h1>
    </div>
  ),
}));
vi.mock('./EdgeUpdatesPage', () => ({
  EdgeUpdatesPage: ({ tabs }: { tabs?: React.ReactNode }) => (
    <div>
      {tabs}
      <h1>Updates-Fläche</h1>
    </div>
  ),
}));

const { GeraeteBereich } = await import('./GeraeteBereich');

describe('GeraeteBereich - EIN Ort, zwei Tabs', () => {
  const onNavigate = vi.fn();
  beforeEach(() => onNavigate.mockReset());

  it('rendert je Route die zugehörige Fläche - beide Lesezeichen bleiben gültig', () => {
    const { rerender } = render(
      <GeraeteBereich page="geraete-registry" onNavigate={onNavigate} />,
    );
    expect(screen.getByText('Inventar-Fläche')).toBeInTheDocument();
    expect(screen.queryByText('Updates-Fläche')).toBeNull();

    rerender(<GeraeteBereich page="edge-updates" onNavigate={onNavigate} />);
    expect(screen.getByText('Updates-Fläche')).toBeInTheDocument();
    expect(screen.queryByText('Inventar-Fläche')).toBeNull();
  });

  it('markiert den laufenden Tab und navigiert auf den anderen', () => {
    render(<GeraeteBereich page="edge-updates" onNavigate={onNavigate} />);
    const tabs = screen.getByRole('tablist', { name: 'Geräte-Bereich' });
    expect(tabs.textContent).toContain('Inventar');
    expect(tabs.textContent).toContain('Updates');
    expect(screen.getByRole('tab', { name: 'Updates' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Inventar' }).getAttribute('aria-selected')).toBe('false');

    fireEvent.click(screen.getByRole('tab', { name: 'Inventar' }));
    expect(onNavigate).toHaveBeenCalledWith({ page: 'geraete-registry', siteId: null, sub: null });
  });

  it('reicht die Leiste in BEIDE Flächen - sie gehört dem Bereich, nicht einer Seite', () => {
    const { rerender } = render(
      <GeraeteBereich page="geraete-registry" onNavigate={onNavigate} />,
    );
    expect(screen.getByRole('tablist', { name: 'Geräte-Bereich' })).toBeInTheDocument();
    rerender(<GeraeteBereich page="edge-updates" onNavigate={onNavigate} />);
    expect(screen.getByRole('tablist', { name: 'Geräte-Bereich' })).toBeInTheDocument();
  });
});
