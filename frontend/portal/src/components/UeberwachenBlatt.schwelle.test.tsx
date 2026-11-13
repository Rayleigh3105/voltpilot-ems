import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const anlegen = vi.fn();
const probelauf = vi.fn();
vi.mock('../ueberwachungApi', () => ({
  ueberwachungApi: {
    anlegen: (...a: unknown[]) => anlegen(...a),
    probelauf: (...a: unknown[]) => probelauf(...a),
  },
}));

import { UeberwachenBlatt } from './UeberwachenBlatt';

/**
 * Kunden-Alarmierung P0, nachgestellt aus dem Labor (13.11.2026): Börsenpreis bei 6,3 ct/kWh, Vorschlag 8, die
 * Person stellt die Schwelle auf 5. Vorher blieb die Rückkehrschwelle bei „7,6000000000000005“ stehen, die Meldung
 * flatterte, und die Vorschau sagte „hätte nicht ausgelöst“, obwohl es für den Preis keine Rückschau gibt.
 */
function blatt() {
  render(
    <UeberwachenBlatt
      offen
      isPhone={false}
      onClose={() => {}}
      wertart="anlage.preis.jetzt"
      bezug={{ anlage: 'a1' }}
      aktuellerWert={6.3}
      einheit="ct/kWh"
      titelZusatz="Börsenpreis"
      onUeberwacht={() => {}}
    />,
  );
}

const rueckkehrFeld = () => screen.getByLabelText(/Rückkehr/) as HTMLInputElement;
const schwelleFeld = () => screen.getByLabelText(/^Schwelle/) as HTMLInputElement;

afterEach(() => {
  anlegen.mockReset();
  probelauf.mockReset();
});

describe('UeberwachenBlatt · Schwelle und Rückkehrschwelle', () => {
  it('der Vorschlag hat keinen Rechenrest', () => {
    probelauf.mockReturnValue(new Promise(() => {}));
    blatt();
    expect(schwelleFeld().value).toBe('8');
    expect(rueckkehrFeld().value).toBe('7.6');
  });

  it('die Rückkehrschwelle folgt der Schwelle, und die Regel geht mit dem neuen Paar hinaus', async () => {
    probelauf.mockReturnValue(new Promise(() => {}));
    anlegen.mockResolvedValue({ id: 'r1' });
    blatt();
    fireEvent.change(schwelleFeld(), { target: { value: '5' } });
    expect(rueckkehrFeld().value).toBe('4.8');

    fireEvent.click(screen.getByRole('button', { name: 'Überwachung starten' }));
    await waitFor(() => expect(anlegen).toHaveBeenCalledTimes(1));
    expect(anlegen.mock.calls[0][0].bedingung).toMatchObject({ art: 'ueber', schwelle: 5, rueckkehr: 4.8 });
  });

  it('eine selbst gesetzte Rückkehr über der Schwelle sperrt „Überwachung starten“ mit Grund', () => {
    probelauf.mockReturnValue(new Promise(() => {}));
    blatt();
    fireEvent.change(schwelleFeld(), { target: { value: '5' } });
    fireEvent.change(rueckkehrFeld(), { target: { value: '7.6' } });
    expect(screen.getByText('Muss bei oder unter der Schwelle liegen.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Überwachung starten' }) as HTMLButtonElement).disabled).toBe(true);

    // Ändert die Person danach die Schwelle, folgt die Rückkehr wieder.
    fireEvent.change(schwelleFeld(), { target: { value: '10' } });
    expect(rueckkehrFeld().value).toBe('9.5');
    expect(screen.queryByText('Muss bei oder unter der Schwelle liegen.')).toBeNull();
  });

  it('ohne Rückschau sagt die Vorschau „keine Vorschau möglich“ statt „hätte nicht ausgelöst“', async () => {
    probelauf.mockResolvedValue({ fensterTage: 30, ausgeloest: 0, zuletzt: null, gesamtdauerS: 0, moeglich: false });
    blatt();
    expect(await screen.findByText('Für diesen Wert ist keine Vorschau möglich.', {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.queryByText(/hätte das nicht ausgelöst/)).toBeNull();
  });

  it('mit Rückschau bleibt die Aussage', async () => {
    probelauf.mockResolvedValue({ fensterTage: 30, ausgeloest: 0, zuletzt: null, gesamtdauerS: 0, moeglich: true });
    blatt();
    expect(await screen.findByText('In den letzten 30 Tagen hätte das nicht ausgelöst.', {}, { timeout: 3000 })).toBeTruthy();
  });
});
