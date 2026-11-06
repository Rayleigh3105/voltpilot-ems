import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Der Raum „Geräte" (umgehängt vom Raum „Plattform"): trägt vier Reiter -
 * Geräte (Liste/Akte) · Software (N5) · Werkstatt · Fernwartung. Geprüft wird
 * der WIRT: dass er je Route die richtige Fläche rendert, die Reiterleiste in
 * jede durchreicht und ein Klick die passende Route navigiert. Was die
 * Flächen selbst zeigen, prüfen ihre eigenen Suiten.
 */
vi.mock('./GeraeteListePage', () => ({
  GeraeteListePage: () => <h1>Geräte-Liste-Fläche</h1>,
}));
vi.mock('./GeraeteAktePage', () => ({
  GeraeteAktePage: () => <h1>Geräteakte-Fläche</h1>,
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

const { GeraeteBereich } = await import('./GeraeteRegistryPage');

describe('GeraeteBereich - EIN Raum, vier Reiter', () => {
  const onNavigate = vi.fn();
  beforeEach(() => onNavigate.mockReset());

  it('rendert je Route die zugehörige Fläche', () => {
    const { rerender } = render(
      <GeraeteBereich page="geraete-registry" onNavigate={onNavigate} />,
    );
    expect(screen.getByText('Geräte-Liste-Fläche')).toBeInTheDocument();

    rerender(<GeraeteBereich page="edge-updates" onNavigate={onNavigate} />);
    expect(screen.getByText('Software-Fläche')).toBeInTheDocument();

    rerender(<GeraeteBereich page="werkstatt" onNavigate={onNavigate} />);
    expect(screen.getByText('Werkstatt-Fläche')).toBeInTheDocument();

    rerender(<GeraeteBereich page="fernwartung" onNavigate={onNavigate} />);
    expect(screen.getByText('Fernwartung-Fläche')).toBeInTheDocument();
  });

  it('zeigt die Geräteakte statt der Liste, wenn eine Box-Referenz dabei ist', () => {
    render(
      <GeraeteBereich page="geraete-registry" geraeteAkte={{ ref: 'edge-abc', reiter: null }} onNavigate={onNavigate} />,
    );
    expect(screen.getByText('Geräteakte-Fläche')).toBeInTheDocument();
  });

  it('nennt die vier Reiter in Lese-Reihenfolge, markiert den laufenden und navigiert auf den anderen', () => {
    render(<GeraeteBereich page="edge-updates" onNavigate={onNavigate} />);
    const tabs = screen.getByRole('tablist', { name: 'Geräte' });
    expect(tabs.textContent).toBe('GeräteSoftwareWerkstattFernwartung');
    expect(screen.getByRole('tab', { name: 'Software' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Geräte' }).getAttribute('aria-selected')).toBe('false');

    fireEvent.click(screen.getByRole('tab', { name: 'Werkstatt' }));
    expect(onNavigate).toHaveBeenCalledWith({ page: 'werkstatt', siteId: null, sub: null });
  });

  it('reicht die Leiste in JEDE Fläche - sie gehört dem Raum, nicht einer Seite', () => {
    const { rerender } = render(
      <GeraeteBereich page="werkstatt" onNavigate={onNavigate} />,
    );
    expect(screen.getByRole('tablist', { name: 'Geräte' })).toBeInTheDocument();
    rerender(<GeraeteBereich page="fernwartung" onNavigate={onNavigate} />);
    expect(screen.getByRole('tablist', { name: 'Geräte' })).toBeInTheDocument();
  });
});
