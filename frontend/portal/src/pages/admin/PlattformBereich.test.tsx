import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Scheibe S1 (Konzept `vp-adminview-konzept-k1` §4.2/4.3): der Raum
 * „Plattform" trägt fünf Reiter - Übersicht · Software (N5) · Werkstatt ·
 * Fernwartung · Katalog. Geprüft wird der WIRT: dass er je Route die
 * richtige Fläche rendert, die Reiterleiste in jede durchreicht und ein
 * Klick die passende Route navigiert. Was die Flächen selbst zeigen, prüfen
 * ihre eigenen Suiten.
 */
vi.mock('./PlattformUebersichtPage', () => ({
  PlattformUebersichtPage: ({ tabs }: { tabs?: React.ReactNode }) => (
    <div>
      {tabs}
      <h1>Übersicht-Fläche</h1>
    </div>
  ),
}));
vi.mock('./EdgeUpdatesPage', () => ({
  EdgeUpdatesPage: ({ tabs }: { tabs?: React.ReactNode }) => (
    <div>
      {tabs}
      <h1>Software-Fläche</h1>
    </div>
  ),
}));
vi.mock('./WerkstattPage', () => ({
  WerkstattPage: ({ tabs }: { tabs?: React.ReactNode }) => (
    <div>
      {tabs}
      <h1>Werkstatt-Fläche</h1>
    </div>
  ),
}));
vi.mock('./FernwartungPage', () => ({
  FernwartungPage: ({ tabs }: { tabs?: React.ReactNode }) => (
    <div>
      {tabs}
      <h1>Fernwartung-Fläche</h1>
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

describe('PlattformBereich - EIN Raum, fünf Reiter', () => {
  const onNavigate = vi.fn();
  beforeEach(() => onNavigate.mockReset());

  it('rendert je Route die zugehörige Fläche', () => {
    const { rerender } = render(
      <PlattformBereich page="plattform-uebersicht" onNavigate={onNavigate} />,
    );
    expect(screen.getByText('Übersicht-Fläche')).toBeInTheDocument();

    rerender(<PlattformBereich page="edge-updates" onNavigate={onNavigate} />);
    expect(screen.getByText('Software-Fläche')).toBeInTheDocument();

    rerender(<PlattformBereich page="werkstatt" onNavigate={onNavigate} />);
    expect(screen.getByText('Werkstatt-Fläche')).toBeInTheDocument();

    rerender(<PlattformBereich page="fernwartung" onNavigate={onNavigate} />);
    expect(screen.getByText('Fernwartung-Fläche')).toBeInTheDocument();

    rerender(<PlattformBereich page="katalog" onNavigate={onNavigate} />);
    expect(screen.getByText('Katalog-Fläche')).toBeInTheDocument();
  });

  it('nennt die fünf Reiter in Lese-Reihenfolge, markiert den laufenden und navigiert auf den anderen', () => {
    render(<PlattformBereich page="edge-updates" onNavigate={onNavigate} />);
    const tabs = screen.getByRole('tablist', { name: 'Plattform' });
    expect(tabs.textContent).toBe('ÜbersichtSoftwareWerkstattFernwartungKatalog');
    expect(screen.getByRole('tab', { name: 'Software' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Übersicht' }).getAttribute('aria-selected')).toBe('false');

    fireEvent.click(screen.getByRole('tab', { name: 'Katalog' }));
    expect(onNavigate).toHaveBeenCalledWith({ page: 'katalog', siteId: null, sub: null });
  });

  it('reicht die Leiste in JEDE Fläche - sie gehört dem Raum, nicht einer Seite', () => {
    const { rerender } = render(
      <PlattformBereich page="werkstatt" onNavigate={onNavigate} />,
    );
    expect(screen.getByRole('tablist', { name: 'Plattform' })).toBeInTheDocument();
    rerender(<PlattformBereich page="katalog" onNavigate={onNavigate} />);
    expect(screen.getByRole('tablist', { name: 'Plattform' })).toBeInTheDocument();
  });
});
