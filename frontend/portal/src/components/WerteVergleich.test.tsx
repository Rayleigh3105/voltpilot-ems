import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type MessstelleWerte, type MessstelleWerteRaster } from '../api';
import { ahrenbergRegister } from '../test/messstellenRegisterFixtures';
import {
  MS_11,
  MS_12,
  monatKarte,
  monatOhneQuelle,
  monatTage,
  ms11Oktober,
  ms11OktoberTage,
  ms12November,
  ms12NovemberTage,
  ms12Oktober,
  ms12OktoberTage,
  ms12Vorjahr,
} from '../test/vergleichFixtures';
import { WerteSektion } from './WerteSektion';

/**
 * Der Vergleich an der Messstelle (UEMS AP-13 IP-5, E6 = A) auf der echten Sektion — die Fälle **O11** und **O12**:
 *  - der Umschalter `aus · Vorperiode · Vorjahr` legt die Vorperiode als ZWEITE Reihe ins Bild und setzt die Δ-Zeile
 *    unter die Karte (O11);
 *  - der Picker „Weitere Messstelle“ zeigt die passenden wählbar und die anderen mit ihrem Grund (O12); die gewählte
 *    Reihe liegt im Bild und bekommt ihre eigene Karte — zwischen zwei Messstellen steht nie eine Differenz (VG4);
 *  - ohne Basis gibt es kein Δ, sondern den Grund (VG5); eine laufende Periode wird gesagt (VG3).
 *
 * Gelesen am 10.12.2026 an MS-12 (Montage Linie M1) bzw. an MS-06; die Antworten sind `test/vergleichFixtures`.
 */

const HEUTE = '2026-12-10';
const WARTEN = { timeout: 3000 };
const register = ahrenbergRegister().register;
const quelleVon = (kz: string) => register.find((z) => z.kennzeichen === kz)!.quelle;
const nb = (t: string) => t.replace(/ (kWh|%)/g, String.fromCharCode(160) + '$1');

/** Die Bühne: MS-12 November/Oktober/November 2025, MS-11 Oktober/November, sonst „nicht gestellt“. */
const antwortFuer = (kz: string, raster: MessstelleWerteRaster, von: string, bis: string): MessstelleWerte => {
  const monat = von.slice(0, 7);
  if (kz === 'MS-12') {
    if (monat === '2026-11') return raster === 'monat' ? ms12November() : ms12NovemberTage();
    if (monat === '2026-10') return raster === 'monat' ? ms12Oktober() : ms12OktoberTage();
    if (monat === '2025-11') return raster === 'monat' ? ms12Vorjahr() : monatOhneQuelle(MS_12, '2025-11');
  }
  if (kz === 'MS-11') {
    if (monat === '2026-10') return raster === 'monat' ? ms11Oktober() : ms11OktoberTage();
    if (monat === '2026-11') return raster === 'monat' ? monatKarte(MS_11, '2026-11', 21500) : monatTage(MS_11, '2026-11', 21500);
  }
  throw new Error(`nicht gestellt: ${kz} ${raster} ${von} ${bis}`);
};

const verdrahte = () =>
  vi.spyOn(api, 'messstelleWerte').mockImplementation(async (kz, raster, von, bis) => antwortFuer(kz, raster, von, bis));

const zeige = (props: Partial<Parameters<typeof WerteSektion>[0]> = {}) => {
  const onVergleich = vi.fn();
  const r = render(
    <WerteSektion
      kennzeichen="MS-12"
      messstelle="MS-12 · Montage Linie M1"
      anfang={{ art: 'monat', wert: '2026-11' }}
      heute={HEUTE}
      register={register}
      quelle={quelleVon('MS-12')}
      onVergleich={onVergleich}
      {...props}
    />,
  );
  return { ...r, onVergleich };
};

const wahl = (wort: string) => screen.getByRole('tab', { name: wort });

beforeEach(() => {
  // Der Cache lebt modul-global; jeder Fall beginnt mit leerem Speicher.
  return import('../uemsWerteCache').then((m) => m.clearWerteCache());
});
afterEach(() => vi.restoreAllMocks());

