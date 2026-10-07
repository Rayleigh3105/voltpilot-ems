import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type BewertungRangliste } from '../api';
import { setSelbstauskunft } from '../rollen';
import { ahrenbergEinsaetze, ahrenbergRangliste } from '../test/bewertungFixtures';
import { rechteSeed } from '../test/rollenFixtures';
import { VERBRAUCH_FEHLER } from '../verbrauch';
import { EnergieeinsatzSeite } from './EnergieeinsatzSeite';

const AUS = new ApiError(503, 'aus');

/** Die Seite eines Energieeinsatzes mit Spritzguss (EE-1); die Karten darunter (Messbedarf, Messmittel, Nachweise) ohne Daten. */
function verdrahte(rangliste: (von: string, bis: string) => Promise<BewertungRangliste>) {
  const ee = ahrenbergEinsaetze();
  vi.spyOn(api, 'energieeinsatz').mockResolvedValue(ee[0]);
  vi.spyOn(api, 'energieeinsatzProtokoll').mockResolvedValue({ aenderungen: [] } as never);
  vi.spyOn(api, 'energieeinsatzEinstufungen').mockResolvedValue({ fassungen: [] } as never);
  vi.spyOn(api, 'berichte').mockResolvedValue({ berichte: [] });
  vi.spyOn(api, 'bewertungMessabdeckung').mockRejectedValue(AUS);
  vi.spyOn(api, 'messbedarfe').mockRejectedValue(AUS);
  vi.spyOn(api, 'messstellenRegister').mockRejectedValue(AUS);
  vi.spyOn(api, 'messstelleQuellen').mockRejectedValue(AUS);
  vi.spyOn(api, 'geraetMessmittel').mockRejectedValue(AUS);
  vi.spyOn(api, 'energiemanagementNachweiseAmEinsatz').mockRejectedValue(AUS);
  return { ee, abruf: vi.spyOn(api, 'bewertungRangliste').mockImplementation(rangliste) };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // Letzter voller Monat: Oktober 2026 - der Monat der Ahrenberg-Rangliste.
  vi.setSystemTime(new Date('2026-11-05T09:00:00+01:00'));
  setSelbstauskunft(rechteSeed('IK').me);
});

afterEach(() => {
  setSelbstauskunft(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('EnergieeinsatzSeite', () => {
  it('scheitert der Abruf des Monats, steht der Fehler mit „Erneut versuchen“ - nie „keine Werte“ (Review r3)', async () => {
    let kaputt = true;
    const { ee } = verdrahte(async (von) => {
      if (kaputt && von === '2026-10-01') throw new ApiError(500, 'kaputt');
      return ahrenbergRangliste();
    });
    render(<EnergieeinsatzSeite id={ee[0].id} onListe={vi.fn()} />);
    const fehler = await screen.findByTestId('einsatz-verbrauch-fehler');
    expect(fehler).toHaveTextContent(VERBRAUCH_FEHLER);
    expect(screen.queryByText(/liegen keine Werte vor/)).toBeNull();
    kaputt = false;
    fireEvent.click(within(fehler).getByRole('button', { name: 'Erneut versuchen' }));
    expect(await screen.findByTestId('einsatz-antwort')).toHaveTextContent(`${ee[0].name} brauchte im Oktober 2026 77.500`);
    expect(screen.queryByTestId('einsatz-verbrauch-fehler')).toBeNull();
  });

  it('„Warum“: nicht belastbare und nicht anwendbare Kriterien stehen mit ihrem Wort und Grund, nie als „nicht erfüllt“ (Review r3)', async () => {
    const { ee } = verdrahte(async () => ahrenbergRangliste());
    render(<EnergieeinsatzSeite id={ee[0].id} onListe={vi.fn()} />);
    const warum = await screen.findByTestId('einsatz-warum');
    // Die Rangliste der Bühne: K1 über Schwelle, K2 nicht belastbar (67,8 % zugeordnet), K3 nicht anwendbar (ein Monat).
    await waitFor(() => expect(within(warum).getAllByTestId('einsatz-kriterium-offen')).toHaveLength(2));
    expect(within(warum).getAllByTestId('einsatz-kriterium-erfuellt')).toHaveLength(1);
    expect(within(warum).queryByTestId('einsatz-kriterium-nicht_erfuellt')).toBeNull();
    expect(warum).toHaveTextContent('nicht belastbar – erst ab 80 % zugeordnetem Strom (jetzt 68 %)');
    expect(warum).toHaveTextContent('nicht anwendbar – die Schwelle gilt für zwölf Monate');
    expect(warum).not.toHaveTextContent('nicht erfüllt');
  });
});
