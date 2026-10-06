import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { keycloak } from '../auth';
import { setSelbstauskunft } from '../rollen';
import { SEITE_IDS, seitenBuehne, type SeitenLage } from '../test/kennzahlSeiteFixtures';
import { rechteSeed } from '../test/rollenFixtures';
import { KennzahlenPage } from './KennzahlenPage';

/**
 * Die Seite einer Kennzahl ohne Reiter und die Bezugsbasis eine Ebene tiefer (Konzept Auswerten a1 §6.5, §6.6; PR2) in
 * der Welt des Konzepts (`test/kennzahlSeiteFixtures.ts`): Antwort zuerst, Verlässlichkeit, Kacheln, Grafik mit
 * Infozeile, Monatsliste, Auffälligkeit, Rechenweg, Bezugsbasis in Klartext. Am Rechner (jsdom kennt keine Breite).
 */
const t = (s: string | null | undefined) => (s ?? '').replace(/\u00a0/g, ' ');
const original = { ...api };

function welt(lage: SeitenLage = 'ueber', person = 'IK') {
  const me = rechteSeed(person).me;
  setSelbstauskunft(me);
  keycloak.tokenParsed = { sub: me.kennung!, name: me.name!, tenant_id: me.kundenbereich!.id };
  Object.assign(api, seitenBuehne(lage));
}

beforeEach(() => {
  window.location.hash = '';
});
afterEach(() => {
  Object.assign(api, original);
  vi.restoreAllMocks();
});

