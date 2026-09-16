import { setSelbstauskunft } from '../rollen';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type MessstellenRegisterAnfrage } from '../api';
import { KNOPF_KENNZAHL_ANLEGEN } from '../gebaeudeKarte';
import { StandortGebaeudePage } from '../pages/StandortGebaeudePage';
import { ahrenbergBilanz } from '../test/bilanzFixtures';
import { rechteSeed, STANDORT_IDS } from '../test/rollenFixtures';
import { RechteStandort } from '../rollen';
import { ahrenbergKennzahlen } from '../test/kennzahlenFixtures';
import { ahrenbergRegister } from '../test/messstellenRegisterFixtures';
import { ortsbaumAhrenberg } from '../test/ortsbaumFixtures';
import { ahrenbergHeute, werkAhrenberg } from '../test/standorteFixtures';

/**
 * Die Gebäude-Karte auf „Standort › Gebäude“ (UEMS AP-13 IP-10, E4 = A, Ü6, B4) — die gerenderte Fläche gegen O4:
 * Halle 2 im Oktober 2026. Geprüft wird, was der Kunde SIEHT; die Zahlen selbst prüft `gebaeudeKarte.test.ts`.
 */

/** Die Uhr der Bühne: 10.11.2026 — die Leiste steht damit auf dem letzten gebildeten Monat, Oktober 2026. */
const JETZT = Date.parse('2026-11-10T09:00:00+01:00');
/** Geschütztes Leerzeichen (U+00A0). */
const NB = String.fromCharCode(160);
const eben = (s: string | null | undefined) => (s ?? '').split(NB).join(' ');

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function stelle(person: string) {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: JETZT });
  vi.spyOn(api, 'standorte').mockResolvedValue(ahrenbergHeute());
  vi.spyOn(api, 'standortOrte').mockResolvedValue(ortsbaumAhrenberg());
  vi.spyOn(api, 'messstellenRegister').mockImplementation(async (a: MessstellenRegisterAnfrage = {}) => ahrenbergRegister(a));
  vi.spyOn(api, 'anlageBilanz').mockImplementation(async (id: string, periode = 'monat', am = '2026-10-01') => ahrenbergBilanz(id, periode, am));
  vi.spyOn(api, 'kennzahlen').mockResolvedValue({ kennzahlen: ahrenbergKennzahlen() });
  vi.spyOn(api, 'kennzahlWerte').mockRejectedValue(new Error('in diesem Test ohne Werte'));
  setSelbstauskunft(rechteSeed(person === 'Claudia Berger' ? 'CB' : 'IK').me);
  render(<RechteStandort.Provider value={STANDORT_IDS['ST-1']}><StandortGebaeudePage standort={werkAhrenberg()} onNavigate={() => undefined} springe={() => undefined} /></RechteStandort.Provider>);
}

/** Die aufgeklappte Karte eines Gebäudes. */
async function klappeAuf(name: string) {
  const knopf = await screen.findByRole('button', { name: `${name}: Karte aufklappen` });
  fireEvent.click(knopf);
  return await screen.findByTestId('gebaeude-karte-G-2');
}

describe('UEMS AP-13 IP-10 · die Gebäude-Karte auf „Standort › Gebäude“', () => {
  it('Halle 2 klappt auf und zeigt Energie, Messstellen und Kennzahlen — mit den Zahlen aus O4', async () => {
    stelle('Ines Kaltenbach');
    const karte = await klappeAuf('Halle 2');
    await waitFor(() => expect(within(karte).getByTestId(/gebaeude-system-/)).toBeTruthy());
    const text = eben(karte.textContent);
    expect(text).toContain('Gemessen im Gebäude 32.000 kWh (3 Messstellen)');
    expect(text).toContain('Spritzguss SG07–SG10');
    expect(text).toContain('Außerhalb des Gebäudes, im selben System:');
    expect(text).toContain('1.100 kWh');
    expect(text).toContain('nicht verortet');
    expect(text).toContain('3.800 kWh');
    // Die Datenlage kommt aus dem gefilterten Register (E13 zählt Hauptzähler und berechnete mit).
    expect(eben(within(karte).getByTestId('gebaeude-datenlage').textContent)).toContain('5 von 5 Messstellen liefern Daten');
    expect(within(karte).getByText('KZ-0001')).toBeTruthy();
    // Der Zeitraum gilt für ALLE Karten und steht einmal über dem Baum.
    expect(screen.getByTestId('gebaeude-zeitraum').textContent).toBe('Oktober 2026');
  });

  it('keine Gebäude-Summe: 36.900 kWh gehört der Anlage, nicht dem Gebäude (B4)', async () => {
    stelle('Ines Kaltenbach');
    const karte = await klappeAuf('Halle 2');
    await waitFor(() => expect(within(karte).getByTestId(/gebaeude-system-/)).toBeTruthy());
    expect(eben(karte.textContent)).not.toContain('36.900');
  });

  it('„Kennzahl anlegen“ steht dem Energiemanager — und öffnet den Assistenten mit der vorgeschlagenen Menge', async () => {
    stelle('Ines Kaltenbach');
    const karte = await klappeAuf('Halle 2');
    const knopf = await within(karte).findByRole('button', { name: KNOPF_KENNZAHL_ANLEGEN });
    fireEvent.click(knopf);
    // Schritt 1 ist die Vorlage; der Vorschlag steht in Schritt 2 — er wird ausgesprochen, nie still gesetzt.
    fireEvent.click(await screen.findByRole('radio', { name: /^Stromeinsatz je Stück/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    const satz = await screen.findByTestId('kennzahl-menge-vorschlag');
    expect(eben(satz.textContent)).toContain('die 3 Messstellen, die in Halle 2 messen (MS-11, MS-12, MS-13)');
  });

  it('dem Leser steht „Kennzahl anlegen“ nicht — das Recht wird gefragt, nicht geraten (G3)', async () => {
    stelle('Claudia Berger');
    const karte = await klappeAuf('Halle 2');
    await waitFor(() => expect(within(karte).getByTestId(/gebaeude-system-/)).toBeTruthy());
    expect(within(karte).queryByRole('button', { name: KNOPF_KENNZAHL_ANLEGEN })).toBeNull();
  });
});
