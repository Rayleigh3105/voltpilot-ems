import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RUHE_VERBINDUNG_HINWEIS } from '../ruheHinweis';
import type { FunktionenKarteAbschnitt } from '../uebersicht';
import { FunktionenKarte } from './FunktionenKarte';

describe('Ruhe an einer Box ohne Fähigkeit', () => {
  it('zeigt den Satz wörtlich nur in der betroffenen Steuern-Zelle', () => {
    const abschnitte: FunktionenKarteAbschnitt[] = [{
      funktion: 'steuern',
      label: 'Steuern & Optimieren',
      verbreitung: null,
      zeilen: [
        { standortId: 'alt', name: 'Werk Ahrenberg', zustand: 'angehalten', satz: 'Angehalten', ton: 'warn',
          schritt: null, ruheHinweis: RUHE_VERBINDUNG_HINWEIS },
        { standortId: 'neu', name: 'Werk Lindach', zustand: 'angehalten', satz: 'Angehalten', ton: 'warn',
          schritt: null, ruheHinweis: null },
      ],
    }];

    render(<FunktionenKarte abschnitte={abschnitte} />);

    expect(screen.getAllByText(RUHE_VERBINDUNG_HINWEIS, { exact: true })).toHaveLength(1);
    const alt = screen.getByText('Werk Ahrenberg').closest('li')!;
    const neu = screen.getByText('Werk Lindach').closest('li')!;
    expect(within(alt).getByText(RUHE_VERBINDUNG_HINWEIS, { exact: true })).toBeInTheDocument();
    expect(within(neu).queryByText(RUHE_VERBINDUNG_HINWEIS, { exact: true })).toBeNull();
  });
});