describe('die Seite einer Kennzahl (§6.5)', () => {
  it('Antwort zuerst: Satz mit Bedingung, Verlässlichkeit, Kachel mit Stern, Ziel, Fazit, Rechenweg, Bezugsbasis', async () => {
    welt();
    render(<KennzahlenPage kennzahlId={SEITE_IDS.kz4} onOeffnen={vi.fn()} onListe={vi.fn()} />);
    const antwort = await screen.findByTestId('kennzahl-antwort');
    expect(t(antwort.textContent)).toContain(
      'Im März 2029 brauchte der Prozess Spritzguss 2,2 % mehr Energie, als die Bezugsbasis bei 306.000 kg Produktionsmenge erwarten ließ.',
    );
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(t(screen.getByTestId('kennzahl-vertrauen').textContent)).toBe(
      'Vorsicht beim Lesen: Die Bezugsbasis stammt aus einem einzigen Monat (Oktober 2026) und ist vorläufig. Bezugsbasis ansehen',
    );
    const kachel = screen.getByTestId('kennzahl-kacheln');
    await waitFor(() => expect(within(kachel).getByLabelText('Leitkennzahl - sie steht auf der Übersicht')).toBeTruthy());
    expect(t(kachel.textContent)).toContain('0,29kWh je kg');
    expect(t(kachel.textContent)).toContain('über der Bezugsbasis▼ 2 % ggü. Vormonat');
    expect(t(kachel.textContent)).toContain('erwartet 0,28 kWh je kg bei 306.000 kg · gemessen 88.740 kWh, erwartet 86.812 kWh');
    expect(t((await screen.findByTestId('kennzahl-energieziel')).textContent)).toContain('Stand nach 1 von 10 Monaten: 2,2 % mehr · verantwortlich Ines Kaltenbach');
    expect(t((await screen.findByTestId('kennzahl-fazit')).textContent)).toBe(
      'April 2028 bis März 2029: 3,0 % mehr als erwartet; 10 von 12 Monaten über der Bezugsbasis, 2 im Rahmen.',
    );
    // Am Rechner: die Monate als Tabelle mit sechs Spalten, „Zusammengezählt“ neben der Grafik.
    expect(within(screen.getByTestId('kennzahl-werte')).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Monat', 'Gemessen', 'Bedingung', 'Erwartet', 'Abweichung', 'Urteil',
    ]);
    expect(screen.getByTestId('kennzahl-zusammen')).toBeTruthy();
    expect(t((await screen.findByTestId('kennzahl-erwartet')).textContent)).toBe(
      'Erwartet: 0,2837 kWh je kg aus der Bezugsbasis mal 306.000 kg = 86.812 kWh.',
    );
    expect(t(screen.getByTestId('kennzahl-bezugsbasis').textContent)).toContain('nächste Überprüfung bis 30.04.2030');
    expect(t(screen.getByTestId('kennzahl-stammdaten').textContent)).toContain('Gilt für den Prozess Spritzguss');
  });

  it('die Grafik ist ein Schieber: Pfeiltasten wechseln den Monat der Infozeile und des Rechenwegs', async () => {
    welt();
    render(<KennzahlenPage kennzahlId={SEITE_IDS.kz4} onOeffnen={vi.fn()} onListe={vi.fn()} />);
    const schieber = await screen.findByRole('slider');
    const info = () => t(screen.getByTestId('grafik-infozeile').textContent);
    expect(info()).toBe('März 202988.740 kWhstatt 86.812 erwartet2,2 % mehr · über der Bezugsbasis');
    expect(schieber.getAttribute('aria-valuenow')).toBe('12');
    fireEvent.keyDown(schieber, { key: 'ArrowLeft' });
    expect(info()).toContain('Februar 2029');
    expect(schieber.getAttribute('aria-valuetext')).toContain('Februar 2029');
    fireEvent.keyDown(schieber, { key: 'Home' });
    expect(info()).toContain('April 2028');
    await waitFor(() => expect(t(screen.getByTestId('kennzahl-herkunft').textContent)).toContain('April 2028: 88.200 kWh (Spritzguss)'));
  });

  it('die offene Auffälligkeit: „Beantworten“ öffnet die beiden Antworten (Abweichung eröffnen, zur Kenntnis nehmen)', async () => {
    welt();
    render(<KennzahlenPage kennzahlId={SEITE_IDS.kz4} onOeffnen={vi.fn()} onListe={vi.fn()} />);
    const karte = await screen.findByTestId('kennzahl-auffaelligkeit');
    expect(t(karte.textContent)).toContain('Auffälligkeit zu März 2029 · offen. VoltPilot hat den Monat vermerkt');
    fireEvent.click(within(karte).getByTestId('auffaelligkeit-beantworten'));
    expect(within(karte).getByTestId('vermerk-eroeffnen')).toBeTruthy();
  });

  it('„Bezugsbasis ansehen“ und „Alle Fassungen“ führen eine Ebene tiefer', async () => {
    welt();
    const onOeffnen = vi.fn();
    render(<KennzahlenPage kennzahlId={SEITE_IDS.kz4} onOeffnen={onOeffnen} onListe={vi.fn()} />);
    fireEvent.click(await within(await screen.findByTestId('kennzahl-vertrauen')).findByRole('button', { name: 'Bezugsbasis ansehen' }));
    fireEvent.click(await screen.findByTestId('alle-fassungen'));
    expect(onOeffnen.mock.calls).toEqual([[SEITE_IDS.kz4, 'bezugsbasis'], [SEITE_IDS.kz4, 'bezugsbasis']]);
  });

  it('noch kein Vergleich: keine zwölf leeren Säulen - die Werte mit Vorjahr, „Vergleich ab Juni 2029“', async () => {
    welt('noch_kein_vergleich');
    render(<KennzahlenPage kennzahlId={SEITE_IDS.kz4} onOeffnen={vi.fn()} onListe={vi.fn()} />);
    const grafik = await screen.findByTestId('kennzahl-grafik');
    expect(within(grafik).getByRole('heading').textContent).toBe('Je Monat');
    expect(t(screen.getByTestId('kennzahl-kacheln').textContent)).toContain('Vergleich ab Juni 2029');
    expect(screen.queryByTestId('kennzahl-fazit')).toBeNull();
    expect(screen.queryByTestId('kennzahl-zusammen')).toBeNull();
  });

  it('ohne Bezugsbasis: das Vorjahr als Satz und Marke, der Hinweis mit „Bezugsbasis festlegen“, keine Kachel', async () => {
    welt();
    render(<KennzahlenPage kennzahlId={SEITE_IDS.kz24} onOeffnen={vi.fn()} onListe={vi.fn()} />);
    const antwort = await screen.findByTestId('kennzahl-antwort');
    expect(t(antwort.textContent)).toBe(
      'Im März 2029 lag das Gebäude Halle 1 bei 20,64 kWh je m² - genauso viel wie im März 2028.kWh je m² · Gebäude Halle 1 · ohne Bezugsbasisunverändert ggü. Vorjahr',
    );
    expect(t(screen.getByTestId('kennzahl-vertrauen').textContent)).toContain('Bezugsbasis festlegen');
    expect(screen.queryByTestId('kennzahl-kacheln')).toBeNull();
    expect(within(screen.getByTestId('kennzahl-werte')).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Monat', 'Wert', 'Vorjahr', 'Veränderung']);
  });

  it('ohne Bezugsbasis trägt jeder Monat sein Vorjahr aus der Auswertung - auch solange die Monatswerte noch laden', async () => {
    welt();
    // Die Monatswerte (Rechenweg) antworten nicht: Infozeile und Tabelle behaupten trotzdem nie „ohne Vorjahreswert“.
    api.kennzahlWerte = () => new Promise(() => {});
    render(<KennzahlenPage kennzahlId={SEITE_IDS.kz24} onOeffnen={vi.fn()} onListe={vi.fn()} />);
    const info = await screen.findByTestId('grafik-infozeile');
    expect(t(info.textContent)).toContain('Vorjahr 20,64');
    expect(t(info.textContent)).not.toContain('ohne Vorjahreswert');
    const zeilen = within(screen.getByTestId('kennzahl-werte')).getAllByRole('row').slice(1);
    expect(zeilen).toHaveLength(12);
    // Jede Zeile: Monat, Wert, Vorjahr und die rohe Veränderung - kein Monat mit leerer Spalte.
    expect(zeilen.map((z) => within(z).getAllByRole('cell').map((c) => t(c.textContent)))).toContainEqual(['17,81 kWh je m²', '17,81', '0,0 %']);
    for (const z of zeilen) expect(within(z).getAllByRole('cell').map((c) => c.textContent)).not.toContain('—');
  });

  it('eine alte Adresse der Wiedervorlage (`…?entscheid=bezugsbasis_ueberpruefung`) springt auf die Ebene der Bezugsbasis', async () => {
    welt();
    window.location.hash = `#/portfolio/kennzahlen/${SEITE_IDS.kz4}?entscheid=bezugsbasis_ueberpruefung&kennzeichen=BB-0001`;
    render(<KennzahlenPage kennzahlId={SEITE_IDS.kz4} onOeffnen={vi.fn()} onListe={vi.fn()} />);
    await waitFor(() =>
      expect(window.location.hash).toBe(`#/portfolio/kennzahlen/${SEITE_IDS.kz4}/bezugsbasis?entscheid=bezugsbasis_ueberpruefung&kennzeichen=BB-0001`),
    );
  });
});

