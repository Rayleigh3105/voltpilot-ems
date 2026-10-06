import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { benutzerApi } from './benutzer';
import { MassnahmeAnlegenDialog, MassnahmeUmgesetztDialog } from './components/MassnahmeDialoge';
import * as Z from './energieziele';
import * as M from './massnahmen';
import * as W from './massnahmeWirkung';
import { MassnahmeSeite } from './pages/MassnahmeSeite';
import { setSelbstauskunft } from './rollen';
import { merkeAbruf, routenHeute, useRoutenHeute, vergissAbruf } from './routenUhr';
import { bezugsbasisBuehne } from './test/bezugsbasisFixtures';
import { energiezielBuehne, standJuli } from './test/energiezielFixtures';
import { kontenAhrenberg, m1, m1Umgesetzt, massnahmeBuehne, wirkungR5 } from './test/massnahmeFixtures';
import { rechteSeed } from './test/rollenFixtures';

/**
 * Konzept Verbessern v1, PR 0 (Fehler): Monatsgrund statt „noch nicht endgültig“ (Befund 1), eine Uhr in den Dialogen
 * (Befund 2), die Ausgangslage höchstens zwölf Monate, kein verlorenes Vorzeichen beim Ändern und „Alle Stände“ mit
 * „Erneut versuchen“.
 */
