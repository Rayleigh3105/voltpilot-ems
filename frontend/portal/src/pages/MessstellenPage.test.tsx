import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type MessstellenRegister, type MessstellenRegisterAnfrage } from '../api';
import type { MessstellenEbene } from '../messstellen';
import { messstelleAngelegt, VORSCHLAG } from '../test/messstelleDialogFixtures';
import { ahrenbergRegister, leeresRegister } from '../test/messstellenRegisterFixtures';
import { ortsbaumAhrenberg, ortsbaumLindach } from '../test/ortsbaumFixtures';
import { ahrenbergHeute, FIXTURE_IDS } from '../test/standorteFixtures';
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
    // Der Schreibweg der Fläche: „Messstelle anlegen“ öffnet den Dialog (AP-04 IP-6); „Vorschläge“ fehlt, bis es die Liste gibt (AP-01 IP-9b).
    expect(screen.getByRole('button', { name: 'Messstelle anlegen' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Vorschläge/ })).toBeNull();
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
    // E6: ohne „Messen & Auswerten“ keine Messstellen — also auch kein Anlegen.
    expect(screen.queryByRole('button', { name: 'Messstelle anlegen' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Zur Übersicht' }));
    expect(zurUebersicht).toHaveBeenCalledTimes(1);
  });

  it('eingerichtet, aber noch keine Messstelle: der Satz und „Messstelle anlegen“ (§5.11) — sonst kein Knopf ohne Ziel', async () => {
    telefon(false);
    verdrahte(() => leeresRegister());
    render(<MessstellenPage ebene={{ art: 'standort', id: FIXTURE_IDS.st2, name: 'Werk Lindach' }} bereichDa />);
    expect(await screen.findByText('Noch keine Messstelle in Werk Lindach.')).toBeInTheDocument();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Messstelle anlegen']);
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

describe('MessstellenPage · „Messstelle anlegen“ öffnet den Dialog (AP-04 IP-6)', () => {
  function dialogGestellt() {
    vi.spyOn(api, 'kennzeichenVorschlag').mockResolvedValue({ kennzeichen: VORSCHLAG });
    vi.spyOn(api, 'standorte').mockResolvedValue(ahrenbergHeute());
    vi.spyOn(api, 'standortOrte').mockImplementation(async (id: string) =>
      id === FIXTURE_IDS.st1 ? ortsbaumAhrenberg() : ortsbaumLindach(),
    );
  }

  it('der Kopf öffnet den Dialog mit dem Standort als Vorgabe; hat ein Schritt gespeichert, liest das Register nach dem Schließen neu', async () => {
    telefon(false);
    const register = verdrahte();
    dialogGestellt();
    const anlegen = vi.spyOn(api, 'messstelleAnlegen').mockResolvedValue(messstelleAngelegt());
    render(<MessstellenPage ebene={WERK} bereichDa />);
    await screen.findByRole('table', {}, WARTEN);

    fireEvent.click(screen.getByRole('button', { name: 'Messstelle anlegen' }));
    const dialog = await screen.findByRole('dialog', { name: 'Messstelle anlegen' });
    await waitFor(() => expect((within(dialog).getByLabelText('Kennzeichen') as HTMLInputElement).value).toBe(VORSCHLAG));
    fireEvent.change(within(dialog).getByLabelText('Name *'), { target: { value: 'Spritzguss SG01–SG06 Kühlung' } });
    for (const [feld, wahl] of [
      ['Hauptgröße *', /^Wirkenergie/],
      ['Richtung *', /^Bezug/],
      ['Wertart *', /^Zählerstand/],
    ] as const) {
      fireEvent.click(within(dialog).getByRole('combobox', { name: feld }));
      fireEvent.click(await screen.findByRole('option', { name: wahl }));
    }
    fireEvent.click(within(dialog).getByRole('button', { name: 'Weiter: Zuordnung' }));
    await waitFor(() => expect(anlegen).toHaveBeenCalledTimes(1));
    // §5.1 „Vorgabe: Standort“ — die Seite ist Werk Ahrenberg.
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: 'Ort' }).textContent).toContain('Werk Ahrenberg'));

    const vorher = register.mock.calls.length;
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(register.mock.calls.length).toBeGreaterThan(vorher));
    expect(register).toHaveBeenLastCalledWith({ standort: FIXTURE_IDS.st1 });
  });

  it('ohne Speichern geschlossen: kein neues Lesen', async () => {
    telefon(false);
    const register = verdrahte();
    dialogGestellt();
    render(<MessstellenPage ebene={UNTERNEHMEN} bereichDa />);
    await screen.findByRole('table', {}, WARTEN);
    fireEvent.click(screen.getByRole('button', { name: 'Messstelle anlegen' }));
    await screen.findByRole('dialog', { name: 'Messstelle anlegen' });
    await waitFor(() => expect(api.kennzeichenVorschlag).toHaveBeenCalled());
    const vorher = register.mock.calls.length;
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Messstelle anlegen' })).toBeNull());
    expect(register.mock.calls.length).toBe(vorher);
  });

  it('mit „Stand am“ gibt es keinen Schreibweg — der Knopf verschwindet', async () => {
    telefon(false);
    verdrahte();
    render(<MessstellenPage ebene={UNTERNEHMEN} bereichDa />);
    await screen.findByRole('table', {}, WARTEN);
    expect(screen.getByRole('button', { name: 'Messstelle anlegen' })).toBeInTheDocument();
    await waehleTag('2026-10-10');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Zurück zu heute' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Messstelle anlegen' })).toBeNull();
  });
});

