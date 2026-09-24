import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { KennzahlenPage } from './pages/KennzahlenPage';
import { setSelbstauskunft } from './rollen';
import { fassungenBuehne } from './test/bezugsbasisFassungenFixtures';
import { BB_IDS } from './test/bezugsbasisFixtures';
import { rechteSeed } from './test/rollenFixtures';

/**
 * Jeder Locator von `e2e/bezugsbasis-fassungen.spec.ts` trifft auf der Bühne GENAU ein Element (Lehre PR 1173): dieselbe
 * Fläche (`KennzahlenPage` mit `fassungenBuehne`, dieselben Routen wie `e2e/bezugsbasis.tsx` `lage=anstoss|frist`) in
 * vitest gerendert und je Locator mit denselben Rollen und Namen gezählt. `exact: true` = ganzer Name.
 */
const eins = (treffer: unknown[], wo: string) => expect(treffer, wo).toHaveLength(1);
const ANSTOSS = 'Bezugsbasis BB-0001: die Fläche der Halle 2 hat sich geändert (3 100 → 3 400 m² ab 01.01.2027) — Fassung 1 prüfen.';
const FRIST = 'Bezugsbasis BB-0001, Fassung 1 vom 12.11.2026 · Überprüfung fällig seit 1 Tag — bestätigen oder neu fassen.';
const LEER =
  'Noch keine Bezugsbasis. Legen Sie fest, gegen welchen Zeitraum diese Kennzahl verglichen werden soll — der Vergleich entsteht aus den gespeicherten Werten.';

const vorher = { ...api };
afterEach(() => {
  Object.assign(api, vorher);
  vi.useRealTimers();
  setSelbstauskunft(null);
});

async function buehne(lage: 'anstoss' | 'frist', person: string, uhr = '2027-01-06T09:00:00+01:00') {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(uhr));
  setSelbstauskunft(rechteSeed(person).me);
  Object.assign(api, fassungenBuehne(lage));
  render(<KennzahlenPage kennzahlId={BB_IDS.kz4} onOeffnen={() => undefined} onListe={() => undefined} zone="Europe/Berlin" />);
  const tab = await screen.findAllByRole('tab', { name: 'Bezugsbasis' });
  eins(tab, 'tab Bezugsbasis (exact)');
  fireEvent.click(tab[0]);
  await screen.findByTestId('bezugsbasis-fassung-1');
}
const testid = (id: string) => {
  const t = screen.queryAllByTestId(id);
  eins(t, `getByTestId(${id})`);
  return t[0];
};
async function waehle(feld: string, wert: string) {
  const a = screen.getAllByRole('combobox', { name: feld });
  eins(a, `combobox ${feld}`);
  fireEvent.click(a[0]);
  const l = await screen.findAllByRole('listbox', { name: feld });
  eins(l, `listbox ${feld}`);
  const o = within(l[0]).getAllByRole('option', { name: wert });
  eins(o, `option ${wert}`);
  fireEvent.click(o[0]);
}

