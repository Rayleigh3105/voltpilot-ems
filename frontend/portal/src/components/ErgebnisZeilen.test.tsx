import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SiteEarnings } from '../api';
import FIXTURES from '../erloeseFixtures.json';
import { ergebnisZeilen, vorzeichenEuro, type ErgebnisZeilenView } from '../erloesZeilen';
import { ErgebnisZeilen } from './ErgebnisZeilen';

/**
 * Ebene 0 als FLÄCHE — was der Kunde wirklich im DOM bekommt.
 *
 * Der Snapshot der SVG-Geometrie liegt in `erloesZeilen.test.ts` (die reine
 * Ableitung); hier steht das, was nur die Fläche beantworten kann: die
 * Reihenfolge, die Vorzeichen im Text, die `textLength`-Regel und dass eine
 * Zeile ohne Ebene-1-Inhalt KEIN leeres Versprechen aufklappt.
 */

interface Fixture {
  id: string;
  range: 'day' | 'week' | 'month' | 'year';
  label: string;
  laeuft: boolean;
  money: SiteEarnings;
}
const FX = FIXTURES.fixtures as unknown as Fixture[];

function viewOf(id: string): ErgebnisZeilenView {
  const f = FX.find((x) => x.id === id)!;
  return ergebnisZeilen({ money: f.money, periodLabel: f.label, laeuft: f.laeuft, range: f.range });
}

describe('ErgebnisZeilen', () => {
  it('rendert Hero, Kurzsatz und die vier Zeilen in fester Reihenfolge', () => {
    const { container } = render(<ErgebnisZeilen view={viewOf('dv-tag-laufend')} />);
    expect(container.querySelector('.vp-ez-hero')?.textContent).toBe(vorzeichenEuro(63.23));
    expect(container.querySelector('.vp-ez-satz')?.textContent).toBe('Heute bisher unterm Strich.');
    const namen = [...container.querySelectorAll('.vp-ez-name')].map((n) => n.textContent);
    expect(namen).toEqual(['Einspeise-Erlös', 'Eigenverbrauch', 'Netzbezug', 'Ergebnis']);
    const werte = [...container.querySelectorAll('.vp-ez-val')].map((n) => n.textContent);
    expect(werte).toEqual(
      [26.13, 38.68, -1.59, 63.23].map((v) => vorzeichenEuro(v)),
    );
  });

  it('die Reihenfolge ist auf jeder Breite dieselbe — kein isPhone-Umsortieren', () => {
    // Es gibt keine Breiten-Prop und kein `isPhone`: die Fläche kennt nur EINE
    // Reihenfolge, das Umbrechen entscheidet allein das CSS (§3.2).
    // Kommentare abstreifen (das `copy.test.ts`-Muster) — der Satz DARÜBER
    // erwähnt `isPhone` legitim.
    const quelle = readFileSync(join(process.cwd(), 'src/components/ErgebnisZeilen.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(quelle).not.toMatch(/isPhone/);
    const { container } = render(<ErgebnisZeilen view={viewOf('eeg-monat')} />);
    expect([...container.querySelectorAll('.vp-ez-name')].map((n) => n.textContent)).toEqual([
      'Einspeise-Erlös',
      'Eigenverbrauch',
      'Netzbezug',
      'Ergebnis',
    ]);
  });

  it('KEIN SVG-Text ohne textLength — die Regel gilt als Wächter, auch wo wir keinen setzen', () => {
    for (const f of FX) {
      const { container, unmount } = render(<ErgebnisZeilen view={viewOf(f.id)} />);
      for (const t of container.querySelectorAll('svg text')) {
        // Headless/Lavish misst Schriften breiter als der echte Browser; ein
        // SVG-Label ohne `textLength` läuft dort über seinen Balken hinaus.
        expect(t.getAttribute('textLength'), `<text> ohne textLength in ${f.id}`).not.toBeNull();
      }
      unmount();
    }
  });

  it('jede Zeile trägt genau EINEN Balken mit der gemeinsamen Nulllinie', () => {
    const { container } = render(<ErgebnisZeilen view={viewOf('dv-tag-laufend')} />);
    const svgs = container.querySelectorAll('svg.vp-ez-bar');
    expect(svgs.length).toBe(4);
    const nullen = [...svgs].map((s) => s.querySelector('.vp-ez-bar-zero')?.getAttribute('x1'));
    expect(new Set(nullen).size).toBe(1);
    for (const s of svgs) {
      expect(s.getAttribute('preserveAspectRatio')).toBe('none');
      expect(s.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('eine Zeile ohne Wert bekommt „—" und KEINEN Balken', () => {
    const { container } = render(<ErgebnisZeilen view={viewOf('eeg-ohne-tarif')} />);
    const zeilen = [...container.querySelectorAll('.vp-ez-row')];
    const eigen = zeilen[1];
    expect(within(eigen as HTMLElement).getByText('—')).toBeTruthy();
    expect(eigen.querySelector('.vp-ez-bar-fill')).toBeNull();
    expect(within(eigen as HTMLElement).getByText('Tarif fehlt ›')).toBeTruthy();
  });

  it('das Vorzeichen kommt aus dem WERT: der negative Einspeise-Erlös trägt „−"', () => {
    const { container } = render(<ErgebnisZeilen view={viewOf('dv-praemie-ruht')} />);
    const erste = container.querySelector('.vp-ez-val')!;
    expect(erste.textContent?.startsWith('−')).toBe(true);
    expect(erste.className).toContain('vp-ez-t-minus');
  });

  it('ohne Ebene-1-Inhalt bleibt die Zeile RUHIG (kein leerer Aufklapper)', () => {
    const { container } = render(<ErgebnisZeilen view={viewOf('dv-monat')} />);
    expect(container.querySelectorAll('details.vp-ez-det').length).toBe(0);
    expect(container.querySelectorAll('.vp-ez-sum-still').length).toBe(4);
  });

  it('mit Ebene-1-Inhalt wird jede Zeile ein Aufklapper', () => {
    const { container } = render(
      <ErgebnisZeilen view={viewOf('dv-monat')} ebene1={(id) => <p>Rechnung {id}</p>} />,
    );
    expect(container.querySelectorAll('details.vp-ez-det').length).toBe(4);
    expect(screen.getByText('Rechnung ergebnis')).toBeTruthy();
  });

  it('die drei Einbaustellen rendern genau dort, wo sie hingehören', () => {
    const { container } = render(
      <ErgebnisZeilen
        view={viewOf('dv-tag-laufend')}
        speicher={<div data-testid="sp">Speicher</div>}
        einordnung={<div data-testid="vg">Vergleich</div>}
        ebene2={<div data-testid="e2">Preise</div>}
      />,
    );
    const rechts = container.querySelector('.vp-ez-rechts')!;
    expect(within(rechts as HTMLElement).getByTestId('sp')).toBeTruthy();
    expect(within(rechts as HTMLElement).getByTestId('vg')).toBeTruthy();
    expect(within(rechts as HTMLElement).getByTestId('e2')).toBeTruthy();
  });

  it.each(FX.map((f) => [f.id] as const))('%s rendert ohne Ausnahme', (id) => {
    const { container, unmount } = render(<ErgebnisZeilen view={viewOf(id)} />);
    expect(container.querySelectorAll('.vp-ez-row').length).toBe(4);
    unmount();
  });
});
