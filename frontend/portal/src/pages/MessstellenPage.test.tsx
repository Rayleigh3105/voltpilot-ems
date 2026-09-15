import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type MessstellenRegister, type MessstellenRegisterAnfrage } from '../api';
import type { MessstellenEbene } from '../messstellen';
import { ahrenbergRegister, leeresRegister } from '../test/messstellenRegisterFixtures';
import { FIXTURE_IDS } from '../test/standorteFixtures';
import { MessstellenPage } from './MessstellenPage';

/**
 * Die Fläche „Messstellen“ (UEMS AP-04 IP-5) gegen die gestellte Route
 * `GET /api/v1/messstellen` (Referenzunternehmen, heute = 20.10.2026):
 * Tabelle (Rechner) und Karten (Telefon), „Stand am …“ mit dem benannten
 * „gab es noch nicht“, der Filter „ohne Quelle“ und die Leerzustände.
 */

const UNTERNEHMEN: MessstellenEbene = { art: 'unternehmen', name: 'Kunststoffwerk Ahrenberg GmbH' };
const WERK: MessstellenEbene = { art: 'standort', id: FIXTURE_IDS.st1, name: 'Werk Ahrenberg' };
const WARTEN = { timeout: 3000 };

function verdrahte(antwort: (a: MessstellenRegisterAnfrage) => MessstellenRegister = ahrenbergRegister) {
  return vi.spyOn(api, 'messstellenRegister').mockImplementation(async (a = {}) => antwort(a));
}

function telefon(ja: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: ja,
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const zeilen = () => screen.getAllByRole('row').slice(1);

/** Wählt im Datumsfeld „Stand am“ einen Tag (wie `StandortePageStandAm.test.tsx`). */
async function waehleTag(iso: string) {
  const feld = screen.getByRole('combobox', { name: 'Stand am' });
  const vorher = feld.textContent ?? '';
  fireEvent.click(feld);
  const [t, m, j] = vorher.match(/\d{2}\.\d{2}\.\d{4}/)![0].split('.');
  const richtung = iso < `${j}-${m}-${t}` ? 'Voriger Monat' : 'Nächster Monat';
  for (let i = 0; i < 24; i++) {
    const tag = document.querySelector<HTMLButtonElement>(`.vp-kal-tag[data-iso="${iso}"]:not(.is-rand)`);
    if (tag) {
      fireEvent.click(tag);
      return;
    }
    fireEvent.click(screen.getByRole('button', { name: richtung }));
  }
  throw new Error(`Tag ${iso} nicht erreicht`);
}

describe('MessstellenPage · Register', () => {
  it('am Rechner eine Tabelle mit den Spalten des Registers und dem „x von y“ im Kopf', async () => {
    telefon(false);
    const register = verdrahte();
    render(<MessstellenPage ebene={UNTERNEHMEN} bereichDa />);
    await screen.findByRole('table');
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Kennzeichen',
      'Name',
      'Ort',
      'Elektrische Stellung',
      'Quelle (führend)',
      'Zustand',
      'Letzter Wert',
    ]);
    expect(zeilen()).toHaveLength(22);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Messstellen');
    expect(screen.getByText('21 von 22 Messstellen liefern Daten')).toBeInTheDocument();
    const ms06 = zeilen()[5];
    expect(ms06).toHaveTextContent('MS-06');
    expect(ms06).toHaveTextContent('Unterzähler Spritzguss SG01–SG06 · GR-4 Z-5a');
    expect(ms06).toHaveTextContent('führend seit 12.03.2024');
    // `toHaveTextContent` fasst Leerraum (auch U+00A0) zu einem Leerzeichen zusammen — das U+00A0 prüft `messstellen.test.ts`.
    expect(ms06).toHaveTextContent('Wirkleistung 148,6 kW 10:15 Uhr');
    // EINE Abfrage ohne Filter.
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith({});
    // Kein Schreibweg auf dieser Fläche (Dialog IP-6 fehlt noch): kein Knopf „anlegen“.
    expect(screen.queryByRole('button', { name: /anlegen|Vorschläge/ })).toBeNull();
  });

  it('am Telefon Karten mit denselben Wörtern — keine Tabelle', async () => {
    telefon(true);
    verdrahte();
    render(<MessstellenPage ebene={UNTERNEHMEN} bereichDa />);
    const karten = await screen.findAllByRole('listitem');
    expect(karten).toHaveLength(22);
    expect(screen.queryByRole('table')).toBeNull();
    const ms21 = karten[20];
    expect(within(ms21).getByRole('heading', { level: 2 })).toHaveTextContent('Gas Heizung Verwaltung');
    expect(ms21).toHaveTextContent('Quelle (führend)Keine Datenquelle');
    expect(ms21).toHaveTextContent('Letzter Wert—');
  });

  it('„Standort › Messstellen“ fragt mit seinem Standort und nennt ihn im Kopf; kein Standort-Filter', async () => {
    telefon(false);
    const register = verdrahte();
    render(<MessstellenPage ebene={WERK} bereichDa />);
    await screen.findByRole('table');
    expect(register).toHaveBeenCalledWith({ standort: FIXTURE_IDS.st1 });
    // MS-19 (am Unternehmen), MS-20 und MS-22 (ohne Ort) und Lindach gehören nicht zu Werk Ahrenberg.
    expect(zeilen().map((z) => z.cells[0].textContent)).toEqual(
      ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15', '21'].map((n) => `MS-${n}`),
    );
    expect(screen.getByText('Werk Ahrenberg · 15 von 16 Messstellen liefern Daten')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Standort' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Ort' })).toBeInTheDocument();
  });
});

