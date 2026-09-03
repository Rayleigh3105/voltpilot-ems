import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SiteEarnings } from '../api';
import FIXTURES from '../erloeseFixtures.json';
import { ebene1, ebene2 } from '../erloesEbenen';
import { ergebnisZeilen } from '../erloesZeilen';
import { PreiseZeile } from './erloese/PreiseZeile';
import { Ebene1Panel } from './ErloesEbenen';

/** Ebene 1 + Ebene 2 als Fläche — Struktur, nicht Inhalt (der lebt im Modul). */

interface Fixture {
  id: string;
  range: 'day' | 'week' | 'month' | 'year';
  label: string;
  laeuft: boolean;
  money: SiteEarnings;
}
const FX = FIXTURES.fixtures as unknown as Fixture[];
const dv = FX.find((f) => f.id === 'dv-tag-laufend')!;

function viewOf(f: Fixture) {
  return ergebnisZeilen({ money: f.money, periodLabel: f.label, laeuft: f.laeuft, range: f.range });
}

describe('Ebene1Panel', () => {
  it('rendert jede Rechenzeile als Formel + Halbsatz Herkunft', () => {
    const e1 = ebene1(dv.money, viewOf(dv), 'einspeisung')!;
    const { container } = render(<Ebene1Panel ebene1={e1} />);
    expect(container.querySelector('.vp-rz-kopf')?.textContent).toBe(
      'Wie setzt sich das zusammen?',
    );
    // ⚠ Seit P2 steht der TERM links und das ERGEBNIS rechts (§3.2 (5)) —
    //   zusammengesetzt ergeben sie wieder genau die Formel der Ableitung.
    const zeilen = [...container.querySelectorAll('.vp-rz-list > li')].map((li) => {
      const term = li.querySelector('.vp-rz-fx')?.textContent ?? '';
      const erg = li.querySelector('.vp-rz-erg')?.textContent;
      return erg == null ? term : `${term} = ${erg}`;
    });
    expect(zeilen).toEqual(e1.zeilen.map((z) => z.formel));
    const herkunft = [...container.querySelectorAll('.vp-rz-hk')].map((n) => n.textContent);
    expect(herkunft).toEqual(e1.zeilen.map((z) => z.herkunft));
  });

  it('das ERGEBNIS jeder Rechenzeile steht in einer eigenen Spalte (P2)', () => {
    // ⚠ Seit P2 KEINE Festbreitenschrift mehr (§3.1): Tabellenziffern in der
    //   Hausschrift stellen die Zahlen genauso untereinander, ohne den Bruch im
    //   Schriftbild. Was die Zahlen ausrichtet, ist die zweite Spalte
    //   (`.vp-rz-erg`) — sie trägt alles hinter dem letzten „ = “.
    const e1 = ebene1(dv.money, viewOf(dv), 'ergebnis')!;
    const { container } = render(<Ebene1Panel ebene1={e1} />);
    expect(container.querySelectorAll('.vp-rz-fx').length).toBe(e1.zeilen.length);
    const ergebnisse = [...container.querySelectorAll('.vp-rz-erg')].map((n) => n.textContent);
    expect(ergebnisse.length).toBeGreaterThan(0);
    // Jede Ergebnis-Spalte trägt genau den Teil hinter dem letzten Gleichheits-
    // zeichen ihrer Formel — der Schnitt ist Anzeige, keine zweite Rechnung.
    const erwartet = e1.zeilen
      .map((z) => z.formel.split(' = ').pop()!.trim())
      .filter((_x, i) => e1.zeilen[i].formel.includes(' = '));
    expect(ergebnisse).toEqual(erwartet);
  });
});

describe('PreiseZeile (Ebene 2 als eigene flache Karte)', () => {
  it('ist ein Aufklapper mit Tabelle und Begriffen', () => {
    const { container } = render(<PreiseZeile ebene2={ebene2({ money: dv.money })} />);
    const det = container.querySelector('details.vp-c-preise')!;
    expect(within(det as HTMLElement).getByText(/Preise & Vergütung/)).toBeTruthy();
    // Jede Zeile ist ein Paar „Größe · Wert" - die Größe ist der Zeilenkopf.
    const koepfe = [...det.querySelectorAll('.vp-e2t th')].map((n) => n.textContent);
    expect(koepfe[0]).toBe('Bezugspreis');
    expect(koepfe).toContain('Bewertung');
    for (const th of det.querySelectorAll('.vp-e2t th')) {
      expect(th.getAttribute('scope')).toBe('row');
    }
    expect(within(det as HTMLElement).getByText('Begriffe')).toBeTruthy();
  });

  it('der E12-Satz steht auf Ebene 2 — nicht in der Zeile darüber', () => {
    const { container } = render(<PreiseZeile ebene2={ebene2({ money: dv.money })} />);
    expect(container.textContent).toContain('Deshalb kann Einspeisen richtig sein');
  });

  it.each(FX.map((f) => [f.id, f] as const))('%s rendert ohne Ausnahme', (_id, f) => {
    const { container, unmount } = render(<PreiseZeile ebene2={ebene2({ money: f.money })} />);
    expect(container.querySelectorAll('.vp-e2t tr').length).toBeGreaterThan(0);
    unmount();
  });

  it('ohne Glossar-Einträge entfällt der Begriffe-Aufklapper', () => {
    const leer = { ...ebene2({ money: dv.money }), glossar: [] };
    const { container } = render(<PreiseZeile ebene2={leer} />);
    expect(container.querySelector('details.vp-gl')).toBeNull();
    expect(screen.queryByText('Begriffe')).toBeNull();
  });
});
