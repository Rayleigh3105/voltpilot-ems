import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { ahrenbergRangliste } from '../test/bewertungFixtures';
import { EinstufungDialog } from './BewertungEntscheidungen';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EinstufungDialog', () => {
  it('ohne Vorschlag (keine Messwerte) ist nichts vorgewählt — die Person wählt selbst (Review r3)', async () => {
    const einstufen = vi.spyOn(api, 'energieeinsatzEinstufen').mockResolvedValue({} as never);
    const r = ahrenbergRangliste();
    const ohne = {
      ...r.einsaetze[0], menge: null, anteil_prozent: null, vorschlag: 'unter_schwelle' as const,
      urteil: { ...r.einsaetze[0].urteil, K1: 'nicht_anwendbar' as const, K2: 'nicht_anwendbar' as const, K3: 'nicht_anwendbar' as const },
    };
    render(<EinstufungDialog einsatz={ohne} onClose={() => undefined} onGespeichert={() => undefined} />);
    const dialog = screen.getByTestId('einstufung-dialog');
    expect(within(dialog).getByRole('radio', { name: 'wesentlich' })).not.toBeChecked();
    expect(within(dialog).getByRole('radio', { name: 'nicht wesentlich' })).not.toBeChecked();
    fireEvent.change(within(dialog).getByLabelText('Begründung'), { target: { value: 'Querschnitt.' } });
    fireEvent.click(screen.getByTestId('einstufung-speichern'));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Bitte wählen Sie „wesentlich“ oder „nicht wesentlich“.');
    expect(einstufen).not.toHaveBeenCalled();
  });

  it('mit Vorschlag steht er vorgewählt', () => {
    render(<EinstufungDialog einsatz={ahrenbergRangliste().einsaetze[0]} onClose={() => undefined} onGespeichert={() => undefined} />);
    expect(within(screen.getByTestId('einstufung-dialog')).getByRole('radio', { name: 'wesentlich' })).toBeChecked();
  });
});
