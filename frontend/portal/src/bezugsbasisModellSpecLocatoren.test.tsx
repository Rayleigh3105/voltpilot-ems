import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { UEMS_NORMGRENZE } from './glossar';
import { KennzahlenPage } from './pages/KennzahlenPage';
import { setSelbstauskunft } from './rollen';
import { BB_IDS, bezugsbasisBuehne } from './test/bezugsbasisFixtures';
import { rechteSeed } from './test/rollenFixtures';

/**
 * UEMS AP-17 IP-14: jeder Locator von `e2e/bezugsbasis-modell.spec.ts` trifft auf der Bühne die zugesicherte Zahl — wie
 * `bezugsbasisSpecLocatoren.test.tsx` für IP-9. Hier läuft kein Browser; dieselbe Fläche (`KennzahlenPage` mit
 * `bezugsbasisBuehne`) wird in vitest gerendert, die Texte sind wörtlich die der Spec.
 */
const eins = (treffer: unknown[], wo: string) => expect(treffer, wo).toHaveLength(1);
const KOPF_R4 = 'Grundlast 10 523 kWh · je kg 0,2343 kWh · Streuung ± 0,8 % · gilt für 254 000–341 000 kg';
const ABGELEHNT_R9 =
  'Betriebsstunden nicht aufgenommen: hängt an Produktionsmenge (r = 0,997). Ein Modell mit zwei Einflussgrößen braucht unabhängige Größen.';
const GUETE = 'Güte 0,991 — das Modell erklärt 99,1 % der Schwankung der Monatswerte.';

const vorher = { ...api };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2027-11-24T09:00:00+01:00'));
});
afterEach(() => {
  Object.assign(api, vorher);
  vi.useRealTimers();
  setSelbstauskunft(null);
});

const buehne = (lage: 'keine' | 'modell', person: string) => {
  setSelbstauskunft(rechteSeed(person).me);
  Object.assign(api, bezugsbasisBuehne(lage));
  render(<KennzahlenPage kennzahlId={BB_IDS.kz4} onOeffnen={() => undefined} onListe={() => undefined} zone="Europe/Berlin" />);
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

describe('e2e/bezugsbasis-modell.spec.ts — jeder Locator trifft', () => {
  it('Ablehnung (R9) an BB-0001 Fassung 2 für die Leserin', async () => {
    buehne('modell', 'CB');
    const tab = await screen.findAllByRole('tab', { name: 'Bezugsbasis' });
    eins(tab, 'tab Bezugsbasis (exact)');
    fireEvent.click(tab[0]);
    const reiter = await screen.findByTestId('bezugsbasis-reiter');
    const ansicht = await within(reiter).findAllByTestId('bezugsbasis-modell-ansicht');
    eins(ansicht, 'bezugsbasis-modell-ansicht im Reiter');
    const a = within(ansicht[0]);
    expect(a.getByTestId('bezugsbasis-modell-kopf').textContent).toBe(KOPF_R4);
    await waitFor(() => expect(a.getByTestId('bezugsbasis-abgelehnt').textContent).toBe(ABGELEHNT_R9));
    expect(a.getByTestId('bezugsbasis-modell-guete').textContent).toBe(GUETE);
    expect(a.getByTestId('bezugsbasis-modell-spannweite-1').textContent).toBe(
      'Einflussgröße 1, Produktionsmenge (BZ-1): 254 000–341 000 kg · das Modell gilt von 228 600 bis 375 100 kg; außerhalb ist es nicht anwendbar.',
    );
    expect(a.getByTestId('bezugsbasis-modell-datenlage').textContent).toBe('vollständig (12 Monate)');
    eins(a.getAllByTestId('bezugsbasis-modell-grafik'), 'grafik');
    eins(a.getAllByTestId('bezugsbasis-modell-tafel'), 'tafel');
    eins(ansicht[0].querySelectorAll('.vp-bbm-legende') as unknown as unknown[], 'legende');
    eins(screen.getAllByText(UEMS_NORMGRENZE), 'getByText(GRENZE) auf der Seite');
    eins(a.getAllByText('Monate der Referenzperiode (12)'), 'summary Monate');
    expect(a.getByTestId('bezugsbasis-modell-monate').textContent).toContain('August 2027: 69 693 kWh bei 254 000 kg');
  });

  it('Modell bilden: zwölf Monate, Modell mit einer Einflussgröße, Vorschau nach dem Speichern', async () => {
    buehne('keine', 'IK');
    fireEvent.click(await screen.findByRole('tab', { name: 'Bezugsbasis' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Bezugsbasis anlegen' }));
    const dialog = await screen.findByTestId('bezugsbasis-assistent');
    await waehleMonat('Erster Monat', 'November 2026');
    await waehleMonat('Letzter Monat', 'Oktober 2027');
    fireEvent.click(screen.getByTestId('bezugsbasis-monate-knopf'));
    await waitFor(() => expect(screen.getByTestId('bezugsbasis-monate').textContent).toContain('Oktober 2027'));
    fireEvent.click(screen.getByTestId('bezugsbasis-weiter'));
    const radio = dialog.querySelectorAll<HTMLInputElement>('input[type="radio"][value="regression_eine_variable"]');
    eins([...radio], 'radio regression_eine_variable');
    fireEvent.click(radio[0]);
    fireEvent.click(screen.getByTestId('bezugsbasis-weiter'));
    await screen.findByTestId('bezugsbasis-kandidaten');
    fireEvent.click(screen.getByTestId('bezugsbasis-weiter'));
    fireEvent.click(screen.getByTestId('bezugsbasis-weiter'));
    fireEvent.click(await screen.findByTestId('bezugsbasis-entwurf-knopf'));
    const vorschau = await within(dialog).findAllByTestId('bezugsbasis-modell-ansicht');
    eins(vorschau, 'bezugsbasis-modell-ansicht im Assistenten');
    const v = within(vorschau[0]);
    expect(v.getByTestId('bezugsbasis-modell-kopf').textContent).toBe(KOPF_R4);
    expect(v.getAllByTestId('bezugsbasis-modell-punkt')).toHaveLength(12);
    eins(v.getAllByTestId('bezugsbasis-modell-gerade'), 'gerade');
    expect(v.getByTestId('bezugsbasis-modell-guete').textContent).toBe(GUETE);
    expect(v.queryAllByTestId('bezugsbasis-abgelehnt')).toHaveLength(0);
    eins(within(dialog).getAllByText(UEMS_NORMGRENZE), 'dialog getByText(GRENZE)');
    eins(screen.getAllByLabelText('Begründung'), 'getByLabel(Begründung)');
    eins(screen.getAllByTestId('bezugsbasis-freigeben-knopf'), 'freigeben-knopf');
  });
});
