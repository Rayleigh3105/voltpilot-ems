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
    berichtAnstoesseVerwerfen: vi.fn(),
    berichtArchivieren: vi.fn(),
  },
}));

vi.mock('../api', async (importOriginal) => {
  const echt = await importOriginal<typeof import('../api')>();
  const api = new Proxy(echt.api as Record<string, unknown>, {
    get: (_ziel, name) => (name in mocks ? mocks[name as keyof typeof mocks] : () => Promise.reject(new Error('nicht im Test'))),
  });
  return { ...echt, api };
});

import { ApiError, type BerichtDetail, type Selbstauskunft } from '../api';
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
    // Review r1, P3-9: „Stand 1“ wie überall in Nachweisen, nicht der alte „Stand Nr. 1“.
    expect(await screen.findByTestId('bericht-abruf')).toHaveTextContent('PDF von Stand 1 abgerufen · protokolliert');
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
    mocks.berichtAnstoesseVerwerfen.mockResolvedValue({ anstoesse: [] });
    await zeige(KORREKTUR);
    const karte = await screen.findByTestId('bericht-entscheid');
    fireEvent.click(within(karte).getByRole('radio', { name: 'Nein, Stand 1 behalten' }));
    fireEvent.click(within(karte).getByTestId('bericht-weiter'));
    const blatt = await screen.findByTestId('bericht-behalten-blatt');
    await act(async () => {
      fireEvent.click(screen.getByTestId('bericht-behalten-senden'));
    });
    expect(blatt.textContent).toContain('Die Begründung fehlt.');
    expect(mocks.berichtAnstoesseVerwerfen).not.toHaveBeenCalled();
    fireEvent.change(within(blatt).getByTestId('bericht-behalten-grund'), { target: { value: 'Korrektur betrifft nur den 31.10. nach Betriebsschluss.' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('bericht-behalten-senden'));
    });
    // Review r1, P3-2: EINE Route mit allen gesehenen Anstößen - alle oder keiner, nie Anstoß für Anstoß.
    const offen = detailAm(KORREKTUR).anstoesse.filter((a) => a.zustand === 'offen');
    expect(mocks.berichtAnstoesseVerwerfen.mock.calls).toEqual([['BR-2026-0001', offen.map((a) => a.id), 'Korrektur betrifft nur den 31.10. nach Betriebsschluss.']]);
    expect(mocks.berichtAnstossVerwerfen).not.toHaveBeenCalled();
  });

  it('Review r1, P3-2: hat inzwischen jemand anders entschieden (409), lädt die Seite neu und das Blatt sagt warum', async () => {
    lage(KORREKTUR);
    setSelbstauskunft(selbst(FREIGEBEN));
    mocks.berichtAnstoesseVerwerfen.mockRejectedValue(
      new ApiError(409, 'Dieser Anstoß ist nicht mehr offen.', { code: 'anstoss_nicht_offen', message: 'Dieser Anstoß ist nicht mehr offen.' }),
    );
    await zeige(KORREKTUR);
    const karte = await screen.findByTestId('bericht-entscheid');
    fireEvent.click(within(karte).getByRole('radio', { name: 'Nein, Stand 1 behalten' }));
    fireEvent.click(within(karte).getByTestId('bericht-weiter'));
    const blatt = await screen.findByTestId('bericht-behalten-blatt');
    fireEvent.change(within(blatt).getByTestId('bericht-behalten-grund'), { target: { value: 'Korrektur betrifft nur den 31.10. nach Betriebsschluss.' } });
    const vorher = mocks.bericht.mock.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByTestId('bericht-behalten-senden'));
    });
    expect(within(blatt).getByTestId('blatt-ablehnung').textContent).toBe('Dieser Anstoß ist nicht mehr offen.');
    await waitFor(() => expect(mocks.bericht.mock.calls.length).toBeGreaterThan(vorher));
  });

  it('Review r1, P3-3: lädt der Entwurf nicht, sagt es die Karte und lädt auf Antippen neu - kein ewiges Skelett', async () => {
    lage(KORREKTUR);
    setSelbstauskunft(selbst(FREIGEBEN));
    mocks.berichtEntwurf.mockRejectedValueOnce(new Error('Netz'));
    await zeige(KORREKTUR);
    const karte = await screen.findByTestId('bericht-entscheid');
    expect((await within(karte).findByTestId('bericht-entscheid-fehler')).textContent).toContain('Die Werte ließen sich gerade nicht laden.');
    expect(within(karte).getByTestId('bericht-weiter')).toBeDisabled();
    await act(async () => {
      fireEvent.click(within(karte).getByTestId('bericht-entscheid-erneut'));
    });
    await waitFor(() => expect(within(karte).queryByTestId('bericht-entscheid-fehler')).toBeNull());
    expect(within(karte).queryByTestId('bericht-entscheid-werte') ?? within(karte).queryByTestId('bericht-entscheid-keine-zahl')).toBeTruthy();
  });

  it('Review r1, P3-4: die Werte der Karte kommen aus dem Entwurf selbst; nach „Entwurf neu laden“ zeigt das Blatt die neuen Werte vor der Freigabe', async () => {
    lage(KORREKTUR);
    setSelbstauskunft(selbst(FREIGEBEN));
    const neu = { ...entwurfAm(KORREKTUR), datenstand: '2026-11-13T08:00:00Z' };
    mocks.berichtFreigeben
      .mockRejectedValueOnce(new ApiError(409, 'Der Entwurf ist nicht mehr aktuell.', { code: 'entwurf_veraltet', message: 'Der Entwurf ist nicht mehr aktuell.' }))
      .mockImplementation(async (_k: string, datenstand: string) => freigabeAm(datenstand, STAND_ZWEI));
    await zeige(KORREKTUR);
    const karte = await screen.findByTestId('bericht-entscheid');
    await waitFor(() => expect(within(karte).getByTestId('bericht-entscheid-werte')).toBeTruthy());
    expect(mocks.berichtVergleich).not.toHaveBeenCalled();
    fireEvent.click(within(karte).getByRole('radio', { name: 'Ja, Stand 2 freigeben' }));
    fireEvent.click(within(karte).getByTestId('bericht-weiter'));
    const blatt = await screen.findByTestId('bericht-freigeben-blatt');
    await act(async () => {
      fireEvent.click(screen.getByTestId('bericht-freigeben-senden'));
    });
    mocks.berichtEntwurf.mockResolvedValue(neu);
    await act(async () => {
      fireEvent.click(within(blatt).getByRole('button', { name: 'Entwurf neu laden' }));
    });
    expect(within(blatt).getByTestId('bericht-freigeben-neu').textContent).toContain('Entwurf neu gebildet');
    expect(within(blatt).getByTestId('bericht-freigeben-werte')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId('bericht-freigeben-senden'));
    });
    expect(mocks.berichtFreigeben).toHaveBeenLastCalledWith('BR-2026-0001', '2026-11-13T08:00:00Z');
  });

  it('Review r1, P3-6: ein gebündelt freigegebener Stand nennt als Grund alle Korrekturen, die er erledigte', async () => {
    lage(STAND_ZWEI);
    const d = detailAm(STAND_ZWEI);
    const erste = d.anstoesse.find((a) => a.erledigt_durch_nr === 2)!;
    const zweite = { ...erste, id: 'a0000000-0000-4000-8000-0000000000b2', anlass_kennung: 'K-2026-0008', anlass_text: 'Korrektur K-2026-0008' };
    mocks.bericht.mockImplementation(async (): Promise<BerichtDetail> => ({ ...d, anstoesse: [...d.anstoesse, zweite] }));
    setSelbstauskunft(selbst(LESEN));
    await zeige(STAND_ZWEI);
    const karte = await screen.findByTestId('bericht-geaendert');
    expect(within(karte).getByTestId('bericht-grund').textContent).toBe('Grund: 2 Korrekturen');
  });

  it('Review r1, P3-7 (C8): „Archivieren“ im Menü - Stände bleiben lesbar; danach „archiviert“ und kein Archivieren mehr', async () => {
    lage(STAND_ZWEI);
    setSelbstauskunft(selbst(FREIGEBEN));
    mocks.berichtArchivieren.mockResolvedValue(detailAm(STAND_ZWEI).bericht);
    await zeige(STAND_ZWEI);
    fireEvent.click(screen.getByRole('button', { name: 'Weitere Aktionen' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archivieren' }));
    const blatt = await screen.findByTestId('bericht-archivieren-blatt');
    expect(blatt.textContent).toContain('Stände bleiben lesbar');
    // Danach liefert die Route den Bericht archiviert.
    mocks.bericht.mockImplementation(async () => {
      const d = detailAm(STAND_ZWEI);
      return { ...d, bericht: { ...d.bericht, archiviert_am: '2026-11-20T10:00:00Z' } };
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('bericht-archivieren-senden'));
    });
    expect(mocks.berichtArchivieren).toHaveBeenCalledWith('BR-2026-0001');
    await waitFor(() => expect(screen.getByTestId('bericht-status').textContent).toBe('archiviert· Stand 2 bleibt lesbar'));
    fireEvent.click(screen.getByRole('button', { name: 'Weitere Aktionen' }));
    expect((await screen.findAllByRole('menuitem')).map((m) => m.textContent)).toEqual(['Kennung BR-2026-0001 kopieren']);
  });

  it('Review r1, P3-9: solange die Selbstauskunft lädt, blitzt kein Rechte-Satz auf', async () => {
    lage(KORREKTUR);
    setSelbstauskunft(null);
    await zeige(KORREKTUR);
    const karte = await screen.findByTestId('bericht-entscheid');
    expect(within(karte).queryByTestId('bericht-freigeben-ohne-recht')).toBeNull();
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