describe('e2e/bezugsbasis-fassungen.spec.ts — jeder Locator trifft genau ein Element', () => {
  it('R5: Anstoß → Fassung 2; Fassung 1 bleibt sichtbar', async () => {
    await buehne('anstoss', 'IK');
    const kasten = await waitFor(() => testid('bezugsbasis-anstoss'));
    eins(within(kasten).getAllByText(ANSTOSS), 'kasten getByText(ANSTOSS)');
    await waitFor(() => expect(testid('bezugsbasis-fassung-1').textContent).toContain('Statischer Faktor: Fläche G-2 3 100 m² (Stand 12.11.2026)'));
    const neu = within(kasten).getAllByRole('button', { name: 'Neue Fassung bilden' });
    eins(neu, 'kasten button Neue Fassung bilden');
    fireEvent.click(neu[0]);
    const anpassung = await screen.findByTestId('bezugsbasis-neue-fassung');
    const grund = within(anpassung).getAllByRole('checkbox', { name: 'Struktur geändert' });
    eins(grund, 'checkbox Struktur geändert');
    fireEvent.click(grund[0]);
    const begr = within(anpassung).getAllByLabelText('Begründung');
    eins(begr, 'anpassung Begründung');
    fireEvent.change(begr[0], { target: { value: 'Anbau Halle 2: die Fläche wächst von 3 100 auf 3 400 m².' } });
    fireEvent.click(testid('bezugsbasis-anpassung-weiter'));

    const assistent = await screen.findByTestId('bezugsbasis-assistent');
    eins(screen.getAllByRole('dialog', { name: 'Neue Fassung bilden' }), 'dialog Neue Fassung bilden');
    await act(async () => fireEvent.click(testid('bezugsbasis-monate-knopf')));
    expect(testid('bezugsbasis-vorlaeufig').textContent).toBe('vorläufig (1 von 12 Monaten)');
    for (let i = 0; i < 4; i++) await act(async () => fireEvent.click(testid('bezugsbasis-weiter')));
    await act(async () => fireEvent.click(testid('bezugsbasis-entwurf-knopf')));
    const altNeu = await waitFor(() => testid('bezugsbasis-alt-neu'));
    expect(altNeu.textContent).toContain('Fassung 1');
    expect(altNeu.textContent).toContain('Fassung 2');
    const fb = within(assistent).getAllByLabelText('Begründung');
    eins(fb, 'assistent Begründung');
    fireEvent.change(fb[0], { target: { value: 'Die neue Fläche gilt ab Januar 2027.' } });
    eins(within(assistent).getAllByTestId('bezugsbasis-freigeben-knopf'), 'assistent freigeben-knopf');
    await act(async () => fireEvent.click(within(assistent).getByTestId('bezugsbasis-freigeben-knopf')));
    await waitFor(() => testid('bezugsbasis-nach-antrag'));
    await act(async () => fireEvent.click(testid('bezugsbasis-fertig')));

    await waitFor(() => expect(testid('bezugsbasis-fassung-2').textContent).toContain('Anpassungsgründe: Struktur geändert'));
    await waitFor(() => expect(testid('bezugsbasis-fassung-1').textContent).toContain('gilt vom 01.11.2026 bis 31.12.2026'));
    expect(screen.queryAllByTestId('bezugsbasis-anstoss')).toHaveLength(0);
  });

  it('die Leserin: Kasten ohne Knöpfe', async () => {
    await buehne('anstoss', 'CB');
    const kasten = await waitFor(() => testid('bezugsbasis-anstoss'));
    eins(within(kasten).getAllByText(ANSTOSS), 'kasten getByText(ANSTOSS)');
    expect(within(kasten).queryAllByRole('button')).toHaveLength(0);
  });

  it('Beenden', async () => {
    await buehne('anstoss', 'IK');
    const kasten = await waitFor(() => testid('bezugsbasis-anstoss'));
    const b = within(kasten).getAllByRole('button', { name: 'Beenden' });
    eins(b, 'kasten button Beenden');
    fireEvent.click(b[0]);
    const dialog = await screen.findByTestId('bezugsbasis-beenden');
    await waehle('Grund', 'Struktur geändert');
    const begr = within(dialog).getAllByLabelText('Begründung');
    eins(begr, 'beenden Begründung');
    fireEvent.change(begr[0], { target: { value: 'Anbau Halle 2 — die Kennzahl wird neu gefasst.' } });
    await act(async () => fireEvent.click(testid('bezugsbasis-beenden-senden')));
    expect(testid('bezugsbasis-beendet').textContent).toBe('Vergleiche danach: Nicht bewertbar: Bezugsbasis beendet am 06.01.2027 (Struktur geändert).');
    const fertig = screen.getAllByRole('button', { name: 'Fertig' });
    eins(fertig, 'button Fertig (exact)');
    await act(async () => fireEvent.click(fertig[0]));
    await waitFor(() => eins(screen.getAllByText(LEER), 'getByText(LEER)'));
  });

  it('R13: Frist → geprüft, bleibt', async () => {
    await buehne('frist', 'IK', '2027-11-13T09:00:00+01:00');
    await waitFor(() => expect(testid('bezugsbasis-frist').textContent).toBe(FRIST));
    const b = screen.getAllByRole('button', { name: 'Geprüft, bleibt' });
    eins(b, 'button Geprüft, bleibt (exact)');
    fireEvent.click(b[0]);
    const dialog = await screen.findByTestId('bezugsbasis-bleibt');
    const begr = within(dialog).getAllByLabelText('Begründung');
    eins(begr, 'bleibt Begründung');
    fireEvent.change(begr[0], { target: { value: 'Keine Änderung an Halle und Produktion.' } });
    await act(async () => fireEvent.click(testid('bezugsbasis-bleibt-senden')));
    expect(testid('bezugsbasis-geprueft').textContent).toBe('Geprüft: Fassung 1 bleibt · nächste Überprüfung am 13.11.2028.');
    const fertig = screen.getAllByRole('button', { name: 'Fertig' });
    eins(fertig, 'button Fertig (exact)');
    await act(async () => fireEvent.click(fertig[0]));
    await waitFor(() => expect(screen.queryAllByTestId('bezugsbasis-frist')).toHaveLength(0));
  });
});
