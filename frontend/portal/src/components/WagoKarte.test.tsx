/**
 * UEMS AP-05 IP-11 — die Fläche: Sichtbarkeit, Hebel und der Dialog „Karte getauscht“ (A10).
 *
 * Der wichtigste Fall steht zuerst: **eine Anlage ohne WAGO-Komponente sieht keinen neuen
 * Einstieg.** Das ist heute jede Anlage jedes Kunden.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError, api, type WagoKartenangaben } from '../api';
import { setSelbstauskunft } from '../rollen';
import { rechteSeed, STANDORT_IDS } from '../test/rollenFixtures';
import { FIXTURE_IDS } from '../test/standorteFixtures';
import { HEBEL_TITEL } from '../wagoKarte';
import { WagoKarte } from './WagoKarte';

const ZONE = 'Europe/Berlin';
const JETZT = '2027-03-20T15:00:00+01:00';
const KOMPONENTE = 'a4e0b000-0000-4000-8000-0000000008d4';

afterEach(() => vi.restoreAllMocks());
beforeEach(() => setSelbstauskunft(rechteSeed('JW').me));

function karte(over: Partial<WagoKartenangaben> = {}): WagoKartenangaben {
  return { slot: 5, anwenderskalierung: false, register35: 0, version: 3, kartenwechsel: null, ...over };
}

function zeichne(jetzt = JETZT) {
  return render(<WagoKarte anlageId={FIXTURE_IDS.an2} standortId={STANDORT_IDS['ST-1']}
    entityId={KOMPONENTE} zone={ZONE} einheit="kWh" jetzt={jetzt} />);
}

it('eine Anlage ohne WAGO-Komponente sieht keinen neuen Einstieg (404 = keine Fläche)', async () => {
  const lesen = vi.spyOn(api, 'wagoKarte').mockRejectedValue(
    new ApiError(404, 'WAGO-Gerät oder Komponente nicht gefunden.'),
  );
  const { container } = zeichne();
  await waitFor(() => expect(lesen).toHaveBeenCalled());
  expect(container).toBeEmptyDOMElement();
  expect(screen.queryByText('Karte getauscht')).toBeNull();
});

it('zeigt die dokumentierten Angaben und OHNE Beleg keinen Hebel', async () => {
  vi.spyOn(api, 'wagoKarte').mockResolvedValue(karte({ anwenderskalierung: null }));
  zeichne();
  await screen.findByTestId('wago-karte');
  expect(screen.getByTestId('wago-karte')).toHaveTextContent('Steckplatz: 5');
  expect(screen.getByTestId('wago-karte')).toHaveTextContent('Anwenderskalierung: nicht erfasst');
  // Kein Dauerhinweis: die fehlende Angabe allein trägt den Hebel nicht.
  expect(screen.queryByTestId('wago-hebel')).toBeNull();
});

it('mit gespeichertem Kartentausch UND fehlender Angabe steht der Hebel da', async () => {
  vi.spyOn(api, 'wagoKarte').mockResolvedValue(
    karte({ anwenderskalierung: null, kartenwechsel: '2027-03-20T09:30:00+01:00' }),
  );
  zeichne();
  const hebel = await screen.findByTestId('wago-hebel');
  expect(hebel).toHaveTextContent(HEBEL_TITEL);
  expect(hebel).toHaveTextContent('20.03.2027');
});

it('A10 · trägt den Kartentausch mit Endstand und Prüfaufgabe ein — genau ein Aufruf', async () => {
  vi.spyOn(api, 'wagoKarte').mockResolvedValue(karte());
  const post = vi.spyOn(api, 'wagoKartenwechsel').mockResolvedValue(
    karte({ anwenderskalierung: null, register35: null, version: 4, kartenwechsel: JETZT }),
  );
  zeichne();
  fireEvent.click(await screen.findByTestId('wago-karte-tauschen'));
  fireEvent.change(screen.getByTestId('wago-endstand'), { target: { value: '6.184,37' } });
  expect(screen.getByTestId('wago-pruefaufgabe')).toBeChecked();
  const knopf = screen.getByTestId('wago-kartenwechsel-speichern');
  fireEvent.click(knopf);
  fireEvent.click(knopf);
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  expect(post.mock.calls[0][2]).toMatchObject({ endstand: 6184.37, einheit: 'kWh', einstellungenPruefen: true });
  const folgen = await screen.findByTestId('wago-kartenwechsel-folgen');
  expect(folgen).toHaveTextContent('das Gerät bleibt dasselbe');
  expect(folgen).toHaveTextContent('zählt nicht als Verbrauch');
});

it('ein Serverfehler erhält die Eingaben und behauptet keinen Eintrag', async () => {
  vi.spyOn(api, 'wagoKarte').mockResolvedValue(karte());
  vi.spyOn(api, 'wagoKartenwechsel').mockRejectedValue(
    new ApiError(409, 'Zu diesem Zeitpunkt ist der Komponente kein Gerät zugeordnet.'),
  );
  zeichne();
  fireEvent.click(await screen.findByTestId('wago-karte-tauschen'));
  fireEvent.change(screen.getByTestId('wago-endstand'), { target: { value: '12,5' } });
  fireEvent.click(screen.getByTestId('wago-kartenwechsel-speichern'));
  await screen.findByText('Zu diesem Zeitpunkt ist der Komponente kein Gerät zugeordnet.');
  expect(screen.getByTestId('wago-endstand')).toHaveValue('12,5');
  expect(screen.queryByTestId('wago-kartenwechsel-folgen')).toBeNull();
});

it('ohne Zählwerk mit Einheit nimmt der Dialog keinen Endstand an', async () => {
  vi.spyOn(api, 'wagoKarte').mockResolvedValue(karte());
  render(<WagoKarte anlageId={FIXTURE_IDS.an2} standortId={STANDORT_IDS['ST-1']} entityId={KOMPONENTE}
    zone={ZONE} einheit={null} jetzt={JETZT} />);
  fireEvent.click(await screen.findByTestId('wago-karte-tauschen'));
  expect(screen.getByTestId('wago-endstand')).toBeDisabled();
  expect(screen.getByLabelText(/Einheit nicht erfasst/)).toBeDisabled();
});