describe('MessstellenPage · Einstieg in die Werte (UEMS AP-13 IP-3, O13)', () => {
  const MS06 = '3e000000-0000-4000-8000-000000000006';
  const zeileVon = (kz: string) => zeilen().find((z) => z.querySelector('td')?.textContent === kz)!;

  it('am Rechner: der letzte Wert und das Zeilenmenü „Werte“ öffnen die Seite mit dem Vortag (heute 20.10.2026)', async () => {
    telefon(false);
    verdrahte();
    const onWerte = vi.fn();
    render(<MessstellenPage ebene={UNTERNEHMEN} bereichDa onWerte={onWerte} />);
    await screen.findByRole('table');
    // Die Spalte des Zeilenmenüs hat keinen sichtbaren Kopf, nur einen für Vorleser.
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Kennzeichen',
      'Name',
      'Ort',
      'Elektrische Stellung',
      'Quelle (führend)',
      'Zustand',
      'Letzter Wert',
      'Aktionen',
    ]);
    const ms06 = zeileVon('MS-06');
    fireEvent.click(within(ms06).getByRole('button', { name: /^Werte MS-06: Wirkleistung/ }));
    expect(onWerte).toHaveBeenLastCalledWith(MS06, '2026-10-19');
    fireEvent.click(within(ms06).getByRole('button', { name: 'Aktionen' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Werte' }));
    expect(onWerte).toHaveBeenCalledTimes(2);
    expect(onWerte).toHaveBeenLastCalledWith(MS06, '2026-10-19');
    // Ohne Wert kein Knopf am Strich — das Zeilenmenü bleibt der Weg.
    expect(within(zeileVon('MS-21')).queryByRole('button', { name: /^Werte / })).toBeNull();
    expect(within(zeileVon('MS-21')).getByRole('button', { name: 'Aktionen' })).toBeInTheDocument();
  });

  it('mit „Stand am 10.10.2026“ öffnet der Einstieg diesen Tag', async () => {
    telefon(false);
    verdrahte();
    const onWerte = vi.fn();
    render(<MessstellenPage ebene={UNTERNEHMEN} bereichDa onWerte={onWerte} />);
    await screen.findByRole('table');
    await waehleTag('2026-10-10');
    await waitFor(() => expect(screen.getByRole('columnheader', { name: 'Zustand (heute)' })).toBeInTheDocument(), WARTEN);
    await waitFor(() => expect(zeileVon('MS-06')).toBeTruthy(), WARTEN);
    fireEvent.click(within(zeileVon('MS-06')).getByRole('button', { name: 'Aktionen' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Werte' }));
    expect(onWerte).toHaveBeenLastCalledWith(MS06, '2026-10-10');
  });

  it('am Telefon: die ganze Karte ist der Einstieg — nicht der Weg auf die Seite ohne Periode', async () => {
    telefon(true);
    verdrahte();
    const onWerte = vi.fn();
    const onOeffnen = vi.fn();
    render(<MessstellenPage ebene={UNTERNEHMEN} bereichDa onOeffnen={onOeffnen} onWerte={onWerte} />);
    const karten = await screen.findAllByRole('listitem');
    expect(karten[5]).toHaveClass('is-werte');
    fireEvent.click(within(karten[5]).getByRole('button', { name: 'Spritzguss SG01–SG06' }));
    expect(onWerte).toHaveBeenCalledWith(MS06, '2026-10-19');
    expect(onOeffnen).not.toHaveBeenCalled();
  });
});