beforeEach(() => {
  vergissAbruf();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const monat = (grund: string | null, satz: string) => ({ satz, bereinigt: { grund } });

describe('Befund 1: ein offener Monat nennt den Grund der Route', () => {
  it('läuft noch · kein gemessener Wert · sonst der Satz der Route; nur ohne Grund „noch nicht endgültig“', () => {
    expect(Z.offenGrund(monat('periode_nicht_zu_ende', 'April 2029: nicht bewertbar — der Monat ist noch nicht zu Ende.'))).toBe('läuft noch');
    expect(Z.offenGrund(monat('keine_werte', 'März 2029: nicht bewertbar — kein gemessener Wert.'))).toBe('kein gemessener Wert');
    expect(Z.offenGrund(monat('basis_fehlt', 'März 2029: nicht bewertbar — keine Bezugsbasis für diesen Monat.'))).toBe(
      'keine Bezugsbasis für diesen Monat',
    );
    expect(Z.offenGrund(monat(null, 'März 2029: 2,2 % mehr als erwartet.'))).toBe(Z.NOCH_NICHT_ENDGUELTIG);
  });
  it('die Zeilen am Energieziel und an der Wirkung tragen den Grund', () => {
    const zeilen = Z.monatZeilen(standJuli());
    const offen = zeilen.filter((z) => z.art === 'offen');
    expect(offen).toHaveLength(6);
    expect(offen.every((z) => z.art === 'offen' && z.grund === 'läuft noch')).toBe(true);
    const wirkung = W.wirkungZeilen(wirkungR5(m1Umgesetzt()));
    const w = wirkung.find((z) => z.art === 'offen');
    expect(w && w.art === 'offen' && w.grund).toBeTruthy();
    expect(w && w.art === 'offen' && w.grund).not.toBe('');
  });
});

describe('Befund 2: eine Uhr — „heute“ ist der Tag der Route', () => {
  it('der gemerkte Tag der Route gilt; ohne ihn der Kalendertag in Berlin', () => {
    expect(routenHeute()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    merkeAbruf('2029-04-30');
    expect(routenHeute()).toBe('2029-04-30');
    merkeAbruf('kein Tag');
    merkeAbruf(null);
    expect(routenHeute()).toBe('2029-04-30');
  });
  it('ohne gemerkten Tag holt ein Einstieg ihn einmal über die Übersicht', async () => {
    const uebersicht = vi.spyOn(api, 'verbesserungUebersicht').mockResolvedValue({ abruf: '2029-04-30' } as Awaited<ReturnType<typeof api.verbesserungUebersicht>>);
    function Zeige() {
      return <p data-testid="tag">{useRoutenHeute() ?? 'lädt'}</p>;
    }
    render(<Zeige />);
    await waitFor(() => expect(screen.getByTestId('tag').textContent).toBe('2029-04-30'));
    expect(uebersicht).toHaveBeenCalledTimes(1);
  });
  it('„umgesetzt melden“ schlägt den Tag der Route vor, nicht den des Browsers', async () => {
    merkeAbruf('2029-04-30');
    const melden = vi.spyOn(api, 'massnahmeUmgesetzt').mockResolvedValue(m1Umgesetzt());
    render(<MassnahmeUmgesetztDialog massnahme={m1('2029-04-30', { angelegt_am: '2029-01-26' })} onClose={() => {}} onFertig={() => {}} />);
    fireEvent.change(screen.getByLabelText('Begründung'), { target: { value: 'Leckagen geortet und beseitigt.' } });
    await act(async () => fireEvent.click(screen.getByTestId('massnahme-umgesetzt-senden')));
    expect(melden).toHaveBeenCalledWith(expect.any(String), { am: '2029-04-30', begruendung: 'Leckagen geortet und beseitigt.' });
  });
});

describe('Ausgangslage höchstens zwölf Monate', () => {
  it('Monate zählen, Ende begrenzen, den letzten Monat nachziehen', () => {
    expect(M.monateZwischen('2028-01', '2028-12')).toBe(12);
    expect(M.monateZwischen('2027-12', '2027-12')).toBe(1);
    expect(M.ausgangslageEnde('2028-01', '2029-03')).toBe('2028-12');
    expect(M.ausgangslageEnde('2028-09', '2029-03')).toBe('2029-03');
    expect(M.bisZu('2028-01', '2029-03', '2029-03')).toBe('2028-12');
    expect(M.bisZu('2028-06', '2028-01', '2029-03')).toBe('2028-06');
    expect(M.bisZu('2028-06', '2028-09', '2029-03')).toBe('2028-09');
  });
  it('mehr als zwölf Monate meldet das Formular, bevor die Route ablehnt', () => {
    const e = { ...M.entwurfAus({ herkunft: 'von_hand', kennzahl: 'kz' }, '2029-04-30'), von: '2028-01', bis: '2029-01' };
    expect(M.pruefen(e).monate).toBe('Die Ausgangslage umfasst höchstens 12 Monate. Wählen Sie einen späteren ersten Monat.');
    expect(M.pruefen({ ...e, bis: '2028-12' }).monate).toBeUndefined();
  });
  it('der Dialog bietet als letzten Monat höchstens zwölf Monate ab dem ersten an', async () => {
    Object.assign(api, bezugsbasisBuehne('modell'), energiezielBuehne('juli'), massnahmeBuehne('r5', '2028-11-15', 'Ines Kaltenbach'));
    Object.assign(benutzerApi, { liste: async () => kontenAhrenberg() });
    render(<MassnahmeAnlegenDialog vorbelegung={{ herkunft: 'energieziel', kennzahl: m1().messgrundlage!.kennzahl.id, energieziel: 'ez', monate: '2027-12' }} onClose={() => {}} onAngelegt={() => {}} tagHeute="2029-04-30" />);
    await act(async () => {});
    fireEvent.click(screen.getByLabelText(/letzter Monat/));
    const optionen = screen.getAllByRole('option').map((o) => o.textContent);
    expect(optionen[0]).toBe('November 2028');
    expect(optionen[optionen.length - 1]).toBe('Dezember 2027');
    expect(optionen).toHaveLength(12);
  });
});

describe('Ändern behält das Vorzeichen der erwarteten Wirkung', () => {
  it('die genaue Umkehrung der Eingaberegel', () => {
    for (const gespeichert of ['-3.0', '3.0', '-2.5', '2.5', '-12.0']) {
      const feld = M.wirkungEingabe(gespeichert);
      expect(M.wirkungAusEingabe(feld), gespeichert).toBe(Number(gespeichert));
    }
    expect(M.wirkungEingabe('-3.0')).toBe('3');
    expect(M.wirkungEingabe('3.0')).toBe('-3');
    expect(M.wirkungEingabe('-2.5')).toBe('2,5');
    expect(M.wirkungEingabe('-2.50')).toBe('2,5');
    expect(M.wirkungEingabe('0.0')).toBe('0');
    expect(M.wirkungEingabe(null)).toBe('');
  });
});

describe('„Alle Stände der Bewertung“ lässt sich nach einem Fehler neu laden', () => {
  it('Satz mit „Erneut versuchen“, danach die Stände', async () => {
    setSelbstauskunft(rechteSeed('IK').me);
    Object.assign(benutzerApi, { liste: async () => kontenAhrenberg() });
    Object.assign(api, bezugsbasisBuehne('modell'), energiezielBuehne('juli'), massnahmeBuehne('r6', '2028-11-15', 'Ines Kaltenbach'));
    const echt = api.massnahmeBewertungen;
    const lesen = vi.spyOn(api, 'massnahmeBewertungen').mockRejectedValueOnce(new Error('offline')).mockImplementation(echt);
    render(<MassnahmeSeite id={m1Umgesetzt().id} onListe={() => {}} />);
    const staende = await screen.findByTestId('massnahme-staende');
    (staende as HTMLDetailsElement).open = true;
    fireEvent(staende, new Event('toggle'));
    expect(await screen.findByText(W.STAENDE_LADEFEHLER)).toBeTruthy();
    fireEvent.click(screen.getByTestId('massnahme-staende-erneut'));
    await waitFor(() => expect(lesen).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(W.STAENDE_LADEFEHLER)).toBeNull());
  });
});
