import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Zeitstrahl } from './Zeitstrahl';

/** UEMS AP-02 IP-12 — der Zeitstrahl-Baustein: Abschnitte in Reihenfolge, mit Zeitraum und Zustand. */
describe('Zeitstrahl', () => {
  it('nennt jeden Abschnitt mit Zeitraum und Zustand in der gegebenen Reihenfolge', () => {
    render(
      <Zeitstrahl
        titel="Zuordnungen"
        abschnitte={[
          { schluessel: 'a', titel: 'Werk Ahrenberg (ST-1)', zeitraum: '01.10.2026 – 28.02.2027', zustand: 'beendet' },
          { schluessel: 'b', titel: 'Werk Lindach (ST-2)', zeitraum: '01.03.2027 – 31.05.2027', zustand: 'gilt' },
          { schluessel: 'c', titel: 'Werk Ahrenberg Nord (ST-3)', zeitraum: 'ab 01.06.2027', zustand: 'geplant' },
        ]}
      />,
    );
    const strahl = screen.getByRole('region', { name: 'Zuordnungen' });
    const zeilen = within(strahl).getAllByRole('listitem');
    expect(zeilen.map((z) => z.textContent)).toEqual([
      'Werk Ahrenberg (ST-1)01.10.2026 – 28.02.2027beendet',
      'Werk Lindach (ST-2)01.03.2027 – 31.05.2027gilt',
      'Werk Ahrenberg Nord (ST-3)ab 01.06.2027geplant',
    ]);
    expect(zeilen.map((z) => z.className)).toEqual([
      'vp-zs-abschnitt vp-zs-beendet',
      'vp-zs-abschnitt vp-zs-gilt',
      'vp-zs-abschnitt vp-zs-geplant',
    ]);
  });

  it('ohne Abschnitte gibt es ihn nicht', () => {
    const { container } = render(<Zeitstrahl titel="Zuordnungen" abschnitte={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
