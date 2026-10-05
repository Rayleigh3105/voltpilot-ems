import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TieferEinsteigen } from './TieferEinsteigen';
import type { EbenenLeistenKachel } from '../ebenenNav';
import { pageRoute } from '../nav';

const GRUPPEN: EbenenLeistenKachel[] = [
  { key: 'uebersicht', label: 'Übersicht', icon: 'dashboard', ziel: pageRoute('portfolio'), bereiche: ['uebersicht'], frage: 'Läuft alles?' },
  { key: 'messen', label: 'Messen', icon: 'activity', ziel: pageRoute('portfolio-messstellen'), bereiche: ['messstellen'], frage: 'Wird alles erfasst?' },
  { key: 'auswerten', label: 'Auswerten', icon: 'trending-up', ziel: pageRoute('portfolio-kennzahlen'), bereiche: ['kennzahlen'], frage: 'Wo geht die Energie hin?' },
  { key: 'nachweisen', label: 'Nachweisen', icon: 'file-text', ziel: pageRoute('portfolio-energiemanagement'), bereiche: ['energiemanagement'], frage: 'Können wir es belegen?' },
];

describe('TieferEinsteigen', () => {
  it('zeigt die Arbeitsgruppen als Karten — ohne die „Übersicht", auf der man schon steht', () => {
    render(<TieferEinsteigen gruppen={GRUPPEN} onNavigate={() => {}} />);
    const sektion = screen.getByRole('region', { name: 'Tiefer einsteigen' });
    // Die „Übersicht"-Gruppe fällt weg; Messen · Auswerten · Nachweisen bleiben.
    expect(within(sektion).queryByText('Übersicht')).toBeNull();
    for (const [label, frage] of [
      ['Messen', 'Wird alles erfasst?'],
      ['Auswerten', 'Wo geht die Energie hin?'],
      ['Nachweisen', 'Können wir es belegen?'],
    ]) {
      expect(within(sektion).getByText(label)).toBeTruthy();
      expect(within(sektion).getByText(frage)).toBeTruthy();
    }
  });

  it('führt mit einem Klick in den Bereich', () => {
    const onNavigate = vi.fn();
    render(<TieferEinsteigen gruppen={GRUPPEN} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: /Auswerten/ }));
    expect(onNavigate).toHaveBeenCalledWith(pageRoute('portfolio-kennzahlen'));
  });

  it('ohne Gruppen (unter drei messenden Standorten) steht nichts', () => {
    const { container } = render(<TieferEinsteigen gruppen={[]} onNavigate={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('nur die „Übersicht"-Gruppe → nichts (kein Sprung auf sich selbst)', () => {
    const { container } = render(<TieferEinsteigen gruppen={[GRUPPEN[0]]} onNavigate={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});
