import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ControlStrip } from './ControlStrip';
import type { ControlStripView } from '../control';

function view(over: Partial<ControlStripView> = {}): ControlStripView {
  return {
    state: 'healthy',
    tone: 'ok',
    sentence: 'Ihr Gerät regelt gerade auf 10,8 kW → Wechselrichter bestätigt 10,8 kW',
    agoNote: 'geprüft vor 3 s',
    reason: null,
    execution: null,
    curtailment: null,
    outlook: null,
    ...over,
  };
}

describe('ControlStrip', () => {
  it('renders the reason under the sentence when the plan recorded one', () => {
    const reason = 'Lädt günstig aus dem Netz: Börsenpreis 3,3 ct/kWh liegt unter dem Wert gespeicherter Energie.';
    const { container } = render(<ControlStrip view={view({ reason })} />);
    expect(screen.getByText(reason)).toBeInTheDocument();
    // The reason belongs to the same card, one notch quieter - never a banner.
    expect(container.querySelector('.vp-control-reason')).not.toBeNull();
  });

  it('renders nothing extra without a reason (the pre-2026-07-30 card)', () => {
    const { container } = render(<ControlStrip view={view()} />);
    expect(container.querySelector('.vp-control-reason')).toBeNull();
    expect(screen.getByText(/regelt gerade auf/)).toBeInTheDocument();
  });

  it('nennt die vom Gerät gemeldete Korrektur - in BEIDEN Varianten (PR 3)', () => {
    const execution =
      'Der Fahrplan sah 4,3 kW vor — Ihr Haus braucht gerade mehr. Die Entladung wurde auf ' +
      'den gemessenen Verbrauch (7,1 kW) angehoben, damit kein Netzstrom nötig ist.';
    for (const variant of ['card', 'bare'] as const) {
      const { container, unmount } = render(<ControlStrip view={view({ execution })} variant={variant} />);
      expect(container.textContent).toContain('angehoben');
      unmount();
    }
  });

  it('behauptet ohne gemeldete Korrektur keine (ältere Edge-Version)', () => {
    const { container } = render(<ControlStrip view={view()} />);
    expect(container.textContent).not.toContain('angehoben');
    expect(container.querySelector('.vp-control-reason')).toBeNull();
  });

  it('renders the Ruhe outlook line (Teil 3) in both variants, else nothing', () => {
    const outlook = '→ Weiter laut Fahrplan: Laden ab ca. 11:15 Uhr.';
    for (const variant of ['card', 'bare'] as const) {
      const { container, unmount } = render(
        <ControlStrip view={view({ outlook })} variant={variant} />,
      );
      expect(container.querySelector('.vp-outlook')?.textContent).toBe(outlook);
      unmount();
    }
    // No outlook → no line.
    const { container } = render(<ControlStrip view={view()} />);
    expect(container.querySelector('.vp-outlook')).toBeNull();
  });

  describe('Bühnenfuß (variant="bare")', () => {
    it('ist eine schlanke Zeile OHNE eigenen Kartenrahmen - Sollwert, Bestätigung, Grund', () => {
      const reason = 'Mittags-PV wird gespeichert und am Abend verkauft.';
      const { container } = render(<ControlStrip view={view({ reason })} variant="bare" />);
      const foot = container.querySelector('.vp-control-foot');
      expect(foot).not.toBeNull();
      // Karte-in-Karte ist aufgelöst (Befund P5 des Konzepts).
      expect(container.querySelector('.vp-card')).toBeNull();
      expect(container.querySelector('.vp-section')).toBeNull();
      // Alle drei Teile stehen weiterhin da - nur ohne Rahmen.
      expect(foot?.textContent).toContain('Steuerung');
      expect(foot?.textContent).toContain('regelt gerade auf');
      expect(foot?.textContent).toContain('geprüft vor 3 s');
      expect(container.querySelector('.vp-control-reason')?.textContent).toBe(reason);
      expect(container.querySelector('.vp-control-dot.tone-ok')).not.toBeNull();
    });

    it('behauptet keinen Grund, wenn der Plan keinen aufgezeichnet hat', () => {
      const { container } = render(<ControlStrip view={view()} variant="bare" />);
      expect(container.querySelector('.vp-control-reason')).toBeNull();
    });
  });
});
