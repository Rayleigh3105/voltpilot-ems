import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SteuerungFormel } from './SteuerungFormel';

/**
 * Der Aufklapper am Steuerungs-Chip. Die einzige Regel, die hier NICHT schon in
 * `steuerungFormel.test.ts` steht, ist die des LAYOUTS: zugeklappt kostet er
 * genau EINE Zeile — die Erlös-Karte darf durch ihn nicht wachsen.
 */
describe('SteuerungFormel (Fläche)', () => {
  it('ist zugeklappt und zeigt nur den Auslöser', () => {
    const { container } = render(
      <SteuerungFormel input={{ tarifArt: 'fest', tarifParamCtKwh: 30 }} />,
    );
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect((details as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByText('Wie wird das berechnet?')).toBeTruthy();
  });

  it('aufgeklappt trägt sie Kernsatz, Rechnung, Preise und Hinweis', () => {
    const { container } = render(
      <SteuerungFormel
        input={{
          tarifArt: 'dynamisch',
          tarifParamCtKwh: 18,
          bezugspreisCtKwh: 32.5,
          plantKind: 'direktvermarktung',
          marktpraemieEur: 0,
          anzulegenderWertCtKwh: 6.9,
          marketValueSolarCtKwh: 7,
          bestandSichtbar: true,
        }}
      />,
    );
    const details = container.querySelector('details') as HTMLDetailsElement;
    details.open = true;

    expect(container.textContent).toContain('Wir vergleichen jede Viertelstunde');
    // ⚠ Die MESSLATTE heisst seit dem 04.09.2026 „ein Speicher ohne smarte
    //   Steuerung" — die Rechenzeile nennt sie beim Namen.
    expect(container.textContent).toContain('Ohne smarte Steuerung');
    expect(container.textContent).toContain('Mit Steuerung');
    expect(container.textContent).toContain('Beitrag der Steuerung');
    expect(container.textContent).toContain('Bezugspreis');
    expect(container.textContent).toContain('Einspeisepreis');
    expect(container.textContent).toContain('Im Zeitraum im Schnitt');
    expect(container.textContent).toContain('voll aus dem Markt');
    expect(container.textContent).toContain('steht in der Zeile darunter');
    // B5: der Historik-Satz sitzt bei den Preis-Angaben (Tarif hinterlegt).
    expect(container.querySelector('.vp-formel-historik')?.textContent).toContain(
      'zurückliegende Auswertungen',
    );
  });

  it('B5 · nacktes „ohne" (reiner Börsenpreis): kein Historik-Satz', () => {
    const { container } = render(<SteuerungFormel input={{ tarifArt: 'ohne' }} />);
    expect(container.querySelector('.vp-formel-historik')).toBeNull();
  });

  it('reicht eine zusätzliche Klasse durch, ohne die eigene zu verlieren', () => {
    const { container } = render(<SteuerungFormel input={{}} className="vp-x" />);
    const details = container.querySelector('details') as HTMLDetailsElement;
    expect(details.className).toBe('vp-formel vp-x');
  });
});
