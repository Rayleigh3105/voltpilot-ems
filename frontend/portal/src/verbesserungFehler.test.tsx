import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { benutzerApi } from './benutzer';
import { MassnahmeAendernDialog, MassnahmeAnlegenDialog, MassnahmeUmgesetztDialog } from './components/MassnahmeDialoge';
import * as Z from './energieziele';
import * as P from './massnahmePlanen';
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
    // An der Wirkung nennt die Infozeile der Grafik denselben Grund der Route (Verbessern v1 PR 2).
    const laufend = wirkungR5(m1Umgesetzt()).monate.filter((x) => !x.endgueltig);
    expect(laufend.length).toBeGreaterThan(0);
    for (const x of laufend) expect(Z.offenGrund(x.vergleich)).not.toBe('');
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
    fireEvent.change(screen.getByTestId('massnahme-umgesetzt-text'), { target: { value: 'Leckagen geortet und beseitigt.' } });
    await act(async () => fireEvent.click(screen.getByTestId('massnahme-umgesetzt-senden')));
    expect(melden).toHaveBeenCalledWith(expect.any(String), { am: '2029-04-30', begruendung: 'Leckagen geortet und beseitigt.' });
  });
});

describe('Ausgangslage höchstens zwölf Monate', () => {
  it('„Maßnahme planen“ bietet als Vorher nur die zwölf abgeschlossenen Monate vor dem Tag der Route', () => {
    expect(P.vorherMonate('2029-04-30')).toHaveLength(12);
    expect(P.vorherMonate('2029-04-30')[0]).toEqual({ value: '2029-03', label: 'März 2029' });
    expect(P.vorherMonate('2029-04-30')[11]).toEqual({ value: '2028-04', label: 'April 2028' });
  });
  it('mehr als zwölf Monate meldet das Formular, bevor die Route ablehnt', () => {
    const e = {
      ...P.entwurfAus({ herkunft: 'von_hand', kennzahl: 'kz' }, '2029-04-30'),
      titel: 'T', prozent: '3', wortlaut: 'W', verantwortlich: 'MD', termin: '2029-06-30', von: '2028-01', bis: '2029-01',
    };
    expect(P.pruefen(e, 2, '2029-04-30').monate).toBe('Vorher sind abgeschlossene Monate, höchstens 12.');
    expect(P.pruefen({ ...e, von: '2028-04', bis: '2029-03' }, 2, '2029-04-30').monate).toBeUndefined();
  });
  it('der Dialog bietet als letzten Monat höchstens zwölf Monate an', async () => {
    Object.assign(api, bezugsbasisBuehne('modell'), energiezielBuehne('juli'), massnahmeBuehne('r5', '2028-11-15', 'Ines Kaltenbach'));
    Object.assign(benutzerApi, { liste: async () => kontenAhrenberg() });
    render(<MassnahmeAnlegenDialog vorbelegung={{ herkunft: 'energieziel', kennzahl: m1().messgrundlage!.kennzahl.id, energieziel: 'ez', monate: '2027-12' }} onClose={() => {}} onAngelegt={() => {}} tagHeute="2029-04-30" />);
    await act(async () => {});
    fireEvent.click(await screen.findByTestId('planen-anderer-monat'));
    fireEvent.click(screen.getByLabelText(/Vorher: letzter Monat/));
    const optionen = screen.getAllByRole('option').map((o) => o.textContent);
    expect(optionen[0]).toBe('März 2029');
    expect(optionen[optionen.length - 1]).toBe('April 2028');
    expect(optionen).toHaveLength(12);
  });
});

describe('Ändern behält die Richtung der erwarteten Wirkung', () => {
  it('„3 % mehr“ steht als Betrag mit dem Wort „mehr“, „2,5 % weniger“ mit „weniger“ - kein Vorzeichen geht verloren', () => {
    Object.assign(benutzerApi, { liste: async () => kontenAhrenberg() });
    for (const [gespeichert, betrag, wort] of [['3.0', '3', 'mehr'], ['-2.5', '2,5', 'weniger']] as const) {
      render(<MassnahmeAendernDialog massnahme={m1('2029-04-30', { erwartete_wirkung_prozent: gespeichert })} onClose={() => {}} onFertig={() => {}} />);
      expect((screen.getByTestId('massnahme-aendern-zahl') as HTMLInputElement).value).toBe(betrag);
      expect(screen.getByText(wort).getAttribute('aria-pressed')).toBe('true');
      cleanup();
    }
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
