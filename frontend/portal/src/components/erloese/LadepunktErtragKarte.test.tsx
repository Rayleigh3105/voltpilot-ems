import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import FIXTURE from '../../../e2e/ladepunkt-ertraege-fixtures.json';
import { kwhText } from '../../mispelMengen';
import type { LadepunktErtraege } from '../../ladepunktErtraege';
import { LadepunktErtragKarte } from './LadepunktErtragKarte';

/**
 * **Ladepunkt · Erträge im Monat** (MP-41a, BK-41). Haus Albers aus dem Bedienkonzept, Formelsatz A2: jede Menge mit
 * Formelnummer der Anlage 1, Fremdtankstrom zählt nicht, Unbekanntes heißt „offen“ — und ohne den Vergleich „das Auto
 * lädt nur“ (Messlatte, MP-33d) steht weder eine Summe noch ein Minus allein.
 */
const FX = FIXTURE as unknown as Record<string, LadepunktErtraege>;
const MIT = FX['ertrag-mit'];
const OHNE = FX['ertrag-ohne'];
const A3 = FX['ertrag-a3'];
const NBSP = String.fromCharCode(160);

function karte() {
  return screen.getByRole('region', { name: 'Erträge am Ladepunkt' });
}

describe('LadepunktErtragKarte · Mengen nach Anlage 1', () => {
  it('zeigt geladen (5), ins Haus (6) − (11), ins Netz (11) und Fremdtankstrom (12) mit den Zahlen des Rechenwerks', () => {
    render(<LadepunktErtragKarte daten={MIT} />);
    const k = karte();
    expect(within(k).getByRole('heading', { name: 'Ladepunkt · Wallbox Garage · November 2026' })).toBeTruthy();
    expect(within(k).getByText('endgültig · Messstellenbetreiber')).toBeTruthy();
    expect(k.textContent).toContain(`Erst ins Haus, dann ins Netz: ${kwhText(108)} hat das Auto dem Haus gegeben, ${kwhText(34)} dem Netz.`);
    const zeile = (art: string) => k.querySelector(`[data-menge="${art}"]`)!.textContent ?? '';
    expect(zeile('geladen')).toContain('(5) Verbrauch im Stromspeicher und/oder Ladepunkt im Kalendermonat');
    expect(zeile('geladen')).toContain(`davon aus dem Netz (9) ${kwhText(120)}, Sonnenstrom (10) ${kwhText(12)}`);
    expect(zeile('geladen')).toContain(kwhText(132));
    expect(zeile('haus')).toContain('(6) − (11)');
    expect(zeile('netz')).toContain('(11) Basiswert der zeitgleichen Netzeinspeisung');
    expect(zeile('fremd')).toContain('(12) mehr zurückgegeben als hier geladen: Strom von anderswo — zählt nicht');
    expect(zeile('fremd')).toContain(kwhText(10));
    expect(zeile('gelb')).toContain('(31) Förderfähige Netzeinspeisung von EE-Speichererzeugung');
    expect(zeile('rot')).toContain('(16) Saldierungsfähige Netzeinspeisung im Kalendermonat · senkt Umlagen auf (20)');
    expect(k.textContent).toContain(`Wirkungsgrad pauschal 0,85 (14) · ${kwhText(24)} berücksichtigungsfähig (13) = (11) − (12) Fremdtankstrom.`);
    expect(k.textContent).toContain('Monatliche Mengenbestimmung nach Anlage 1 · Formelsatz A2 · Z2 am Ladepunkt');
  });

  it('nennt eine fehlende Menge „offen“, nie 0', () => {
    const daten: LadepunktErtraege = {
      ...MIT,
      teile: [{ ...MIT.teile[0], mengen: MIT.teile[0].mengen.map((m) => (m.nr === '(12)' ? { ...m, kwh: null } : m)) }],
    };
    render(<LadepunktErtragKarte daten={daten} />);
    expect(karte().querySelector('[data-menge="fremd"] .vp-mi-z')!.textContent).toBe('offen');
  });

  it('zeigt ohne Lauf mit Ladepunkt nichts', () => {
    const { container } = render(<LadepunktErtragKarte daten={FX['ertrag-leer']} />);
    expect(container.textContent).toBe('');
  });
});

