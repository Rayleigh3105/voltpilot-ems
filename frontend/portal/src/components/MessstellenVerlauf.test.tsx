import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UEMS_VERLAUF_WAHL } from '../glossar';
import { f8Tag, f8Viertelstunden, f13Viertelstunden } from '../test/werteKarteFixtures';
import { kernaussage } from '../uemsVerlauf';
import { MessstellenVerlauf } from './MessstellenVerlauf';

/**
 * Die Render-Hälfte des Verlaufs (UEMS AP-13 IP-4): was `uemsVerlauf.ts` ableitet, steht wirklich im Bild — ein Ziel je
 * Schritt, kein Balken ohne Zahl, die Lücke als Fläche, die Marke mit Nummer und ihr Satz in der Liste, die Karte des
 * gewählten Schritts. Testing Library normalisiert U+00A0 zu einem Leerzeichen.
 */

const zeichne = (antwort = f8Viertelstunden(), kern = kernaussage('tag', f8Tag())) => render(<MessstellenVerlauf antwort={antwort} kern={kern} />);

describe('MessstellenVerlauf · F8 · 03.11.2026', () => {
  it('96 Ziele, 82 Balken, eine schraffierte Fläche, eine Marke — und der Kernaussage-Satz', () => {
    const { container } = zeichne();
    const verlauf = screen.getByTestId('verlauf');
    expect(within(verlauf).getByRole('heading', { level: 3, name: 'Verlauf' })).toBeInTheDocument();
    expect(within(verlauf).getByText('Di 03.11.2026: 2.304 kWh · vollständig · vorläufig')).toBeInTheDocument();
    expect(screen.getAllByTestId('verlauf-schritt')).toHaveLength(96);
    expect(container.querySelectorAll('[data-zustand="keine_werte"]')).toHaveLength(13);
    expect(container.querySelectorAll('.vp-mv-balken')).toHaveLength(82);
    expect(screen.getAllByTestId('verlauf-luecke')).toHaveLength(1);
    expect(screen.getAllByTestId('verlauf-luecke')[0].getAttribute('fill')).toMatch(/^url\(#vp-mv-.*-luecke\)$/);
    expect(screen.getAllByTestId('verlauf-marke').map((m) => m.getAttribute('data-nummer'))).toEqual(['1']);
    expect(screen.getAllByTestId('verlauf-ereignis').map((e) => e.textContent)).toEqual(['1Lücke von 03.11.2026 14:00 bis 17:31 — nie als 0 gerechnet']);
  });

  it('Farbe UND Wort: die Legende nennt genau die Zustände im Bild', () => {
    zeichne();
    expect(within(screen.getByTestId('verlauf-legende')).getAllByRole('listitem').map((l) => l.textContent)).toEqual([
      'vollständig',
      'unvollständig',
      'keine Werte',
    ]);
  });

  it('Tipp → die Karte des Schritts; ‹ › wandert zum Nachbarn; ein zweiter Tipp hebt die Wahl auf', () => {
    zeichne();
    const wahl = UEMS_VERLAUF_WAHL.viertelstunde;
    expect(screen.getByText(wahl.tipp)).toBeInTheDocument();
    const ziel = screen.getAllByTestId('verlauf-schritt').find((s) => s.getAttribute('data-von') === '2026-11-03T17:30:00+01:00')!;
    fireEvent.click(ziel);
    const karte = screen.getByTestId('verlauf-schritt-karte');
    expect(karte).toHaveTextContent('17:30–17:45');
    expect(karte).toHaveTextContent('22,4 kWh');
    expect(karte).toHaveTextContent('unvollständig (Menge aus Zählerständen)');
    expect(karte).toHaveTextContent('Verlauf 93 % · 14 von 15 Werten · 1 Lücke');
    expect(karte).toHaveTextContent('Anfang nicht gemessen (kein Stand an der Periodengrenze)');
    expect(screen.queryByText(wahl.tipp)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: wahl.vorher }));
    expect(screen.getByTestId('verlauf-schritt-karte')).toHaveTextContent('17:15–17:30');
    expect(screen.getByTestId('verlauf-schritt-karte')).toHaveTextContent('keine Werte');
    expect(screen.getByTestId('verlauf-schritt-karte')).toHaveTextContent('0 von 15 Werten');

    const vorher = screen.getAllByTestId('verlauf-schritt').find((s) => s.getAttribute('data-von') === '2026-11-03T17:15:00+01:00')!;
    fireEvent.click(vorher);
    expect(screen.queryByTestId('verlauf-schritt-karte')).toBeNull();
  });

  it('am Rechner mit den Pfeiltasten: → wählt die erste Viertelstunde, Ende die letzte (die Route schreibt „23:45–00:00“), Escape hebt auf', () => {
    zeichne();
    const bild = screen.getByRole('group', { name: /Verlauf/ });
    fireEvent.keyDown(bild, { key: 'ArrowRight' });
    expect(screen.getByTestId('verlauf-schritt-karte')).toHaveTextContent('00:00–00:15');
    fireEvent.keyDown(bild, { key: 'End' });
    expect(screen.getByTestId('verlauf-schritt-karte')).toHaveTextContent('23:45–00:00');
    expect(screen.getByRole('button', { name: UEMS_VERLAUF_WAHL.viertelstunde.weiter })).toBeDisabled();
    fireEvent.keyDown(bild, { key: 'Escape' });
    expect(screen.queryByTestId('verlauf-schritt-karte')).toBeNull();
  });

  it('der Einstieg „Versionen“ kommt vom Wirt, für genau den gewählten Schritt', () => {
    const versionen = vi.fn(() => <span>Versionen-Einstieg</span>);
    render(<MessstellenVerlauf antwort={f8Viertelstunden()} kern={null} versionen={versionen} />);
    fireEvent.click(screen.getAllByTestId('verlauf-schritt')[70]);
    expect(versionen).toHaveBeenLastCalledWith(expect.objectContaining({ index: 70, titel: '17:30–17:45' }));
    expect(screen.getByText('Versionen-Einstieg')).toBeInTheDocument();
  });
});

describe('MessstellenVerlauf · F13 · 25.10.2026', () => {
  it('100 Viertelstunden, keine Fläche, keine Marke, nur „vollständig“ in der Legende', () => {
    zeichne(f13Viertelstunden(), null);
    expect(screen.getAllByTestId('verlauf-schritt')).toHaveLength(100);
    expect(screen.queryAllByTestId('verlauf-luecke')).toHaveLength(0);
    expect(screen.queryAllByTestId('verlauf-marke')).toHaveLength(0);
    expect(screen.queryByRole('list', { name: 'Ereignisse im Verlauf' })).toBeNull();
    expect(within(screen.getByTestId('verlauf-legende')).getAllByRole('listitem').map((l) => l.textContent)).toEqual(['vollständig']);
  });
});
