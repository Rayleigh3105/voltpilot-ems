import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api';
import { UEMS_NORMGRENZE } from '../glossar';
import { vergleichLeer, vergleichMitMaerz, vergleichMitStand, vergleichR2 } from '../test/bezugsbasisVergleichFixtures';
import { BezugsbasisVergleich } from './BezugsbasisVergleich';

const KZ1 = 'c0de0000-0000-4000-8000-00000000a001';
/** VG3: an der rohen Hälfte steht kein Urteil-Wort und kein Pfeil. */
const URTEIL_ODER_PFEIL = /besser|schlechter|im Rahmen|nicht bewertbar|[↑↓▲▼⬆⬇]/u;

function leser(antwort = vergleichR2(), basen: { id: string; kennzeichen: string; beendet_zum: string | null }[] = []) {
  const vergleich = vi.spyOn(api, 'bezugsbasisVergleich').mockImplementation(async () => antwort);
  vi.spyOn(api, 'kennzahlBezugsbasen').mockImplementation(async () => ({ bezugsbasen: basen }));
  return vergleich;
}

afterEach(() => vi.restoreAllMocks());

describe('AP-17 IP-20 · Reiter „Vergleich mit Bezugsbasis“', () => {
  it('R2: Dezember roh ohne Urteil neben bereinigt „schlechter“ mit Band, Bedingung, Kennzeichen und Satz', async () => {
    const vergleich = leser();
    render(<BezugsbasisVergleich kennzahlId={KZ1} />);
    const dez = await screen.findByTestId('monat-2027-12');
    expect(vergleich).toHaveBeenCalledWith(KZ1, {});

    const roh = within(dez).getByTestId('roh');
    expect(roh.textContent).toBe('8,8 % weniger als im VormonatProduktionsmenge: 21,9 % weniger');
    expect(roh.textContent).not.toMatch(URTEIL_ODER_PFEIL);
    expect(within(dez).getByTestId('roh-urteil').textContent).toBe('ohne Urteil');
    expect(within(dez).getByTestId('gemessen').textContent).toBe('78 000 kWhVersion 1');

    expect(within(dez).getByTestId('bedingung').textContent).toBe('bei 250 000 kg');
    expect(within(dez).getByTestId('erwartet').textContent).toBe('69 098 kWh');
    expect(within(dez).getByTestId('delta').textContent).toBe('12,9 % mehr');
    expect(within(dez).getByTestId('urteil').textContent).toBe('schlechter (± 2 %)');
    expect(within(dez).getByTestId('kennzeichen').textContent).toContain('bereinigt um Produktionsmenge');
    expect(within(dez).getByTestId('satz').textContent).toBe(
      'Dezember 2027: 78 000 kWh gemessen, 69 098 kWh erwartet bei 250 000 kg — 12,9 % mehr als die Bezugsbasis erwarten lässt: schlechter.',
    );
  });

  it('kein Urteil-Wort in einer rohen Zelle irgendeines Monats', async () => {
    leser(vergleichMitMaerz());
    render(<BezugsbasisVergleich kennzahlId={KZ1} />);
    await screen.findByTestId('monat-2028-03');
    const rohe = [...document.querySelectorAll('.vp-bbv-roh, .vp-bbv-gemessen')];
    expect(rohe).toHaveLength(15);
    for (const zelle of rohe) expect(zelle.textContent).not.toMatch(URTEIL_ODER_PFEIL);
  });

  it('Zeitraum-Kopf R11 und Basis-Zeile; Stände-Zeile „ungesichert — noch kein Stand“; Grenz-Satz', async () => {
    leser();
    render(<BezugsbasisVergleich kennzahlId={KZ1} />);
    const kopf = await screen.findByTestId('vergleich-zeitraum');
    expect(within(kopf).getByRole('heading').textContent).toBe('Zeitraum · November 2027 bis Februar 2028');
    expect(kopf.textContent).toContain('323 000 kWh');
    expect(kopf.textContent).toContain('317 395 kWh');
    expect(within(kopf).getByTestId('urteil').textContent).toBe('im Rahmen (± 2 %)');
    expect(within(kopf).getByTestId('zeitraum-satz').textContent).toBe(
      'November 2027 bis Februar 2028: 323 000 kWh gemessen, 317 395 kWh erwartet — 1,8 %: im Rahmen der Bezugsbasis (Summe über vier Monate).',
    );
    expect(within(kopf).queryByTestId('zeitraum-monate')).toBeNull();
    expect(screen.getByTestId('vergleich-basis').textContent).toContain('Bezugsbasis BB-0001 · Fassung 2');
    expect(screen.getByTestId('vergleich-stand').textContent).toBe('ungesichert — noch kein Stand');
    expect(screen.getByTestId('vergleich-grenze').textContent).toBe(UEMS_NORMGRENZE);
  });

  it('G3: der März zeigt den Grund statt der Zahlen; der Zeitraum sagt „4 von 5 Monaten“ und „ohne Urteil“', async () => {
    leser(vergleichMitMaerz());
    render(<BezugsbasisVergleich kennzahlId={KZ1} />);
    const maerz = await screen.findByTestId('monat-2028-03');
    expect(within(maerz).getByTestId('grund').textContent).toContain(
      'Modell nicht anwendbar: Produktionsmenge im März 2028 (390 000 kg) liegt außerhalb der Bezugsbasis (254 000–341 000 kg).',
    );
    expect(within(maerz).queryByTestId('erwartet')).toBeNull();
    expect(within(maerz).queryByTestId('urteil')).toBeNull();
    const kopf = screen.getByTestId('vergleich-zeitraum');
    expect(within(kopf).getByTestId('zeitraum-monate').textContent).toBe('4 von 5 Monaten');
    expect(within(kopf).getByTestId('urteil').textContent).toBe('ohne Urteil (± 2 %)');
  });

  it('S5: mit Stand „Stand Nr. 1 vom 12.01.2028“', async () => {
    leser(vergleichMitStand());
    render(<BezugsbasisVergleich kennzahlId={KZ1} />);
    expect((await screen.findByTestId('vergleich-stand')).textContent).toBe('Stand Nr. 1 vom 12.01.2028');
  });

  it('R10: ohne Bezugsbasis nur der Leer-Satz mit Verweis auf den Reiter „Bezugsbasis“ — keine Tafel, kein Urteil', async () => {
    leser(vergleichLeer());
    render(<BezugsbasisVergleich kennzahlId={KZ1} />);
    const leer = await screen.findByTestId('vergleich-leer');
    expect(leer.textContent).toContain('Noch keine Bezugsbasis.');
    expect(leer.textContent).toContain('Reiter „Bezugsbasis“');
    expect(screen.queryByTestId('vergleich-monate')).toBeNull();
    expect(screen.queryByTestId('urteil')).toBeNull();
    expect(screen.queryByTestId('vergleich-stand')).toBeNull();
    expect(screen.getByTestId('vergleich-grenze').textContent).toBe(UEMS_NORMGRENZE);
  });

  it('Zeitraum-Wahl fragt den Leser mit von/bis; die Basis-Wahl gibt es erst ab zwei Bezugsbasen', async () => {
    const vergleich = leser(vergleichR2(), [{ id: 'b1', kennzeichen: 'BB-0001', beendet_zum: null }]);
    render(<BezugsbasisVergleich kennzahlId={KZ1} />);
    await screen.findByTestId('monat-2027-12');
    expect(screen.queryByText('Bezugsbasis', { selector: 'label' })).toBeNull();
    fireEvent.click(screen.getByRole('combobox', { name: 'Von Monat' }));
    fireEvent.click(await screen.findByRole('option', { name: /Dezember 2027/ }));
    await waitFor(() => expect(vergleich).toHaveBeenLastCalledWith(KZ1, { von: '2027-12', bis: '2028-02' }));
  });

  it('ein Fehler des Lesers zeigt den Satz mit „Erneut versuchen“', async () => {
    vi.spyOn(api, 'bezugsbasisVergleich').mockRejectedValue(new ApiError(500, 'kaputt'));
    vi.spyOn(api, 'kennzahlBezugsbasen').mockResolvedValue({ bezugsbasen: [] });
    render(<BezugsbasisVergleich kennzahlId={KZ1} />);
    expect(await screen.findByText('Der Vergleich konnte nicht geladen werden.')).toBeTruthy();
  });
});