describe('MessstellenPage · „Stand am …“', () => {
  it('ein Stichtag, an dem es eine Messstelle noch nicht gab: benannt an ihrem Platz, Zustand „heute“, kein „x von y“', async () => {
    telefon(false);
    const register = verdrahte();
    render(<MessstellenPage ebene={UNTERNEHMEN} bereichDa />);
    await screen.findByRole('table');
    await waehleTag('2026-10-10');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Sie sehen den Stand am 10.10.2026'), WARTEN);
    await waitFor(() => expect(screen.getByRole('columnheader', { name: 'Zustand (heute)' })).toBeInTheDocument(), WARTEN);
    expect(register).toHaveBeenLastCalledWith({ stichtag: '2026-10-10' });
    expect(zeilen()).toHaveLength(22);
    const ms16 = zeilen()[15];
    expect(ms16).toHaveTextContent('MS-16');
    expect(ms16).toHaveTextContent('Am 10.10.2026 gab es MS-16 „Netzbezug Lindach“ im Portal noch nicht.');
    expect(ms16.cells).toHaveLength(3);
    expect(screen.queryByText(/von 22 Messstellen liefern Daten/)).toBeNull();
    // Zurück zu heute: die Liste von heute, ohne Banner.
    fireEvent.click(screen.getByRole('button', { name: 'Zurück zu heute' }));
    await waitFor(() => expect(screen.getByText('21 von 22 Messstellen liefern Daten')).toBeInTheDocument(), WARTEN);
  });
});

describe('MessstellenPage · Filter und Leerzustände', () => {
  it('„Nur ohne Quelle“ fragt dieselbe Route mit dem Filter und zeigt MS-21', async () => {
    telefon(false);
    const register = verdrahte();
    render(<MessstellenPage ebene={UNTERNEHMEN} bereichDa />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Nur ohne Quelle (1)' }));
    await waitFor(() => expect(zeilen()).toHaveLength(1), WARTEN);
    expect(register).toHaveBeenLastCalledWith({ ohneQuelle: true });
    expect(zeilen()[0]).toHaveTextContent('MS-21');
    expect(screen.getByRole('button', { name: 'Nur ohne Quelle (1)' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Filter zurücksetzen' }));
    await waitFor(() => expect(zeilen()).toHaveLength(22), WARTEN);
  });

  it('„ohne Quelle“ ohne Treffer nennt, wie viele eine Quelle haben', async () => {
    telefon(false);
    verdrahte((a) => {
      const b = ahrenbergRegister(a);
      b.register = b.register.filter((z) => z.kennzeichen !== 'MS-21');
      b.messstellen = b.messstellen.filter((m) => m.kennzeichen !== 'MS-21');
      return b;
    });
    render(<MessstellenPage ebene={UNTERNEHMEN} bereichDa />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Nur ohne Quelle (0)' }));
    expect(await screen.findByText('Alle 16 gemessenen Messstellen haben eine Quelle.', {}, WARTEN)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('ohne „Messen & Auswerten“: der Satz und der Weg zur Übersicht — kein Datumsfeld, keine Filter', async () => {
    telefon(false);
    verdrahte(() => leeresRegister());
    const zurUebersicht = vi.fn();
    render(<MessstellenPage ebene={UNTERNEHMEN} bereichDa={false} onUebersicht={zurUebersicht} />);
    expect(
      await screen.findByText('Messstellen gibt es, sobald ein Standort „Messen & Auswerten“ eingerichtet hat.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Stand am' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Filter' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Zur Übersicht' }));
    expect(zurUebersicht).toHaveBeenCalledTimes(1);
  });

  it('eingerichtet, aber noch keine Messstelle: der Satz, kein Knopf ohne Ziel', async () => {
    telefon(false);
    verdrahte(() => leeresRegister());
    render(<MessstellenPage ebene={{ art: 'standort', id: FIXTURE_IDS.st2, name: 'Werk Lindach' }} bereichDa />);
    expect(await screen.findByText('Noch keine Messstelle in Werk Lindach.')).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('ein Ladefehler wird genannt und lässt sich wiederholen', async () => {
    telefon(false);
    const register = vi.spyOn(api, 'messstellenRegister').mockRejectedValueOnce(new Error('503'));
    register.mockImplementation(async (a = {}) => ahrenbergRegister(a));
    render(<MessstellenPage ebene={UNTERNEHMEN} bereichDa />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Die Messstellen konnten nicht geladen werden.');
    fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    await screen.findByRole('table');
  });
});
