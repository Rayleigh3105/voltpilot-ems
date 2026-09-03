import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SiteEarnings } from '../api';
import FIXTURES from '../erloeseFixtures.json';
import { ergebnisZeilen, vorzeichenEuro, type ErgebnisZeilenView } from '../erloesZeilen';
import { ErgebnisZeilen } from './ErgebnisZeilen';

/**
 * Ebene 0 als FLÄCHE — was der Kunde wirklich im DOM bekommt, in der Anatomie
 * der Variante C (Konzept `vp-erloese-lesbar-konzept-u3` §3.10): Statement auf
 * der Fläche, Karte „Kontoauszug", rechte Spalte für Speicher und Preise.
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

describe('ErgebnisZeilen (Anatomie C)', () => {
  const LABEL = 'Ergebnis · Heute';

  it('rendert Statement, Kurzsatz und die vier Ledger-Zeilen in fester Reihenfolge', () => {
    const { container } = render(
      <ErgebnisZeilen view={viewOf('dv-tag-laufend')} label={LABEL} />,
    );
    expect(container.querySelector('.vp-c-stm-zahl')?.textContent).toBe(vorzeichenEuro(63.23));
    expect(container.querySelector('.vp-c-stm-satz')?.textContent).toBe(
      'Heute bisher unterm Strich.',
    );
    const namen = [...container.querySelectorAll('.vp-c-led-name')].map((n) => n.textContent);
    expect(namen).toEqual(['Einspeise-Erlös', 'Eigenverbrauch', 'Netzbezug', 'Ergebnis']);
    const werte = [...container.querySelectorAll('.vp-c-led-val')].map((n) => n.textContent);
    expect(werte).toEqual([26.13, 38.68, -1.59, 63.23].map((v) => vorzeichenEuro(v)));
  });

  it('das Label steht 12/700 über der Zahl, das Provenienz-Abzeichen daneben', () => {
    const { container } = render(
      <ErgebnisZeilen view={viewOf('dv-tag-laufend')} label={LABEL} provenienz="bewertet" />,
    );
    const stm = container.querySelector('.vp-c-stm')!;
    expect(stm.querySelector('.vp-c-label-text')?.textContent).toBe(LABEL);
    // GENAU EIN Chip im Statement (§2 Prinzip 5).
    expect(stm.querySelectorAll('.vp-chip').length).toBe(1);
  });

  it('die Reihenfolge ist auf jeder Breite dieselbe — kein isPhone-Umsortieren', () => {
    // Es gibt keine Breiten-Prop und kein `isPhone`: die Fläche kennt nur EINE
    // Reihenfolge, das Umbrechen entscheidet allein das CSS (§3.2).
    // Kommentare abstreifen (das `copy.test.ts`-Muster) — der Satz DARÜBER
    // erwähnt `isPhone` legitim.
    for (const datei of [
      'src/components/ErgebnisZeilen.tsx',
      'src/components/erloese/Kontoauszug.tsx',
      'src/components/erloese/Statement.tsx',
    ]) {
      const quelle = readFileSync(join(process.cwd(), datei), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(quelle, datei).not.toMatch(/isPhone/);
    }
    const { container } = render(<ErgebnisZeilen view={viewOf('eeg-monat')} label={LABEL} />);
    expect([...container.querySelectorAll('.vp-c-led-name')].map((n) => n.textContent)).toEqual([
      'Einspeise-Erlös',
      'Eigenverbrauch',
      'Netzbezug',
      'Ergebnis',
    ]);
  });

  it('KEIN SVG-Text ohne textLength — die Regel gilt als Wächter, auch wo wir keinen setzen', () => {
    for (const f of FX) {
      const { container, unmount } = render(<ErgebnisZeilen view={viewOf(f.id)} label={LABEL} />);
      for (const t of container.querySelectorAll('svg text')) {
        // Headless/Lavish misst Schriften breiter als der echte Browser; ein
        // SVG-Label ohne `textLength` läuft dort über seinen Balken hinaus.
        expect(t.getAttribute('textLength'), `<text> ohne textLength in ${f.id}`).not.toBeNull();
      }
      unmount();
    }
  });

  it('jede Zeile trägt genau EINEN Balken mit der gemeinsamen Nulllinie', () => {
    const { container } = render(
      <ErgebnisZeilen view={viewOf('dv-tag-laufend')} label={LABEL} />,
    );
    const svgs = container.querySelectorAll('svg.vp-c-led-bar');
    expect(svgs.length).toBe(4);
    const nullen = [...svgs].map((s) => s.querySelector('.vp-c-led-bar-zero')?.getAttribute('x1'));
    expect(new Set(nullen).size).toBe(1);
    for (const s of svgs) {
      expect(s.getAttribute('preserveAspectRatio')).toBe('none');
      expect(s.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('eine Zeile ohne Wert bekommt „—", KEINEN Balken und den WEG in der Sekundärzeile', () => {
    const { container } = render(<ErgebnisZeilen view={viewOf('eeg-ohne-tarif')} label={LABEL} />);
    const zeilen = [...container.querySelectorAll('.vp-c-led-row')];
    const eigen = zeilen[1];
    expect(within(eigen as HTMLElement).getByText('—')).toBeTruthy();
    expect(eigen.querySelector('.vp-c-led-bar-fill')).toBeNull();
    // ⚠ Der WEG ist seit Variante C Text in der Sekundärzeile, kein Chip
    //   (§2 Prinzip 5) — und ohne `hrefFor` bleibt er ruhiger Text.
    expect(within(eigen as HTMLElement).getByText(/Stromtarif hinterlegen ›/)).toBeTruthy();
    expect(eigen.querySelector('a')).toBeNull();
  });

  it('mit `hrefFor` wird der Weg ein echter Link', () => {
    const { container } = render(
      <ErgebnisZeilen
        view={viewOf('eeg-ohne-tarif')}
        label={LABEL}
        hrefFor={() => '#/anlage/1/technik'}
      />,
    );
    const link = container.querySelectorAll('.vp-c-led-row')[1].querySelector('a')!;
    expect(link.getAttribute('href')).toBe('#/anlage/1/technik');
    expect(link.textContent).toBe('Stromtarif hinterlegen ›');
  });

  it('das Vorzeichen kommt aus dem WERT: der negative Einspeise-Erlös trägt „−"', () => {
    const { container } = render(<ErgebnisZeilen view={viewOf('dv-praemie-ruht')} label={LABEL} />);
    const erste = container.querySelector('.vp-c-led-val')!;
    expect(erste.textContent?.startsWith('−')).toBe(true);
    expect(erste.className).toContain('is-minus');
  });

  it('ohne Ebene-1-Inhalt bleibt die Zeile RUHIG (kein leerer Aufklapper)', () => {
    const { container } = render(<ErgebnisZeilen view={viewOf('dv-monat')} label={LABEL} />);
    expect(container.querySelectorAll('details.vp-c-led-det').length).toBe(0);
    expect(container.querySelectorAll('.vp-c-led-chev').length).toBe(0);
  });

  it('mit Ebene-1-Inhalt wird jede Zeile ein Aufklapper', () => {
    const { container } = render(
      <ErgebnisZeilen
        view={viewOf('dv-monat')}
        label={LABEL}
        ebene1={(id) => <p>Rechnung {id}</p>}
      />,
    );
    expect(container.querySelectorAll('details.vp-c-led-det').length).toBe(4);
    expect(screen.getByText('Rechnung ergebnis')).toBeTruthy();
  });

  it('Speicher und Preise wohnen in der RECHTEN Spalte, die Einordnung im Statement', () => {
    const { container } = render(
      <ErgebnisZeilen
        view={viewOf('dv-tag-laufend')}
        label={LABEL}
        speicher={<div data-testid="sp">Speicher</div>}
        preise={<div data-testid="pr">Preise</div>}
        einordnung={{
          betraege: 'Bis 11 Uhr: 50,90 € · gestern 67,71 €',
          chip: { text: '25 %', richtung: 'weniger' },
          satz: null,
        }}
      />,
    );
    const rechts = container.querySelector('.vp-c-rechts')!;
    expect(within(rechts as HTMLElement).getByTestId('sp')).toBeTruthy();
    expect(within(rechts as HTMLElement).getByTestId('pr')).toBeTruthy();
    // ⚠ Die Einordnung steht im STATEMENT (§3.10 (1)), nicht in der rechten
    //   Spalte — sie ordnet die eine Zahl ein, also gehört sie unter sie.
    const stm = container.querySelector('.vp-c-stm')!;
    expect(within(stm as HTMLElement).getByText(/gestern 67,71 €/)).toBeTruthy();
    // Das ZEICHEN kommt aus der Richtung, der Text aus den Daten — der Chip
    // trägt keinen Farbton (W1), die Richtung steht also als Pfeil da.
    expect(within(stm as HTMLElement).getByText(/↓\s*25 %/)).toBeTruthy();
  });

  it.each(FX.map((f) => [f.id] as const))('%s rendert ohne Ausnahme', (id) => {
    const { container, unmount } = render(<ErgebnisZeilen view={viewOf(id)} label={LABEL} />);
    expect(container.querySelectorAll('.vp-c-led-row').length).toBe(4);
    unmount();
  });
});
