import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SiteEarnings } from '../../api';
import FIXTURE from '../../../e2e/mispel-mengen-fixtures.json';
import { speicherWert } from '../../erloesEbenen';
import { arbitrageAusweisErlaubt, balken, betragText, kwhText, type MispelJahr, type MispelMonat } from '../../mispelMengen';
import { MispelJahrKarte, MispelMonatKarte } from './MispelKarte';

/**
 * **MiSpeL · Mengen nach Anlage 1** (MP-18, BK-18 Variante A). Die Fixture ist die Antwort der Route für die
 * Simulator-Anlage aus `MispelMengenApiTest` (echter Monatslauf MP-8) — die Karte zeigt genau diese Zahlen, jede mit
 * Begriff und Formelnummer, und nennt Unbekanntes „offen“, nie 0 €.
 */
const FX = FIXTURE as unknown as Record<string, unknown>;
const NOV = FX['monat-2026-11'] as MispelMonat;
const DEZ = FX['monat-2026-12'] as MispelMonat;
const OKT = FX['monat-2026-10'] as MispelMonat;
const JAHR = FX['jahr-2026'] as MispelJahr;
const NBSP = String.fromCharCode(160);

describe('MispelMonatKarte · endgültiger Monat', () => {
  it('zeigt jede Farbe mit Wort, Formelnummer, Begriff und der Zahl des Rechenwerks', () => {
    render(<MispelMonatKarte siteId="s1" daten={NOV} />);
    const karte = screen.getByRole('region', { name: 'MiSpeL · Mengen nach Anlage 1' });
    expect(within(karte).getByRole('heading', { name: /November 2026/ })).toBeTruthy();
    expect(within(karte).getByText('endgültig · Messstellenbetreiber')).toBeTruthy();
    const teil = NOV.teile[0];
    for (const f of teil.farben) {
      const zeile = karte.querySelector(`[data-farbe="${f.farbe}"]`) as HTMLElement;
      expect(zeile.textContent).toContain(f.formel);
      expect(zeile.textContent).toContain(f.begriff);
      expect(zeile.textContent).toContain(kwhText(f.kwh));
    }
    expect(karte.textContent).toContain(`(26) Förderfähige zeitgleiche Netzeinspeisung von EE-Strom in AW>0-Zeiten`);
    expect(karte.textContent).toContain(kwhText(teil.einspeisung.kwh));
    expect(karte.textContent).toContain(`davon umlagereduziert (20)`);
    expect(karte.textContent).toContain(kwhText(teil.umlagereduziert.kwh));
    expect(karte.textContent).toContain(`davon umlagebelastet (21)`);
  });

  it('„Was das wert ist“: Beträge der Route, Marktprämie „offen“ statt 0 €', () => {
    render(<MispelMonatKarte siteId="s1" daten={NOV} />);
    const karte = screen.getByRole('region', { name: 'MiSpeL · Mengen nach Anlage 1' });
    const w = NOV.wert!;
    expect(karte.querySelector('[data-betrag="umlagen"]')!.textContent).toBe(betragText(w.vermiedeneUmlagen));
    expect(karte.querySelector('[data-betrag="netzentgelt"]')!.textContent).toBe(betragText(w.vermiedenesNetzentgelt));
    expect(karte.querySelector('[data-betrag="marktpraemie"]')!.textContent).toBe('offen');
    expect(karte.textContent).toContain('Jahresmarktwert Solar');
    expect(karte.textContent).not.toMatch(new RegExp(`0,00${NBSP}€`));
    expect(karte.querySelector('[data-betrag="summe"]')!.textContent).toBe(`+${NBSP}116,38${NBSP}€`);
    expect(screen.getByRole('button', { name: 'Nachweis (PDF)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'CSV' })).toBeTruthy();
  });
});

describe('MispelMonatKarte · vorläufig und leer', () => {
  it('vorläufiger Monat: Chip „Gerätewerte“, Vorschau-Beträge, nur „Vorschau (PDF)“', () => {
    render(<MispelMonatKarte siteId="s1" daten={DEZ} />);
    const karte = screen.getByRole('region', { name: 'MiSpeL · Mengen nach Anlage 1' });
    expect(within(karte).getByText('vorläufig · Gerätewerte')).toBeTruthy();
    expect(karte.textContent).toContain('Vorschau aus den Werten Ihrer Geräte, Stand 10.12., 13:00');
    expect(karte.textContent).toContain('Vermiedene Umlagen (Vorschau)');
    expect(screen.getByRole('button', { name: 'Vorschau (PDF)' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Nachweis (PDF)' })).toBeNull();
    expect(karte.textContent).toContain('vorläufig – keine Mengenbestimmung');
  });

  it('ohne Lauf: „noch nicht bestimmt“, keine Zahl', () => {
    const leer: MispelMonat = { ...NOV, stand: null, teile: [], wert: null, giltAlsNachweis: false };
    render(<MispelMonatKarte siteId="s1" daten={leer} />);
    const karte = screen.getByRole('region', { name: 'MiSpeL · Mengen nach Anlage 1' });
    expect(within(karte).getByText('noch nicht bestimmt')).toBeTruthy();
    expect(karte.textContent).not.toMatch(/kWh|€/);
  });
});

describe('MispelJahrKarte', () => {
  it('eine Zeile je Monat, neueste zuerst; Oktober ohne Mengen mit dem Förderweg; Grund der Änderung', () => {
    render(<MispelJahrKarte siteId="s1" daten={JAHR} onMonat={() => {}} />);
    const liste = screen.getByRole('list', { name: 'Monate nach Anlage 1' });
    const zeilen = within(liste).getAllByRole('listitem');
    expect(zeilen.map((z) => z.getAttribute('data-monat'))).toEqual(['2026-12', '2026-11', '2026-10']);
    expect(zeilen[2].textContent).toContain('Marktprämie mit Ausschließlichkeitsoption — keine Mengen nach Anlage 1');
    expect(zeilen[1].textContent).toContain('gegenüber der Vorschau — Grund: Gerätewerte statt Werte des Messstellenbetreibers');
    expect(zeilen[1].querySelector('[data-betrag="monat"]')!.textContent).toBe(`+${NBSP}116,38${NBSP}€`);
    const karte = screen.getByRole('region', { name: 'MiSpeL · Saldierung je Monat' });
    expect(karte.querySelector('[data-betrag="jahr"]')!.textContent).toBe(`+${NBSP}234,02${NBSP}€`);
    expect(karte.textContent).toContain('Bestimmung nach Anlage 1 ab 01.11.2026');
    expect(karte.textContent).toContain('bis 31.05.2027 (§ 21 Abs. 7 EnFG) — verfügbar, sobald Dezember endgültig ist.');
  });
});

describe('Arbitrage-Ausweis (W5) und Balken', () => {
  it('für MiSpeL-Anlagen nennt der Preise-Fuß kein „davon durch Netzladen“', () => {
    const money = { arbitrageEur: 12.4 } as SiteEarnings;
    expect(speicherWert(money, true)).toContain('davon durch Netzladen');
    expect(speicherWert(money, true, arbitrageAusweisErlaubt(NOV))).toBe('darf aus dem Netz laden');
    expect(arbitrageAusweisErlaubt(OKT)).toBe(true);
    expect(arbitrageAusweisErlaubt(null)).toBe(true);
  });

  it('die Balkenstücke sind die Anteile an (4) und füllen die Spur', () => {
    const b = balken(NOV.teile[0]);
    expect(b.map((x) => x.farbe)).toEqual(['gruen', 'gelb', 'rot', 'grau']);
    expect(b.reduce((s, x) => s + x.pct, 0)).toBeCloseTo(100, 6);
  });
});