describe('die Bezugsbasis eine Ebene tiefer (§6.6)', () => {
  it('Kopf, Status, Antwort, „vorläufig“, Fassungen als Datumsblöcke und die Überprüfung mit dem Entscheid der Wiedervorlage', async () => {
    welt();
    const onOeffnen = vi.fn();
    render(<KennzahlenPage kennzahlId={SEITE_IDS.kz4} ebene="bezugsbasis" onOeffnen={onOeffnen} onListe={vi.fn()} />);
    expect(t((await screen.findByTestId('bezugsbasis-status')).textContent)).toBe('Gilt seit 01.11.2027nächste Überprüfung bis 30.04.2030');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Bezugsbasis BB-0001');
    expect(t(screen.getByTestId('bezugsbasis-antwort').textContent)).toBe(
      'VoltPilot erwartet 0,2837 kWh je kg - so viel wie im Oktober 2026.Fassung 2 · Verhältnis · Vergleichszeitraum Oktober 2026',
    );
    expect(t(screen.getByTestId('bezugsbasis-vorlaeufig-hinweis').textContent)).toContain('Belastbar wird sie mit zwölf Monaten');
    const f2 = await screen.findByTestId('bezugsbasis-fassung-2');
    expect(t(f2.textContent)).toContain('seit01.11.2027Fassung 2 · gilt');
    const pruefung = screen.getByTestId('bezugsbasis-ueberpruefung');
    expect(t(pruefung.textContent)).toContain('Zuletzt bestätigt am 30.04.2029. Ist sie noch die richtige Messlatte?');
    expect(within(pruefung).getByTestId('bezugsbasis-antworten').getAttribute('data-entscheid')).toBe('bezugsbasis_ueberpruefung');
    fireEvent.click(screen.getByRole('button', { name: 'Stromeinsatz Spritzguss je kg' }));
    expect(onOeffnen).toHaveBeenCalledWith(SEITE_IDS.kz4);
  });
});
