import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SiteEarnings } from '../api';
import FIXTURES from '../erloeseFixtures.json';
import { ebene1, ebene2 } from '../erloesEbenen';
import { ergebnisZeilen } from '../erloesZeilen';
import { Ebene1Panel, Ebene2Panel } from './ErloesEbenen';

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
    const formeln = [...container.querySelectorAll('.vp-rz-fx')].map((n) => n.textContent);
    expect(formeln).toEqual(e1.zeilen.map((z) => z.formel));
    const herkunft = [...container.querySelectorAll('.vp-rz-hk')].map((n) => n.textContent);
    expect(herkunft).toEqual(e1.zeilen.map((z) => z.herkunft));
  });

  it('die Formel steht in Festbreitenschrift — sie soll nachrechenbar aussehen', () => {
    const e1 = ebene1(dv.money, viewOf(dv), 'ergebnis')!;
    const { container } = render(<Ebene1Panel ebene1={e1} />);
    expect(container.querySelectorAll('.vp-rz-fx').length).toBe(e1.zeilen.length);
  });
});

describe('Ebene2Panel', () => {
  it('ist ein Aufklapper mit Tabelle und Begriffen', () => {
    const { container } = render(<Ebene2Panel ebene2={ebene2({ money: dv.money })} />);
    const det = container.querySelector('details.vp-e2')!;
    expect(within(det as HTMLElement).getByText('Preise & Vergütung')).toBeTruthy();
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
    const { container } = render(<Ebene2Panel ebene2={ebene2({ money: dv.money })} />);
    expect(container.textContent).toContain('Deshalb kann Einspeisen richtig sein');
  });

  it.each(FX.map((f) => [f.id, f] as const))('%s rendert ohne Ausnahme', (_id, f) => {
    const { container, unmount } = render(<Ebene2Panel ebene2={ebene2({ money: f.money })} />);
    expect(container.querySelectorAll('.vp-e2t tr').length).toBeGreaterThan(0);
    unmount();
  });

  it('ohne Glossar-Einträge entfällt der Begriffe-Aufklapper', () => {
    const leer = { ...ebene2({ money: dv.money }), glossar: [] };
    const { container } = render(<Ebene2Panel ebene2={leer} />);
    expect(container.querySelector('details.vp-gl')).toBeNull();
    expect(screen.queryByText('Begriffe')).toBeNull();
  });
});
