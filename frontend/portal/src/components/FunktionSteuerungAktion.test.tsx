import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setSelbstauskunft } from '../rollen';
import { rechteSeed, STANDORT_IDS } from '../test/rollenFixtures';
import { FunktionSteuerungAktion } from './FunktionSteuerungAktion';
import { RUHE_VERBINDUNG_HINWEIS } from '../ruheHinweis';

afterEach(() => act(() => setSelbstauskunft(null)));

describe('Steuerung anhalten und fortsetzen', () => {
  it('A4: nennt vor dem Standort-Anhalten alle betroffenen Anlagen und schreibt erst nach Bestätigung', async () => {
    act(() => setSelbstauskunft(rechteSeed('JW').me));
    const ausfuehren = vi.fn().mockResolvedValue(undefined);
    render(<FunktionSteuerungAktion
      art="anhalten"
      umfang="standort"
      standortId={STANDORT_IDS['ST-1']}
      betroffen={['Werk Ahrenberg – Halle 1', 'Werk Ahrenberg – Halle 2']}
      ruheHinweis={RUHE_VERBINDUNG_HINWEIS}
      onBestaetigen={ausfuehren}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'Standort anhalten' }));
    expect(ausfuehren).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Standort anhalten?' })).toHaveTextContent(
      'Betroffen: Werk Ahrenberg – Halle 1 und Werk Ahrenberg – Halle 2.',
    );
    expect(screen.getByText(/ohne Enddatum angehalten/)).toBeInTheDocument();
    expect(screen.getByText(RUHE_VERBINDUNG_HINWEIS, { exact: true })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('dialog', { name: 'Standort anhalten?' })
      .querySelector('.dfoot button:last-child')!);
    await waitFor(() => expect(ausfuehren).toHaveBeenCalledTimes(1));
  });

  it('A5: erklärt vor dem Fortsetzen die erneute Prüfliste', () => {
    act(() => setSelbstauskunft(rechteSeed('JW').me));
    render(<FunktionSteuerungAktion
      art="fortsetzen"
      umfang="anlage"
      standortId={STANDORT_IDS['ST-1']}
      betroffen={['Werk Ahrenberg – Halle 1']}
      onBestaetigen={vi.fn().mockResolvedValue(undefined)}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'Steuerung fortsetzen' }));
    expect(screen.getByText(/prüft Box, Freigaben, Grenze, Hauptzähler und Betriebsweise erneut/))
      .toBeInTheDocument();
    expect(screen.getByText(/mit dem nächsten Fahrplan/)).toBeInTheDocument();
  });

  it('zeigt ohne das Matrix-Recht keinen toten Knopf', () => {
    const me = structuredClone(rechteSeed('JW').me);
    me.unternehmen_rechte = [];
    me.standorte = me.standorte.map((s) => ({ ...s, rechte: [] }));
    act(() => setSelbstauskunft(me));
    render(<FunktionSteuerungAktion
      art="anhalten"
      umfang="anlage"
      standortId={STANDORT_IDS['ST-1']}
      betroffen={['Werk Ahrenberg – Halle 1']}
      onBestaetigen={vi.fn().mockResolvedValue(undefined)}
    />);
    expect(screen.queryByRole('button', { name: 'Steuerung anhalten' })).not.toBeInTheDocument();
  });
});
