import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { UEMS_NORMGRENZE } from './glossar';
import { KennzahlenPage } from './pages/KennzahlenPage';
import { setSelbstauskunft } from './rollen';
import { BB_IDS, bezugsbasisBuehne } from './test/bezugsbasisFixtures';
import { rechteSeed } from './test/rollenFixtures';

/**
 * Nachprüfung PR 1173: jeder Locator von `e2e/bezugsbasis.spec.ts` trifft auf der Bühne GENAU ein Element (bzw. die
 * zugesicherte Zahl). Hier läuft kein Browser — darum wird dieselbe Fläche (`KennzahlenPage` mit `bezugsbasisBuehne`,
 * denselben Routen wie `e2e/bezugsbasis.tsx`) in vitest gerendert und je Locator mit denselben Rollen und Namen gezählt.
 *
 * Namen wie Playwright: ohne `exact` Teilstring ohne Groß/Klein (`teil`), mit `exact: true` der ganze Name (Zeichenkette).
 */
const teil = (t: string) => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
const eins = (treffer: unknown[], wo: string) => expect(treffer, wo).toHaveLength(1);
const LEER =
  'Noch keine Bezugsbasis. Legen Sie fest, gegen welchen Zeitraum diese Kennzahl verglichen werden soll — der Vergleich entsteht aus den gespeicherten Werten.';
const MODELL_NICHT = 'Modell nicht möglich: 1 von 12 Monaten in der Referenzperiode. Das Verhältnis ist vorläufig.';

const vorher = { ...api };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-12T09:00:00+01:00'));
});
afterEach(() => {
  Object.assign(api, vorher);
  vi.useRealTimers();
  setSelbstauskunft(null);
});

const buehne = (lage: 'keine' | 'freigegeben', person: string, register = false) => {
  setSelbstauskunft(rechteSeed(person).me);
  Object.assign(api, bezugsbasisBuehne(lage));
  render(<KennzahlenPage kennzahlId={register ? null : BB_IDS.kz4} onOeffnen={() => undefined} onListe={() => undefined} zone="Europe/Berlin" />);
};

async function waehleMonat(feld: string, monat: string) {
  const ausloeser = screen.getAllByRole('combobox', { name: feld });
  eins(ausloeser, `combobox ${feld} (exact)`);
  fireEvent.click(ausloeser[0]);
  const listen = await screen.findAllByRole('listbox', { name: feld });
  eins(listen, `listbox ${feld} (exact)`);
  const optionen = within(listen[0]).getAllByRole('option', { name: monat });
  eins(optionen, `option ${monat} (exact) in ${feld}`);
  fireEvent.click(optionen[0]);
}