describe('LadepunktErtragKarte · Was es gebracht hat', () => {
  it('mit Messlatte: alle Posten mit Vorzeichen und die Summe gegenüber nur laden', () => {
    render(<LadepunktErtragKarte daten={MIT} />);
    const k = karte();
    const betrag = (id: string) => k.querySelector(`[data-betrag="${id}"]`)!.textContent;
    expect(betrag('weniger_gekauft')).toBe(`+${NBSP}36,94${NBSP}€`);
    expect(betrag('mehr_geladen')).toBe(`−${NBSP}22,61${NBSP}€`);
    expect(betrag('akku_verschleiss')).toBe(`−${NBSP}4,26${NBSP}€`);
    expect(betrag('marktpraemie')).toBe('offen');
    expect(betrag('summe')).toBe(`+${NBSP}15,42${NBSP}€`);
    expect(k.textContent).toContain('Gegenüber nur laden');
    expect(k.textContent).toContain('Vergleich: dasselbe Haus, das Auto lädt nur');
    expect(k.textContent).toContain('Netzentgelt auf Rückspeisung aus Ladepunkten: Gesetzesfassung wird geprüft.');
    expect(k.querySelector('[data-hinweis="ohne-vergleich"]')).toBeNull();
  });

  it('ohne Messlatte: keine Summe, kein Minus allein, Vergleichsposten offen mit Grund', () => {
    render(<LadepunktErtragKarte daten={OHNE} />);
    const k = karte();
    const betrag = (id: string) => k.querySelector(`[data-betrag="${id}"]`)!.textContent;
    expect(betrag('summe')).toBe('offen');
    for (const id of ['weniger_gekauft', 'mehr_geladen', 'ins_netz_verkauft', 'akku_verschleiss']) expect(betrag(id)).toBe('offen');
    expect(betrag('vermiedene_umlagen')).toBe(`+${NBSP}0,48${NBSP}€`);
    expect(k.textContent).not.toMatch(/−\s?\d/);
    expect(k.textContent).not.toMatch(/(^|\D)0,00/);
    expect(k.textContent).toContain('braucht den Vergleich mit dem Haus, in dem das Auto nur lädt');
    expect(k.querySelector('[data-hinweis="ohne-vergleich"]')!.textContent).toContain('Eine Summe steht hier, sobald');
  });

  it('ohne Messlatte bleibt auch ein geliefertes Minus offen', () => {
    const daten: LadepunktErtraege = {
      ...OHNE,
      posten: OHNE.posten.map((p) => (p.schluessel === 'akku_verschleiss' ? { ...p, stand: 'bestimmt', eur: -4.26 } : p)),
    };
    render(<LadepunktErtragKarte daten={daten} />);
    expect(karte().querySelector('[data-betrag="akku_verschleiss"]')!.textContent).toBe('offen');
  });
});

describe('LadepunktErtragKarte · A3: ein Zähler Z2 für Stromspeicher und Ladepunkt', () => {
  it('sagt, dass die Mengen beide zusammen sind, und schreibt sie nicht dem Auto allein zu', () => {
    render(<LadepunktErtragKarte daten={A3} />);
    const k = karte();
    expect(k.textContent).toContain('Stromspeicher und Ladepunkt zusammen (ein Zähler Z2, A1 S. 30–32)');
    expect(k.textContent).toContain('haben Stromspeicher und Auto zusammen dem Haus gegeben');
    expect(k.textContent).not.toContain('hat das Auto dem Haus gegeben');
    expect(k.textContent).toContain('Z2 an Stromspeicher und Ladepunkt');
    expect(within(k).getByText('vorläufig · Gerätewerte')).toBeTruthy();
    expect(k.querySelector('[data-betrag="vermiedene_umlagen"]')!.textContent).toBe('offen');
    expect(k.textContent).toContain('den Anteil des Autos zeigt erst der Vergleich');
  });
});
