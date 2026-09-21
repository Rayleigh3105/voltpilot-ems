import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FunktionenKarte } from './FunktionenKarte';
import { setSelbstauskunft } from '../rollen';
import { rechteSeed, STANDORT_IDS } from '../test/rollenFixtures';
import type { FunktionenKarteAbschnitt } from '../uebersicht';

/** AP-01 E5 = A: die Karte führt in den Messen-Assistenten — nur mit Recht, sonst Grund und Weg. */
const ST = STANDORT_IDS['ST-1'];
const abschnitte: FunktionenKarteAbschnitt[] = [
  {
    funktion: 'messen',
    label: 'Messen & Auswerten',
    verbreitung: null,
    zeilen: [
      {
        standortId: ST,
        name: 'Werk Ahrenberg',
        zustand: 'kein_objekt',
        satz: 'Messen & Auswerten — noch nicht eingerichtet',
        ton: 'off',
        schritt: 'Messen & Auswerten für Werk Ahrenberg einrichten',
      },
    ],
  },
];
const einstiege = new Map([[ST, { text: 'Messen & Auswerten für Werk Ahrenberg einrichten', start: { standortId: ST, schritt: 1 as const } }]]);

afterEach(() => {
  cleanup();
  setSelbstauskunft(null);
});

describe('FunktionenKarte — Einstieg Messen & Auswerten', () => {
  it('mit Recht: der Schritt ist der Knopf und öffnet den Assistenten am Standort', () => {
    setSelbstauskunft(rechteSeed('JW').me);
    const oeffnen = vi.fn();
    render(<FunktionenKarte abschnitte={abschnitte} messenEinstiege={einstiege} onMessenOeffnen={oeffnen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Messen & Auswerten für Werk Ahrenberg einrichten' }));
    expect(oeffnen).toHaveBeenCalledWith({ standortId: ST, schritt: 1 });
    expect(screen.queryByText('Nächster Schritt:')).toBeNull();
  });

  it('ohne Recht: kein Knopf, Grund und Weg', () => {
    setSelbstauskunft(rechteSeed('CB').me);
    render(<FunktionenKarte abschnitte={abschnitte} messenEinstiege={einstiege} onMessenOeffnen={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('note').textContent).toMatch(/\S/);
  });

  it('ohne Wirt (Bühnen, Einzeltests): der bisherige Hinweis bleibt', () => {
    setSelbstauskunft(rechteSeed('JW').me);
    render(<FunktionenKarte abschnitte={abschnitte} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Nächster Schritt:')).toBeTruthy();
  });
});
