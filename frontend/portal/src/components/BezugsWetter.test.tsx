import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Bezugsgroesse, StandortAmStichtag, StandortWetter, Wetterbezug } from '../api';
import { UEMS_KOORDINATEN_FEHLEN, UEMS_KOORDINATEN_FEHLEN_SATZ, UEMS_TEMPERATUR_BEZOGEN } from '../glossar';
import { abrufText, standortWetterZeile, standText, zustandSatz } from '../wetterBezug';

/**
 * AP-17 IP-12c: die zwei Wetter-Flächen — Abschnitt „Wetter“ an der Gradtagzahl (binden/lösen, Zustand „x von y
 * Tagen“, Koordinaten-Satz) und die Zeile „Wetter“ am Standort. Die Sätze kommen aus `glossar.ts` und §5.8.
 */

const wetterbezug = vi.fn();
const wetterBinden = vi.fn();
const wetterLoesen = vi.fn();
const standortWetter = vi.fn();
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      wetterbezug: (...a: unknown[]) => wetterbezug(...a),
      wetterBinden: (...a: unknown[]) => wetterBinden(...a),
      wetterLoesen: (...a: unknown[]) => wetterLoesen(...a),
      standortWetter: (...a: unknown[]) => standortWetter(...a),
    },
  };
});
let erlaubt = true;
const darfAufrufe: [string, string | null][] = [];
vi.mock('../rollen', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../rollen')>();
  return { ...actual, useRollen: () => ({ darf: (aktion: string, standort: string | null) => { darfAufrufe.push([aktion, standort]); return erlaubt; } }) };
});

const { BezugsWetter } = await import('./BezugsWetter');
const { StandortWetterZeile } = await import('./StandortWetterZeile');

const BZ: Bezugsgroesse = {
  art: 'gradtagzahl', id: 'bz-8', kennzeichen: 'BZ-8', name: 'Gradtagzahl Werk Ahrenberg', wertart: 'periodenwert',
  einheit: 'Kd', periode_art: 'monat', geltung_art: 'standort', geltung_id: 'st-1', geltung_name: 'Werk Ahrenberg',
  hat_werte: false, archiviert_am: null, angelegt_am: '2026-09-01T00:00:00Z',
};
const ABRUF = '2027-04-03T04:10:00Z';
const GEBUNDEN: Wetterbezug = {
  moeglich: true, koordinaten: true, bindung: {
    raumtemperatur: 20, heizgrenze: 15, regel: 'Gradtage G20/15', von: '2027-03-01', gebunden_von: 'Ines Kaltenbach',
    gebunden_am: '2027-03-02T08:00:00Z', quelle: 'Open-Meteo-Archiv', letzter_abruf: ABRUF,
    stand: { monat: '2027-03', tage: 27, tage_erwartet: 31, zustand: 'unvollständig' },
  },
};
const LINDACH = UEMS_KOORDINATEN_FEHLEN_SATZ('Lindach');

const oeffnen = () => {
  const details = screen.getByTestId('bezugsgroesse-wetter') as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event('toggle'));
};

beforeEach(() => { erlaubt = true; });
afterEach(() => { cleanup(); vi.clearAllMocks(); darfAufrufe.length = 0; });

describe('AP-17 IP-12c · die Sätze', () => {
  it('Zustand: „bezogen aus …, zuletzt am …, März 2027: 27 von 31 Tagen“ in der Ortszone', () => {
    expect(abrufText(ABRUF)).toBe('03.04.2027 06:10');
    expect(standText(GEBUNDEN.bindung!.stand!)).toBe('März 2027: 27 von 31 Tagen');
    expect(zustandSatz(GEBUNDEN.bindung!)).toBe('bezogen aus Open-Meteo-Archiv, zuletzt am 03.04.2027 06:10, März 2027: 27 von 31 Tagen');
  });

  it('Standort-Zeile: ohne Koordinaten „Koordinaten fehlen“ mit dem Satz aus §5.8', () => {
    expect(standortWetterZeile({ koordinaten: false, satz: LINDACH, gradtagzahlen: [] })).toEqual({ wert: UEMS_KOORDINATEN_FEHLEN, satz: LINDACH });
    expect(standortWetterZeile({ koordinaten: true, quelle: 'Open-Meteo-Archiv', letzter_abruf: ABRUF,
      gradtagzahlen: [{ id: 'bz-8', kennzeichen: 'BZ-8', name: 'Gradtagzahl', quelle: 'Open-Meteo-Archiv', letzter_abruf: ABRUF }] }).wert)
      .toBe('bezogen aus Open-Meteo-Archiv, zuletzt am 03.04.2027 06:10 · BZ-8');
  });
});

