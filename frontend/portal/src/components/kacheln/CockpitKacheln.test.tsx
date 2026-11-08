import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HistoryTotals, SiteEarnings } from '../../api';
import FIXTURES from '../../erloeseFixtures.json';
import { speicherAussage } from '../../speicherAussage';
import { AutarkieKachel, FahrplanKachel, GeldKachel, GeldZeile, HeuteKachel, NetzKachel, WertKachel } from './CockpitKacheln';

/**
 * Die Kacheln unter der Bühne (Konzept „Cockpit als Tagesfilm“): eine Hülle
 * mit Kopf als Absprung, darunter der Inhalt. Die Geldzahl ist dieselbe
 * Erlöskarte wie auf der Erlöse-Seite - abgeleitet, nie abgeschrieben.
 */
const SPEICHER = (() => {
  const f = (FIXTURES.fixtures as unknown as Array<{ id: string; now: string; money: SiteEarnings }>).find(
    (x) => x.id === 'dv-tag-laufend',
  )!;
  return speicherAussage(f.money, { now: new Date(f.now) })!;
})();

const MONEY = {
  label: 'Unterm Strich · Heute',
  value: '371,43 €',
  kosten: false,
  speicher: SPEICHER,
  attribution: 'Steuerung + 12,10 €',
};

describe('Die Hülle', () => {
  it('der Kopf ist der Absprung, die Leitkachel trägt den Stern', () => {
    const onOpen = vi.fn();
    const { container, getByRole } = render(
      <WertKachel id="wetter" name="Wetter" icon="thermometer" ton="neutral" wert="25,0 °C" sub="sonnig" lead onOpen={onOpen} />,
    );
    fireEvent.click(getByRole('button', { name: /Wetter/ }));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(container.querySelector('.vp-k.is-lead .vp-k-stern')).not.toBeNull();
    expect(container.querySelector('.vp-k-platz.is-klein')).not.toBeNull();
  });
});

