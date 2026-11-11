import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Scheibe S1 (Konzept `vp-adminview-konzept-k1` §4.2/4.3; seither umgehängt):
 * der Raum „Plattform" trägt zwei Reiter - Übersicht · Katalog. Software,
 * Werkstatt und Fernwartung sind gerätebezogene Flächen und wohnen seit dem
 * Umhängen im Raum „Geräte" (`GeraeteBereich.test.tsx`). Geprüft wird der
 * WIRT: dass er je Route die richtige Fläche rendert, die Reiterleiste in
 * jede durchreicht und ein Klick die passende Route navigiert. Was die
 * Flächen selbst zeigen, prüfen ihre eigenen Suiten.
 */
vi.mock('./PlattformUebersichtPage', () => ({
  PlattformUebersichtPage: ({ tabs }: { tabs?: React.ReactNode }) => (
    <div>
      {tabs}
      <h1>Übersicht-Fläche</h1>
    </div>
  ),
}));
vi.mock('./KatalogBereich', () => ({
  KatalogBereich: ({ tabs }: { tabs?: React.ReactNode }) => (
    <div>
      {tabs}
      <h1>Katalog-Fläche</h1>
    </div>
  ),
}));

const { PlattformBereich } = await import('./PlattformBereich');

describe('PlattformBereich - EIN Raum, zwei Reiter', () => {
  const onNavigate = vi.fn();
  beforeEach(() => onNavigate.mockReset());

  it('rendert je Route die zugehörige Fläche', () => {
    const { rerender } = render(
      <PlattformBereich page="plattform-uebersicht" onNavigate={onNavigate} />,
    );
    expect(screen.getByText('Übersicht-Fläche')).toBeInTheDocument();

    rerender(<PlattformBereich page="katalog" onNavigate={onNavigate} />);
    expect(screen.getByText('Katalog-Fläche')).toBeInTheDocument();
  });

  it('nennt die zwei Reiter in Lese-Reihenfolge, markiert den laufenden und navigiert auf den anderen', () => {
    render(<PlattformBereich page="plattform-uebersicht" onNavigate={onNavigate} />);
    const tabs = screen.getByRole('tablist', { name: 'Plattform' });
    expect(tabs.textContent).toBe('ÜbersichtKatalog');
    expect(screen.getByRole('tab', { name: 'Übersicht' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Katalog' }).getAttribute('aria-selected')).toBe('false');

    fireEvent.click(screen.getByRole('tab', { name: 'Katalog' }));
    expect(onNavigate).toHaveBeenCalledWith({ page: 'katalog', siteId: null, sub: null });
  });

  it('reicht die Leiste in JEDE Fläche - sie gehört dem Raum, nicht einer Seite', () => {
    const { rerender } = render(
      <PlattformBereich page="plattform-uebersicht" onNavigate={onNavigate} />,
    );
    expect(screen.getByRole('tablist', { name: 'Plattform' })).toBeInTheDocument();
    rerender(<PlattformBereich page="katalog" onNavigate={onNavigate} />);
    expect(screen.getByRole('tablist', { name: 'Plattform' })).toBeInTheDocument();
  });
});