describe('e2e/bezugsbasis.spec.ts — jeder Locator trifft genau ein Element', () => {
  it('leerer Zustand (IK mit Knopf, CB ohne)', async () => {
    buehne('keine', 'IK');
    await screen.findByRole('tablist', { name: 'Reiter der Kennzahl KZ-0004' });
    // Warum `exact`: der Teilstring „Bezugsbasis“ träfe auch „Vergleich mit Bezugsbasis“.
    expect(screen.getAllByRole('tab', { name: teil('Bezugsbasis') })).toHaveLength(2);
    const tab = screen.getAllByRole('tab', { name: 'Bezugsbasis' });
    eins(tab, 'tab Bezugsbasis (exact)');
    fireEvent.click(tab[0]);
    await screen.findByTestId('bezugsbasis-leer');
    eins(screen.getAllByText(teil(LEER)), 'getByText(LEER)');
    eins(screen.getAllByRole('button', { name: 'Bezugsbasis anlegen' }), 'button Bezugsbasis anlegen (exact)');
    eins(within(screen.getByTestId('bezugsbasis-reiter')).getAllByText(teil(UEMS_NORMGRENZE)), 'reiter getByText(GRENZE)');
  });

  it('leerer Zustand für die Leserin: Satz ja, Knopf 0', async () => {
    buehne('keine', 'CB');
    fireEvent.click(await screen.findByRole('tab', { name: 'Bezugsbasis' }));
    await screen.findByTestId('bezugsbasis-leer');
    eins(screen.getAllByText(teil(LEER)), 'getByText(LEER)');
    expect(screen.queryAllByRole('button', { name: 'Bezugsbasis anlegen' })).toHaveLength(0);
  });

  it('R1: Anlegen vorläufig bis zur Basis-Zeile', async () => {
    buehne('keine', 'IK');
    fireEvent.click(await screen.findByRole('tab', { name: 'Bezugsbasis' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Bezugsbasis anlegen' }));
    eins(await screen.findAllByTestId('bezugsbasis-assistent'), 'bezugsbasis-assistent');
    const dialog = screen.getByTestId('bezugsbasis-assistent');

    await waehleMonat('Erster Monat', 'Oktober 2026');
    await waehleMonat('Letzter Monat', 'Oktober 2026');
    eins(screen.getAllByTestId('bezugsbasis-monate-knopf'), 'monate-knopf');
    await act(async () => fireEvent.click(screen.getByTestId('bezugsbasis-monate-knopf')));
    eins(screen.getAllByTestId('bezugsbasis-vorlaeufig'), 'vorlaeufig');
    expect(screen.getByTestId('bezugsbasis-vorlaeufig').textContent).toBe('vorläufig (1 von 12 Monaten)');
    eins(screen.getAllByTestId('bezugsbasis-monate'), 'monate');
    expect(screen.getByTestId('bezugsbasis-monate').textContent).toContain('Oktober 2026');

    eins(screen.getAllByTestId('bezugsbasis-weiter'), 'weiter');
    fireEvent.click(screen.getByTestId('bezugsbasis-weiter'));
    expect(within(dialog).getAllByText(teil(MODELL_NICHT))).toHaveLength(3);
    // Warum nicht `radio /Verhältnis/`: der Datenbedarf der Modelle nennt das Wort auch — vier Treffer.
    expect(within(dialog).getAllByRole('radio', { name: /Verhältnis/ }).length).toBeGreaterThan(1);
    const radio = dialog.querySelectorAll<HTMLInputElement>('input[type="radio"][value="verhaeltnis"]');
    eins([...radio], 'radio[value=verhaeltnis]');
    expect(radio[0].checked).toBe(true);

    fireEvent.click(screen.getByTestId('bezugsbasis-weiter'));
    eins(await screen.findAllByTestId('bezugsbasis-kandidaten'), 'kandidaten');
    await waitFor(() => expect(screen.getByTestId('bezugsbasis-kandidaten').textContent).toContain('r = 0,997'));
    fireEvent.click(screen.getByTestId('bezugsbasis-weiter'));
    eins(await screen.findAllByTestId('bezugsbasis-faktoren'), 'faktoren');
    fireEvent.click(screen.getByTestId('bezugsbasis-weiter'));
    eins(screen.getAllByTestId('bezugsbasis-basiswert'), 'basiswert');
    expect(screen.getByTestId('bezugsbasis-basiswert').textContent).toBe('0,2837 kWh je kg');
    eins(screen.getAllByTestId('bezugsbasis-entwurf-knopf'), 'entwurf-knopf');
    await act(async () => fireEvent.click(screen.getByTestId('bezugsbasis-entwurf-knopf')));
    const begruendung = within(dialog).getAllByLabelText('Begründung');
    eins(begruendung, 'dialog getByLabel(Begründung, exact)');
    fireEvent.change(begruendung[0], { target: { value: 'Oktober 2026 ist der erste volle Monat mit erfasster Produktionsmenge.' } });
    eins(within(dialog).getAllByTestId('bezugsbasis-freigeben-knopf'), 'dialog freigeben-knopf');
    await act(async () => fireEvent.click(within(dialog).getByTestId('bezugsbasis-freigeben-knopf')));
    eins(screen.getAllByTestId('bezugsbasis-nach-antrag'), 'nach-antrag');
    expect(screen.getByTestId('bezugsbasis-nach-antrag').textContent).toBe('Fassung 1 ist freigegeben und gilt ab 01.11.2026.');
    eins(within(dialog).getAllByText(teil(UEMS_NORMGRENZE)), 'dialog getByText(GRENZE)');

    eins(screen.getAllByTestId('bezugsbasis-fertig'), 'fertig');
    await act(async () => fireEvent.click(screen.getByTestId('bezugsbasis-fertig')));
    const zeile = await screen.findAllByTestId('bezugsbasis-zeile');
    eins(zeile, 'bezugsbasis-zeile');
    expect(zeile[0].textContent).toBe(
      'Bezugsbasis BB-0001 · Oktober 2026 · Verhältnis 0,2837 kWh je kg · vorläufig (1 von 12 Monaten) · freigegeben von Ines Kaltenbach am 12.11.2026.',
    );
  });

  it('Register: Kennzeichen und Filter', async () => {
    buehne('freigegeben', 'IK', true);
    const zeichen = await screen.findAllByTestId('kennzahl-energieleistung');
    eins(zeichen, 'kennzahl-energieleistung');
    expect(zeichen[0].textContent).toBe('Energieleistungskennzahl — Bezugsbasis BB-0001 · vorläufig.');
    const filter = screen.getAllByLabelText('nur Energieleistungskennzahlen');
    eins(filter, 'getByLabel(nur Energieleistungskennzahlen, exact)');
    fireEvent.click(filter[0]);
    expect(screen.getAllByTestId('kennzahl-karte')).toHaveLength(1);
  });
});
