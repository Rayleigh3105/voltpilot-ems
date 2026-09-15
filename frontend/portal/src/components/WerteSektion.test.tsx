import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type MessstelleWerte, type MessstelleWerteRaster } from '../api';
import { UEMS_WOCHE_OHNE_ZAHL } from '../glossar';
import { f13Stunden, f13Tag, f13Viertelstunden, f16Monat, f16Tage, grundlastWoche, jahr2026 } from '../test/werteKarteFixtures';
import { WerteSektion } from './WerteSektion';

/**
 * Die Zeit-Leiste der Werte mit dem Verlauf (UEMS AP-13 IP-4, E5 = A): vier Zeiträume im Raster der Route, der Zeitraum
 * bleibt beim Umschalten, im Monat und im Jahr antwortet der Verlauf aus der Liste (keine dritte Anfrage), die Woche hat
 * keine Karte. Gelesen am 10.11.2026 an MS-06 (Ahrenberg: F13, F16, Grundlast 28,8 kW, Einführung 01.10.2026).
 */

const HEUTE = '2026-11-10';
const WARTEN = { timeout: 3000 };

const antwortFuer = (raster: MessstelleWerteRaster, von: string, bis: string): MessstelleWerte => {
  if (von === '2026-10-25' && bis === '2026-10-25') return raster === 'tag' ? f13Tag() : raster === 'stunde' ? f13Stunden() : f13Viertelstunden();
  if (von === '2026-10-19' && bis === '2026-10-25') {
    const w = grundlastWoche('2026-10-19', HEUTE);
    return raster === 'tag' ? w.tage : w.stunden;
  }
  if (von === '2026-10-01' && bis === '2026-10-31') return raster === 'monat' ? f16Monat() : f16Tage();
  if (von === '2026-01-01' && bis === '2026-12-31') {
    const j = jahr2026(HEUTE);
    return raster === 'jahr' ? j.karte : j.monate;
  }
  throw new Error(`nicht gestellt: ${raster} ${von} ${bis}`);
};

const verdrahte = (ohneVerlauf = false) =>
  vi.spyOn(api, 'messstelleWerte').mockImplementation(async (_kz, raster, von, bis) => {
    if (ohneVerlauf && raster === 'viertelstunde') throw new Error('Netz');
    return antwortFuer(raster, von, bis);
  });

const zeige = (onZeitraum = vi.fn()) =>
  render(
    <WerteSektion
      kennzeichen="MS-06"
      messstelle="MS-06 · Spritzguss SG01–SG06"
      anfang={{ art: 'tag', wert: '2026-10-25' }}
      heute={HEUTE}
      onZeitraum={onZeitraum}
    />,
  );

const schritteImBild = () => screen.getAllByTestId('verlauf-schritt').length;

afterEach(() => vi.restoreAllMocks());

describe('WerteSektion · Verlauf in vier Zeiträumen (UEMS AP-13 IP-4)', () => {
  it('Tag → Woche → Monat → Jahr → Tag: das Raster der Route, der Zeitraum bleibt, nichts summiert', async () => {
    const werte = verdrahte();
    const onZeitraum = vi.fn();
    zeige(onZeitraum);

    // Tag 25.10.2026: Karte, 25 Stunden in der Liste, 100 Viertelstunden im Verlauf.
    await waitFor(() => expect(schritteImBild()).toBe(100), WARTEN);
    expect(werte).toHaveBeenCalledWith('MS-06', 'tag', '2026-10-25', '2026-10-25');
    expect(werte).toHaveBeenCalledWith('MS-06', 'stunde', '2026-10-25', '2026-10-25');
    expect(werte).toHaveBeenCalledWith('MS-06', 'viertelstunde', '2026-10-25', '2026-10-25');
    expect(screen.getAllByTestId('werte-zeile')).toHaveLength(25);
    expect(screen.getByTestId('verlauf')).toHaveTextContent('So 25.10.2026: 720 kWh · vollständig · endgültig');

    // Woche 43: keine Karte, und der Kopf sagt warum; 169 Stunden, 7 Tage.
    fireEvent.click(screen.getByRole('tab', { name: 'Woche' }));
    expect(onZeitraum).toHaveBeenLastCalledWith('2026-W43');
    await waitFor(() => expect(schritteImBild()).toBe(169), WARTEN);
    expect(werte).toHaveBeenCalledWith('MS-06', 'tag', '2026-10-19', '2026-10-25');
    expect(werte).toHaveBeenCalledWith('MS-06', 'stunde', '2026-10-19', '2026-10-25');
    expect(screen.queryByTestId('werte-karte')).toBeNull();
    expect(screen.getByTestId('verlauf')).toHaveTextContent(UEMS_WOCHE_OHNE_ZAHL);
    expect(screen.getAllByTestId('werte-zeile')).toHaveLength(7);
    expect(screen.getByRole('heading', { name: 'Tage' })).toBeInTheDocument();

    // Oktober 2026: der Verlauf ist die Liste — zwei Anfragen, keine dritte.
    werte.mockClear();
    fireEvent.click(screen.getByRole('tab', { name: 'Monat' }));
    expect(onZeitraum).toHaveBeenLastCalledWith('2026-10');
    await waitFor(() => expect(schritteImBild()).toBe(31), WARTEN);
    expect(werte.mock.calls.map((c) => c[1])).toEqual(['monat', 'tag']);
    expect(screen.getByTestId('werte-karte')).toHaveTextContent('Oktober 2026');
    expect(screen.getByTestId('verlauf')).toHaveTextContent('Oktober 2026: 55.100 kWh · vollständig · vorläufig');

    // 2026: bis September „keine Werte“ als Fläche mit Satz, die Monate in der Liste, weiter geht es nicht.
    werte.mockClear();
    fireEvent.click(screen.getByRole('tab', { name: 'Jahr' }));
    expect(onZeitraum).toHaveBeenLastCalledWith('2026');
    await waitFor(() => expect(schritteImBild()).toBe(12), WARTEN);
    expect(werte.mock.calls.map((c) => c[1])).toEqual(['jahr', 'monat']);
    expect(screen.getByTestId('werte-jahr')).toHaveTextContent('2026');
    expect(screen.getByRole('button', { name: 'Nächster Zeitraum' })).toBeDisabled();
    expect(screen.getAllByTestId('verlauf-luecke')).toHaveLength(1);
    expect(screen.getAllByTestId('verlauf-ereignis').map((e) => e.textContent)).toEqual(['1keine Werte von Januar 2026 bis September 2026']);
    expect(within(screen.getByRole('region', { name: 'Monate' })).getAllByTestId('werte-zeile')[9]).toHaveTextContent('Oktober 2026');

    // Zurück zum Tag: derselbe 25.10., nicht der 01.01.
    fireEvent.click(screen.getByRole('tab', { name: 'Tag' }));
    expect(onZeitraum).toHaveBeenLastCalledWith('2026-10-25');
    await waitFor(() => expect(schritteImBild()).toBe(100), WARTEN);
  });

  it('scheitert nur der Verlauf, bleiben Karte und Liste stehen — mit einem eigenen Weg, es noch einmal zu versuchen', async () => {
    verdrahte(true);
    zeige();
    expect(await screen.findByText('Der Verlauf konnte nicht geladen werden.', undefined, WARTEN)).toBeInTheDocument();
    expect(screen.getByTestId('werte-karte')).toHaveTextContent(/720\skWh/);
    expect(screen.getAllByTestId('werte-zeile')).toHaveLength(25);
    expect(screen.queryByText('Die Werte konnten nicht geladen werden.')).toBeNull();
  });
});