describe('Unterm Strich', () => {
  it('sagt „Zwischenstand" nur einmal: steht es schon in der Zeile, entfällt die Marke', () => {
    const { container } = render(
      <GeldKachel money={{ ...MONEY, attribution: 'Zwischenstand Steuerung + 0,09 €', attributionInterim: true }} />,
    );
    expect(container.textContent).toContain('Zwischenstand Steuerung + 0,09 €');
    expect(container.querySelector('.vp-k-marke')).toBeNull();
  });

  it('kompakt wie im Prototyp: die eine Geldzahl, der Zeitraum daneben, die Zurechnung als Satz', () => {
    const { container } = render(
      <GeldKachel money={{ ...MONEY, attributionInterim: true }} periodSeg={<div className="vp-seg" />} />,
    );
    expect(container.querySelector('.vp-k-platz.is-breit')).not.toBeNull();
    expect(container.querySelector('.vp-c-stm-zahl')?.textContent).toBe('371,43 €');
    expect(container.querySelector('.vp-k-zeitraum .vp-seg')).not.toBeNull();
    expect(container.textContent).toContain('Heute');
    expect(container.textContent).toContain('Steuerung + 12,10 €');
    expect(container.querySelector('.vp-k-marke')?.textContent).toBe('Zwischenstand');
    // Die Langform (Speicher-Sektion, Rechenweg) steht auf der Erlöse-Seite;
    // Autarkie und Eigenverbrauch sind eigene Kacheln - keine Ringe hier.
    expect(container.querySelector('.vp-c-speicher')).toBeNull();
    expect(container.querySelector('.vp-c-ck-ring')).toBeNull();
  });

  it('färbt ein negatives Netto und behält sein Vorzeichen im Text', () => {
    const { container } = render(<GeldKachel money={{ ...MONEY, value: '− 4,12 €', kosten: true }} />);
    const zahl = container.querySelector('.vp-c-stm-zahl');
    expect(zahl?.classList.contains('is-kosten')).toBe(true);
    expect(zahl?.textContent).toContain('−');
  });

  it('ohne Geld und ohne Zeitraum gibt es keine Kachel', () => {
    const { container } = render(<GeldKachel money={null} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('Kacheln ohne Daten', () => {
  it('fehlt die Kennzahl, fehlt die Kachel - nie „0 %“', () => {
    const { container } = render(
      <>
        <AutarkieKachel totals={{ autarkiePct: null } as unknown as HistoryTotals} tag={null} />
        <NetzKachel totals={null} />
      </>,
    );
    expect(container.textContent).toBe('');
  });

  it('der Fahrplan sagt ohne Plan, warum er leer ist', () => {
    const { container } = render(<FahrplanKachel tag={null} kind="eigenverbrauch" leer="Der Plan wird geladen …" />);
    expect(container.textContent).toContain('Der Plan wird geladen');
  });

  it('Autarkie mit Kennzahl: Prozent und Legende nach Herkunft', () => {
    const { container } = render(
      <AutarkieKachel totals={{ autarkiePct: 65.2 } as unknown as HistoryTotals} tag={null} />,
    );
    expect(container.querySelector('.vp-k-gross')?.textContent).toBe('65%');
    expect(container.querySelector('.vp-k-legende')?.textContent).toContain('Netz');
  });
});

describe('Führt der Fluss (Konzept vp-cockpit-privat-konzept)', () => {
  const ABEND = {
    consumptionKwh: 58.4,
    pvGenerationKwh: 22,
    gridImportKwh: 41.5,
    gridExportKwh: 5.1,
    autarkiePct: 29,
    eigenverbrauchPct: 77,
  } as unknown as HistoryTotals;
  const text = (el: Element) => (el.textContent ?? '').replace(/[\u00a0\u202f]/g, ' ');

  it('„Heute“: die Autarkie groß, darunter die zwei Balken mit den kWh, aus denen sie entsteht', () => {
    const { container } = render(<HeuteKachel totals={ABEND} tag={null} now={new Date(2026, 10, 7, 19, 47)} mitSpeicher={false} spalte />);
    expect(container.querySelector('.vp-k-heute.is-spalte')).not.toBeNull();
    expect(text(container)).toContain('Heute bis 19:47');
    expect(container.querySelector('.vp-k-gross.is-xl')?.textContent).toBe('29%');
    expect(text(container)).toContain('Verbraucht58,4 kWh');
    expect(text(container)).toContain('Sonne 16,9 kWh');
    expect(text(container)).toContain('Netz 41,5 kWh');
    expect(text(container)).toContain('Sonne erzeugt22,0 kWh');
    expect(text(container)).toContain('ins Netz 5,1 kWh');
    expect(text(container)).toContain('77 % selbst genutzt');
    expect(container.querySelectorAll('.vp-k-heute-balken')).toHaveLength(2);
    // Keine Leitkachel: der Fluss führt, kein Stern.
    expect(container.querySelector('.vp-k-stern')).toBeNull();
  });

  it('„Heute“ ohne Tagesverbrauch gibt es nicht (fehlend ist keine Null)', () => {
    const { container } = render(
      <HeuteKachel totals={{ ...ABEND, consumptionKwh: null } as unknown as HistoryTotals} tag={null} now={new Date()} mitSpeicher={false} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('die Geld-Zeile: dieselbe Zahl, in Textfarbe, ohne Stern, mit dem Weg zur Erlöse-Seite', () => {
    const onOpen = vi.fn();
    const { container, getByRole } = render(
      <GeldZeile money={{ label: 'Unterm Strich · Heute', value: '− 5,56 €', kosten: true, speicher: null, attribution: null, laeuft: true }} onOpen={onOpen} />,
    );
    expect(text(container)).toContain('Unterm Strich');
    expect(text(container)).toContain('heute bisher');
    expect(text(container)).toContain('− 5,56 €');
    expect(container.querySelector('.is-kosten, .vp-k-stern')).toBeNull();
    fireEvent.click(getByRole('button', { name: /Erlöse öffnen/ }));
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