describe('AP-13 IP-5 · O11 — der Umschalter, die Überlagerung und die Δ-Zeile', () => {
  it('„aus“ zeigt EINE Reihe und keine Δ-Zeile — der Vergleich drängt sich nicht auf', async () => {
    verdrahte();
    zeige();
    await screen.findByTestId('verlauf', undefined, WARTEN);
    expect(screen.getByTestId('vergleich')).toBeTruthy();
    expect(wahl('aus').getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByTestId('vergleich-delta')).toBeNull();
    expect(screen.queryByTestId('verlauf-reihen')).toBeNull();
    // Nur die eigene Reihe liegt im Bild.
    expect(screen.getAllByTestId('verlauf-balken').every((b) => b.getAttribute('data-reihe') === '0')).toBe(true);
  });

  it('„Vorperiode“: die Δ-Zeile steht unter der Karte, der Oktober liegt als zweite Reihe im Bild, und `v=` geht an den Wirt', async () => {
    verdrahte();
    const { onVergleich, rerender } = zeige();
    await screen.findByTestId('verlauf', undefined, WARTEN);

    fireEvent.click(wahl('Vorperiode'));
    expect(onVergleich).toHaveBeenCalledWith('vorperiode');

    // Der Wirt schreibt die Adresse — die Sektion bekommt sie zurück.
    rerender(
      <WerteSektion
        kennzeichen="MS-12"
        messstelle="MS-12 · Montage Linie M1"
        anfang={{ art: 'monat', wert: '2026-11' }}
        heute={HEUTE}
        register={register}
        quelle={quelleVon('MS-12')}
        vergleich="vorperiode"
        onVergleich={onVergleich}
      />,
    );

    const zeile = await screen.findByTestId('vergleich-delta', undefined, WARTEN);
    expect(zeile.textContent).toBe(nb('+260 kWh (+4,3 %) gegenüber Oktober 2026 · korrigiert (Version 2)'));

    // Zwei Reihen im Bild, die zweite mit Namen in der Legende.
    await waitFor(() => expect(screen.getAllByTestId('verlauf-balken').some((b) => b.getAttribute('data-reihe') === '1')).toBe(true), WARTEN);
    const legende = within(screen.getByTestId('verlauf-reihen')).getAllByTestId('verlauf-reihe');
    expect(legende.map((l) => l.textContent)).toEqual(['MS-12 · Montage Linie M1', 'Oktober 2026']);
  });

  it('„Vorjahr“ ohne Basis: kein Δ und keine leere Kurve — der Grund (VG5)', async () => {
    verdrahte();
    zeige({ vergleich: 'vorjahr' });
    const zeile = await screen.findByTestId('vergleich-delta', undefined, WARTEN);
    expect(zeile.textContent).toBe('November 2025: keine Werte — vor Beginn');
    expect(zeile.getAttribute('data-grund')).toBe('vor_bestehen');
    // Eine Reihe ohne Zahl wird nicht gezeichnet.
    await waitFor(() => expect(screen.getAllByTestId('verlauf-balken').every((b) => b.getAttribute('data-reihe') === '0')).toBe(true), WARTEN);
  });

  it('eine laufende Periode wird gesagt (VG3) — ein halber Monat gegen einen ganzen ist kein Rückgang', async () => {
    verdrahte();
    zeige({ heute: '2026-11-20', vergleich: 'vorperiode' });
    const satz = await screen.findByTestId('vergleich-laufend', undefined, WARTEN);
    expect(satz.textContent).toBe('November 2026 läuft — der Vergleich gilt für den bisherigen Zeitraum.');
  });

  it('im Jahr gibt es nur „aus · Vorjahr“ — eine zweite Wahl mit derselben Wirkung wäre eine Behauptung', async () => {
    vi.spyOn(api, 'messstelleWerte').mockImplementation(async () => ms12November());
    zeige({ anfang: { art: 'jahr', wert: '2026' } });
    await screen.findByTestId('vergleich', undefined, WARTEN);
    expect(screen.queryByRole('tab', { name: 'Vorperiode' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Vorjahr' })).toBeTruthy();
  });
});

describe('AP-13 IP-5 · O12 — weitere Messstellen, und bei den anderen steht der Grund', () => {
  it('der Picker nennt die passenden wählbar und die anderen mit Grund; die gewählte Reihe liegt im Bild und hat ihre eigene Karte — ohne Differenz (VG4)', async () => {
    verdrahte();
    zeige();
    await screen.findByTestId('verlauf', undefined, WARTEN);

    fireEvent.click(screen.getByRole('combobox', { name: 'Weitere Messstelle' }));
    const liste = await screen.findByRole('listbox');
    const zeilen = within(liste).getAllByRole('option');
    const text = zeilen.map((z) => z.textContent ?? '');
    expect(text.some((t) => t.includes('MS-11'))).toBe(true);
    expect(text.find((t) => t.includes('MS-04'))).toContain('nicht passend: Laden / Entladen');
    expect(text.find((t) => t.includes('MS-21'))).toContain('nicht passend: Volumen in m³');
    expect(text.find((t) => t.includes('MS-03'))).toContain('nicht passend: Erzeugung');
    // Die eigene Messstelle steht nicht in der Liste — sie liegt schon im Bild.
    expect(text.some((t) => t.includes('MS-12'))).toBe(false);

    fireEvent.click(within(liste).getAllByRole('option').find((o) => (o.textContent ?? '').includes('MS-11'))!);

    // Zwei Reihen, jede mit Namen; die zweite mit ihrer eigenen Karte.
    await waitFor(() => expect(screen.getAllByTestId('verlauf-balken').some((b) => b.getAttribute('data-reihe') === '1')).toBe(true), WARTEN);
    const karten = await screen.findByTestId('vergleich-karten', undefined, WARTEN);
    expect(within(karten).getAllByTestId('vergleich-reihe-karte')).toHaveLength(1);
    expect(within(karten).getByTestId('vergleich-reihe-karte').textContent).toContain('MS-11 · Spritzguss SG07–SG10');

    // VG4: kein Δ zwischen den beiden — und die Fläche sagt, warum.
    expect(screen.getByTestId('vergleich-kein-delta').textContent).toContain('Zwischen zwei Messstellen');
    const alleTexte = document.body.textContent ?? '';
    expect(alleTexte).not.toContain('32.700');
    expect(screen.queryByTestId('vergleich-reihe-delta')).toBeNull();
  });

  it('mit weiteren Reihen bleibt die Überlagerung aus dem Bild — und die Δ-Zeile JEDER Reihe gilt weiter', async () => {
    verdrahte();
    zeige({ vergleich: 'vorperiode' });
    await screen.findByTestId('verlauf', undefined, WARTEN);

    fireEvent.click(screen.getByRole('combobox', { name: 'Weitere Messstelle' }));
    const liste = await screen.findByRole('listbox');
    fireEvent.click(within(liste).getAllByRole('option').find((o) => (o.textContent ?? '').includes('MS-11'))!);

    // Genau zwei Reihen (die eigene und MS-11) — die Vergleichsperiode wird NICHT zusätzlich gezeichnet.
    await waitFor(() => expect(screen.getAllByTestId('verlauf-balken').some((b) => b.getAttribute('data-reihe') === '1')).toBe(true), WARTEN);
    expect(screen.getAllByTestId('verlauf-balken').every((b) => Number(b.getAttribute('data-reihe')) < 2)).toBe(true);
    expect(screen.getByTestId('vergleich-nur-eine-reihe')).toBeTruthy();

    // MS-11 vergleicht sich mit IHREM Oktober: 21 500 gegen 22 400 = −900 kWh.
    const zeile = await screen.findByTestId('vergleich-reihe-delta', undefined, WARTEN);
    expect(zeile.textContent).toBe(nb('−900 kWh (−4,0 %) gegenüber Oktober 2026'));
  });

  it('eine Reihe lässt sich wieder aus dem Bild nehmen', async () => {
    verdrahte();
    zeige();
    await screen.findByTestId('verlauf', undefined, WARTEN);
    fireEvent.click(screen.getByRole('combobox', { name: 'Weitere Messstelle' }));
    const liste = await screen.findByRole('listbox');
    fireEvent.click(within(liste).getAllByRole('option').find((o) => (o.textContent ?? '').includes('MS-11'))!);
    await screen.findByTestId('vergleich-reihe', undefined, WARTEN);

    fireEvent.click(screen.getByRole('button', { name: 'MS-11 · Spritzguss SG07–SG10 aus dem Bild nehmen' }));
    await waitFor(() => expect(screen.queryByTestId('vergleich-reihe')).toBeNull(), WARTEN);
    expect(screen.getAllByTestId('verlauf-balken').every((b) => b.getAttribute('data-reihe') === '0')).toBe(true);
  });

  it('ohne Register gibt es keinen Vergleich — „passend“ braucht die Hauptgrößen der anderen (der Dialog an den Gesamtwert-Karten)', async () => {
    verdrahte();
    zeige({ register: [] });
    await screen.findByTestId('verlauf', undefined, WARTEN);
    expect(screen.queryByTestId('vergleich')).toBeNull();
  });
});