describe('AP-17 IP-12c · Abschnitt „Wetter“ an der Gradtagzahl', () => {
  it('gebunden: Regel, Zustand, Kennzeichen-Satz — und Lösen nach Bestätigung', async () => {
    wetterbezug.mockResolvedValue(GEBUNDEN);
    wetterLoesen.mockResolvedValue(undefined);
    render(<BezugsWetter bezug={BZ} standort="st-1" zone="Europe/Berlin" />);
    oeffnen();
    expect(await screen.findByText('Gradtage G20/15 ab 01.03.2027')).toBeTruthy();
    expect(screen.getByTestId('wetter-zustand').textContent).toBe('bezogen aus Open-Meteo-Archiv, zuletzt am 03.04.2027 06:10, März 2027: 27 von 31 Tagen');
    expect(screen.getByText(UEMS_TEMPERATUR_BEZOGEN)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Wetter beziehen' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Bezug lösen' }));
    expect(await screen.findByText('Die schon bezogenen Werte bleiben mit ihrem Kennzeichen erhalten.')).toBeTruthy();
    const knoepfe = screen.getAllByRole('button', { name: 'Bezug lösen' });
    fireEvent.click(knoepfe[knoepfe.length - 1]);
    await waitFor(() => expect(wetterLoesen).toHaveBeenCalledWith('bz-8'));
  });

  it('ohne Koordinaten: kein Knopf, der Satz aus §5.8', async () => {
    wetterbezug.mockResolvedValue({ moeglich: true, koordinaten: false, satz: LINDACH, bindung: null });
    render(<BezugsWetter bezug={BZ} standort="st-2" zone="Europe/Berlin" />);
    oeffnen();
    expect((await screen.findByTestId('wetter-koordinaten-fehlen')).textContent).toBe(LINDACH);
    expect(screen.queryByRole('button', { name: 'Wetter beziehen' })).toBeNull();
  });

  it('mit Koordinaten: „Wetter beziehen“ bindet ab dem Monatsersten mit G20/15', async () => {
    wetterbezug.mockResolvedValue({ moeglich: true, koordinaten: true, bindung: null });
    wetterBinden.mockResolvedValue(GEBUNDEN);
    render(<BezugsWetter bezug={BZ} standort="st-1" zone="Europe/Berlin" />);
    oeffnen();
    fireEvent.click(await screen.findByRole('button', { name: 'Wetter beziehen' }));
    const absenden = screen.getAllByRole('button', { name: 'Wetter beziehen' });
    fireEvent.click(absenden[absenden.length - 1]);
    await waitFor(() => expect(wetterBinden).toHaveBeenCalledTimes(1));
    const [id, body] = wetterBinden.mock.calls[0] as [string, { von: string; raumtemperatur: number; heizgrenze: number }];
    expect(id).toBe('bz-8');
    expect(body.von).toMatch(/^\d{4}-\d{2}-01$/);
    expect(body).toMatchObject({ raumtemperatur: 20, heizgrenze: 15 });
  });

  it('das Recht kommt vom Standort der Karte: bezugsgroesse.verwalten am übergebenen Standort (wie der Messkanal)', async () => {
    wetterbezug.mockResolvedValue({ moeglich: true, koordinaten: true, bindung: null });
    render(<BezugsWetter bezug={BZ} standort="st-1" zone="Europe/Berlin" />);
    oeffnen();
    expect(await screen.findByRole('button', { name: 'Wetter beziehen' })).toBeTruthy();
    expect(darfAufrufe.length).toBeGreaterThan(0);
    expect(darfAufrufe.every(([a, s]) => a === 'bezugsgroesse.verwalten' && s === 'st-1')).toBe(true);
  });

  it('ohne auflösbaren Standort (undefined): kein Knopf, auch nicht mit Recht', async () => {
    wetterbezug.mockResolvedValue({ moeglich: true, koordinaten: true, bindung: null });
    render(<BezugsWetter bezug={BZ} standort={undefined} zone="Europe/Berlin" />);
    oeffnen();
    expect(await screen.findByText('Es wird kein Wetter bezogen.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Wetter beziehen' })).toBeNull();
  });

  it('ohne Recht: Zustand ja, kein Knopf', async () => {
    erlaubt = false;
    wetterbezug.mockResolvedValue({ moeglich: true, koordinaten: true, bindung: null });
    render(<BezugsWetter bezug={BZ} standort="st-1" zone="Europe/Berlin" />);
    oeffnen();
    expect(await screen.findByText('Es wird kein Wetter bezogen.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Wetter beziehen' })).toBeNull();
  });
});

describe('AP-17 IP-12c · Zeile „Wetter“ am Standort', () => {
  const ST = { id: 'st-2', name: 'Lindach' } as StandortAmStichtag;
  it('ohne Koordinaten: „Koordinaten fehlen“ und der Satz', async () => {
    standortWetter.mockResolvedValue({ koordinaten: false, satz: LINDACH, gradtagzahlen: [] } satisfies StandortWetter);
    render(<StandortWetterZeile standort={ST} />);
    const zeile = await screen.findByTestId('standort-wetter');
    expect(zeile.textContent).toContain(UEMS_KOORDINATEN_FEHLEN);
    expect(zeile.textContent).toContain(LINDACH);
  });

  it('ohne Antwort oder mit einer unlesbaren: keine Zeile', async () => {
    standortWetter.mockRejectedValue(new Error('404'));
    const { container } = render(<StandortWetterZeile standort={ST} />);
    await waitFor(() => expect(standortWetter).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
    cleanup();
    standortWetter.mockResolvedValue({});
    const zweiter = render(<StandortWetterZeile standort={ST} />);
    await waitFor(() => expect(standortWetter).toHaveBeenCalledTimes(2));
    expect(zweiter.container.innerHTML).toBe('');
  });
});
