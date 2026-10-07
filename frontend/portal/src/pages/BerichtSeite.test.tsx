/**
 * Die Seite eines Berichts nach Konzept Nachweisen n1, Runde 2 (§6.4): Status-Zeile, Stufen, Weitergeben (PDF, Teilen,
 * mit `export.*` CSV), „Geändert ggü. Stand 1“ mit Werten alt → neu und dem Grund hinter dem i-Zeichen; nach einer
 * Korrektur die Entscheidung mit zwei Antworten (Entscheid 16) - ohne Recht statt der Antworten, wer freigibt.
 * Zeitachse der Fixtures: 10.11. Stand 1 · 12.11. Korrektur K-2026-0007 · 16.11. Stand 2.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    bericht: vi.fn(),
    berichtStand: vi.fn(),
    berichtEntwurf: vi.fn(),
    berichtDatei: vi.fn(),
    berichtVergleich: vi.fn(),
    berichtFreigeben: vi.fn(),
    berichtAnstossVerwerfen: vi.fn(),
  },
}));

vi.mock('../api', async (importOriginal) => {
  const echt = await importOriginal<typeof import('../api')>();
  const api = new Proxy(echt.api as Record<string, unknown>, {
    get: (_ziel, name) => (name in mocks ? mocks[name as keyof typeof mocks] : () => Promise.reject(new Error('nicht im Test'))),
  });
  return { ...echt, api };
});

import type { Selbstauskunft } from '../api';
import { setSelbstauskunft } from '../rollen';
import { detailAm, entwurfAm, freigabeAm, standAm, vergleichAm, ZEIT } from '../test/berichtFixtures';
import { FIXTURE_IDS } from '../test/standorteFixtures';
import { BerichtSeite } from './BerichtSeite';

const nach = (iso: string) => Date.parse(iso) + 60 * 60_000;
const KORREKTUR = nach(ZEIT.korrektur);
const STAND_ZWEI = nach(ZEIT.nr2);

const LESEN = ['bericht.standort_abrufen'];
const FREIGEBEN = ['bericht.standort_abrufen', 'bericht.standort_freigeben'];

const selbst = (rechte: string[]): Selbstauskunft => ({
  kennung: 'claudia',
  name: 'Claudia Berger',
  konto: 'benutzer',
  zustand: 'aktiv',
  kundenbereich: null,
  zugang: 'konto',
  rollen: ['leser'],
  unternehmensweit: false,
  standorte: [{ id: FIXTURE_IDS.st1, rechte } as unknown as Selbstauskunft['standorte'][number]],
  unternehmen_rechte: [],
  kuenftig: [],
  text: null,
  teilansicht: null,
  unterstuetzungen: { eigene: [], gewaehrte: [] } as unknown as Selbstauskunft['unterstuetzungen'],
  kundenadministratoren: [{ kennung: 'jonas', name: 'Jonas Wendlinger' }] as Selbstauskunft['kundenadministratoren'],
});

const lage = (jetzt: number) => {
  // Asynchron wie die Routen: eine Ablehnung der Bühne (Stand gibt es nicht) ist eine abgelehnte Antwort, kein Wurf.
  mocks.bericht.mockImplementation(async () => detailAm(jetzt));
  mocks.berichtStand.mockImplementation(async (_k: string, nr: number) => standAm(nr, jetzt));
  mocks.berichtEntwurf.mockImplementation(async () => entwurfAm(jetzt));
  mocks.berichtVergleich.mockImplementation(async (_k: string, gegen: number) => vergleichAm(gegen, jetzt));
};

const zeige = async (jetzt: number) => {
  render(<BerichtSeite kennung="BR-2026-0001" onListe={() => {}} jetzt={() => jetzt} />);
  await screen.findByTestId('bericht-status');
  await act(async () => {});
};

describe('Seite eines Berichts (Konzept Nachweisen n1, Runde 2, §6.4)', () => {
  beforeEach(() => {
    mocks.berichtDatei.mockResolvedValue(new Blob(['%PDF']));
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    // jsdom navigiert nicht: der Download-Link wird nur geklickt, nicht gefolgt.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    setSelbstauskunft(null);
    vi.clearAllMocks();
  });

  it('nach einer Korrektur: „Daten geändert · Stand 1 gilt noch“, die Werte und der Grund - ohne Recht, wer freigibt', async () => {
    lage(KORREKTUR);
    setSelbstauskunft(selbst(LESEN));
    await zeige(KORREKTUR);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Monatsbericht Oktober 2026BR-2026-0001');
    expect(screen.getByTestId('bericht-status').textContent).toBe('Daten geändert· Stand 1 gilt noch');
    expect(within(screen.getByTestId('bericht-stufen')).getAllByRole('listitem').map((li) => li.getAttribute('aria-label'))).toEqual([
      'Entwurf: 10.11.2026',
      'Stand 1: 10.11.2026',
      'Stand 2: jetzt',
    ]);
    const karte = await screen.findByTestId('bericht-entscheid');
    await waitFor(() => expect(within(karte).getByTestId('bericht-entscheid-werte')).toBeTruthy());
    expect(within(karte).getByTestId('bericht-grund').textContent).toContain('Grund:');
    // Ohne Freigabe-Recht keine Antworten, sondern wer es kann - Grund und Weg im Erklär-Blatt (Befund 2).
    expect(within(karte).queryByTestId('bericht-antwort-ja')).toBeNull();
    const zeile = within(karte).getByTestId('bericht-freigeben-ohne-recht');
    expect(zeile).toHaveTextContent('Freigeben: Jonas Wendlinger');
    fireEvent.click(within(zeile).getByTestId('bericht-freigeben-warum-knopf'));
    expect(await screen.findByTestId('erklaer-blatt')).toHaveTextContent('Jonas Wendlinger gibt frei oder vergibt das Recht.');
    // Am gültigen Stand PDF und Teilen, ohne `export.standort` kein CSV.
    const dateien = screen.getByTestId('bericht-dateien');
    expect(within(dateien).getAllByRole('button').map((k) => k.textContent)).toEqual(['PDF', 'Teilen']);
    expect(document.body.textContent).not.toContain('Dafür fehlt Ihnen das Recht');
  });

  it('PDF lädt den gezeigten Stand; mit `export.standort` auch CSV', async () => {
    lage(KORREKTUR);
    setSelbstauskunft(selbst([...LESEN, 'export.standort']));
    await zeige(KORREKTUR);
    const dateien = screen.getByTestId('bericht-dateien');
    expect(within(dateien).getAllByRole('button').map((k) => k.textContent)).toEqual(['PDF', 'Teilen', 'CSV']);
    fireEvent.click(within(dateien).getByRole('button', { name: 'PDF' }));
    await waitFor(() => expect(mocks.berichtDatei).toHaveBeenCalledWith('BR-2026-0001', 1, 'pdf'));
    expect(await screen.findByTestId('bericht-abruf')).toHaveTextContent('PDF von Stand Nr. 1 abgerufen');
  });

  it('„Ja, Stand 2 freigeben“: Prüfen, dann die Bestätigung mit PDF - freigegeben wird genau der gesehene Entwurf', async () => {
    lage(KORREKTUR);
    setSelbstauskunft(selbst(FREIGEBEN));
    // Die Bühne gibt den Stand zur Uhr seiner Freigabe heraus (16.11.); gesehen wurde der Entwurf vom 12.11.
    mocks.berichtFreigeben.mockImplementation(async (_k: string, datenstand: string) => freigabeAm(datenstand, STAND_ZWEI));
    await zeige(KORREKTUR);
    const karte = await screen.findByTestId('bericht-entscheid');
    expect(within(karte).getByTestId('bericht-weiter')).toBeDisabled();
    fireEvent.click(within(karte).getByRole('radio', { name: 'Ja, Stand 2 freigeben' }));
    fireEvent.click(within(karte).getByTestId('bericht-weiter'));
    const blatt = await screen.findByTestId('bericht-freigeben-blatt');
    expect(within(blatt).getByTestId('bericht-pruefen').textContent).toContain('Monatsbericht Oktober 2026');
    expect(within(blatt).getByTestId('bericht-pruefen-hinweis').textContent).toContain('Ändert sich danach nie mehr');
    await act(async () => {
      fireEvent.click(screen.getByTestId('bericht-freigeben-senden'));
    });
    expect(mocks.berichtFreigeben).toHaveBeenCalledWith('BR-2026-0001', entwurfAm(KORREKTUR).datenstand);
    expect((await screen.findByTestId('bericht-bestaetigung')).textContent).toContain('Stand 2 ist freigegeben');
    const vorher = mocks.bericht.mock.calls.length;
    fireEvent.click(screen.getByTestId('bericht-fertig'));
    await waitFor(() => expect(mocks.bericht.mock.calls.length).toBeGreaterThan(vorher));
  });

  it('„Nein, Stand 1 behalten“: ein Grund für alle offenen Anstöße (Entscheid 16)', async () => {
    lage(KORREKTUR);
    setSelbstauskunft(selbst(FREIGEBEN));
    mocks.berichtAnstossVerwerfen.mockResolvedValue({});
    await zeige(KORREKTUR);
    const karte = await screen.findByTestId('bericht-entscheid');
    fireEvent.click(within(karte).getByRole('radio', { name: 'Nein, Stand 1 behalten' }));
    fireEvent.click(within(karte).getByTestId('bericht-weiter'));
    const blatt = await screen.findByTestId('bericht-behalten-blatt');
    await act(async () => {
      fireEvent.click(screen.getByTestId('bericht-behalten-senden'));
    });
    expect(blatt.textContent).toContain('Die Begründung fehlt.');
    expect(mocks.berichtAnstossVerwerfen).not.toHaveBeenCalled();
    fireEvent.change(within(blatt).getByTestId('bericht-behalten-grund'), { target: { value: 'Korrektur betrifft nur den 31.10. nach Betriebsschluss.' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('bericht-behalten-senden'));
    });
    const offen = detailAm(KORREKTUR).anstoesse.filter((a) => a.zustand === 'offen');
    expect(mocks.berichtAnstossVerwerfen.mock.calls).toEqual(offen.map((a) => ['BR-2026-0001', a.id, 'Korrektur betrifft nur den 31.10. nach Betriebsschluss.']));
  });

  it('am Stand 2: „Geändert ggü. Stand 1“ mit Werten alt → neu und Grund; „Stand 1“ zeigt den überholten Stand', async () => {
    lage(STAND_ZWEI);
    setSelbstauskunft(selbst(LESEN));
    await zeige(STAND_ZWEI);
    expect(screen.getByTestId('bericht-status').textContent).toBe('Stand 2 gilt· Daten unverändert');
    const karte = await screen.findByTestId('bericht-geaendert');
    expect(within(karte).getByRole('heading').textContent).toBe('Geändert ggü. Stand 1');
    expect(within(karte).getAllByRole('listitem').length).toBeGreaterThan(0);
    fireEvent.click(within(karte).getByTestId('bericht-grund'));
    expect((await screen.findByTestId('bericht-grund-blatt')).textContent).toContain('Korrektur K-2026-0007');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('bericht-stand-1'));
    await waitFor(() => expect(screen.getByTestId('bericht-status').textContent).toBe('Stand 1· überholt'));
    expect(screen.getByTestId('bericht-stand-2')).toHaveTextContent('gilt');
  });

  it('nur ein Entwurf: „◎ Entwurf“, Stufe „Stand 1“ offen, „Freigeben“ mit Recht', async () => {
    const VOR = Date.parse(ZEIT.angelegt) + 60_000;
    lage(VOR);
    setSelbstauskunft(selbst(FREIGEBEN));
    await zeige(VOR);
    expect(screen.getByTestId('bericht-status').textContent).toBe('Entwurf');
    await screen.findByTestId('bericht-hebel');
    expect(screen.getByTestId('bericht-freigeben').textContent).toBe('Freigeben');
    // Ein Entwurf ist nie eine Datei (EW4): nur Teilen.
    expect(within(screen.getByTestId('bericht-dateien')).getAllByRole('button').map((k) => k.textContent)).toEqual(['Teilen']);
  });
});
